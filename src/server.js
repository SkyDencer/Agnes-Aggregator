import http from 'node:http';
import { promises as fs } from 'node:fs';
import { loadConfig } from './config.js';
import { maskKey } from './crypto.js';
import { KeyStore } from './store.js';
import { KeySelector } from './selector.js';
import { proxyChatCompletion, POOL_EXHAUSTED_BODY } from './proxy.js';

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB
const RELOAD_POLL_MS = 5000;
const MASTER_KEY_RE = /^[0-9a-fA-F]{64}$/;

// ---------------------------------------------------------------------------
// Config & startup
// ---------------------------------------------------------------------------
const config = loadConfig();

if (!MASTER_KEY_RE.test(config.masterKey)) {
  console.error(
    '[server] MASTER_KEY is missing or invalid. Generate with: ' +
      "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" " +
      'and add to .env'
  );
  process.exit(1);
}

const store = new KeyStore({ filePath: config.keysFile, masterKeyHex: config.masterKey });
const selector = new KeySelector({
  store,
  cooldownSeconds: config.cooldownSeconds,
  maxConsecutiveFailures: config.maxConsecutiveFailures,
});

try {
  await store.init();
  await store.seedFromEnvIfEmpty(config.agnesApiKey, 'Bootstrap (from .env)');
} catch (err) {
  console.error(`[server] failed to initialize key store: ${err?.message || err}`);
  process.exit(1);
}

// Poll the keys file mtime; on change, reload into memory.
let lastMtime = null;
try {
  lastMtime = (await fs.stat(config.keysFile)).mtimeMs;
} catch {
  lastMtime = null;
}
const pollTimer = setInterval(async () => {
  let mtime;
  try {
    mtime = (await fs.stat(config.keysFile)).mtimeMs;
  } catch {
    return; // file temporarily absent — keep current pool
  }
  if (mtime !== lastMtime) {
    lastMtime = mtime;
    try {
      await store.reload();
      console.log('[server] keys reloaded from disk');
    } catch (err) {
      console.error(`[server] keys reload failed: ${err?.message || err}`);
    }
  }
}, RELOAD_POLL_MS);
pollTimer.unref();

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, obj, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(obj));
}

function sendRawJson(res, status, text, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  let aborted = false;
  await new Promise((resolve, reject) => {
    req.on('data', (chunk) => {
      if (aborted) return; // ignore the rest of the body
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!aborted) resolve();
    });
    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
  return Buffer.concat(chunks).toString('utf8');
}

// Masked log tag for a result. 'pool-429' when the pool was exhausted.
async function keyTagFor(result) {
  if (!result || !result.key_id) return 'pool-429';
  const pub = store.getPublic(result.key_id);
  return pub?.masked_key ?? 'sk-***';
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
async function handleModels(res, path) {
  // Single-attempt proxy: pick one key, one fetch. No failover loop.
  const picked = await selector.selectKey({});
  if (!picked) {
    const retryAfter = await selector.minRemainingCooldownSeconds();
    sendJson(res, 429, POOL_EXHAUSTED_BODY, { 'Retry-After': String(retryAfter || 60) });
    return { status: 429, keyTag: 'pool-429' };
  }
  try {
    const upRes = await fetch(`${config.agnesBaseUrl}/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${picked.plaintext}` },
      signal: AbortSignal.timeout(config.upstreamTimeoutMs),
    });
    const text = await upRes.text();
    await store.recordSuccess(picked.id, { tokens: 0 });
    sendRawJson(res, upRes.status, text);
    return { status: upRes.status, keyTag: maskKey(picked.plaintext) };
  } catch (err) {
    await store.recordNetworkError(picked.id, err?.message || 'network error');
    sendJson(res, 502, { error: { message: 'upstream unavailable', type: 'upstream_error' } });
    return { status: 502, keyTag: maskKey(picked.plaintext) };
  }
}

async function handleHealth(res) {
  const list = store.list();
  const counts = { total: list.length, active: 0, cooling_down: 0, disabled: 0, error: 0 };
  for (const k of list) {
    if (k.status in counts) counts[k.status] += 1;
  }
  sendJson(res, 200, {
    status: 'ok',
    phase: 1,
    keys: counts,
    key_details: list, // public metadata only — never plaintext or encrypted_key
  });
  return { status: 200, keyTag: null };
}

async function handleRequest(req, res, path) {
  const base = config.apiBasePath;

  if (req.method === 'GET' && path === `${base}/health`) return handleHealth(res);
  if (req.method === 'GET' && path === `${base}/models`) return handleModels(res, path);

  if (req.method === 'POST' && path === `${base}/chat/completions`) {
    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      if (err?.statusCode === 413) {
        sendJson(res, 413, { error: { message: 'request body too large', type: 'invalid_request_error' } });
        return { status: 413, keyTag: null };
      }
      sendJson(res, 400, { error: { message: 'request aborted', type: 'invalid_request_error' } });
      return { status: 400, keyTag: null };
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { error: { message: 'invalid JSON body', type: 'invalid_request_error' } });
      return { status: 400, keyTag: null };
    }

    if (body && typeof body === 'object' && body.stream === true) {
      console.log(
        '[server] warning: client requested stream=true but Phase 1 is non-streaming — forcing stream=false'
      );
      body.stream = false;
    }

    const result = await proxyChatCompletion({
      store,
      selector,
      config,
      body,
      clientSignal: null,
    });
    const keyTag = await keyTagFor(result);
    const extraHeaders = {};
    if (result.retry_after_seconds != null) {
      extraHeaders['Retry-After'] = String(result.retry_after_seconds);
    }
    sendJson(res, result.status, result.body, extraHeaders);
    return { status: result.status, keyTag };
  }

  sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
  return { status: 404, keyTag: null };
}

function createHandler() {
  return (req, res) => {
    const started = Date.now();
    const path = new URL(req.url, 'http://localhost').pathname;
    handleRequest(req, res, path).then((outcome) => {
      const keyPart = outcome.keyTag ? ` key=${outcome.keyTag}` : '';
      console.log(
        `[${new Date().toISOString()}] ${req.method} ${path} -> ${outcome.status} ${Date.now() - started}ms${keyPart}`
      );
    });
  };
}

// ---------------------------------------------------------------------------
// Server & shutdown
// ---------------------------------------------------------------------------
const server = http.createServer(createHandler());

server.listen(config.port, config.host);
console.log(`[server] listening on http://${config.host}:${config.port}${config.apiBasePath}`);
console.log(`[server] upstream: ${config.agnesBaseUrl}`);
console.log(`[server] key pool: ${store.list().length} key(s) in ${config.keysFile}`);

function shutdown() {
  console.log('[server] shutting down');
  clearInterval(pollTimer);
  const forceExit = setTimeout(() => process.exit(0), 5000);
  forceExit.unref();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

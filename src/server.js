import http from 'node:http';
import { loadConfig } from './config.js';

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB
const UPSTREAM_TIMEOUT_MS = 60_000;

// Mask an API key for logs: sk-*** + last 4 chars, or sk-*** if shorter than 4.
function maskKey(k) {
  if (!k || k.length < 4) return 'sk-***';
  return `sk-***${k.slice(-4)}`;
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function sendRawJson(res, status, text) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

// Read the request body as utf8. Rejects with err.statusCode = 413 when the
// body exceeds MAX_BODY_BYTES; the rest of the body is ignored.
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

// Call the Agnes upstream. Throws on network error or timeout; caller maps to 502.
async function callUpstream(config, pathname, method, bodyText) {
  const res = await fetch(`${config.agnesBaseUrl}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.agnesApiKey}`,
    },
    ...(method === 'POST' ? { body: bodyText } : {}),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const text = await res.text();
  return { status: res.status, text };
}

const UPSTREAM_ERROR = { error: { message: 'upstream unavailable', type: 'upstream_error' } };

// Returns the status code that was sent, so the request log line stays accurate.
async function handleRequest(req, res, config, path) {
  const base = config.apiBasePath;

  if (req.method === 'GET' && path === `${base}/health`) {
    sendJson(res, 200, { status: 'ok', phase: 0 });
    return 200;
  }

  if (req.method === 'GET' && path === `${base}/models`) {
    try {
      const up = await callUpstream(config, '/models', 'GET');
      sendRawJson(res, up.status, up.text);
      return up.status;
    } catch {
      sendJson(res, 502, UPSTREAM_ERROR);
      return 502;
    }
  }

  if (req.method === 'POST' && path === `${base}/chat/completions`) {
    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      if (err && err.statusCode === 413) {
        sendJson(res, 413, {
          error: { message: 'request body too large', type: 'invalid_request_error' },
        });
        return 413;
      }
      sendJson(res, 400, {
        error: { message: 'request aborted', type: 'invalid_request_error' },
      });
      return 400;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendJson(res, 400, {
        error: { message: 'invalid JSON body', type: 'invalid_request_error' },
      });
      return 400;
    }

    if (!config.agnesApiKey) {
      sendJson(res, 503, {
        error: { message: 'no upstream key configured', type: 'configuration_error' },
      });
      return 503;
    }

    // Phase 0: non-streaming only. Force stream=false regardless of the client.
    if (parsed && typeof parsed === 'object' && parsed.stream === true) {
      console.log(
        '[server] warning: client requested stream=true but Phase 0 is non-streaming — forcing stream=false'
      );
    }
    if (parsed && typeof parsed === 'object') parsed.stream = false;

    try {
      const up = await callUpstream(config, '/chat/completions', 'POST', JSON.stringify(parsed));
      sendRawJson(res, up.status, up.text);
      return up.status;
    } catch {
      sendJson(res, 502, UPSTREAM_ERROR);
      return 502;
    }
  }

  sendJson(res, 404, {
    error: { message: 'not found', type: 'invalid_request_error' },
  });
  return 404;
}

function createHandler(config) {
  return (req, res) => {
    const started = Date.now();
    const path = new URL(req.url, 'http://localhost').pathname;
    handleRequest(req, res, config, path).then((status) => {
      const keyTag = config.agnesApiKey ? maskKey(config.agnesApiKey) : 'none';
      // One line per request. Never log bodies or full keys.
      console.log(
        `[${new Date().toISOString()}] ${req.method} ${path} -> ${status} ${Date.now() - started}ms key=${keyTag}`
      );
    });
  };
}

const config = loadConfig();

if (!config.agnesApiKey) {
  console.log('[config] AGNES_API_KEY is empty — proxy requests will fail');
}

const server = http.createServer(createHandler(config));

server.listen(config.port, config.host);
console.log(`[server] listening on http://${config.host}:${config.port}${config.apiBasePath}`);
console.log(`[server] upstream: ${config.agnesBaseUrl}`);
console.log(`[server] key: ${config.agnesApiKey ? maskKey(config.agnesApiKey) : 'none'}`);

// Graceful shutdown: stop accepting connections, drain, exit 0.
// If connections hang, force-exit after 5 s (unref'd timer, server.close pattern).
function shutdown() {
  console.log('[server] shutting down');
  const forceExit = setTimeout(() => process.exit(0), 5000);
  forceExit.unref();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

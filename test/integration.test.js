import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyStore } from '../src/store.js';
import { KeySelector } from '../src/selector.js';
import { proxyChatCompletion } from '../src/proxy.js';

// Cooldown window for this file (KeyStore reads it at construction).
// Generous margin over the sleep below so parallel-load jitter can't
// make the "A resurfaces" step flaky.
process.env.COOLDOWN_SECONDS = '2';
process.env.MAX_CONSECUTIVE_FAILURES = '3';

const K = 'ab'.repeat(32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const completion = (model) => ({
  id: `mock-${Math.random().toString(36).slice(2, 10)}`,
  object: 'chat.completion',
  model,
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

// In-process mock Agnes. Per-token behavior map, mutable from tests.
async function startMock(behaviors) {
  const hits = { chat: 0, perKey: {} };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      hits.chat += 1;
      hits.perKey[token] = (hits.perKey[token] ?? 0) + 1;
      const spec = behaviors[token] ?? { status: 200, json: completion(token) };
      if (spec.destroySocket) {
        req.socket.destroy(); // simulate a network drop mid-request
        return;
      }
      res.writeHead(spec.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(spec.json));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, hits }));
  });
}

async function fixture(behaviors) {
  const dir = await mkdtemp(join(tmpdir(), 'agnes-int-'));
  const store = await new KeyStore({ filePath: join(dir, 'keys.json'), masterKeyHex: K }).init();
  const a = await store.add({ label: 'A', apiKey: 'sk-A' });
  const b = await store.add({ label: 'B', apiKey: 'sk-B' });
  const mock = await startMock(behaviors);
  const config = { agnesBaseUrl: `http://127.0.0.1:${mock.port}`, upstreamTimeoutMs: 5000 };
  const selector = new KeySelector({ store, cooldownSeconds: 2, maxConsecutiveFailures: 3 });
  const body = { model: 'agnes-3.0-flash', messages: [{ role: 'user', content: 'say hi' }], stream: false };
  const chat = () => proxyChatCompletion({ store, selector, config, body, clientSignal: null });
  return { store, selector, a, b, mock, chat, close: () => mock.server.close() };
}

test('two active keys -> alternating usage', async () => {
  const env = await fixture({});
  try {
    const picks = [];
    for (let i = 0; i < 4; i++) {
      const r = await env.chat();
      assert.equal(r.status, 200);
      picks.push(r.key_id);
    }
    assert.deepEqual(picks, [env.a.id, env.b.id, env.a.id, env.b.id]);
    assert.equal(env.mock.hits.perKey['sk-A'], 2);
    assert.equal(env.mock.hits.perKey['sk-B'], 2);
  } finally {
    env.close();
  }
});

test('429 on key A -> A cooling_down, failover to B, A resurfaces after cooldown', async () => {
  const behaviors = { 'sk-A': { status: 429, json: { error: { message: 'rate limited' } } } };
  const env = await fixture(behaviors);
  try {
    const r1 = await env.chat(); // A 429s, B serves
    assert.equal(r1.status, 200);
    assert.equal(r1.key_id, env.b.id);
    assert.equal(env.store.getPublic(env.a.id).status, 'cooling_down');

    const r2 = await env.chat(); // A still in its 2s window -> B again
    assert.equal(r2.status, 200);
    assert.equal(r2.key_id, env.b.id);

    await sleep(2500); // let A's window elapse even if r2 re-cooled it
    behaviors['sk-A'] = { status: 200, json: completion('agnes-3.0-flash') }; // A is healthy now
    const r3 = await env.chat();
    assert.equal(r3.status, 200);
    assert.equal(r3.key_id, env.a.id); // A resurfaced
    assert.equal(env.store.getPublic(env.a.id).status, 'active'); // success reactivated it
  } finally {
    env.close();
  }
});

test('401 on key A -> A disabled, failover to B', async () => {
  const env = await fixture({ 'sk-A': { status: 401, json: { error: { message: 'invalid key' } } } });
  try {
    const r1 = await env.chat();
    assert.equal(r1.status, 200);
    assert.equal(r1.key_id, env.b.id);
    assert.equal(env.store.getPublic(env.a.id).status, 'disabled');
    const r2 = await env.chat();
    assert.equal(r2.key_id, env.b.id); // disabled key never selected
    assert.equal(env.mock.hits.perKey['sk-A'], 1);
  } finally {
    env.close();
  }
});

test('500 on key A 3 times -> A marked error', async () => {
  const env = await fixture({ 'sk-A': { status: 500, json: { error: { message: 'boom' } } } });
  try {
    for (let i = 0; i < 3; i++) {
      const r = await env.chat(); // each call burns one A 500, B serves
      assert.equal(r.status, 200);
      assert.equal(r.key_id, env.b.id);
    }
    const pubA = env.store.getPublic(env.a.id);
    assert.equal(pubA.consecutive_failures, 3);
    assert.equal(pubA.status, 'error');
    const r4 = await env.chat(); // error key no longer selectable
    assert.equal(r4.key_id, env.b.id);
  } finally {
    env.close();
  }
});

test('404 model_not_found -> no retry, no penalty, body passthrough', async () => {
  const notFound = {
    status: 404,
    json: { error: { code: 'model_not_found', message: 'Model xyz is not available', type: 'AgnesAI_error' } },
  };
  const env = await fixture({ 'sk-A': notFound, 'sk-B': notFound });
  try {
    const r = await env.chat();
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'model_not_found');
    assert.equal(r.key_id, env.a.id); // first key tried, no failover
    assert.equal(env.mock.hits.chat, 1); // exactly one upstream hit — no retry
    const pubA = env.store.getPublic(env.a.id);
    assert.equal(pubA.total_requests, 1);
    assert.equal(pubA.consecutive_failures, 0); // not penalized
    assert.equal(pubA.status, 'active');
    assert.equal(env.store.getPublic(env.b.id).total_requests, 0); // B never touched
  } finally {
    env.close();
  }
});

test('all keys cooling down -> proxy 429 with retry_after_seconds', async () => {
  const env = await fixture({});
  try {
    for (const id of [env.a.id, env.b.id]) {
      await env.store.updateStatus(id, {
        status: 'cooling_down',
        cooldown_until: Date.now() + 30_000,
      });
    }
    const r = await env.chat();
    assert.equal(r.status, 429);
    assert.equal(r.body.error.type, 'aggregator_error');
    assert.ok(r.retry_after_seconds > 0);
    assert.ok(r.retry_after_seconds <= 30);
    assert.equal(env.mock.hits.chat, 0); // pool exhausted before any upstream call
  } finally {
    env.close();
  }
});

test('network failure on key A -> failover to B, A counted once', async () => {
  const env = await fixture({ 'sk-A': { destroySocket: true } });
  try {
    const r = await env.chat();
    assert.equal(r.status, 200);
    assert.equal(r.key_id, env.b.id);
    const pubA = env.store.getPublic(env.a.id);
    assert.equal(pubA.consecutive_failures, 1);
    assert.equal(pubA.status, 'active'); // 1 < MAX_CONSECUTIVE_FAILURES
    assert.ok(pubA.last_error);
    assert.equal(env.mock.hits.perKey['sk-A'], 1);
    assert.equal(env.mock.hits.perKey['sk-B'], 1);
  } finally {
    env.close();
  }
});

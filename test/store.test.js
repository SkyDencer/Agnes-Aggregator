import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyStore } from '../src/store.js';

const K = 'ab'.repeat(32);

async function newStore() {
  const dir = await mkdtemp(join(tmpdir(), 'agnes-store-'));
  const store = await new KeyStore({ filePath: join(dir, 'keys.json'), masterKeyHex: K }).init();
  return { store, dir };
}

test('init creates an empty store file', async () => {
  const { store, dir } = await newStore();
  assert.deepEqual(store.list(), []);
  const raw = JSON.parse(await readFile(join(dir, 'keys.json'), 'utf8'));
  assert.equal(raw.version, 1);
  assert.deepEqual(raw.keys, []);
});

test('add / list / getPlaintext round-trip', async () => {
  const { store } = await newStore();
  const meta = await store.add({ label: 'Account 1', apiKey: 'sk-test-ef01' });
  assert.equal(meta.status, 'active');
  assert.equal(meta.priority, 100);
  assert.equal(meta.masked_key, 'sk-***ef01');
  assert.equal(meta.total_requests, 0);
  assert.ok(meta.id);
  assert.equal(store.getPublic(meta.id).label, 'Account 1');
  assert.equal(store.getPlaintext(meta.id), 'sk-test-ef01');
});

test('list() never exposes plaintext or encrypted_key', async () => {
  const { store } = await newStore();
  await store.add({ label: 'A', apiKey: 'sk-test-ef01' });
  const dumped = JSON.stringify(store.list());
  assert.ok(!dumped.includes('sk-test-ef01'));
  assert.ok(!dumped.includes('encrypted_key'));
});

test('remove deletes and reports', async () => {
  const { store } = await newStore();
  const a = await store.add({ apiKey: 'sk-test-aaaa' });
  assert.equal(await store.remove(a.id), true);
  assert.equal(store.getPublic(a.id), null);
  assert.equal(await store.remove(a.id), false);
});

test('updateStatus applies allowed fields only', async () => {
  const { store } = await newStore();
  const a = await store.add({ apiKey: 'sk-test-bbbb' });
  const pub = await store.updateStatus(a.id, { status: 'disabled', last_error: 'manual' });
  assert.equal(pub.status, 'disabled');
  assert.equal(pub.last_error, 'manual');
  // disallowed field is ignored
  await store.updateStatus(a.id, { total_requests: 999, label: 'hacked' });
  const after = store.getPublic(a.id);
  assert.equal(after.total_requests, 0);
  assert.equal(after.label, 'untitled');
});

test('recordSuccess resets consecutive_failures and counts tokens', async () => {
  const { store } = await newStore();
  const a = await store.add({ apiKey: 'sk-test-cccc' });
  await store.recordFailure(a.id, { classifyResult: { action: 'failure_count', reason: 'server_error', retry: true } });
  assert.equal(store.getPublic(a.id).consecutive_failures, 1);
  await store.recordSuccess(a.id, { tokens: 42 });
  const pub = store.getPublic(a.id);
  assert.equal(pub.consecutive_failures, 0);
  assert.equal(pub.total_tokens, 42);
  assert.equal(pub.total_requests, 2);
  assert.equal(pub.last_used_at != null, true);
});

test('recordFailure cooldown sets cooling_down + window', async () => {
  const { store } = await newStore();
  const a = await store.add({ apiKey: 'sk-test-dddd' });
  const before = Date.now();
  await store.recordFailure(a.id, { classifyResult: { action: 'cooldown', reason: 'rate_limit', retry: true } });
  const pub = store.getPublic(a.id);
  assert.equal(pub.status, 'cooling_down');
  assert.equal(pub.last_error, '429 rate limited');
  assert.ok(pub.cooldown_until > before);
  assert.ok(pub.cooldown_until <= before + 61_000); // default 60s window
});

test('recordFailure disable sets disabled and does not reset failure counter', async () => {
  const { store } = await newStore();
  const a = await store.add({ apiKey: 'sk-test-eeee' });
  await store.recordFailure(a.id, { classifyResult: { action: 'failure_count', reason: 'server_error', retry: true } });
  assert.equal(store.getPublic(a.id).consecutive_failures, 1);
  await store.recordFailure(a.id, { classifyResult: { action: 'disable', reason: 'unauthorized', retry: true } });
  const pub = store.getPublic(a.id);
  assert.equal(pub.status, 'disabled');
  assert.equal(pub.last_error, '401 unauthorized');
  assert.equal(pub.consecutive_failures, 1); // NOT reset
});

test('3 consecutive 5xx failures -> status error', async () => {
  const { store } = await newStore();
  const a = await store.add({ apiKey: 'sk-test-ffff' });
  const cls = { action: 'failure_count', reason: 'server_error', retry: true };
  await store.recordFailure(a.id, { classifyResult: cls });
  await store.recordFailure(a.id, { classifyResult: cls });
  assert.notEqual(store.getPublic(a.id).status, 'error');
  await store.recordFailure(a.id, { classifyResult: cls });
  assert.equal(store.getPublic(a.id).status, 'error');
  assert.equal(store.getPublic(a.id).consecutive_failures, 3);
});

test('atomic write leaves no .tmp behind', async () => {
  const { store, dir } = await newStore();
  const a = await store.add({ apiKey: 'sk-test-gggg' });
  await store.recordSuccess(a.id, { tokens: 1 });
  await store.recordFailure(a.id, { classifyResult: { action: 'none', reason: 'client_error', retry: false } });
  const files = await readdir(dir);
  assert.deepEqual(files.filter((f) => f.endsWith('.tmp')), []);
  assert.ok(files.includes('keys.json'));
});

test('seedFromEnvIfEmpty is idempotent and one-way', async () => {
  const { store } = await newStore();
  const seeded = await store.seedFromEnvIfEmpty('sk-seed-1234', 'Bootstrap (from .env)');
  assert.equal(seeded.masked_key, 'sk-***1234');
  assert.equal(store.list().length, 1);
  // second seed: no-op
  assert.equal(await store.seedFromEnvIfEmpty('sk-other-9999', 'again'), null);
  assert.equal(store.list().length, 1);
  // empty apiKey: no-op
  assert.equal(await store.seedFromEnvIfEmpty('', 'empty'), null);
  assert.equal(store.list().length, 1);
});

test('state persists across reload (new instance)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agnes-store-'));
  const path = join(dir, 'keys.json');
  const s1 = await new KeyStore({ filePath: path, masterKeyHex: K }).init();
  const a = await s1.add({ label: 'persist', apiKey: 'sk-persist-77' });
  const s2 = await new KeyStore({ filePath: path, masterKeyHex: K }).init();
  assert.equal(s2.list().length, 1);
  assert.equal(s2.getPlaintext(a.id), 'sk-persist-77');
  assert.equal(s2.getPublic(a.id).label, 'persist');
});

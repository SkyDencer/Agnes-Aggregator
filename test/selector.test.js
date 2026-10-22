import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyStore } from '../src/store.js';
import { KeySelector } from '../src/selector.js';

const K = 'ab'.repeat(32);

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'agnes-sel-'));
  const store = await new KeyStore({ filePath: join(dir, 'keys.json'), masterKeyHex: K }).init();
  const selector = new KeySelector({ store, cooldownSeconds: 60, maxConsecutiveFailures: 3 });
  return { store, selector, dir };
}

test('round-robin picks A, B, A, B', async () => {
  const { store, selector } = await fixture();
  const a = await store.add({ label: 'A', apiKey: 'sk-aaaa-1' });
  const b = await store.add({ label: 'B', apiKey: 'sk-bbbb-2' });
  const picks = [];
  for (let i = 0; i < 4; i++) {
    picks.push((await selector.selectKey({})).id);
  }
  assert.deepEqual(picks, [a.id, b.id, a.id, b.id]);
});

test('skips cooling_down keys whose window is in the future', async () => {
  const { store, selector } = await fixture();
  const a = await store.add({ label: 'A', apiKey: 'sk-aaaa-1' });
  const b = await store.add({ label: 'B', apiKey: 'sk-bbbb-2' });
  await store.updateStatus(a.id, { status: 'cooling_down', cooldown_until: Date.now() + 60_000 });
  const picks = [];
  for (let i = 0; i < 3; i++) picks.push((await selector.selectKey({})).id);
  assert.deepEqual(picks, [b.id, b.id, b.id]);
});

test('expired cooling_down key re-enters rotation', async () => {
  const { store, selector } = await fixture();
  const a = await store.add({ label: 'A', apiKey: 'sk-aaaa-1' });
  const b = await store.add({ label: 'B', apiKey: 'sk-bbbb-2' });
  await store.updateStatus(a.id, { status: 'cooling_down', cooldown_until: Date.now() - 1000 });
  const picks = [];
  for (let i = 0; i < 4; i++) picks.push((await selector.selectKey({})).id);
  assert.deepEqual(picks, [a.id, b.id, a.id, b.id]);
});

test('skips disabled and error keys', async () => {
  const { store, selector } = await fixture();
  const a = await store.add({ label: 'A', apiKey: 'sk-aaaa-1' });
  const b = await store.add({ label: 'B', apiKey: 'sk-bbbb-2' });
  await store.updateStatus(a.id, { status: 'disabled' });
  await store.updateStatus(b.id, { status: 'error' });
  assert.equal(await selector.selectKey({}), null);
});

test('honors the exclude list', async () => {
  const { store, selector } = await fixture();
  const a = await store.add({ label: 'A', apiKey: 'sk-aaaa-1' });
  const b = await store.add({ label: 'B', apiKey: 'sk-bbbb-2' });
  const r1 = await selector.selectKey({ exclude: [a.id] });
  assert.equal(r1.id, b.id);
  assert.equal(await selector.selectKey({ exclude: [a.id, b.id] }), null);
});

test('returns null on an empty pool', async () => {
  const { selector } = await fixture();
  assert.equal(await selector.selectKey({}), null);
});

test('minRemainingCooldownSeconds', async () => {
  const { store, selector } = await fixture();
  assert.equal(await selector.minRemainingCooldownSeconds(), 0);
  const a = await store.add({ label: 'A', apiKey: 'sk-aaaa-1' });
  await store.updateStatus(a.id, { status: 'cooling_down', cooldown_until: Date.now() + 30_000 });
  const min = await selector.minRemainingCooldownSeconds();
  assert.ok(min > 28 && min <= 30, `expected ~30, got ${min}`);
});

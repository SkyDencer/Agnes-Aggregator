import test from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt, maskKey } from '../src/crypto.js';

const K = 'ab'.repeat(32); // 64 hex chars
const K2 = 'cd'.repeat(32);

test('encrypt/decrypt round-trip', () => {
  const payload = 'sk-live-abcdef1234567890';
  const enc = encrypt(payload, K);
  assert.equal(typeof enc.iv, 'string');
  assert.equal(enc.iv.length, 24); // 12-byte IV as hex
  assert.equal(typeof enc.authTag, 'string');
  assert.equal(typeof enc.ciphertext, 'string');
  assert.equal(decrypt(enc, K), payload);
});

test('each encryption uses a fresh IV', () => {
  const a = encrypt('same', K);
  const b = encrypt('same', K);
  assert.notEqual(a.iv, b.iv);
});

test('wrong key throws', () => {
  const enc = encrypt('secret', K);
  assert.throws(() => decrypt(enc, K2));
});

test('tampered ciphertext throws', () => {
  const enc = encrypt('secret', K);
  const tampered = { ...enc, ciphertext: '00'.repeat(enc.ciphertext.length / 2) };
  assert.throws(() => decrypt(tampered, K));
});

test('bad MASTER_KEY format throws with a generation hint', () => {
  assert.throws(() => encrypt('x', 'short'), /64 hex/);
  assert.throws(() => encrypt('x', 'g'.repeat(64)), /64 hex/);
  assert.throws(() => decrypt({ iv: 'aa', authTag: 'bb', ciphertext: 'cc' }, ''), /randomBytes/);
});

test('maskKey edge cases', () => {
  assert.equal(maskKey(''), 'sk-***');
  assert.equal(maskKey('abc'), 'sk-***');
  assert.equal(maskKey('abcd'), 'sk-***abcd');
  assert.equal(maskKey('sk-AbCdefGh'), 'sk-***efGh');
  assert.equal(maskKey(null), 'sk-***');
});

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const MASTER_KEY_RE = /^[0-9a-fA-F]{64}$/;
const GENERATE_HINT =
  "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"";

function assertMasterKey(masterKeyHex) {
  if (typeof masterKeyHex !== 'string' || !MASTER_KEY_RE.test(masterKeyHex)) {
    throw new Error(
      'MASTER_KEY must be exactly 64 hex characters (32 bytes). ' +
        `Generate one with: ${GENERATE_HINT}`
    );
  }
}

// AES-256-GCM. MASTER_KEY (64 hex) is the raw 32-byte key — no KDF
// (documented trade-off, see docs/problems.md). Per-key random 12-byte IV.
export function encrypt(plaintext, masterKeyHex) {
  assertMasterKey(masterKeyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(masterKeyHex, 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

// Throws (bad auth tag) on wrong key or tampered ciphertext.
export function decrypt({ iv, authTag, ciphertext }, masterKeyHex) {
  assertMasterKey(masterKeyHex);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(masterKeyHex, 'hex'), Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  const plain = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'hex')), decipher.final()]);
  return plain.toString('utf8');
}

// Mask a key for display/logs: "sk-***" + last 4 chars, or "sk-***" if shorter than 4.
export function maskKey(k) {
  if (typeof k !== 'string' || k.length < 4) return 'sk-***';
  return `sk-***${k.slice(-4)}`;
}

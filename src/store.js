import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { encrypt, decrypt, maskKey } from './crypto.js';

// Rotation knobs. KeyStore's constructor signature is locked to
// { filePath, masterKeyHex }, so these come from process.env with the same
// defaults as src/config.js (COOLDOWN_SECONDS=60, MAX_CONSECUTIVE_FAILURES=3).
function rotationKnobs() {
  return {
    cooldownSeconds: Number(process.env.COOLDOWN_SECONDS ?? 60),
    maxConsecutiveFailures: Number(process.env.MAX_CONSECUTIVE_FAILURES ?? 3),
  };
}

// Public metadata shape — NEVER includes encrypted_key or plaintext.
function publicMeta(record, masterKeyHex) {
  let masked = 'sk-***';
  try {
    masked = maskKey(decrypt(record.encrypted_key, masterKeyHex));
  } catch {
    // key undecryptable (e.g. MASTER_KEY changed) — show degraded marker
  }
  return {
    id: record.id,
    label: record.label,
    status: record.status,
    priority: record.priority,
    masked_key: masked,
    last_used_at: record.last_used_at ?? null,
    last_error: record.last_error ?? null,
    total_requests: record.total_requests ?? 0,
    total_tokens: record.total_tokens ?? 0,
    consecutive_failures: record.consecutive_failures ?? 0,
    cooldown_until: record.cooldown_until ?? null,
    created_at: record.created_at ?? null,
  };
}

export class KeyStore {
  #knobs;
  #data;
  #writeChain;

  constructor({ filePath, masterKeyHex }) {
    this.filePath = filePath;
    this.masterKeyHex = masterKeyHex;
    this.#knobs = rotationKnobs();
    this.#data = { version: 1, keys: [] };
    this.#writeChain = Promise.resolve();
  }

  async init() {
    await fs.mkdir(dirname(this.filePath), { recursive: true });
    let raw = null;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch {
      raw = null;
    }
    if (raw) {
      this.#data = JSON.parse(raw);
      if (this.#data.version !== 1 || !Array.isArray(this.#data.keys)) {
        throw new Error('keys.json is not a valid Phase 1 store (expected version 1)');
      }
    } else {
      this.#data = { version: 1, keys: [] };
      await this.#save();
    }
    return this;
  }

  // Seed one key from AGNES_API_KEY on first boot. One-way: never deletes.
  async seedFromEnvIfEmpty(apiKey, label) {
    if (apiKey === '' || apiKey == null) return null;
    if (this.#data.keys.length > 0) return null;
    return this.add({ label, apiKey });
  }

  // Re-read from disk (mtime polling in server.js). A missing file resets the
  // pool to empty; a corrupt file throws so the caller can log it.
  async reload() {
    let raw;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') {
        this.#data = { version: 1, keys: [] };
        return this;
      }
      throw err;
    }
    this.#data = JSON.parse(raw);
    if (this.#data.version !== 1 || !Array.isArray(this.#data.keys)) {
      throw new Error('keys.json is not a valid Phase 1 store (expected version 1)');
    }
    return this;
  }

  list() {
    return this.#data.keys.map((k) => publicMeta(k, this.masterKeyHex));
  }

  getPublic(id) {
    const k = this.#data.keys.find((x) => x.id === id);
    return k ? publicMeta(k, this.masterKeyHex) : null;
  }

  // INTERNAL only — used by the rotation path, never exposed over HTTP.
  getPlaintext(id) {
    const k = this.#data.keys.find((x) => x.id === id);
    if (!k) throw new Error(`key not found: ${id}`);
    return decrypt(k.encrypted_key, this.masterKeyHex);
  }

  async add({ label, apiKey, priority = 100 }) {
    if (!apiKey) throw new Error('apiKey is required');
    const record = {
      id: randomUUID(),
      label: label ?? 'untitled',
      encrypted_key: encrypt(String(apiKey), this.masterKeyHex),
      status: 'active',
      priority: Number(priority) || 100,
      last_used_at: null,
      last_error: null,
      total_requests: 0,
      total_tokens: 0,
      consecutive_failures: 0,
      cooldown_until: null,
      created_at: new Date().toISOString(),
    };
    this.#data.keys.push(record);
    await this.#save();
    return publicMeta(record, this.masterKeyHex);
  }

  async remove(id) {
    const before = this.#data.keys.length;
    this.#data.keys = this.#data.keys.filter((k) => k.id !== id);
    if (this.#data.keys.length === before) return false;
    await this.#save();
    return true;
  }

  // Patch only the allowed status fields; ignore anything else.
  async updateStatus(id, patch) {
    const k = this.#data.keys.find((x) => x.id === id);
    if (!k) return null;
    const allowed = ['status', 'cooldown_until', 'consecutive_failures', 'last_error'];
    for (const f of allowed) {
      if (f in patch) k[f] = patch[f];
    }
    await this.#save();
    return publicMeta(k, this.masterKeyHex);
  }

  async recordSuccess(id, { tokens = 0 } = {}) {
    const k = this.#data.keys.find((x) => x.id === id);
    if (!k) return null;
    const now = Date.now();
    k.total_requests += 1;
    k.total_tokens += Number(tokens) || 0;
    k.consecutive_failures = 0;
    k.last_used_at = new Date(now).toISOString();
    // A success on a cooled-down key whose window has passed reactivates it.
    if (k.status === 'cooling_down' && (!k.cooldown_until || k.cooldown_until <= now)) {
      k.status = 'active';
    }
    await this.#save();
    return publicMeta(k, this.masterKeyHex);
  }

  async recordFailure(id, { classifyResult }) {
    const k = this.#data.keys.find((x) => x.id === id);
    if (!k) return null;
    const now = Date.now();
    k.total_requests += 1;
    switch (classifyResult?.action) {
      case 'cooldown':
        k.status = 'cooling_down';
        k.cooldown_until = now + this.#knobs.cooldownSeconds * 1000;
        k.last_error = '429 rate limited';
        k.consecutive_failures += 1;
        break;
      case 'disable':
        k.status = 'disabled';
        k.last_error = '401 unauthorized';
        break;
      case 'failure_count':
        k.consecutive_failures += 1;
        k.last_error = `5xx ${classifyResult.reason ?? 'server_error'}`;
        if (k.consecutive_failures >= this.#knobs.maxConsecutiveFailures) k.status = 'error';
        break;
      case 'none':
      default:
        // client error / unknown — request counted, key not penalized
        break;
    }
    await this.#save();
    return publicMeta(k, this.masterKeyHex);
  }

  async recordNetworkError(id, message) {
    const k = this.#data.keys.find((x) => x.id === id);
    if (!k) return null;
    k.total_requests += 1;
    k.consecutive_failures += 1;
    k.last_error = message || 'network error';
    if (k.consecutive_failures >= this.#knobs.maxConsecutiveFailures) k.status = 'error';
    await this.#save();
    return publicMeta(k, this.masterKeyHex);
  }

  // Atomic write: tmp file + rename. Writes are serialized so concurrent
  // saves never clobber each other (each save flushes the current memory
  // state, which is the source of truth between writes).
  async #save() {
    this.#writeChain = this.#writeChain.then(async () => {
      const tmp = `${this.filePath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.#data, null, 2));
      await fs.rename(tmp, this.filePath);
    });
    await this.#writeChain;
  }
}

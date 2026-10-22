// Round-robin key selection with cooldown / disable awareness.
// The selector only reads store.list(); the server is responsible for
// reloading the store when the file changes.
export class KeySelector {
  constructor({ store, cooldownSeconds, maxConsecutiveFailures }) {
    this.store = store;
    this.cooldownSeconds = cooldownSeconds;
    this.maxConsecutiveFailures = maxConsecutiveFailures;
    this._rrIndex = 0;
  }

  // In-list indexes of keys we may pick right now.
  _eligibleIndexes(list, excludeSet, now) {
    const eligible = new Set();
    list.forEach((k, i) => {
      if (excludeSet.has(k.id)) return;
      const inCooldown = k.cooldown_until != null && k.cooldown_until > now;
      if (inCooldown) return;
      // 'cooling_down' whose window has passed is effectively active.
      const usable =
        k.status === 'active' || k.status === 'cooling_down';
      if (usable) eligible.add(i);
    });
    return eligible;
  }

  async selectKey({ exclude = [] } = {}) {
    const list = await this.store.list();
    if (list.length === 0) return null;
    const now = Date.now();
    const eligible = this._eligibleIndexes(list, new Set(exclude), now);
    if (eligible.size === 0) return null;

    // Scan from the round-robin pointer, wrapping around the full list.
    const len = list.length;
    for (let step = 0; step < len; step++) {
      const pos = (this._rrIndex + step) % len;
      if (!eligible.has(pos)) continue;
      const k = list[pos];
      let plaintext;
      try {
        plaintext = this.store.getPlaintext(k.id);
      } catch {
        continue; // undecryptable key — skip it, never return it
      }
      this._rrIndex = (pos + 1) % len; // advance for the next call
      return { id: k.id, plaintext };
    }
    return null;
  }

  // Smallest positive seconds remaining across cooling_down keys, or 0.
  async minRemainingCooldownSeconds() {
    const list = await this.store.list();
    const now = Date.now();
    let min = 0;
    for (const k of list) {
      if (k.status !== 'cooling_down' || k.cooldown_until == null) continue;
      const remaining = (k.cooldown_until - now) / 1000;
      if (remaining > 0 && (min === 0 || remaining < min)) min = remaining;
    }
    return min;
  }
}

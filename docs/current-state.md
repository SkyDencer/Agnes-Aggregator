# Current State

Append-only log of completed work. Most recent entry at the bottom.

---

## 2026-10-20 — Phase -0.5: Scaffolding
- Created project directory tree.
- Added package.json (zero dependencies, ESM, Node 20+).
- Added .gitignore, .env.example, README.md, AGENTS.md, CHANGELOG.md, LICENSE (MIT).
- Created docs/ skeleton (current-state, implementation-plan, problems, ai-context, decision-dictionary, architecture, api, panel, reports/).
- Initialized git repository. No commit yet.
- No application code written.

---

## 2026-10-22 — Phase 0: Feasibility & Skeleton
- src/config.js — env loader, no dependencies
- src/server.js — node:http server with /health, /models, /chat/completions (non-streaming)
- Proxies to single Agnes key from AGNES_API_KEY
- No rotation, no streaming, no storage, no panel (by design for Phase 0)
- Key masked in logs (sk-***abcd)

---

## 2026-10-22 — Phase 1: Multi-key rotation
- Persistent encrypted key pool in data/keys.json (AES-256-GCM, atomic write, gitignored).
- Bootstrap: first boot seeds one key from AGNES_API_KEY, labeled "Bootstrap (from .env)".
- CLI: scripts/keys.js (list/add/remove/disable/enable/reset-cooldown), exit codes 0/1/2.
- Round-robin KeySelector with 429 cooldown, 401/403 disable, 5xx/network failure count.
- Up to 3 upstream attempts per client request; 404 model_not_found is never retried nor penalized.
- Pool-aware /health (phase 1, key counts + public metadata); 5s mtime polling reloads the pool.
- 40 tests across 5 files, all passing (crypto, classifier, store, selector, integration).

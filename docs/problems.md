# Problems & Known Issues

- 2026-10-22 (Phase 1): MASTER_KEY has no KDF; 64-hex key used as raw AES-256 key. Mitigation: user stores MASTER_KEY in a password manager. Future: Argon2id via a dependency, deferred to post-v1.
- 2026-10-22 (Phase 1): Server reloads keys file on mtime change every 5s. CLI changes may take up to 5s to apply. Phase 3 will add HTTP admin endpoints to eliminate the polling.
- 2026-10-22 (Phase 1): Graceful shutdown remains verified only on Linux in Phase 0; Windows Git Bash signal delivery untested. Deferred to Phase 5.
- 2026-10-22 (Phase 1): 404 model_not_found from Agnes is treated as client error — not retried, not penalized. Confirmed from Phase 0.5 real-API observation.
- 2026-10-22 (Phase 1): `npm test` (`node --test test/`) fails on Windows/Node 24 — the directory argument is treated as a CJS entry (MODULE_NOT_FOUND). Running `node --test` (auto-discovery) works and is the verified invocation on this host. package.json left untouched per Phase 1 constraints.
- 2026-10-22 (Phase 1): The mtime poller also reacts to the store's own writes (recordSuccess/recordFailure change the file mtime), so "keys reloaded from disk" can appear right after a request burst. Harmless (reloads identical state) but noisier than ideal.

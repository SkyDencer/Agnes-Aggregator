# Changelog

All notable changes to this project will be documented here.
Format based on Keep a Changelog. Versioning follows SemVer.

## [Unreleased]
### Added
- Project scaffolding: directory tree, package.json, .env.example, LICENSE, docs skeleton.
- Phase 1: persistent encrypted key pool (data/keys.json, AES-256-GCM, atomic write), `scripts/keys.js` CLI (list/add/remove/disable/enable/reset-cooldown), round-robin key selection with 429 cooldown, 401/403 disable, 5xx/network failure counting, up to 3 upstream attempts per client request, pool-aware /health, 5s mtime-poll config reload.

### Changed
- POST /chat/completions now routes through the key pool instead of a single AGNES_API_KEY; on first boot the pool is seeded from AGNES_API_KEY ("Bootstrap (from .env)").
- GET /models is a single-attempt proxy through the pool (429 aggregator error when no key is available).
- 404 model_not_found from upstream is passed through without retry and without key penalty.

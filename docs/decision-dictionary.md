# Decision Dictionary

Recurring questions and their locked answers.

## D1. TypeScript or JavaScript?
JavaScript. Plain ESM. No build step.

## D2. Express or native http?
Native node:http. Fewer deps, explicit control.

## D3. SQLite or JSON storage?
JSON files with atomic write (write to temp, rename). Single-user local tool.

## D4. React or plain HTML for panel?
Plain HTML/CSS/JS. No build pipeline for the panel.

## D5. Default port?
7000.

## D6. Default API base path?
/api/v1.

## D7. What happens when all keys are cooling down?
Return 429 to client with Retry-After header and a clear message.

## D8. What happens on 401 from upstream?
Mark key as disabled immediately. Requires manual re-enable.

## D9. Where do we store the key pool?
data/keys.json (gitignored). Atomic write via .tmp + rename.

## D10. How are keys encrypted?
AES-256-GCM with MASTER_KEY (64-hex raw key) from .env. Per-key random 12-byte IV.

## D11. What is the retry limit per client request?
3 upstream attempts.

## D12. How does the aggregator classify a 404 model_not_found?
As client error — passthrough, no retry, no key penalty.

## D13. When does a key transition to 'error'?
After MAX_CONSECUTIVE_FAILURES (default 3) consecutive 5xx/network failures.

## D14. How does a 'disabled' key get re-enabled?
Manual via CLI in Phase 1; via panel in Phase 3.

## D15. What is the bootstrap path for existing Phase 0 users?
On first Phase 1 boot, seed one key from AGNES_API_KEY if keys.json is empty.

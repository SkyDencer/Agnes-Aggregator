# AGENTS.md — Quick Reference for Coding Agents

## Project
Agnes Aggregator — local-first OpenAI-compatible proxy for Agnes AI.

## Non-negotiable rules
- English only in code, comments, commits, docs.
- NO new runtime dependencies without explicit PM approval.
- NO TypeScript. Plain JavaScript ESM only.
- NO Express/Fastify. Use native node:http.
- API keys must NEVER appear in logs or HTTP responses. Mask as sk-***abcd.
- Fail-over on key errors — NEVER hang, NEVER fail-open.
- One commit per sub-phase, imperative mood.
- Do NOT push unless explicitly told.

## Verification before declaring success
- npm test
- npm run build
- npm run lint

## Where to look
- docs/ai-context.md — architecture and conventions
- docs/decision-dictionary.md — recurring Q&A
- docs/current-state.md — what has been done
- docs/problems.md — known issues
- data/keys.json — the key pool (gitignored, encrypted at rest). DO NOT read, print, or commit it.
- MASTER_KEY in .env is mandatory; server refuses to start without a valid 64-hex value.

## Stop conditions
If any invariant above would be violated, STOP and report — do not proceed.

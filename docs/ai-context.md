# AI Context — Architecture & Conventions

## Purpose
Aggregate multiple Agnes AI API keys behind a single OpenAI-compatible endpoint.

## Stack (locked for v1.0)
- Node.js 20+, ESM ("type": "module")
- Plain JavaScript — NO TypeScript
- native node:http — NO Express/Fastify
- JSON storage with atomic write — NO SQLite
- Plain HTML/CSS/JS panel — NO React

## Directory layout
src/        — server and modules
public/     — panel static files
test/       — node:test files
docs/       — documentation

## Conventions
- English only in code/comments/commits/docs.
- Redact API keys everywhere: sk-***abcd.
- Fail-over on errors. Never fail-open. Never hang.
- One commit per sub-phase.
- Zero runtime dependencies. Every dependency needs PM approval.

## External API
- Agnes base URL: configurable via AGNES_BASE_URL (default https://apihub.agnes-ai.com/v1)
- Auth: Authorization: Bearer <agnes-key>

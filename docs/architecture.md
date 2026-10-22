# Architecture

(to be expanded in later phases)

## High-level
Client (ZCode) → [Agnes Aggregator :7000] → multiple Agnes keys → Agnes upstream

## Components (planned)
- HTTP server (node:http)
- Router (/api/v1/*, /panel/*)
- Key store (JSON)
- Key selector (round-robin + cooldown)
- Upstream client (fetch)
- Usage tracker
- Panel backend + static files

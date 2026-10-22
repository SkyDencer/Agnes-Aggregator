# Architecture

(to be expanded in later phases)

## High-level
Client (ZCode) → [Agnes Aggregator :7000] → multiple Agnes keys → Agnes upstream

## Phase 1 data flow
- Client → HTTP server → proxyChatCompletion → KeySelector (round-robin) → store.getPlaintext → fetch(Agnes)
- Response → classifier → store.record{Success,Failure,NetworkError}
- On failover: selector.selectKey({exclude: triedIds})
- /health reads store.list()

## Components (planned)
- Usage tracker
- Panel backend + static files

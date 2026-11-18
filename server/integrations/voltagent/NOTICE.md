# NOTICE: VoltAgent integration

Status: original TitanZero code. Checked 2026-11-18 against Mastra commit `b9d38c73982210c6564ee8a33d992a238e29a20b`. No Mastra or VoltAgent source is copied. Attribution rules and the scan method are in `docs/mastra-attribution.md`.

Counsel review is still required before the paid launch of Desk (issue #395, owner-only item).

## Source files covered by this notice

Each file below is original code. Its header says so, and the provenance scan found no verbatim Mastra line in it.

- agents/bridge.ts
- agents/voltagent-tools.ts
- citations/adapter.ts
- evals/adapter.ts
- flags.ts
- guard.ts
- guardrails/adapter.ts
- mcp/tools.ts
- model/adapter.ts
- rag/chunker.ts
- rag/knowledge-port.ts
- rag/vector-store.ts
- rerank/cohere-reranker.ts
- vector-pg/pg-vector-store.ts
- vector-pg/sql.ts
- voice/spike.ts
- workflows/approval-flow.ts

## Rules

- No file under an `ee/` directory may be added. Gate G1 (`scripts/check-voltagent-licence.mjs`) enforces this.
- Any copied Apache-2.0 file must keep its upstream header, be listed here with its upstream path, and be covered by `docs/mastra-attribution.md`.
- A new file in this directory must be added to the list above. `tests/integrations/voltagent/provenance.test.mjs` fails if it is missing.

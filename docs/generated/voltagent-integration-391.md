# VoltAgent integration record (#391)

Date: 2026-11-18. Branch: team/issue-391, cut from origin/main.

## R1 gate (defined here, because the issue referenced it and no definition existed)
1. Narrow tests: `node --test --experimental-strip-types tests/integrations/voltagent/*.test.mjs tests/integrations/voltagent/_helpers/*.test.mjs tests/infrastructure/telemetry*.test.mjs` must report 0 failures.
2. Every new TypeScript module must be covered by a test in step 1 and load under `--experimental-strip-types`.
3. No full `tsc` (8 GB machine). Narrow checks only.
4. A file is integrated only when a test in the gate covers it. Files that fail a step are not integrated.

## Baseline and result
- origin/main: 123 of 123 narrow tests pass.
- This branch: 145 of 145 pass (123 on main, plus 9 harness tests and 13 approval-step tests).

## Workstreams
Rule: where main already has a file, main's version is kept.

- W1 agents: already on main (agents/bridge.ts, agents.test.mjs). Nothing new.
- W2 workflows: integrated. server/integrations/voltagent/workflows/approval-step.ts (from feature/w2-workflows), with tests/integrations/voltagent/approval-step.test.mjs (13 tests: flag gating, start suspend/complete/fail, resume reject, already-resolved, flag off after build). Main's approval-flow.ts and workflows.test.mjs are unchanged.
- W3 model: NOT integrated. chat-provider.ts uses parameter properties (needs transform-types) and imports `ai`, which is not installed in this checkout. No test on main covers it.
- W4 RAG: NOT integrated. retrieval-adapter.ts imports @voltagent/rag, which is not installed in this checkout. Main's rag/ modules and tests stay.
- W5 pgvector: already on main (vector-pg/pg-vector-store.ts, sql.ts; test: tests/integrations/voltagent/vector-pg.test.mjs). Nothing new.
- W6 reranker: already on main (rerank/cohere-reranker.ts; test: tests/integrations/voltagent/rerank.test.mjs). Nothing new.
- W7 telemetry: NOT integrated. receipt.ts and spans.ts import redactTelemetryAttributes from the branch's own redact.ts, which main does not have. Main's telemetry/index.ts and redact.ts stay.
- W8 and W10: BLOCKED. No branch on origin and no spec in the repo for these workstream IDs. Needs owner or coordinator input on what W8 and W10 are.
- W9 MCP tools: already on main (mcp/tools.ts; test: tests/integrations/voltagent/mcp.test.mjs). Nothing new.
- W11 voice: already on main (voice/spike.ts; test: tests/integrations/voltagent/voice.test.mjs). Nothing new.
- W12 storage: main already holds the candidate migrations/candidates/voltagent_0001_runs_evals.sql (#451). The branch's second candidate (voltagent_0001_schema.sql) fails main's storage-candidates test and is not integrated.
- W13 harness: the branch's helper test targeted a different fake API and failed (10 failures). Rewritten as tests/integrations/voltagent/_helpers/harness.test.mjs against main's fake-chat-provider, fake-registry and fixtures (9 tests). The branch's fake files and README are not integrated, because main's helpers are kept.
- W5, W6, W8, W9, W10, W11 had no branch on origin. The four with main code are listed above. W8 and W10 remain blocked.

## Open
Issue #391 stays open. Open items: W3, W4, W7 (need deps or a shared redact module, plus tests), and W8/W10 (no spec).

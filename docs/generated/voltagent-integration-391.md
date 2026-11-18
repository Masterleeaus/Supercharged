# VoltAgent integration record (#391)

Date: 2026-11-18. Branch: team/issue-391, cut from origin/main.

## R1 gate
1. Narrow tests: `node --test --experimental-transform-types tests/integrations/voltagent/*.test.mjs tests/integrations/voltagent/_helpers/*.test.mjs tests/infrastructure/telemetry*.test.mjs` must report 0 failures.
2. Every new TypeScript module must be covered by a test in step 1 and load under `--experimental-transform-types` (needed for parameter properties).
3. Dependencies installed with `npm ci --ignore-scripts` (the lock file is unchanged). No full `tsc` (8 GB machine).
4. A file is integrated only when a test in the gate covers it.

## Result
- origin/main baseline: 123 of 123 narrow tests pass, with node_modules from the lock (before this branch).
- This branch: 181 of 181 pass.

## Workstreams
Rule: where main already has a file, main's version is kept. Only new files are added.

- W1 agents: already on main with tests (agents.test.mjs). Nothing new.
- W2 workflows: integrated. workflows/approval-step.ts, tests/integrations/voltagent/approval-step.test.mjs (13 tests).
- W3 model: integrated. model/chat-provider.ts, tests/integrations/voltagent/chat-provider.test.mjs (7 tests). Uses `ai`, installed as a dependency of @voltagent/core. No direct dependency was added to package.json, so the lock is unchanged. Main's model/adapter.ts (#377) is unchanged.
- W4 RAG: integrated. rag/retrieval-adapter.ts, tests/integrations/voltagent/rag-adapter.test.mjs (8 tests). Uses @voltagent/rag, which is installed.
- W5 pgvector: already on main with tests (vector-pg.test.mjs). Nothing new.
- W6 reranker: already on main with tests (rerank.test.mjs). Nothing new.
- W7 telemetry: integrated. telemetry/telemetry-redact.ts (the redact module W7 depends on, added under a new name because main's redact.ts exists), spans.ts and receipt.ts (imports point at telemetry-redact.ts). Tests: tests/integrations/voltagent/telemetry-w7.test.mjs (8 tests).
- W8 evals: main's evals/adapter.ts is the spec. Added tests/integrations/voltagent/evals-contract.test.mjs (5 tests) for the score mapping, the disabled path and the flag rule. No source change.
- W9 MCP tools: already on main with tests (mcp.test.mjs). Nothing new.
- W10 guardrails: main's guardrails/adapter.ts is the spec. Added tests/integrations/voltagent/guardrails-fail-closed.test.mjs (8 tests): throw, non-verdict, pass and reason rules, stage, non-string text. No source change.
- W11 voice: already on main with tests (voice.test.mjs). Nothing new.
- W12 storage: main holds the candidate migrations/candidates/voltagent_0001_runs_evals.sql (#451). The branch's second candidate is not integrated because it breaks main's storage-candidates test.
- W13 harness: tests/integrations/voltagent/_helpers/harness.test.mjs (9 tests) rewritten against main's fake-chat-provider, fake-registry and fixtures. The branch's fake files and README are not integrated.

## Open
Issue #391 closes when the PR merges and every checklist box has evidence in the PR body.

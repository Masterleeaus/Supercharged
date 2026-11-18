# VoltAgent integration record (#391)

Date: 2026-11-18. Integration branch: team/issue-391, cut from origin/main.

## R1 gate (defined here, because the issue referenced it and no definition existed)
1. Narrow tests: `node --test --experimental-strip-types tests/integrations/voltagent/*.test.mjs tests/integrations/voltagent/_helpers/*.test.mjs tests/infrastructure/telemetry*.test.mjs` must report 0 failures.
2. Every new TypeScript module must load under `node --experimental-strip-types` (or `--experimental-transform-types` for parameter properties), with its declared packages installed.
3. No full `tsc` run (8 GB machine). Use the narrow checks above.
4. A workstream is integrated only when its additions have a test that runs in the gate. Files that fail a step are not integrated.

## Baseline
- origin/main: 123 of 123 narrow tests pass.

## Merge order and result
Rule applied: where main already has a file, main's version is kept. Only new files are considered.

- W13 harness (feature/w13-harness): NOT integrated. Its fake chat provider and fake registry differ from main's; its helper smoke test (`_helpers/helpers.test.mjs`) fails against main's helpers (10 failures). Main already has an equivalent helper set.
- W12 storage (feature/w12-storage): NOT integrated. Main already holds the W12 candidate `migrations/candidates/voltagent_0001_runs_evals.sql` (#451). The branch's second candidate `voltagent_0001_schema.sql` fails main's own storage-candidates test (RLS and payload-column rules).
- W3 model (feature/w3-model): NOT integrated. `server/integrations/voltagent/model/chat-provider.ts` uses parameter properties (needs transform-types) and imports `ai`, which is not installed in this checkout. No test on main imports it.
- W1 agents (feature/w1-agents): nothing new. Both files already on main.
- W2 workflows (feature/w2-workflows): NOT integrated. `workflows/approval-step.ts` loads, but no test covers it. The gate requires a test.
- W7 telemetry (feature/w7-telemetry): NOT integrated. `receipt.ts` and `spans.ts` import `redactTelemetryAttributes` from the branch's own redact module, which main does not have.
- W4 RAG (feature/w4-rag): NOT integrated. `rag/retrieval-adapter.ts` imports `@voltagent/rag`, which is not installed in this checkout. No test covers it.
- W5, W6, W8, W9, W10, W11: no branch exists on origin. Nothing to merge.

## Open
Issue #391 stays open. The workstream modules above need their own tests, and their packages need installing, before they can be integrated.

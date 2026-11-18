# VoltAgent integration

Status: index for the VoltAgent work in `server/integrations/voltagent/`. It describes what the code does today. Where this file and the code differ, the code is right. Owner: issue #390.

## Flags

Every flag is OFF unless its environment variable is exactly `true` (`server/integrations/voltagent/flags.ts`).

| Environment variable | Flag |
| --- | --- |
| `VOLTAGENT_AGENTS_ENABLED` | agentsEnabled |
| `VOLTAGENT_WORKFLOWS_ENABLED` | workflowsEnabled |
| `VOLTAGENT_RAG_ENABLED` | ragEnabled |
| `VOLTAGENT_PGVECTOR_ENABLED` | pgvectorEnabled |
| `VOLTAGENT_RERANK_ENABLED` | rerankEnabled |
| `VOLTAGENT_TELEMETRY_ENABLED` | telemetryEnabled |
| `VOLTAGENT_EVALS_ENABLED` | evalsEnabled |
| `VOLTAGENT_MCP_ENABLED` | mcpEnabled |
| `VOLTAGENT_VOICE_ENABLED` | voiceEnabled |

Nothing mounts a route from these flags yet.

## VoltOps guard

`VOLTAGENT_PUBLIC_KEY` and `VOLTAGENT_SECRET_KEY` must be unset. `assertNoVoltOpsKeys` (`server/integrations/voltagent/guard.ts`) throws at boot if either is set.

## Modules

| Path | What it does | Mounted |
| --- | --- | --- |
| `agents/bridge.ts`, `agents/voltagent-tools.ts` | Agent bridge and tool mapping | No |
| `workflows/approval-flow.ts` | Approval suspend and resume flow | No |
| `rag/chunker.ts`, `rag/knowledge-port.ts`, `rag/vector-store.ts` | RAG chunking and ports | No |
| `vector-pg/pg-vector-store.ts`, `vector-pg/sql.ts` | pgvector store | No |
| `rerank/cohere-reranker.ts` | Cohere reranker | No |
| `model/adapter.ts` | Model adapter | No |
| `guardrails/adapter.ts`, `citations/adapter.ts`, `evals/adapter.ts`, `mcp/tools.ts`, `voice/spike.ts` | Adapters and spike code | No |

"No" means no route or boot path reaches the module. Tests cover the modules directly.

## Migrations

`migrations/candidates/voltagent_0001_runs_evals.sql` is a candidate. It is not applied.

## Licence

See `docs/mastra-attribution.md`. The licence gate is `npm run check:licence`.

## Tests

`tests/integrations/voltagent/` holds the module tests. `tests/docs/voltagent-docs.test.mjs` checks that this index lists every flag and that its links resolve.

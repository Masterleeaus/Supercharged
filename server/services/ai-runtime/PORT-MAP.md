# AI runtime port map

Source: `/home/claude/scan-gh/TitanPro`. Target: `server/services/ai-runtime/` in merged4.
Tests: `tests/services/ai-runtime.test.mjs` (55 tests, fake providers only).
Run: `cd /home/claude/work/merged4 && node --test tests/services/ai-runtime.test.mjs`

Source locations differ from the brief. The orchestrator is in `Modules/TitanCore/AI/`. Failover is in
`Modules/TitanCore/Services/`. The guardrail, retrieval, citation and evaluator are in `Modules/TitanZero/`.

Status: **Ported** = same behaviour, same concept name. **Changed** = ported with a behaviour change listed
under "Decisions". **Not ported** = left out, reason given.

## Pipeline and tools

| TitanPro source | Concept | TypeScript module | Status |
| --- | --- | --- | --- |
| `Modules/TitanCore/AI/AIOrchestratorPipeline.php` | `AIOrchestratorPipeline::run` (guardrail, retrieval, tool, citation) | `pipeline.ts` `runPipeline` | Changed (D2, D3, D4, D5) |
| `Modules/TitanCore/Contracts/AI/GuardrailContract.php` | `GuardrailContract::evaluate` | `guardrail.ts` `GuardrailContract`, `evaluateGuardrail` | Changed (D1) |
| `Modules/TitanCore/Contracts/AI/RetrievalContract.php` | `RetrievalContract::retrieve` | `pipeline.ts` `PipelineStages.retrieval` (a function, tenant passed in) | Ported |
| `Modules/TitanCore/Contracts/AI/CitationContract.php` | `CitationContract::resolve` | `pipeline.ts` `PipelineStages.citation` | Ported |
| `Modules/TitanCore/AI/ToolExecutor.php` | `ToolExecutor::execute` (allowlist, manifest, permission, validation, dry run, timeout, audit) | `tools.ts` `ToolExecutor` | Changed (D6 to D10) |
| `Modules/TitanCore/AI/ToolPermissionGate.php` | `ToolPermissionGate::allows` / `__invoke` | `tools.ts` `createToolPermissionGate` | Changed (D7) |
| `Modules/TitanCore/AI/ValueObjects/ToolResult.php` | `ToolResult` envelope | `tools.ts` `ToolResult` (`audit_ref` kept) | Ported, plus `error_code` |
| `Modules/TitanCore/AI/ToolAuditWriter.php` | audit entry fields | `tools.ts` `ToolAuditEntry` (`audit` is injected) | Ported (no storage) |
| `Modules/TitanCore/Exceptions/AI/*` (not read) | tool exceptions | `tools.ts` error codes, returned not thrown | Changed (D6) |

## Providers

| TitanPro source | Concept | TypeScript module | Status |
| --- | --- | --- | --- |
| `Modules/TitanCore/AI/ClientInterface.php` | chat / embed / health client | `contracts.ts` `ChatProviderContract`, `EmbeddingProviderContract` | Ported (interfaces only) |
| `Modules/TitanCore/Services/ProviderFailoverChain.php` | `ProviderFailoverChain`, statuses 429/500/502/503/504 | `failover.ts` `ProviderFailoverChain`, `DEFAULT_FAILOVER_STATUSES` | Changed (D11, D12) |
| (none, fail-closed default is new) | refusal when no client is configured | `contracts.ts` `DisabledChatProvider`, `DisabledEmbeddingProvider`; `index.ts` `createAiRuntime` | New |
| `Modules/TitanCore/AI/Providers/*`, `Modules/TitanCore/AI/Adapters/*`, `Modules/TitanCore/Services/TitanCoreModelGateway.php`, `Modules/TitanCore/AI/Http/HttpClientFactory.php` | HTTP clients that hold keys | not ported | Not ported: the brief forbids HTTP clients that hold keys. Real clients come later (see the open decisions in the report). |
| `Modules/TitanCore/AI/VectorStore/*` (Pgvector, Pinecone, Qdrant, Meilisearch, database) | vector search | not ported | Not ported: the path is keyword retrieval only. The store interface in `retrieval.ts` can be backed by these later. |

## Guardrails

| TitanPro source | Concept | TypeScript module | Status |
| --- | --- | --- | --- |
| `Modules/TitanZero/Services/Guardrails/BlockedTermGuardrailService.php` | `screen`, `screenInput`, `screenOutput`, `resolveTerms` | `guardrail.ts` `screenText`, `screenInput`, `screenOutput`, `resolveBlockedTerms` | Changed (D1, D13) |
| `Modules/TitanZero/DTO/GuardrailTripped.php` | `GuardrailTripped` | `guardrail.ts` `GuardrailTripped` | Ported |
| `Modules/TitanZero/Contracts/Guardrails/GuardrailHandlerInterface.php` | custom `handler_class` | `guardrail.ts` `GuardrailHandler` (injected object) | Changed (D1) |
| `Modules/TitanZero/AI/Guardrails/guardrails.json` (and the other module manifests) | blocked-term manifests | read as data by the caller, passed to `createBlockedTermGuardrail` | Ported as data |
| prompt-injection check | none in production code | not ported | Not ported: TitanPro has no production check. Its only injection terms are test fixtures (`BlockedTermGuardrailTest.php`). |
| PII check | none | not ported | Not ported: TitanPro has none. merged4 has `server/services/redaction.ts`, which is a candidate, not wired here. |
| `Modules/Budgeting/AI/Guardrails/SensitiveFinanceDataGuard.php` (not read) | finance-data guard | not ported | Not ported: outside the AI pipeline scope. |

## Retrieval and citations

| TitanPro source | Concept | TypeScript module | Status |
| --- | --- | --- | --- |
| `Modules/TitanZero/Services/Retrieval/ManifestDrivenRetrievalService.php` | term split, hit-count score, preference boost (cap 5), top-k, over-fetch x3 | `retrieval.ts` `extractTerms`, `scoreCandidate`, `rankCandidates`, `resolveTopK`, `retrieveChunks` | Changed (D14, D15) |
| `Modules/TitanZero/DTO/RetrievalResult.php` | `RetrievalResult` | `retrieval.ts` `RetrievalResult` | Ported (shape from call sites; file not read) |
| `Modules/TitanZero/Services/Citations/CitationResolver.php` | `resolveOne`, `resolveMany`, `toCitation`, `parseChunkId`, `isUrl` | `citation.ts` `parseChunkId`, `buildCitation`, `resolveCitations`, `attachCitations` | Changed (D16) |
| `Modules/TitanZero/DTO/Citation.php` | `Citation` | `citation.ts` `Citation` | Ported |
| `Modules/TitanZero/Entities/TitanZeroDocumentChunk.php`, `TitanZeroDocument.php` | Eloquent entities | not ported | Not ported: replaced by the injected `RetrievalStore` and `loadChunks` |

## Evaluator

| TitanPro source | Concept | TypeScript module | Status |
| --- | --- | --- | --- |
| `Modules/TitanZero/Evaluation/AgentEvaluator.php` | `evaluate`, `scoreTaskCompletion`, `detectHallucination`, `scoreToolAccuracy`, `compositeScore` | `evaluator.ts` (same names) | Changed (D17, D18) |
| `Modules/TitanZero/Entities/AgentEvaluationScore.php`, `Jobs/RunAgentEvaluationJob.php` | persistence and weekly job | not ported; `evaluateResponse` takes an injected `sink` | Not ported: needs a DB decision |

## Decisions (each one needs review)

- **D1 Guardrail verdict and handlers.** A verdict must be exactly `{ pass: true }`. TitanPro passes a verdict with no `pass` key. A declared handler is an injected object. TitanPro loads a class named in the manifest and fails open when the class is missing.
- **D2 Malformed or throwing guardrail blocks.** Both return a block with `guardrail_malformed_result` or `guardrail_error`.
- **D3 Tool with no executor is refused** at stage `tool`. TitanPro reports `ok: true` with no tool result.
- **D4 `ok` means nothing blocked and the tool succeeded**, not "the function returned".
- **D5 companyId is passed to every stage.** TitanPro passes context to retrieval only.
- **D6 Tool failures are returned** with `error_code`. TitanPro throws.
- **D7 Permission gate is default-deny.** Unlisted tools are denied unless named in `unrestricted`. TitanPro allows unlisted tools.
- **D8 Allowlist is required.** No `'*'` default.
- **D9 A failed input check is audited.** TitanPro throws before the audit write.
- **D10 Timeout aborts the handler's `AbortSignal` and audits once.** TitanPro writes the timeout audit twice. Its SIGALRM handler is a no-op, so a hung handler is never stopped. The handler must honour the signal.
- **D11 A thrown provider error is a transport failure** and the chain moves on. TitanPro lets it escape.
- **D12 Refusals stop the chain.** `retryable: false` stops failover whatever the status.
- **D13 Blocked-term matching is substring, not word-boundary**, as in TitanPro. A short term such as `ass` matches inside `class`. Review before any real blocklist ships.
- **D14 Retrieval has no null-tenant path.** TitanPro's `company_id = null` platform search is not ported.
- **D15 The scorer ranks every candidate it receives.** The store must filter by terms and limit without ordering by recency.
- **D16 Citation chunks are checked against the tenant.** TitanPro's resolver has no tenant check.
- **D17 Forbidden strings match values, not keys.** In TitanPro the key name `result` matches every response that has a result key. An empty forbidden string is skipped. In PHP 8, `str_contains($text, '')` is true, so TitanPro flags every response.
- **D18 Tool accuracy stays recall-only**, as in TitanPro. Extra or wrong tool calls are not penalised. Left as is, not changed.

## Known limits kept from TitanPro

- Citations attach every retrieved chunk. Nothing checks that the model's answer uses them.
- Blocked terms screen the text only, not tool params.
- The evaluator scores are heuristics (key presence, keyword match, tool-name recall). They do not measure answer quality.

# Titan Desk: capability map

Status key (four words):

- **Active** = wired into the mounted app (imported or registered by a route, middleware, or entry point that runs).
- **Tested** = has a test that exercises it, but it is not necessarily mounted.
- **Gated** = built but behind an env flag or unmounted.
- **Planned** = not built.
- **Unverified** = not confirmed by the code checked in this pass.

Kinds: **engine** = a vertical provider group with gateways (like `server/engines/payment`). **module** = a bounded feature with routes, service and storage (like `server/modules/widget`). **plugin** = an optional add-on loaded from `plugin.json` (like `plugins/titan-workforce-bridge`). **service** = a shared singleton (like `server/services/audit-log.ts`).

Each status was checked with grep against the Desk tree on 2026-11-03. Where a row mixes parts with different statuses, the note after the status gives the detail.

## 1. Platform foundations

| Capability | Kind | Status | Where / source |
|---|---|---|---|
| JWT auth, roles, team sessions | service | Active | `server/middleware/auth.ts`, `hybrid-auth.ts`, `admin-auth.ts` (imported by `server/routes.ts` and `server/routes/common.ts`) |
| Rate limiting | service | Active | `server/middleware/rateLimiter.ts` (imported by `server/routes.ts`) |
| Webhook validation and delivery | service | Active | `server/services/webhook-delivery.ts`, `webhook-retry-service.ts` (retry service used by mounted payment routes). Reprocessing is a stub for every gateway: `reprocessWebhookEvent` in `webhook-retry-service.ts` always returns `success: false` with "Reprocessing not implemented", so failed payment webhooks are retried but never reprocessed |
| Webhook replay protection | middleware | Gated | `server/middleware/webhook-replay.ts` (event id, timestamp window, in-memory duplicate check; test `tests/middleware/webhook-replay.test.mjs`). No server file imports it, so it is not mounted |
| Background queues and workers | service | Gated | `server/infrastructure/bullmq/` (Redis); initialised only when `ENABLE_BULLMQ` is set |
| Scheduler and cron | service | Active | `campaign-scheduler.ts` (imported by `routes.ts`), `phone-billing-cron.ts` (imported by `server/index.ts`). Campaign scheduler also checks `ENABLE_BULLMQ` |
| Basic audit log | service | Active | `server/services/audit-log.ts` with `audit-chain.mjs` (hash chain, test `tests/services/audit-chain.test.mjs`). Approval event types (`approval.requested`, `approved`, `rejected`, `expired`, `executed`) are defined; they are emitted from the approvals module, which `server/routes.ts` registers with `registerApprovalModule(app)` |
| Tenant scoping (`company_id`, RLS) | service | Gated | Reason: company middleware exists and is partly imported; `withTenant` is live only in the approvals tenant runner (`server/modules/approvals/index.ts`, `poolTenantRunner`, reached by the mounted `/api/approvals` routes), and no other mounted route scopes its queries with it; no live `company_id` column. `server/infrastructure/database/tenant-context.ts` (`withTenant`), `server/middleware/company-scope.ts` (`getCompanyScope` imported by CRM, template, flow automation and incoming connection routes). `company_id` columns exist only in `shared/schema.ts`, `shared/schema.js` and `migrations/DRAFT_*.sql`. RLS: Unverified |
| Correlation IDs, error handling | middleware | Active | `correlation-id.ts` (`correlationIdMiddleware` in `server/index.ts`), `errorHandler.ts` |
| Realtime (WebSocket) | service | Active | `WebSocketServer` upgrade for Twilio streams in `server/routes.ts`. Use of `server/infrastructure/websocket/connection-manager.ts`: Unverified |
| Email and notifications | service | Active | `email-service.ts` and `notification-service.ts` (imported by `server/routes.ts`) |
| Plugin loader | service | Active | `server/plugins/loader.ts` reads `plugins/*/plugin.json` (imported by `server/routes.ts`) |
| Demo mode, system update, i18n | service | Active | `system-update-service.ts` (`maintenanceMiddleware` in `server/routes.ts`). `server/demo-mode/` use: Unverified. i18n locales in `client/src/i18n/locales` |
| Metrics (Prometheus) | service | Gated | `server/services/metrics.ts` requires `prom-client` (listed in `package.json`). `server/routes/metrics-routes.ts` and `server/middleware/metrics.ts` are not imported by `server/routes.ts`, so `/metrics` is unmounted. Needs `METRICS_TOKEN` or an admin check |

## 2. Business engines and modules already in Desk

| Capability | Kind | Status | Where |
|---|---|---|---|
| Payments (Stripe, PayPal, Razorpay, Paystack, Mercado Pago, YooKassa) | engine | Active | `server/engines/payment/` (six gateway folders); routers mounted at `/api/stripe`, `/api/razorpay`, `/api/paypal`, `/api/paystack`, `/api/mercadopago`, `/api/yookassa` in `server/routes.ts` |
| Membership, plans, credits, invoices | service | Active | `membership-service.ts`, `invoice-service.ts`, `credit-service.ts`; invoice router mounted at `/api/invoices`. Credit path: Unverified |
| KYC | engine | Active | `server/engines/kyc/` (`registerKycRoutes` imported by `server/routes.ts`) |
| CRM | engine | Active | `server/engines/crm/`; `server/routes/crm-routes.ts` mounted at `/api/crm` |
| Telephony and voice agents (Plivo, Twilio + OpenAI, ElevenLabs) | engine | Active | `server/engines/plivo*`, `twilio-openai`, `elevenlabs-migration`; Plivo and Twilio stream handlers set up in `server/routes.ts` |
| Flow automation | module | Active | `server/routes/flow-automation-routes.ts` (mounted at `/api/flow-automation`), `flow-agent.ts` |
| Knowledge base and RAG | service | Active | `server/services/rag-knowledge.ts` (OpenAI embeddings and cosine search), routes mounted at `/api/rag-knowledge`. No agent memory store (see section 3) |
| Messaging (WhatsApp, email templates) | plugin | Unverified | `plugins/messaging/` holds `services/` only and has no `plugin.json`, so the loader does not load it as a plugin. Usage of its services not checked |
| Team management | plugin | Active | `server/plugins/team-management-adapter.ts` (imported by `server/routes.ts` and `crm-routes.ts`) |
| Widget | module | Active | `server/modules/widget/` (mounted under `/api` in `server/routes.ts`) |
| Chatbot (chatbots, conversations, messages) | module | Active | `server/modules/chatbot/`; `registerChatbotModule` called at `server/routes.ts` line 1711 (routes under `/api/chatbot`). Tables exist only in `migrations/DRAFT_chatbot.sql`, so requests fail until that draft is applied. Tests `tests/modules/chatbot-mount.test.mjs` (passes), `tests/modules/chatbot.test.mjs` |

## 3. AI workforce capabilities needed

| Capability | Kind | Status | Source to reuse |
|---|---|---|---|
| Policy engine (allow, deny, route to human) | engine | Active | `server/modules/approvals/policy-engine.ts`, exercised by `tests/modules/approvals-policy.test.mjs`. Called by `approval-service.ts` (`evaluatePolicy`), which the mounted approval routes use. Re-exported from `modules/approvals/index.ts`. Origin: agentgate `packages/core/src/policy-engine.ts` (MIT) |
| Approval workflow (pending, approved, rejected, expired) | module | Active | `server/modules/approvals/` (`approval-service.ts`, `approval-routes.ts`). `server/routes.ts` calls `registerApprovalModule(app)` (line 1711) from `modules/approvals/index.ts`, so the routes are mounted at `/api/approvals`. The service is reached through that index and runs on the mounted routes. Approval tables exist only in `migrations/DRAFT_approvals.sql` (no non-draft migration creates them), so the live API needs that draft applied. Origin: mcp-gateway-work `approvals.ts` (MIT) |
| Approval and audit events | service | Active | Event types in `server/services/audit-log.ts`; `approval-service.ts` emits `approval.requested` (lines 548 and 808), and that module is mounted by `server/routes.ts`. Emission for the other event types not checked. Extend `audit-log.ts` (agent under way) |
| Output redaction (secrets, PII) | service | Active | `server/services/redaction.ts` (test `tests/services/redaction.test.mjs`), wired into `audit-log.ts`. Not yet applied to agent output. Origin: mcp-gateway-work `redaction.ts` (MIT) |
| Credential vault for connectors | service | Planned | No vault module found by name or content search. Reference: mcp-gateway-work `credentials.ts` (MIT) |
| API keys for agents | service | Unverified | Client `client/src/components/api-keys` and API key references in routes exist; no agent-specific key service found. Reference: mcp-gateway-work `apiKeys.ts` (MIT) |
| Durable approval expiry and retries | service | Gated | `server/infrastructure/bullmq/jobs/approval-expiry.ts`; BullMQ needs `ENABLE_BULLMQ`; approvals module registered by `routes.ts` (see Approval workflow row). Decision: BullMQ only, no DBOS |
| Agent runtime adapter (to `services/workforce`) | plugin | Tested | `server/workforce/runtime/`, `plugins/titan-workforce-bridge/`, and `plugins/workforce-runtime/`; tests `tests/titan-workforce/adapter.test.mjs`, `tests/workforce/runtime.test.mjs`. Connection to a real runtime: Unverified |
| MCP tool gateway | engine | Planned | No MCP code in Desk; "mcp" appears only in comments and a namespace label. Reference: mcp-gateway-work (MIT) |
| Agent memory (pgvector) | engine | Planned | `server/services/ai-runtime/retrieval.ts` is keyword retrieval only. Reference: pg-agent-memory and TypeGraph (both MIT) |
| Workforce roster and task board | module | Tested | Roster: `server/workforce/catalogue/roles/` with `tests/workforce/catalogue.test.mjs`. Task board: Unverified |
| Human review inbox (approve or reject in UI) | module | Active | UI page `client/src/pages/Approvals.tsx` routed at `/app/approvals` (`client/src/App.tsx`); its approval API is mounted at `/api/approvals` by `routes.ts`. Uses the approvals module. Approval tables exist only in `migrations/DRAFT_approvals.sql`, so the live API needs that draft applied. No UI test found |
| Cockpit workforce activity feed | module | Active | `GET /api/workforce/activity` in `server/routes/cockpit-routes.ts`, mounted by `routes.ts` (line 2629). Admin or manager only. Pending approvals come from the approval service (limit 50). Runs source is empty: the response sets `runsSource: 'none'` because no stored run list exists. Test `tests/routes/cockpit-routes.test.mjs` (passes) |
| Desk-mode lookup | module | Active | `GET /api/desk-mode` in `server/routes/cockpit-routes.ts`, mounted by `routes.ts`. Reads the Host header only. Hosts come from `DEFAULT_MODE_CONFIG`. Test `tests/modules/desk-modes.test.mjs` and `tests/routes/cockpit-routes.test.mjs` (pass) |
| Campaign responses feed | module | Active | `GET /api/campaigns/responses` in `server/routes/cockpit-routes.ts`, mounted by `routes.ts`. Events source is empty: the response sets `eventsSource: 'none'`, so it returns no campaign events yet. Builder test `tests/modules/campaign-responses-feed.test.mjs` (passes) |
| Field read integration (signed API) | plugin | Tested | `server/integrations/field-link/` with `tests/integrations/field-link.test.mjs`. `plugins/titan-field-bridge` is absent; live integration not deployed |
| Data Machine WordPress bridge | plugin | Planned | `plugins/titan-zero-workforce-bridge` is absent; separate WordPress service |
| Metrics and traces | service | Gated | Same as Metrics (Prometheus) in section 1; traces not checked |
| Usage metering per company | service | Unverified | `server/services/credit-service.ts` exists; per-tenant scoping and mounted use not checked |
| Run lifecycle, status machine and handoffs | module | Active | `server/workforce/runtime/run.ts` (imported by `compose.ts`) and `team.ts` (value-imported by `run.ts`); tests `tests/workforce/run-integration.test.mjs`, `runtime.test.mjs`, `handoff-enforcement.test.mjs`, `handoff-depth-limit.test.mjs` |
| Tool registry (company, actor, schema, risk, policy, approval checks) | service | Active | `server/workforce/runtime/tool-registry.ts` (imported by `compose.ts` and `run.ts`); tests `tests/workforce/tool-registry-policy.test.mjs`, `revoked-approval.test.mjs` |
| Budget ledger and retry backoff | service | Active | `server/workforce/runtime/budgets.ts` (imported by `run.ts`); test `tests/workforce/budgets.test.mjs` |
| Pause, resume, disable and retire controls | service | Active | `server/workforce/runtime/controls.ts` (imported by `compose.ts` and `run.ts`); test `tests/workforce/controls.test.mjs` |
| Read tool handlers | service | Active | `server/workforce/tools/read-handlers.ts` (imported by `compose.ts`); test `tests/workforce/tools-read.test.mjs` |
| Approval gate adapter and policy evaluator | service | Active | `server/modules/approvals/approval-gate-adapter.ts` and `policy-evaluator.ts` (imported by `compose.ts`); tests `tests/modules/approval-gate-adapter.test.mjs`, `policy-evaluator.test.mjs`, `predictive-tier.test.mjs` |
| Workforce health handler | service | Active | `server/workforce/runtime/health.ts` (imported by `routes.ts`, mounted at `/api/workforce/health`). No direct test |
| Workforce admin router | module | Active | `server/workforce/runtime/workforce-admin-routes.ts` (mounted by `routes.ts`); test `tests/workforce/workforce-admin-routes.test.mjs`. Not listed in `docs/WORKFORCE_MODULES.md` |
| Catalogue startup load | service | Active | `server/workforce/catalogue/startup.ts` (`loadCatalogueAtStartup`, imported by `routes.ts`); test `tests/workforce/catalogue-startup.test.mjs` |
| Catalogue loader and role files | module | Gated | `server/workforce/catalogue/loader.ts`, reached through `startup.ts`, plus the role files in `roles/` that it loads; tests `tests/workforce/catalogue-loader.test.mjs` and `roles-*.test.mjs` |
| Catalogue validation, role schema | service | Unverified | `catalogue/validate.ts` and `role.schema.ts`: no direct importer found by grep in this pass (`role.schema.ts` is imported by `roster.ts` and `pg-roster.ts`); the wiring in `WORKFORCE_MODULES.md` is not confirmed |
| Prompt version hashes | service | Gated | `server/workforce/catalogue/prompt-version.ts`; `run.ts` mentions it only in a comment, so no import; test `tests/workforce/prompt-version.test.mjs` |
| Freshness and idempotency checks | service | Gated | `freshness.ts` and `idempotency.ts` in `server/workforce/runtime/`, imported by `tool-registry.ts` rather than by the entry points; tests `freshness.test.mjs`, `idempotency.test.mjs`. `WORKFORCE_MODULES.md` lists both as NOT WIRED |
| Human review inbox logic | module | Gated | `server/workforce/runtime/review-inbox.ts`, imported by `workforce-admin-routes.ts`; test `tests/workforce/review-inbox.test.mjs`. `WORKFORCE_MODULES.md` lists it as NOT WIRED |
| Run store and Postgres persistence | service | Gated | `store.ts` (type-only imports, no runtime importer); `pg-store.ts` (imported only by `pg-budgets.ts`) and `pg-budgets.ts`; tests `tests/workforce/pg-store.test.mjs`, `pg-budgets.test.mjs`. Not applied to any database per their headers |
| Log and prompt redaction (workforce) | service | Gated | `server/workforce/runtime/redact.ts`, imported only by `pg-store.ts`; test `tests/workforce/redact.test.mjs` |
| Scheduler for once and recurring work | service | Gated | `server/workforce/runtime/scheduler.ts`; no importer found; test `tests/workforce/scheduler.test.mjs` |
| Citation check for recommendations | service | Gated | `server/workforce/runtime/citations.ts`; no importer found; test `tests/workforce/citations.test.mjs`. Separate from `server/services/ai-runtime/citation.ts` |
| Agent, task and run status views | module | Gated | `agent-view.ts`, `task-view.ts`, `run-status-view.ts` in `server/workforce/runtime/`; no entry-point importer (`run-status-view.ts` is imported only by `agent-view.ts`); tests exist for each |
| Workforce metrics counters | service | Gated | `server/workforce/runtime/workforce-metrics.ts`; no importer found; test `tests/workforce/workforce-metrics.test.mjs`. Separate from Metrics (Prometheus) |
| Tool call simulator (dry run) | service | Gated | `server/workforce/tools/simulator.ts`; no importer found; test `tests/workforce/tool-simulator.test.mjs` |
| Authority ladder | service | Gated | `server/modules/approvals/authority-ladder.ts`, imported by `tool-registry.ts` and `policy-evaluator.ts`; tests `tests/modules/authority-ladder.test.mjs` |
| Approval view, company policy and decision signing | service | Gated | `approval-view.ts` and `company-policy.ts` (no importer found; tests `tests/modules/approval-view.test.mjs`, `company-policy.test.mjs`); `approval-signing.ts` (imported only by `approval-service.ts`) |
| Approval schema and types | module | Unverified | `server/modules/approvals/schema.ts` and `types.ts`: no importer found by grep in this pass; `WORKFORCE_MODULES.md` describes them as draft and type-only |

## 4. Templates

| Template | Status | Where |
|---|---|---|
| Plugin (`plugins/_template/`) | Planned | Directory absent |
| Module (`server/modules/_template/`) | Tested | Directory present; `tests/templates/templates.test.mjs` references `_template` |
| Engine (`server/engines/_template/`) | Tested | Directory present; `tests/templates/engine-template.test.mjs` |

## 5. Known gaps before this list is complete

- `company_id` columns exist only in `shared/schema.ts`, `shared/schema.js` and `migrations/DRAFT_*.sql`, not in a live database. `withTenant` is called live only by the approvals tenant runner, so the company middleware alone does not scope the other queries. Row-level isolation (RLS) and the draft companies migrations still need checking before tenancy is called complete.
- No MCP gateway in Desk. The metrics route is built but not mounted. An agent runtime adapter exists in `server/workforce/runtime/`, but its link to a real `services/workforce` runtime is Unverified.
- The live Field integration is not deployed (`plugins/titan-field-bridge` is absent), so Field reads are not yet possible from Desk.
- Whether `services/workforce` is in any zip is Unverified (not checked in this pass).

## Comms modules built in memory (added 2026-11-03)

| Capability | Kind | Status | Evidence |
|---|---|---|---|
| Messaging consent, quiet hours and opt-out keywords | module | Gated | `server/modules/comms/consent.ts`; tests `tests/modules/consent.test.mjs` (23 pass). Not called by any send path yet. |
| Approved-template rendering for customer messages | module | Gated | `server/modules/comms/template-rules.ts`; tests `tests/modules/template-rules.test.mjs` (22 pass). Not used by any send path yet. |
| Reply threading | module | Gated | `server/modules/comms/thread-match.ts`; tests `tests/modules/thread-match.test.mjs` (17 pass). Not connected to ingestion. |
| Duplicate contact detection | module | Gated | `server/modules/comms/contact-dedupe.ts`; tests `tests/modules/contact-dedupe.test.mjs` (12 pass). |
| Email send transport through an injected sender | module | Gated | `server/modules/comms/email-send-transport.ts` and `email-campaign-adapter.ts`; 13 tests pass. The real sender is not connected. |

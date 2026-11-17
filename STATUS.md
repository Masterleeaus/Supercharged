# Desk module status

Date: 15 November 2026. Refreshed from code reads and grep against origin/main at 41d034a. Nothing was run, built, installed or type-checked.

This file is the single source of truth for what is live, mounted, fail-closed or draft in this bundle. It must be kept in step with the code. When a mount, env flag, migration or gate changes, update the matching line here in the same change. Where this file and the code disagree, the code is right and this file is wrong. Claims marked UNVERIFIED were not confirmed in code.

Status labels used below:
- LIVE: mounted or imported by live code, with no mount-level gate.
- MOUNTED, FAIL-CLOSED: mounted, but a flag, a readiness check or a missing dependency makes it refuse.
- DRAFT: depends on a migration in migrations/DRAFT_*.sql that is not promoted.
- NOT MOUNTED: nothing in routes.ts or the modules it calls reaches it.

Readiness labels. Each claim bullet starts with one label:
- [verified]: read in this repo at the commit above. The line cited was checked on 15 November 2026.
- [untested]: not run, or not confirmed in this repo.

Line numbers. `server/routes.ts` is now 218 lines and mostly calls register functions. The cites below point to the file that holds each mount. The old routes.ts line numbers (for example 1743, 2717, 2723) are gone and must not be used.

COMMS flags are NO-GO. Per docs/records/COMMS-FLAGS-GO-LIVE-REVIEW.md, both `COMMS_INBOX_ENABLED` and `COMMS_MARKETING_ENABLED` must stay off in production, and `COMMS_CAMPAIGNS_ENABLED` must stay unset. That review is on branch docs/comms-go-live-review (commit c8c2ec8) and is not on main yet. Its base was 749b7bb, not the current main.

## Modules in server/modules (11 folders, _template excluded)

- [verified] agent-embed: NOT MOUNTED. No file outside its own folder imports it. server/modules/desk-modes/mode-modules.ts lists it by name only. No env flag and no migration. Needs wiring before it can run.
- [verified] approvals: DRAFT, MOUNTED. registerApprovalModule is called at server/routes/core/chatbot-wiring-routes.ts:55 (/api/approvals), and that file is called from server/routes.ts:173. The mount is not flag-gated. Its tables come only from migrations/archive/DRAFT_approvals.sql, DRAFT_approvals_one_pending.sql and DRAFT_approvals_resubmit_guard.sql, and none is promoted. Whether the live database has the tables is UNVERIFIED.
- [verified] booking-agent: NOT MOUNTED. No file outside its own folder and its tests imports it. A comment in server/modules/chatbot/bookings/availability.ts:21 names it. No env flag and no draft migration.
- [verified] campaigns: MOUNTED, FAIL-CLOSED, under /api/comms, only when COMMS_CAMPAIGNS_ENABLED is on. The flag is read at server/routes/core/workforce-comms-routes.ts:97 with a default of off, and the mount is at lines 99 to 115. The flag accepts 1, true, yes or on. Approvals and transport are `commsNotConfigured`, which throws, at lines 73 to 77. Every method in server/modules/campaigns/drizzle-adapter.ts goes through `notReady`, so the store refuses. Turning it on needs DRAFT_campaigns.sql promoted, which is blocked by a table-name clash (see open decisions), and real approval and transport ports, which do not exist. Do not set the flag (NO-GO).
- [verified] chatbot: DRAFT, MOUNTED. registerChatbotModule is called at server/routes/core/chatbot-wiring-routes.ts:54 and that file is called from server/routes.ts:173. The mount is not flag-gated. Tables come only from migrations/archive/DRAFT_chatbot.sql, which is not promoted. A comment at chatbot-wiring-routes.ts:21 to 23 says the wiring mounts before the core chatbot route. Whether requests fail until the draft is applied is [untested].
- [verified] comms: PARTLY MOUNTED. The audit sink is created at server/routes.ts:39 to 41. The suppression list is imported at server/routes/core/workforce-comms-routes.ts:17 and used by the campaign mount at line 111. The channel inbound and webhook files (sms, email, meta, telegram, whatsapp) have no importers in server routes, so they are not mounted. Its table draft is migrations/archive/DRAFT_comms_company_id.sql, not promoted. No env flag of its own. Suppression is held in memory (server/modules/comms/suppression.ts, per the NO-GO review); durability is [untested] here.
- [untested] desk-modes: LIVE as a guard. deskModeMiddleware is in the campaign chain at workforce-comms-routes.ts:105 and in the inbox and marketing chain at server/routes/core/optional-comms-routes.ts:25. Always on, no flag. The claim that an unknown host gets 404 (modules/desk-modes/mode-middleware.ts) is [untested]. The campaign chain uses DEFAULT_MODE_CONFIG from server/routes/cockpit-routes.ts; its contents are [untested].
- [verified] inbox: MOUNTED, FAIL-CLOSED, under /api/comms/inbox. It is off unless COMMS_INBOX_ENABLED is exactly `true` (server/routes/core/verified-marketing-routes.ts:33, optional-comms-routes.ts:18). The chain is: server/routes.ts:200 calls registerWorkforceCommsRoutes, which calls registerVerifiedCommsRoutes at workforce-comms-routes.ts:64. With the flag on, verified-marketing-routes.ts:46 builds the SQL inbox service and checks the schema first. optional-comms-routes.ts:34 then mounts the router behind deskModeMiddleware, authenticate, requireCompanyScope and an actor check. With the flag off, no inbox service is built and nothing mounts.
  - [verified] The readiness check requires row-level security to be ENABLED and FORCED on the inbox tables (server/modules/inbox/schema-readiness.ts:28). Startup should throw if it is not (production-service.ts:26). The throw itself is [untested].
  - [verified] The schema is not promoted. DRAFT_inbox.sql is in migrations/archive/. The RLS and outbox candidates are migrations/candidates/0018_inbox_tenant_rls.sql, 0019_inbox_outbox.sql, 0020_inbox_delivery_receipts.sql and 0021_inbox_delivery_state.sql.
  - [untested] Staff sends bypass the suppression, consent, opt-out and quiet-hours checks, and no outbound transport is wired. These are blockers in the NO-GO review. Which of migrations/0011_inbox_channels_and_providers.sql and the DRAFT inbox tables is live is UNVERIFIED.
  - Decision: NO-GO. Keep the flag off.
- [verified] marketing: MOUNTED, FAIL-CLOSED, under /api/comms/marketing. It is off unless COMMS_MARKETING_ENABLED is exactly `true` (verified-marketing-routes.ts:32). The chain is the same as inbox. verified-marketing-routes.ts:38 builds the marketing service only with the flag on, and production-service.ts:22 checks the schema. The service needs a campaign reference adapter (production-service.ts:18). Without a real one, verified-marketing-routes.ts:43 passes `unavailableCampaignReferences()`, so campaign links are refused. optional-comms-routes.ts:36 mounts the router.
  - [verified] Tables come only from migrations/archive/DRAFT_marketing.sql (landing_pages and content_items), which is not promoted. The RLS candidate is migrations/candidates/0017_marketing_tenant_rls.sql.
  - [untested] Publication routes can publish pages. The NO-GO review says there is no marketing send path, and that the drizzle marketing adapter is a placeholder.
  - Decision: NO-GO. Keep the flag off.
- [untested] settings: LIVE, used only through the /api/comms campaign mount. company-settings.ts is imported at workforce-comms-routes.ts:14 and used at line 111. A comment at workforce-comms-routes.ts:72 says settings are held in memory, so they are not persisted. Persistence is [untested]. No flag.
- [verified] widget: LIVE. Public widget routes are mounted under /api/public at server/routes/core/crm-public-routes.ts:20, and widgetRoutes are mounted under /api behind hybridGateUnlessExempt at server/routes/core/stream-widget-routes.ts:47. No flag.

## Engines in server/engines (10 folders, _template excluded)

- [untested] crm: LIVE through imports from server/index.ts, services/call-sync.ts and routes/webhook-routes.ts. No separate mount. No flag.
- [verified] decision: NOT MOUNTED. Its only importers are the decision-adapter test and server/engines/payment/contract.ts.
- [untested] elevenlabs-migration: LIVE through imports from live routes and services. No separate mount. No flag.
- [verified] interaction: NOT MOUNTED. No file in server/ imports it. The offline code is not mounted, per DELIVERABLE.md.
- [verified] kyc: LIVE. registerKycRoutes is called at server/routes/core/voice-engine-routes.ts:49 with requireAuth and requireAdmin. That file is called from server/routes.ts:140. No flag.
- [verified] payment: LIVE for the gateway routers. server/routes/core/payment-routes.ts mounts /api/stripe (line 6), /api/razorpay (9), /api/paypal (12), /api/paystack (15), /api/mercadopago (18) and /api/yookassa (21). That file is called from server/routes.ts:164. The routers come from server/engines/payment. Whether the gateway routers reach the engine core (engine.ts, verifiers.ts, idempotency.ts, contract.ts) indirectly is [untested]. Each gateway checks its own database-level enable (per the A9 review, [untested] in code). Stripe with no webhook secret returns 403, not 503 (see open decisions).
- [verified] plivo: LIVE. createPlivoApiRoutes is mounted at server/routes/core/voice-engine-routes.ts:20, setupPlivoWebhooks at line 25, and the stuck-calls scheduler starts at lines 29 to 30. No env flag in code. Needs Plivo credentials at runtime (names UNVERIFIED).
- [verified] plivo-elevenlabs: LIVE. initPlivoElevenLabsEngine is called at server/routes/core/voice-engine-routes.ts:39. No env flag in code. The SIP webhook signing question is open (see open decisions).
- [verified] trust: NOT MOUNTED. Only tests import it (tests/engines/trust-readiness.test.mjs). The readiness evaluator is not mounted, per DELIVERABLE.md.
- [verified] twilio-openai: LIVE. The /api/twilio-openai webhook routes are mounted at server/routes/core/voice-engine-routes.ts:44, incoming connections behind requireAuth at line 45, and the stream handler is set up at server/routes.ts:215. No env flag in code.

## Other mounts outside those folders

- [verified] Titan Field bridge: MOUNTED, FAIL-CLOSED. server/routes/core/platform-routes.ts:48 mounts it with no ports passed. It returns 503 bridge_not_enabled unless TITAN_FIELD_BRIDGE_MODE is `shadow` (server/integrations/titan-field/route.ts:86 to 88). Even in shadow mode, server/integrations/titan-field/receiver.mjs:21 returns 503 identity_or_ledger_not_configured when no ports are supplied. The ports belong to the database integration owner and are not built.
- [verified] Titan local link: MOUNTED, FAIL-CLOSED, at server/routes/core/platform-routes.ts:50. It returns 503 unless TITAN_LOCAL_LINK_ENABLED is `1` (server/integrations/titan-field/local-link-route.ts:11).
- [untested] Workforce course training: NOT WIRED. Modules under server/workforce/courses/: ingest/loader.ts (builds lesson revisions from the curriculum; 896 revisions, 121 skipped), store/ (in-memory revision store and search port), register.ts (seven course assistant roles), and knowledge/policy.ts. Nothing calls them at boot or in a route. Flags: WORKFORCE_COURSE_ASSISTANTS (default OFF, register.ts) and WORKFORCE_INTERNAL_DRAFT_COURSES (default OFF, policy.ts). The draft flag is set to 1 only in the dev script in package.json. All 896 revisions are DRAFT, so nothing is retrievable unless that flag is on. Table draft: migrations/archive/DRAFT_course_knowledge.sql, not promoted.
- [verified] Workforce runtime: LIVE. Catalogue and runtime start at boot at server/routes/core/workforce-comms-routes.ts:29 and 30. The health route is at line 31. Admin write routes return 503 with no catalogue (comment at lines 32 to 34, runtime [untested]). The in-memory roster is built at lines 53 to 60. No env flag in code.
- [verified] RAG knowledge: LIVE, mounted at /api/rag-knowledge by server/routes/core/integration-routes.ts:15 with no flag check. That file is called from server/routes.ts:182. USE_RAG_KNOWLEDGE only gates the ElevenLabs tool wiring (server/services/rag-elevenlabs-tool.ts:233 to 235), and it is on when the variable is unset.
- [verified] Migrate call user ids: the 501 stub answers first. server/routes/admin-routes.ts:62 registers calls-moderation, which registers POST /migrate-call-user-ids at server/routes/admin/calls-moderation-routes.ts:425 using the stub at calls-user-id-migration-stub.ts:10. The admin router is mounted at /api/admin from server/routes.ts:167. The real handler at server/routes/core/admin-campaign-routes.ts:88 is registered later, from server/routes.ts:203, so it is shadowed for the same path. Whether any script calls the endpoint is [untested].

## Draft migrations

[untested] Promotion check: the 25 DRAFT_*.sql files are in migrations/archive/ (counted on 15 November 2026). None is at the top level of migrations/. The earlier byte-for-byte comparison was not repeated in this refresh. The list below is what each draft is for. Every line says "not promoted".

- DRAFT_action_ledger.sql: action ledger table (public.action_ledger). Not promoted. Consumers UNVERIFIED.
- DRAFT_approvals.sql: approval_rules and approvals tables. Not promoted. Migration 0013 depends on it.
- DRAFT_approvals_one_pending.sql: one pending approval per source. Not promoted. Has a guard.
- DRAFT_approvals_resubmit_guard.sql: resubmit unique index. Not promoted.
- DRAFT_audit_chain.sql: no CREATE statement found by grep. Not promoted. Contents UNVERIFIED.
- DRAFT_campaign_send_queue.sql: campaign_send_jobs and its idempotency index. Not promoted. Has a guard.
- DRAFT_campaigns.sql: seven campaign tables. Not promoted. Do not promote until the name clash with the legacy campaigns table is decided.
- DRAFT_chatbot.sql: chatbots, chatbot_conversations and chatbot_messages. Not promoted.
- DRAFT_comms_company_id.sql: comms audit, saved replies, segments, suppressions and company_id on contacts. Not promoted. Has two guards.
- DRAFT_companies_foundation.sql: companies and related agent, appointment and audit tables. Not promoted.
- DRAFT_company_scope.sql: company_id scoping across many tables. Not promoted. Has many guards.
- DRAFT_company_scope_extension.sql: company scope for chatbot and workforce tables. Not promoted. Has three guards.
- DRAFT_credential_encryption_backfill.sql: credential encryption backfill. Not promoted. Has a guard.
- DRAFT_inbox.sql: inbox threads, messages, participants and the dedupe index. Not promoted. The inbox router is flag-gated (see the inbox entry).
- DRAFT_knowledge_base_company_backfill.sql: knowledge base company backfill. Not promoted.
- DRAFT_marketing.sql: content_items and landing_pages. Not promoted. The marketing router is flag-gated (see the marketing entry).
- DRAFT_shadow_changes.sql: shadow_changes table. Not promoted. Has three guards.
- DRAFT_webhook_delivery_status.sql: webhook_logs table. Not promoted.
- DRAFT_workforce_agents.sql: workforce_agents table. Not promoted. Until it is promoted the roster is in memory (server/routes/core/workforce-comms-routes.ts:53 to 60).
- DRAFT_workforce_append_only.sql: append-only protection for workforce tables. Not promoted. Has a guard.
- DRAFT_workforce_budgets.sql: workforce_budget_usage table. Not promoted.
- DRAFT_workforce_control_state.sql: workforce_control_state table. Not promoted. Has three guards.
- DRAFT_workforce_runs.sql: workforce runs, tasks, tool calls and audit events. Not promoted.
- DRAFT_workforce_tier_migration.sql: workforce tier migration. Not promoted.

Numbered migrations and runner facts:
- [untested] The numbered files present are 0000 to 0007, 0010, 0011 and 0013, plus 0001_add_missing_columns.sql and an unnumbered add_missing_columns.sql.
- [untested] migrations/meta/_journal.json lists only 0000 to 0006. Its 0006 tag (0006_cultured_purifiers) does not match the file name 0006_add_default_campaign_type.sql.
- [untested] The safe runner, scripts/run-safe-migration.mjs at lines 53 to 62, names 0001 to 0007, 008, 009 and 0010. Files 008 and 009 do not exist in migrations/. The runner does not name 0011 or 0013. Which set a live database runs is UNVERIFIED.
- [untested] Migration 0013 stops with an error if the approvals table is missing, so DRAFT_approvals.sql must be applied before it.

## Open decisions

Each item below is in TODO_CHECKLIST.md unless marked NEW. The checklist is at /home/claude/desk-review-notes/TODO_CHECKLIST.md.

- Migration endpoint: the checklist records the decision to delete the dead handler. The row count on each live database is not yet recorded, and the delete patch is not applied (section "Migration endpoint"). The A1 review is at /home/claude/desk-review-notes/agents/A1/report.md.
- Module flags: the checklist says existing live paths default to on and new modules default to off (section "Module flags"). The A9 plan (agents/A9/enable-flags.md) sets Plivo, Twilio, payments, invoices, chatbot and widget to OFF by default. That conflicts with the checklist decision, so the plan needs revising before it is applied. No flag names exist in code yet, apart from the COMMS flags and the others listed under Not verified.
- Campaigns: rename the new campaigns table or plan a merge with the legacy table (section "Campaigns"). The collision is real, because shared/schema.ts:327 defines the legacy campaigns table (A4 risk 1, and the header added to DRAFT_campaigns.sql by F2).
- Campaign recipient key: F2 keyed the send-job uniqueness on contact_id. The owner may prefer the address key instead. NEW, not in the checklist.
- Campaign opt-in uniqueness and job idempotency: A4 risks 2 to 4 (partial unique index on active opt-ins, and composite FKs for jobs). Partly addressed by F2. NEW, not in the checklist.
- COMMS flags: both inbox and marketing are NO-GO (docs/records/COMMS-FLAGS-GO-LIVE-REVIEW.md, on branch docs/comms-go-live-review). That review says the owner reported turning both on in production. Confirm the production values and the startup logs. NEW.
- Bridge stuck claims: release the pending claim when recording fails (section "Bridge: stuck claims"). The A6 recovery path is in agents/A6/ports-spec.md.
- Inbox: build the service per request, bound to the company (section "Inbox").
- Field SMS routing: parked until the owner uploads the webhook route file (section "Field SMS routing").
- SMS binding: review agents/A5/binding-draft.sql, then make it a migration (section "SMS binding").
- Owner actions before deploy: set STRIPE_WEBHOOK_SECRET, YooKassa shop credentials, WEBHOOK_TOKEN and a new STRIPE_SECRET_KEY; confirm ElevenLabs signs SIP webhooks; set the proxy to pass the real client IP (TRUST_PROXY is read in server/index.ts:82); seed workforce.previews.create; decide the held patches SEC-06 and play-audio HMAC; approve the billing and timezone rules; decide the journal gaps 0008, 0009 and 0012 and the foundation drafts (section "Before any deploy").
- Root configs: the checklist says to restore drizzle.config.ts, tsconfig.json and vite.config.ts. tsconfig.json and vite.config.ts are present at the bundle root. drizzle.config.ts is missing. The checklist item needs narrowing. NEW.
- Migration runner list: the runner names 008 and 009 with no matching files, and omits 0011 and 0013. Decide the correct list before any run. NEW, and it extends the journal gap item above.
- Corrections needed in other files, not made here: DELIVERABLE.md says Stripe returns 503 with no secret, but stripe-routes.ts returns 403 (the 503 at line 575 is for a full replay guard). DELIVERABLE.md says the workforce preview gate needs seeding, but the string workforce.previews.create does not appear anywhere in server/ (see Not verified). NEW.
- Upgrades: define one canonical tenant ID and an alias table for Field and Desk (section "Upgrades"). Sign off on the rollback plan (agents/A10/rollback-plan.md).

## Not verified

- [untested] Which migrations are applied on any live database, and whether the approvals, chatbot, comms, inbox, campaigns and workforce tables exist.
- [untested] Production environment variables, and whether any flag is set. Env names that appear in code include TITAN_FIELD_BRIDGE_MODE, TITAN_LOCAL_LINK_ENABLED, USE_RAG_KNOWLEDGE, STRIPE_WEBHOOK_SECRET, WEBHOOK_TOKEN, COMMS_INBOX_ENABLED, COMMS_MARKETING_ENABLED and COMMS_CAMPAIGNS_ENABLED.
- [untested] Runtime behaviour of every gate in this file. No server was started and no request was sent. This includes whether startup throws when the inbox or marketing schema check fails.
- [untested] Whether the route order described in agents/A1/report.md behaves as stated, including its infinite-loop claim, which was inferred from reading code and not reproduced.
- [untested] Whether the chatbot requests fail until its draft is applied.
- [untested] SEC-02 (ElevenLabs webhook): the file exists but the fail-closed behaviour was not read.
- [untested] SEC-04: requireAdminPermission is used, but the runtime check with a team token was not run.
- [untested] SEC-09 and SEC-10: authRateLimiter is on the OTP routes (routes/auth-routes.ts:48, 100, 159, 211) and on /api/contact (routes/public-routes.ts:975), and strictRateLimiter is on audio delete (routes/audio-routes.ts:82). The limits were not exercised.
- [untested] SEC-11: audio delete checks ownership through audio-ownership.mjs. The owner check was not read in full.
- [untested] CORE-03: the plugin loader sets registered to false by default and to true only for externally registered plugins (plugins/loader.ts:193 and 203 to 206). The rest of that function was not read.
- [untested] Workforce D1 and D2 gates: the workforce ports and the preview gate could not be confirmed. The string workforce.previews.create is not in server/.
- [untested] Whether the gateway routers reach the payment engine core indirectly.
- [untested] Whether ElevenLabs RAG tool is on in production, and whether any scheduled job or script calls the migrate endpoint.
- [untested] The Field side. Its receiver and reminder projector files are not in this bundle. Per agents/A6/reminder-columns.md, none of the 22 cited Field columns is defined in shared/schema.ts, and the Field ai_fsm schema is not in the bundle.
- [untested] The 871-test figure, and which tests fail. No test run was done for this bundle. A4 ran three campaign test files in a scratch copy only (50 of 50 passed). The comms mount tests (tests/integration/optional-comms-mount.test.mjs and related) were not run.
- [untested] TypeScript: tsc was not run and node_modules is absent, so type correctness is UNVERIFIED.
- [untested] Whether the A9 flag plan or the A1 delete patch has been applied to the live code. The checklist says neither has been.

## VoltAgent integration (branch voltagent/integration)

Date: 18 November 2026. Phase 0 only. Nothing is mounted and no flag is on.

- [verified] Foundation pins added: seven @voltagent packages at exact versions, npm install run clean. Node engine set to >=22.13.0. One side effect: transitive @opentelemetry/api moved 1.10.0 to 1.9.1 (see the fixes checklist).
- [verified] VoltOps guard: assertNoVoltOpsKeys throws if VOLTAGENT_PUBLIC_KEY or VOLTAGENT_SECRET_KEY is set. Wired as the first call in server/index.ts. Boot itself was not run, so the wiring is [untested] at boot.
- [verified] Flag scaffold: nine VOLTAGENT_* flags, all OFF by default, nothing mounted. Tests pass.
- [verified] Licence gate: scripts/check-voltagent-licence.mjs, run as npm run check:licence. Passes with no /ee/ paths and no @mastra imports.

# Desk module status

Date: 8 November 2026. Written from code reads and grep only. Nothing was run, built, installed or type-checked.

This file is the single source of truth for what is live, mounted, fail-closed or draft in this bundle. It must be kept in step with the code. When a mount, env flag, migration or gate changes, update the matching line here in the same change. Where this file and the code disagree, the code is right and this file is wrong. Claims marked UNVERIFIED were not confirmed in code.

Status labels used below:
- LIVE: mounted or imported by live code, with no mount-level gate.
- MOUNTED, FAIL-CLOSED: mounted, but a gate or missing dependency makes it refuse.
- DRAFT: depends on a migration in migrations/DRAFT_*.sql that is not promoted.
- NOT MOUNTED: nothing in routes.ts or index.ts reaches it.

## Modules in server/modules (11 folders, _template excluded)

- agent-embed: NOT MOUNTED. Nothing imports it. No env flag and no migration. Needs wiring before it can run.
- approvals: DRAFT, mounted at server/routes.ts:1743 (registerApprovalModule). Its tables come only from migrations/DRAFT_approvals.sql, DRAFT_approvals_one_pending.sql and DRAFT_approvals_resubmit_guard.sql, and none of them is promoted. Turn on by promoting those drafts. Whether the live database has the tables is UNVERIFIED.
- booking-agent: NOT MOUNTED. Only tests import it. No env flag and no draft migration.
- campaigns: MOUNTED, FAIL-CLOSED, at server/routes.ts:2717 under /api/comms (the desk-mode guard is at 2723). Every store method in modules/campaigns/drizzle-adapter.ts calls notReady and throws. Approvals and transport are commsNotConfigured and throw (routes.ts:2695 to 2699), so nothing can be approved or sent. Turn on needs DRAFT_campaigns.sql promoted, which is blocked by a table-name clash (see open decisions), and real approval and transport ports, which do not exist. Flag COMMS_CAMPAIGNS_ENABLED (default OFF, routes.ts:2719): the mount is skipped unless it is set to 1.
- chatbot: DRAFT, MOUNTED at server/routes.ts:1742 (registerChatbotModule). Tables come only from migrations/DRAFT_chatbot.sql, which is not promoted. A comment at routes.ts:1740 says requests fail until the draft is applied; the runtime result is UNVERIFIED.
- comms: PARTLY MOUNTED. Its suppression list and audit sink are imported at server/routes.ts:149 and 150 and used by the /api/comms campaign mount. One Plivo webhook file imports from it. The channel inbound and webhook files (sms, email, meta, telegram, whatsapp) are not imported by routes.ts, so they are not mounted. Its table draft is migrations/DRAFT_comms_company_id.sql, not promoted. No env flag.
- desk-modes: LIVE and fail-closed as a guard. deskModeMiddleware at server/routes.ts:2723 sits inside the /api/comms chain. An unknown host gets 404 (modules/desk-modes/mode-middleware.ts). Always on, no flag. The host list is DEFAULT_MODE_CONFIG in server/routes/cockpit-routes.ts; its contents are UNVERIFIED.
- inbox: NOT MOUNTED. Neither routes.ts nor index.ts imports it. Turn on by promoting migrations/DRAFT_inbox.sql and wiring the router. Note that migrations/0011_inbox_channels_and_providers.sql also changes inbox tables and names the same inbox_messages_external_uidx index. Which of the two is live is UNVERIFIED.
- marketing: NOT MOUNTED. Neither routes.ts nor index.ts imports it. Turn on by promoting migrations/DRAFT_marketing.sql and wiring the router.
- settings: LIVE, used only through the /api/comms mount (company-settings.ts is imported at routes.ts:148). Settings are held in memory, as the comment at routes.ts:2694 says, so they are not persisted. No flag.
- widget: LIVE. Public widget routes at server/routes.ts:1755 under /api/public, and widgetRoutes at routes.ts:1793 under /api behind hybridGateUnlessExempt. No flag.

## Engines in server/engines (10 folders, _template excluded)

- crm: LIVE through imports from server/index.ts, services/call-sync.ts and routes/webhook-routes.ts. No separate mount. No flag.
- decision: NOT MOUNTED. Only the decision-adapter test and payment/contract.ts import it, and the DELIVERABLE says only tests use contract.ts (UNVERIFIED for the rest). No flag.
- elevenlabs-migration: LIVE through imports from live routes and services (server/index.ts, routes/webhook-routes.ts, services/campaign-executor.ts and others). No separate mount. No flag.
- interaction: NOT MOUNTED. Only tests import its adapter. The offline code is not mounted, per DELIVERABLE.md.
- kyc: LIVE. registerKycRoutes at server/routes.ts:319, with authenticateToken and checkAdmin. No flag.
- payment: LIVE for the gateway routers, and the engine core is not used. The routes mount stripe (routes.ts:1638), razorpay (1641), paypal (1644), paystack (1647), mercadopago (1650) and yookassa (1653). Each gateway checks its own database-level enable, per the A9 review (UNVERIFIED in code). The core files engine.ts, verifiers.ts, idempotency.ts and contract.ts are not imported by routes.ts (routes.ts:70 to 77 imports only the routers and PAYMENT_ENGINE_VERSION). Whether the gateway routers reach them indirectly is UNVERIFIED. Stripe fails closed with no webhook secret, but with 403, not 503 (see open decisions).
- plivo: LIVE. createPlivoApiRoutes at server/routes.ts:286, setupPlivoWebhooks at 291, stuck-calls scheduler at 296. No env flag in code. Needs Plivo credentials at runtime (UNVERIFIED names).
- plivo-elevenlabs: LIVE. initPlivoElevenLabsEngine at server/routes.ts:305. No env flag in code. The SIP webhook signing question is open (see open decisions).
- trust: NOT MOUNTED. Only tests import it. The readiness evaluator is not mounted, per DELIVERABLE.md.
- twilio-openai: LIVE. The /api/twilio-openai webhook routes at server/routes.ts:310, incoming connections behind authenticateToken at 312, and the stream handler at 2953. No env flag in code.

## Other mounts outside those folders

- Titan Field bridge: MOUNTED, FAIL-CLOSED, at server/routes.ts:255 with no ports passed. It returns 503 bridge_not_enabled unless TITAN_FIELD_BRIDGE_MODE is set to shadow (integrations/titan-field/route.ts:86 to 88). Even in shadow mode it returns 503 identity_or_ledger_not_configured, because no ports are passed (receiver.mjs:21). The ports belong to the database integration owner and are not built.
- Titan local link: MOUNTED, FAIL-CLOSED, at server/routes.ts:257. It returns 503 unless TITAN_LOCAL_LINK_ENABLED is 1 (local-link-route.ts:11).
- Workforce course training: NOT WIRED. Modules under server/workforce/courses/: ingest/loader.ts (builds lesson revisions from the curriculum; 896 revisions, 121 skipped), store/ (in-memory revision store and search port), register.ts (seven course assistant roles), and knowledge/policy.ts. Nothing calls them at boot or in a route. Flags: WORKFORCE_COURSE_ASSISTANTS (default OFF, register.ts) and WORKFORCE_INTERNAL_DRAFT_COURSES (default OFF, policy.ts). The draft flag is set to 1 only in the dev script in package.json. All 896 revisions are DRAFT, so nothing is retrievable unless that flag is on. Table draft: migrations/DRAFT_course_knowledge.sql, not promoted.
- Workforce runtime: LIVE, at server/routes.ts:2658 to 2686. The catalogue and runtime start at boot (routes.ts:2658 and 2659). Admin write routes return 503 when there is no catalogue. No env flag in code.
- RAG knowledge: LIVE, mounted unconditionally at server/routes.ts:1799. USE_RAG_KNOWLEDGE only gates the ElevenLabs tool wiring (services/rag-elevenlabs-tool.ts:228), and it defaults to on.
- Migrate call user ids: MOUNTED, FAIL-CLOSED. The 501 stub is reached through the admin router at routes.ts:1660 (calls-moderation-routes.ts:424, calls-user-id-migration-stub.ts:10). The real handler at routes.ts:2810 is shadowed and never runs.

## Draft migrations

Promotion check: none of the 24 files in migrations/DRAFT_*.sql has a byte-identical copy among the numbered migrations, so none is promoted. The list below is what each draft is for. Every line says "not promoted".

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
- DRAFT_inbox.sql: inbox threads, messages, participants and the dedupe index. Not promoted. The inbox module is not mounted.
- DRAFT_knowledge_base_company_backfill.sql: knowledge base company backfill. Not promoted.
- DRAFT_marketing.sql: content_items and landing_pages. Not promoted.
- DRAFT_shadow_changes.sql: shadow_changes table. Not promoted. Has three guards.
- DRAFT_webhook_delivery_status.sql: webhook_logs table. Not promoted.
- DRAFT_workforce_agents.sql: workforce_agents table. Not promoted. Until it is promoted the roster is in memory (routes.ts:2684).
- DRAFT_workforce_append_only.sql: append-only protection for workforce tables. Not promoted. Has a guard.
- DRAFT_workforce_budgets.sql: workforce_budget_usage table. Not promoted.
- DRAFT_workforce_control_state.sql: workforce_control_state table. Not promoted. Has three guards.
- DRAFT_workforce_runs.sql: workforce runs, tasks, tool calls and audit events. Not promoted.
- DRAFT_workforce_tier_migration.sql: workforce tier migration. Not promoted.

Numbered migrations and runner facts:
- The numbered files present are 0000 to 0007, 0010, 0011 and 0013, plus 0001_add_missing_columns.sql and an unnumbered add_missing_columns.sql.
- migrations/meta/_journal.json lists only 0000 to 0006. Its 0006 tag (0006_cultured_purifiers) does not match the file name 0006_add_default_campaign_type.sql.
- The safe runner, scripts/run-safe-migration.mjs at lines 53 to 62, names 0001 to 0007, 008, 009 and 0010. Files 008 and 009 do not exist in migrations/. The runner does not name 0011 or 0013. Which set a live database runs is UNVERIFIED.
- Migration 0013 stops with an error if the approvals table is missing, so DRAFT_approvals.sql must be applied before it.

## Open decisions

Each item below is in TODO_CHECKLIST.md unless marked NEW. The checklist is at /home/claude/desk-review-notes/TODO_CHECKLIST.md.

- Migration endpoint: the checklist records the decision to delete the dead handler. The row count on each live database is not yet recorded, and the delete patch is not applied (section "Migration endpoint"). The A1 review is at /home/claude/desk-review-notes/agents/A1/report.md.
- Module flags: the checklist says existing live paths default to on and new modules default to off (section "Module flags"). The A9 plan (agents/A9/enable-flags.md) sets Plivo, Twilio, payments, invoices, chatbot and widget to OFF by default. That conflicts with the checklist decision, so the plan needs revising before it is applied. No flag names exist in code yet.
- Campaigns: rename the new campaigns table or plan a merge with the legacy table (section "Campaigns"). The collision is real, because shared/schema.ts:327 defines the legacy campaigns table (A4 risk 1, and the header added to DRAFT_campaigns.sql by F2).
- Campaign recipient key: F2 keyed the send-job uniqueness on contact_id. The owner may prefer the address key instead. NEW, not in the checklist.
- Campaign opt-in uniqueness and job idempotency: A4 risks 2 to 4 (partial unique index on active opt-ins, and composite FKs for jobs). Partly addressed by F2. NEW, not in the checklist.
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

- Which migrations are applied on any live database, and whether the approvals, chatbot, comms, inbox, campaigns and workforce tables exist.
- Production environment variables, and whether any flag is set. Only five env names appear in code: TITAN_FIELD_BRIDGE_MODE, TITAN_LOCAL_LINK_ENABLED, USE_RAG_KNOWLEDGE, STRIPE_WEBHOOK_SECRET and WEBHOOK_TOKEN.
- Runtime behaviour of every gate in this file. No server was started and no request was sent.
- Whether the route order described in agents/A1/report.md behaves as stated, including its infinite-loop claim, which was inferred from reading code and not reproduced.
- Whether the chatbot requests fail until its draft is applied.
- SEC-02 (ElevenLabs webhook): the file exists but the fail-closed behaviour was not read.
- SEC-04: requireAdminPermission is used, but the runtime check with a team token was not run.
- SEC-09 and SEC-10: authRateLimiter is on the OTP routes (routes/auth-routes.ts:48, 100, 159, 211) and on /api/contact (routes/public-routes.ts:975), and strictRateLimiter is on audio delete (routes/audio-routes.ts:82). The limits were not exercised.
- SEC-11: audio delete checks ownership through audio-ownership.mjs. The owner check was not read in full.
- CORE-03: the plugin loader sets registered to false by default and to true only for externally registered plugins (plugins/loader.ts:193 and 203 to 206). The rest of that function was not read.
- Workforce D1 and D2 gates: the workforce ports and the preview gate could not be confirmed. The string workforce.previews.create is not in server/.
- Whether the gateway routers reach the payment engine core indirectly.
- Whether ElevenLabs RAG tool is on in production, and whether any scheduled job or script calls the migrate endpoint.
- The Field side. Its receiver and reminder projector files are not in this bundle. Per agents/A6/reminder-columns.md, none of the 22 cited Field columns is defined in shared/schema.ts, and the Field ai_fsm schema is not in the bundle.
- The 871-test figure, and which tests fail. No test run was done for this bundle. A4 ran three campaign test files in a scratch copy only (50 of 50 passed).
- TypeScript: tsc was not run and node_modules is absent, so type correctness is UNVERIFIED.
- Whether the A9 flag plan or the A1 delete patch has been applied to the live code. The checklist says neither has been.

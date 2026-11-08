# Deploy pack: manual upload and SQL run (DirectAdmin, no SSH)

Prepared 2026-11-03 from the review tree `/home/claude/desk-review`, compared against `/tmp/orig-full`.

**Status: NOTHING IN THIS PACK HAS BEEN RUN.** No file was uploaded, no SQL was executed, no migration was run, no database or server was contacted, and no secret value was read or printed. The owner performs every step below by hand through the DirectAdmin File Manager and database panel. Claude does not run any of it.

Companion file: `docs/MIGRATION_ORDER.sql.txt` (the SQL to paste, in order, with the exclusions explained).

---

## (a) What to upload

Found by comparing `/home/claude/desk-review` with `/tmp/orig-full` (`diff -rq`, `node_modules` and `package-lock.json` excluded from the first pass; `package-lock.json` then checked separately). The total is 222 differing entries: 126 role files and 96 others.

### a1. Runtime code: upload these

**Server (`server/`)**, changed or new (every non-role entry under `server/`):

- `server/index.ts`, `server/routes.ts`, `server/routes/*.ts` (changed: auth, crm, flow-automation, incoming-connections, mercadopago, paypal, paystack, public, razorpay, stripe, template, webhook)
- `server/storage.ts`, `server/storage/types.ts`
- `server/demo-mode/index.ts`
- `server/engines/plivo/plivo-signature.ts` (new), `server/engines/plivo/routes/plivo-webhooks.ts`
- `server/engines/twilio-openai/routes/twilio-openai-incoming-connections.ts`
- `server/middleware/auth.ts`, `server/middleware/hybrid-auth.ts`, `server/middleware/company-scope.ts`, `server/middleware/rateLimiter.ts`, `server/middleware/webhookValidation.ts`
- `server/middleware/embed-cors.ts` (new), `server/middleware/team-member-company.ts` (new)
- `server/modules/chatbot/` : `chatbot-scope.ts`, `chatbot-storage.ts`, `index.ts`, `schema.DRAFT.ts`
- `server/modules/approvals/authority-ladder.ts`, `server/modules/approvals/PORT-NOTES.md`
- `server/modules/booking-agent/company-scope.ts`
- `server/modules/desk-modes/PORT-NOTES.md`
- `server/modules/widget/public-widget-routes.ts`
- `server/services/audit-log.ts`, `server/services/graceful-shutdown.ts`, `server/services/play-audio-elevenlabs-tool.ts`, `server/services/razorpay-service.ts`, `server/services/webhook-delivery.ts`, `server/services/webhook-retry-service.ts`
- `server/workforce/catalogue/role.schema.ts`, `server/workforce/catalogue/SCHEMA.md`
- `server/workforce/courses/course-agent.template.ts`
- `server/workforce/runtime/tool-registry.ts`, `server/workforce/runtime/RUNTIME.md`
- `server/workforce/catalogue/roles/` : **126 role files** changed (every file in the folder that differs from the original; the list is in the `diff -rq` output, filter `workforce/catalogue/roles/`)

**Shared (`shared/`)**: `shared/schema.ts` and `shared/schema.js` (both changed; upload both, the runtime loads one or the other).

**Client (`client/src/`)**: `App.tsx`, `components/app-sidebar.tsx`, `lib/approvals-api.ts` (changed); `pages/ChatbotBuilder.tsx` (new).

**Root**: `package.json` (changed: one line added, a `"test"` script; no other edit) and `package-lock.json` (changed; the checklist records a lockfile update at line 219).

Note: a client build (`npm run build`, script present in `package.json`) is needed before the client files are served. Claude did not run it. Whether the DirectAdmin Node setup builds on the server is for the owner to confirm.

### a2. Not needed on the server (do not upload)

- `migrations/DRAFT_*.sql`: the SQL is pasted from `docs/MIGRATION_ORDER.sql.txt`. The runner (`scripts/run-safe-migration.mjs`) does not read these files, and nothing should reference them.
- `migrations/meta/`, `scripts/run-safe-migration.mjs`: unchanged in this pack. Do not run the runner (see blocker B2 in section f).
- `docs/`: review notes only (changed or new: `TENANCY-INVENTORY.md`, `RELEASE_NOTES_DRAFT.md`, `MIGRATION_RECONCILIATION.md`, `ROUTE_AUTH_AUDIT.md`, and others). Keep them locally; they are not read at runtime.
- `scripts/report-owners-without-company.mjs`: a report script, not run by the server. Upload only if the owner wants to run it.
- `tests/`: 14 changed or new entries (including `tests/security/*`). Not needed at runtime. Keep locally for the test run in section f.
- `tsconfig.DRAFT-NOTES.md`, `DELIVERABLE.md`, `_TITAN_HANDOFF/`: review artifacts, not runtime.
- `node_modules/`: never upload from this tree.
- `plugins/`, `packages/`, `vendor/`, `client/` other than `client/src/` items above: no difference from the original.

---

## (b) Environment variables

Set these in the DirectAdmin Node app / environment configuration. **Names only.** Values are not recorded here and must not be written into any file in the pack.

Source: `docs/RELEASE_NOTES_DRAFT.md` section 1. Total: **80 names**. The release notes say the optional list was grouped by hand and not checked name by name against each file, so treat it as a checklist, not a proof.

### Required (the code throws when missing): 2

- `DATABASE_URL`
- `JWT_SECRET` (throws in production; set in every real deployment)

### Fail closed (the feature is refused or disabled when missing): 4

- `WIDGET_ALLOWED_ORIGINS` (every external site that embeds the widget, comma-separated)
- `STRIPE_WEBHOOK_SECRET` (Stripe webhooks are rejected without it)
- `TITAN_COMMS_ENABLED` (must be exactly `true`, or the comms plugin registers nothing)
- `METRICS_TOKEN` (`/metrics` returns 404 unless this or admin auth is configured)

### Set for this release, though optional in the release notes: 1

- `APPOINTMENT_WEBHOOK_SECRET`: the checklist (line 194) says to set it in production before release, because otherwise the secret changes on restart.

### Must be unset or `false` in production (release notes, decision): 2

- `DEMO_MODE`
- `TITAN_LOCAL_LINK_ENABLED`

### Optional: 71 names, grouped as in the release notes

Count check: 2 required + 4 fail closed + 1 set for release + 2 must-be-unset + 71 optional = 80 names.

- **Twilio:** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MODE`
- **Stripe:** `STRIPE_SECRET_KEY`, `VITE_STRIPE_PUBLIC_KEY`, `TESTING_STRIPE_SECRET_KEY`
- **Other payment gateways:** `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`, `PAYSTACK_WEBHOOK_SECRET`, `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_PUBLIC_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_MODE`, `PAYPAL_WEBHOOK_ID`, `YOOKASSA_SHOP_ID`, `YOOKASSA_SECRET_KEY`, `YOOKASSA_WEBHOOK_SECRET`
- **Webhook secrets for other integrations:** `ELEVENLABS_WEBHOOK_SECRET`, `ELEVENLABS_HMAC_SECRET`, `ELEVENLABS_AGENT_SECRET`, `ELEVENLABS_API_KEY`, `RAG_WEBHOOK_SECRET`, `FORM_WEBHOOK_SECRET`, `WEBHOOK_TOKEN`
- **Email:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_FROM_EMAIL`
- **Google:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- **AI providers:** `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `USE_RAG_KNOWLEDGE`, `USE_ENHANCED_FLOW_COMPILER`
- **Titan Field bridge and local link:** `TITAN_LOCAL_LINK_SECRET`, `TITAN_LOCAL_FIELD_ORIGIN`, `TITAN_FIELD_BRIDGE_MODE`, `TITAN_FIELD_BRIDGE_SECRET`, `TITAN_FIELD_REPLY_BRIDGE_URL`, `TITAN_FIELD_REPLY_BRIDGE_SECRET`, `TITAN_WORKFORCE_ADAPTER_MODE`
- **Queues:** `REDIS_URL`, `ENABLE_BULLMQ`, `BULLMQ_MAX_CONCURRENT_CALLS`, `BULLMQ_STUCK_CAMPAIGN_MAX_AGE_MS`, `BULLMQ_STALE_CALL_MAX_AGE_MS`, `BULLMQ_STALE_CLEANUP_INTERVAL_MS`, `BULLMQ_RECOVERY_CHECK_INTERVAL_MS`
- **URLs and domains:** `APP_URL`, `APP_DOMAIN`, `DEV_DOMAIN`, `BASE_URL`, `CANONICAL_BASE_URL`
- **Storage paths:** `REFUND_NOTE_STORAGE_DIR`, `INVOICE_STORAGE_DIR`
- **Other:** `NODE_ENV` (production, owner to confirm), `PORT`, `LOG_LEVEL`, `DEMO_EMAILS`, `DESK_APP_DB_ROLE`, `VE_AUDIO_WS_IP`, `PUBLIC_IP`, `SYSTEM_UPDATE_KEEP_BACKUPS`, `SYSTEM_UPDATE_NPM_INSTALL_TIMEOUT_MS`, `TS_NODE_PROJECT`

Not set by any name above (checked in the release notes): `PLIVO_*`. Plivo credentials come from stored records, not from environment variables. The owner should confirm this is intended.

---

## (c) Database steps

Run the blocks of `docs/MIGRATION_ORDER.sql.txt` in this order through the panel's SQL tool. Do not run the migration runner, and do not change `migrations/meta/_journal.json`.

**Order against the code upload (important):** `shared/schema.ts` already declares `company_id` on many tables and `delivery_status` on `webhook_logs` (line 1586). The uploaded code will select those columns. **Run FILES 1 to 5 before the uploaded code is started.** If the code goes live first, queries on those tables fail because the columns do not exist yet. Keep the old code running until the SQL checks pass.

**Before FILE 1:** resolve blocker B2 (section f, item 1). Check the live `__drizzle_migrations` table, and check the PostgreSQL version (`SELECT version();`). Versions older than 13 need the `pgcrypto` extension for `gen_random_uuid()` (FILE 1, FILE 4 and FILE 5 use it).

**Panel behaviour:** every statement in the blocks is `IF NOT EXISTS` or `CREATE OR REPLACE`, so a block that stops partway can be pasted again. The company-scope `CONCURRENTLY` indexes are not included, so the panel should not need to run outside a transaction.

| Step | Block | Check after it runs |
|---|---|---|
| 1 | FILE 1: `DRAFT_companies_foundation.sql` | `SELECT to_regclass('public.companies');` returns `companies`. `SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND column_name='company_id';` should return 65 if no table already had the column (the file adds it to 65 tables). Any error stops the block; read it before rerunning. |
| 2 | FILE 2: company-scope section 2 (function only) | `SELECT public.current_company_id();` returns NULL in a new session. |
| 3 | FILE 3: `DRAFT_webhook_delivery_status.sql` | `SELECT column_name FROM information_schema.columns WHERE table_name='webhook_logs' AND column_name='delivery_status';` returns one row. |
| 4 | FILE 4: `DRAFT_chatbot.sql` | `SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('chatbots','chatbot_conversations','chatbot_messages');` returns 3. |
| 5 | FILE 5: `DRAFT_action_ledger.sql` (last) | `SELECT to_regclass('public.action_ledger');` returns the table. `SELECT has_table_privilege('PUBLIC','public.action_ledger','UPDATE');` returns false. |

Notes for the owner:

- FILE 1 creates a plain index on 65 existing tables. The draft's comment says there is nothing to scan, but the index build still reads every row of each table and blocks writes while it runs. Run this block in a low-traffic window.
- The `REVOKE` in FILE 5 is nearly a no-op on a new table, because new tables do not grant anything to PUBLIC by default. Append-only depends on the application role being granted only `INSERT` and `SELECT`. That role is created out of band and is not in this pack.
- Adding `company_id` does not change any existing row, because every value stays NULL. Scoping of reads and writes is still open (checklist lines 75 to 93), so the new columns are present but not enforced.

---

## (d) Post-deploy checks

Open these after the upload, the environment setup, and the SQL. The responses below are what the code is written to return, from the files named. Anything not listed was not verified.

| URL / request | Expected | Source |
|---|---|---|
| `GET /health` | 200, JSON with `status: "ok"` | `server/index.ts:164` |
| `GET /health/detailed` | 200 when healthy or degraded; 503 otherwise | `server/index.ts:169` |
| `GET /api/health` | responds (public route, no login) | `server/routes/public-routes.ts:303` |
| `GET /api/chatbot/chatbots` with **no** login | **401** (authentication required) | `server/routes.ts:1703`, `server/middleware/hybrid-auth.ts:58` |
| `GET /api/chatbot/chatbots` with a login that has **no** company claim (old tokens, team members) | **403** "Company scope required" | `server/middleware/company-scope.ts:54`; checklist lines 86 and 87 |
| `GET /api/chatbot/chatbots` with a valid login **and** company claim, after FILE 4 | 200 | Requires FILE 4 applied. Before FILE 4, a logged-in call fails with a server error, not a 401 or 403 (checklist line 206) |
| `GET /metrics` with no token and no admin login | **404** | Release notes section 1 (`METRICS_TOKEN`) |
| Cross-origin widget request from an origin not in `WIDGET_ALLOWED_ORIGINS` | No `Access-Control-Allow-Origin` header; browser blocks it | Release notes section 2, item 3 |
| Stripe webhook POST with no signature header | Rejected (not processed) | Release notes section 2, item 4 |
| Old ElevenLabs play-audio URL without the secret in the path | Must not play audio. Confirm the response on the server; the expected code is not stated in the source | Checklist lines 191 to 193 |
| Any request with an **invalid or expired** token on `/api/chatbot` | **401** (hybrid auth). Note: the older `authenticateToken` path returns 403 for an invalid token (`server/middleware/auth.ts:75`), so check which route you hit | `server/middleware/hybrid-auth.ts:147` |

**Expected 401 and 403 summary:**

- **401**: no login, or an invalid token on the hybrid-auth routes. Correct.
- **403**: a valid login with no company claim (pre-change tokens and team-member sessions). Correct, and fail closed. Fix: sign in again. Team members stay 403 until the parent-account lookup exists (checklist line 86).
- Any **500** on `/api/chatbot` before FILE 4 is applied. Expected, not a fault in auth.

---

## (e) Rollback

The steps are listed in reverse order of the migration. Each row says whether it is reversible.

| Step | Undo | Reversible? |
|---|---|---|
| FILE 5 `action_ledger` | `DROP TABLE public.action_ledger;` | Yes **while the table is empty**. Once rows exist, the append-only audit records are lost. Treat as not reversible once used. |
| FILE 4 chatbot | `DROP TABLE public.chatbot_messages; DROP TABLE public.chatbot_conversations; DROP TABLE public.chatbots;` (in this order, because of the foreign keys) | Yes **while empty**. Chat data is lost once rows exist. |
| FILE 3 webhook status | `DROP INDEX IF EXISTS public.webhook_logs_delivery_status_idx; ALTER TABLE public.webhook_logs DROP COLUMN IF EXISTS delivery_status;` | Yes, while the new column is not used by code. Its values are lost when dropped. |
| FILE 2 function | `DROP FUNCTION IF EXISTS public.current_company_id();` | Yes. Nothing stores data in it. |
| FILE 1 `company_id` columns (65 tables) | `ALTER TABLE <table> DROP COLUMN IF EXISTS company_id;` for each table (the index goes with the column) | Yes, **only while the column is NULL everywhere and the code does not read it**. Every row written with a company value is lost when dropped. Code that selects `company_id` must be reverted first, or those queries fail. |
| FILE 1 `companies` table | `DROP TABLE public.companies;` | Yes, as long as nothing points at it. No table in FILES 2 to 5 has a foreign key to `companies`, so drop it last, after the other steps are undone. |

**Not reversible by this pack**, because none of it is in the pack, but listed so no one assumes otherwise:

- Any backfill of `company_id` (company-scope STEP B). Blocked on decision D1 and blocker B1.
- Any foreign key from `company_id` to `companies` (STEP C) and any `NOT NULL` (STEP D). Not in this pack.
- Any data written with a company value by new code after the deploy.

**Code rollback** goes with the SQL rollback. Revert the uploaded files to the originals in `/tmp/orig-full` (keep a copy of the current tree first), because the schema in `shared/schema.ts` declares `company_id` and `delivery_status`. Dropping the columns without reverting the code will break queries.

The migration journal is not changed by this pack, so there is no journal to roll back.

---

## (f) Blockers still open (copied from `/home/claude/supercharged-fixes-checklist.md`)

These must be closed, or deliberately accepted, before the release. Line numbers are from that file. This pack did not tick, edit or resolve any of them.

1. **Live migration reconciliation needs a database check** (line 185). Check whether `0006_cultured_purifiers` was ever applied, by reading the live `__drizzle_migrations` table in each target database, before any journal repair. Blocker B2 in `docs/TENANCY-INVENTORY.md`.
2. **Plivo test call** (line 168). Make one real call from a Plivo number with the signature check on. The check is built but has not been tested against live Plivo.
3. **Stripe key rotation and history scrub** (lines 136 and 181). Confirm rotation from the handoff, and remove the exposed historical key from active credentials. Outside this repo.
4. **npm audit decision** (line 220). `npm audit` reports 49 vulnerabilities (1 critical, 22 high). Needs a separate decision before `npm audit fix` is run.
5. **Existing ElevenLabs tools need their play-audio URL changed** (lines 193 and 195). Every deployed ElevenLabs agent tool URL must be updated to include the secret. Line 193 is still unchecked. The URL generator change (line 192) is recorded as done but has not been run.

Also open, not repeated in full here: install dependencies, run the TypeScript check, and resolve the failing tests (line 186, and the test run at line 225, which recorded 802 tests, 767 pass, 35 fail).

---

## (g) Status of this pack

- **Nothing here has been run.** No upload, no SQL, no migration, no runner, no build, no test, no server or database contact.
- The SQL in `docs/MIGRATION_ORDER.sql.txt` was copied from the drafts. It was not checked against a live schema.
- The expected responses in section (d) come from reading the code. They were not observed on a running server.
- Decisions the owner must confirm before running, stated where they apply: the company-scope STEP A exclusion (MIGRATION_ORDER), the company_id on 10 ambiguous tables (decision D2, MIGRATION_ORDER), the team-member rule (release notes section 2, item 2, not verified in code), and the approvals behaviour change (release notes section 2, item 6, conflicting with the checklist).

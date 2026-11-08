# Release Notes: Operator Configuration and Migrations (DRAFT for owner review)

**Status: DRAFT. Every item below is for owner review. Nothing here is approved, applied or released.**
Prepared 2026-11-03 from a read-only review of `/home/claude/desk-review` (server/ and plugins/ only). No secret values were read or printed.

---

## 1. Environment variables

The code reads 79 distinct names through `process.env.` in `server/` and `plugins/`. One more, `TITAN_COMMS_ENABLED`, is read through a constant in `plugins/comms/index.mjs`, which brings the total to 80.

**Required:** the code throws at startup, or refuses to run, when the variable is missing.

| Variable | Read in | Behaviour when missing |
|---|---|---|
| `DATABASE_URL` | `server/db.ts:23`, `server/infrastructure/database/connection-pool.ts:85` | Throws at startup. |
| `JWT_SECRET` | `server/middleware/auth.ts:23`, `server/middleware/admin-auth.ts:25`, `server/middleware/hybrid-auth.ts:23` | Throws in production. Outside production it falls back to a development default and logs a warning. Set it in every real deployment. |

**Fail closed:** the feature is refused or disabled when the variable is missing. Required for that feature to work.

| Variable | Read in | Behaviour when missing |
|---|---|---|
| `WIDGET_ALLOWED_ORIGINS` | `server/modules/widget/public-widget-routes.ts:31` | No cross-origin widget access. Every external site that embeds the widget must be listed (comma-separated). |
| `STRIPE_WEBHOOK_SECRET` | `server/middleware/webhookValidation.ts:86`, `server/routes/stripe-routes.ts`, `server/engines/payment/gateways/stripe/service.ts:68` | Stripe webhooks are rejected. Also needed for signature verification. |
| `TITAN_COMMS_ENABLED` | `plugins/comms/index.mjs:8` | Must be exactly `"true"`. Otherwise the comms plugin registers nothing. |
| `METRICS_TOKEN` | `server/routes/metrics-routes.ts:11`, `server/middleware/metrics.ts:68` | `/metrics` returns 404 unless this token or admin auth is configured. |

**Optional:** not found to throw at startup. The variable only switches on or configures one feature. Set it when that feature is used.

- **Twilio:** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (read in `server/services/twilio-connector.ts`, `server/middleware/webhookValidation.ts:189`, and the admin phone-number routes). Stored settings take precedence over these. `TWILIO_MODE` defaults to `live` (`server/services/twilio.ts:30`).
- **Plivo:** no `process.env` read found. Plivo credentials come from stored credential records (`server/engines/plivo/services/plivo-recording.service.ts` uses `credential.authId`). Do not expect `PLIVO_*` variables to have any effect. The owner should confirm this is the intended setup.
- **Stripe:** `STRIPE_SECRET_KEY`, `VITE_STRIPE_PUBLIC_KEY`, `TESTING_STRIPE_SECRET_KEY` (fallback).
- **Other payment gateways:** `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`, `PAYSTACK_WEBHOOK_SECRET`, `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_PUBLIC_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_MODE`, `PAYPAL_WEBHOOK_ID`, `YOOKASSA_SHOP_ID`, `YOOKASSA_SECRET_KEY`, `YOOKASSA_WEBHOOK_SECRET`.
- **Webhook secrets for other integrations:** `ELEVENLABS_WEBHOOK_SECRET`, `ELEVENLABS_HMAC_SECRET`, `ELEVENLABS_AGENT_SECRET`, `ELEVENLABS_API_KEY`, `RAG_WEBHOOK_SECRET`, `FORM_WEBHOOK_SECRET`, `APPOINTMENT_WEBHOOK_SECRET`, `WEBHOOK_TOKEN`.
- **Email:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_FROM_EMAIL`.
- **Google:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
- **AI providers:** `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `USE_RAG_KNOWLEDGE`, `USE_ENHANCED_FLOW_COMPILER`.
- **Titan Field bridge and local link:** `TITAN_LOCAL_LINK_ENABLED`, `TITAN_LOCAL_LINK_SECRET`, `TITAN_LOCAL_FIELD_ORIGIN`, `TITAN_FIELD_BRIDGE_MODE`, `TITAN_FIELD_BRIDGE_SECRET`, `TITAN_FIELD_REPLY_BRIDGE_URL`, `TITAN_FIELD_REPLY_BRIDGE_SECRET`, `TITAN_WORKFORCE_ADAPTER_MODE` (`plugins/titan-workforce-bridge/index.mjs:25`).
- **Queues:** `REDIS_URL`, `ENABLE_BULLMQ`, `BULLMQ_MAX_CONCURRENT_CALLS`, `BULLMQ_STUCK_CAMPAIGN_MAX_AGE_MS`, `BULLMQ_STALE_CALL_MAX_AGE_MS`, `BULLMQ_STALE_CLEANUP_INTERVAL_MS`, `BULLMQ_RECOVERY_CHECK_INTERVAL_MS`.
- **URLs and domains:** `APP_URL`, `APP_DOMAIN`, `DEV_DOMAIN`, `BASE_URL`, `CANONICAL_BASE_URL`.
- **Storage paths:** `REFUND_NOTE_STORAGE_DIR`, `INVOICE_STORAGE_DIR`.
- **Other:** `NODE_ENV`, `PORT`, `LOG_LEVEL`, `DEMO_MODE`, `DEMO_EMAILS`, `DESK_APP_DB_ROLE`, `VE_AUDIO_WS_IP`, `PUBLIC_IP`, `SYSTEM_UPDATE_KEEP_BACKUPS`, `SYSTEM_UPDATE_NPM_INSTALL_TIMEOUT_MS`, `TS_NODE_PROJECT`.

**Count:** 80 names read. 2 are required (throw when missing). 4 more fail closed (`WIDGET_ALLOWED_ORIGINS`, `STRIPE_WEBHOOK_SECRET`, `TITAN_COMMS_ENABLED`, `METRICS_TOKEN`). The remaining 74 are optional. The optional list above was grouped by hand and not checked one by one against each file.

**DECISION FOR REVIEW:** `DEMO_MODE` and `TITAN_LOCAL_LINK_ENABLED` change access behaviour. The owner should confirm both are unset or `false` in production.

---

## 2. Behaviour changes users will notice

1. **Sign in again after the company claim change.** Verified. The company claim is written into tokens only when it is a valid UUID. A token without it leaves `req.user.companyId` undefined, and `requireCompanyScope()` returns 403 (`server/middleware/company-scope.ts`, `server/middleware/auth.ts:~30`). Existing sessions will need a fresh sign-in.
2. **Team members get their company from the parent account.** Not verified in this review. Taken from the owner's list. The company-scope comment says the claim comes from `users.company_id` at token issue. The parent-account rule was not located in code.
3. **Widget origins must be listed in `WIDGET_ALLOWED_ORIGINS`.** Verified. Origins not in the list no longer receive `Access-Control-Allow-Origin`, so the browser blocks cross-origin widget reads. Same-origin use is unaffected.
4. **Webhooks without signatures are refused.** Verified for Stripe (`server/middleware/webhookValidation.ts`): a missing signature header or missing secret rejects the request. Other webhook providers were not checked.
5. **60 requests per minute per user.** Partly verified. The default limiter is 60 requests per 60-second window (`server/middleware/rateLimiter.ts:125-126`). That it is keyed per user was not confirmed.
6. **Approvals needed for critical actions.** **Conflict, flagged for owner.** The owner's list says this takes effect now. The checklist says it is not yet enforced: no declared tool is tagged `critical`, and `role.schema.ts` (around lines 232-238) still allows critical tools at auto (`/home/claude/supercharged-fixes-checklist.md`, lines 13-15). Do not publish this as a current change until the owner confirms it.

---

## 3. Migration steps (ALL NOT YET APPLIED, DRAFT)

Run in this order. Each file's header says it is a draft, not applied, not listed in `migrations/meta/_journal.json`, and not picked up by any runner.

1. **`migrations/DRAFT_companies_foundation.sql`** (NOT YET APPLIED). Creates `public.companies` and adds a nullable `company_id` column and index to 65 tables. Must run first.
2. **`migrations/DRAFT_company_scope.sql`** (NOT YET APPLIED). Run only as the owner approves each step, in this order:
   - Step A: add nullable `company_id` and index (additive).
   - Step B: backfill from the owning parent row.
   - Step C: foreign key to `companies`, added `NOT VALID`, then `VALIDATE`.
   - Step D: `NOT NULL`. Separate review and a later window.
3. **`migrations/DRAFT_action_ledger.sql`** (NOT YET APPLIED). Run only after owner approval.

**Count:** 3 files, 6 steps (1 foundation, 4 company-scope steps A to D, 1 action ledger).

**Not in the requested order, owner to decide:** `DRAFT_approvals.sql`, `DRAFT_audit_chain.sql`, `DRAFT_campaigns.sql`, `DRAFT_chatbot.sql`, `DRAFT_inbox.sql`, `DRAFT_marketing.sql` in `migrations/`, and `docs/pending/foundation/B4/0013_DRAFT_sip_calls_drift.sql`, `docs/pending/foundation/B5/0011_DRAFT_approvals.sql`, `docs/pending/foundation/B5/0012_DRAFT_audit_chain.sql`. Their order relative to the list above is not set.

---

## 4. Known gaps that block release

Full checklist: `/home/claude/supercharged-fixes-checklist.md`. Top five unchecked items, in file order:

1. **Line 8:** Replace `observe_only`, `recommend_only`, `prepare_only`, `approval_required`, `delegated_autonomous` with Assist, Suggest, Auto, Predictive. Sub-items at lines 13-15 record that no tool declares access yet and nothing enforces critical tagging.
2. **Line 17:** Define permissions for each tier.
3. **Line 30:** Make Predictive's action permissions explicit.
4. **Line 31:** Apply autonomy at the action level as well as the role level.
5. **Line 32:** Build one policy evaluator combining tier, action risk, company policy, user permissions, approval state and financial limits.

Also relevant to item 6 in section 2: line 63, mount the approvals API, which is unregistered in the main routes.

---

## 5. Owner decisions needed before release

- Confirm the approvals behaviour change (section 2, item 6) and whether it ships in this release.
- Confirm the team-member company rule (section 2, item 2), which was not verified in code.
- Confirm the Plivo setup (no `PLIVO_*` variables are read).
- Approve each company-scope step (A to D) and `DRAFT_action_ledger.sql` separately.
- Confirm `JWT_SECRET`, `DATABASE_URL`, `WIDGET_ALLOWED_ORIGINS`, `METRICS_TOKEN` and `TITAN_COMMS_ENABLED` values for production. Values are not recorded in this document.

All items above: **DRAFT for owner review.**

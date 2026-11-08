# Desk: complete package (working copy, not deployed)

Built 3 Nov 2026 from merged4 (working copy) with the approved patches applied in order.
Nothing has been run against a database. No migrations are applied. No packages are installed.

## Applied in this package
| Item | What it does | Needs before go-live |
|---|---|---|
| SEC-01 YooKassa | Re-fetches each payment from YooKassa before crediting. Fails closed. | Valid shop credentials in env |
| SEC-02 ElevenLabs | Webhook fails closed; SIP and dev bypasses removed | Confirm ElevenLabs signs SIP webhooks |
| SEC-04 Admin permissions | Admin team tokens need a permission on each route | Runtime test with a team token |
| SEC-07 Stripe | Webhook fails closed when no secret is set (returns 503) | STRIPE_WEBHOOK_SECRET set, or Stripe retries |
| SEC-09 / SEC-10 / SEC-11 Rate limits, audio owner | Limits on OTP, public contact, audio delete; owner check | Proxy must pass the real client IP (C6) |
| CORE-04 / WKF-01 Workforce ports (D1) | Ports passed to the bridge; 503 until ports are registered | Identity owner registers ports |
| WKF-02 Workforce gate (D2) | Preview needs permission, not team membership | Seed `workforce.previews.create` (not done) |
| CORE-03 / D5 Plugin loader | A plugin that returns registered:false is no longer marked registered | None |
| C-01 / E5 migrate-call-user-ids | Stub returns 501 instead of success. The stub is mounted first (admin router, routes.ts:1660), so the real handler at routes.ts:2809 is shadowed and unreachable | Decide the real migration, then wire it through the stub or remove the stub |
| SEC-08 / E6 RAG webhook | Only that path exempt from hybrid gate; its own token check kept | WEBHOOK_TOKEN set |

## Modules included but NOT mounted
- Inbox and marketing modules: not imported by `routes.ts` or `index.ts`. The inbox dedupe fix (unique index `inbox_messages_external_uidx`) is not live until `migrations/DRAFT_inbox.sql` is promoted to a numbered migration and applied.
- Desk two modes (`server/modules/desk-modes/`) and the comms campaigns router: **mounted** in `routes.ts` (desk-mode middleware at ~line 2722; campaigns under `/api/comms` at ~line 2723). Both fail closed. The campaign store throws until `migrations/DRAFT_campaigns.sql` is promoted, and approvals and transport throw "not configured for production", so nothing can be approved or sent. Promoting that migration would make the route live, so review it first.
- Interaction engine offline code and trust readiness evaluator, with Desk adapters. Not mounted.
- Payment engine webhook files `server/engines/payment/verifiers.ts`, `engine.ts`, `idempotency.ts` and `contract.ts`. Not used by the live routes. Only tests import `engine.ts`, `idempotency.ts` and `contract.ts`; `verifiers.ts` is imported only by `engine.ts`.
- Workforce catalogue: 125 role files; plugin manifests under `plugins/`.

## Held, not applied
- SEC-06 / audit durability (`docs/pending/held-patches/08-audit-durability`): needs the soft-delete migration first.
- Play-audio HMAC (`docs/pending/held-patches/04-play-audio-hmac`): ElevenLabs cannot sign per request. Would return 401 for play-audio.
- Foundation drafts (`docs/pending/foundation/`): journal repair proposal, lockfile additions, sip_calls drift draft, approvals and audit-chain drafts. Not in `migrations/`, so the runner will not pick them up.

## Excluded (other repos)
- Hard-coded secrets (Clean-Hub, Titan-Business-OS) and the chatbot browser-call fix: different repositories, patches in `/home/claude/work/security-fixes/05-*` and `06-*`.

## Changes made in this package, not in any patch
- Three scripts (`scripts/setup-live-policy-flow.ts`, `create-policy-flow.ts`, `create-live-policy-flow.ts`) had a live Stripe key written in. Now they read `STRIPE_SECRET_KEY` from env. **Rotate that key.** It is still in git history.

## Tests
The "871 tests, 867 pass, 4 fail" figure is unverified: no full test run was reproduced for this package. A static count of test calls under `tests/` (lines beginning with `test(` or `it(`) found 3,541. The 4 failing files need flags or dependencies that are not installed here:
- tests/engines/decision-adapter.test.mjs (needs --experimental-transform-types)
- tests/engines/interaction-adapter.test.mjs (needs --experimental-transform-types)
- tests/modules/approvals-policy.test.mjs (needs safe-regex2)
- tests/modules/booking-agent.test.mjs (needs zod)

The claim that the same 4 also fail in the unpatched working copy has not been re-checked.

Not type-checked (no node_modules). A `tsc` run is still owed before deploy.

## Deploy steps (for when you upload)
1. Back up the live database and the live code.
2. Set env: STRIPE_WEBHOOK_SECRET, YooKassa shop credentials, WEBHOOK_TOKEN, STRIPE_SECRET_KEY (new key).
3. Run `npm install`, then `tsc`, then the test suite.
4. Apply the migrations reviewed in docs/pending/foundation after the journal decision.
5. Restart and check the payment and webhook routes with test events.

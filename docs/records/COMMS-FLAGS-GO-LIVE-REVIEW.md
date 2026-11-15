# Comms flags go-live review

Date: 2026-11-15
Scope: `COMMS_INBOX_ENABLED` and `COMMS_MARKETING_ENABLED` (the two flags the owner turned on for production), plus `COMMS_CAMPAIGNS_ENABLED`, which is a separate flag in the same mount code and is reached by the same comms surface.
Base: `origin/main` at 749b7bb.
Method: static review of the code and docs in this repository. No deployment, host or database was touched. The test suite was not run for this review.

## Summary

| Capability | Flag | Decision |
|---|---|---|
| Inbox routes (read threads, messages, assignment, status, drafts, staff send) | `COMMS_INBOX_ENABLED` | NO-GO |
| Inbox outbound delivery to any channel | `COMMS_INBOX_ENABLED` | NO-GO |
| Marketing routes (landing pages, content, publication) | `COMMS_MARKETING_ENABLED` | NO-GO |
| Marketing campaign links | `COMMS_MARKETING_ENABLED` | NO-GO (always refused) |
| Campaign approvals and campaign sends | `COMMS_CAMPAIGNS_ENABLED` (not in scope, do not set) | NO-GO (stubs that throw) |
| Suppression list (bounces, complaints, unsubscribes) | shared | NO-GO (in memory only) |
| Quiet hours enforcement | shared | NO-GO for inbox and marketing (not called on those paths) |
| Opt-out handling (STOP / START) | shared | NO-GO for inbox (not wired) |

Overall: both flags must stay off in production.

## Immediate action for the owner

The owner has reported turning both flags on in production. Based on this review, the server is expected to refuse to start with them on, because the database security checks fail before any route mounts. Please check the production environment now:

- If `COMMS_INBOX_ENABLED` or `COMMS_MARKETING_ENABLED` is set to `true`, set it back to `false` (or unset it) and restart.
- I could not confirm the production state from here. This is an inference from the code and the migration folders. Confirm the startup logs before and after the change.

## What the two flags mount

Both flags are read in `server/routes/core/optional-comms-routes.ts`. Both are called from `registerVerifiedCommsRoutes` in `server/routes/core/verified-marketing-routes.ts`, which is called from `server/routes/core/workforce-comms-routes.ts`, which `server/routes.ts` calls at startup.

- `COMMS_INBOX_ENABLED=true` mounts `/api/comms/inbox`. The routes are: `GET /threads`, `GET /threads/:id`, `GET /threads/:id/messages`, `POST /threads/:id/assignment`, `POST /threads/:id/status`, `POST /threads/:id/drafts`, `POST /threads/:id/messages` (staff send, no approval), and `POST /messages/:id/send-request` (agent send through approval).
- `COMMS_MARKETING_ENABLED=true` mounts `/api/comms/marketing`. The routes cover landing pages and content items, including publication and archive.
- Mount-level auth is `deskMode`, `authenticate`, `requireCompanyScope`, and a human actor check. Route-level roles are `admin` and `manager` for assignment, status, publication and approval. Thread reads and staff replies are open to any member.

## Inbox

### Blockers

1. **The Inbox database security migration is not promoted.** `migrations/candidates/0018_inbox_tenant_rls.sql` is marked "REVIEW CANDIDATE ONLY". `requireInboxSchema` in `server/modules/inbox/schema-readiness.ts` requires `ENABLE` and `FORCE` row-level security on the four inbox tables. Without it, startup throws. The docs say the same thing (`docs/security/INBOX_ROUTE_ACTIVATION.md`: "Enabling before the migration is deployed will prevent startup").
2. **The outbox, delivery receipts and delivery state migrations are not promoted.** `migrations/candidates/0019_inbox_outbox.sql`, `0020_inbox_delivery_receipts.sql` and `0021_inbox_delivery_state.sql` are still candidates.
3. **Staff sends bypass every compliance check.** `sendAsStaff` in `server/modules/inbox/inbox-service.ts` inserts an outbound message with status `queued`. It does not check suppression, consent, opt-out or quiet hours. The approval gate is also skipped by design (the file header says a human send is "the only unapproved path").
4. **There is no outbound transport.** `server/modules/inbox/outbox-dispatcher.ts` requires an injected transport, and none is registered. `docs/security/INBOX_OUTBOX_DELIVERY.md` says the local `queued` state is not remote delivery. So queued messages are never delivered, but they also are not blocked. Once a transport is added later, this gap becomes live.
5. **Inbound opt-outs are not handled in the inbox.** `server/modules/comms/inbound-optout.ts` (STOP and START parsing) is imported only by `sms-inbound-route.ts`, which belongs to the Plivo engine, not the Inbox. An inbound STOP from a contact on the inbox path does not suppress that contact.
6. **The approval policy for `inbox.send_message` is not verified.** `gateAction` sends a request with no matching rule to the human queue as pending (this is the safe default). Confirm that the production company has no `auto_approve` rule that would catch this action.

### Verification needed before go

- Promote migrations 0018 to 0021 through the normal review process. Then run the read-only readiness check in staging and confirm it passes.
- Confirm the `desk_app` role is not superuser and does not bypass RLS, then run a cross-tenant read and write test against staging. A company A session must get no rows from company B's threads or messages.
- Decide and document whether member-level staff send is allowed. If yes, add a pre-send check for suppression, consent, opt-out and quiet hours, and test that refusals block a queued message.
- Add a test that an inbound STOP on the inbox channel records an opt-out that the send check then enforces.
- Choose a transport per channel, with idempotency keys, and test that the dispatcher does not send a message twice on retry.
- Confirm the production approval policy has no auto-approve rule for `inbox.send_message`.

## Marketing

### Blockers

1. **The Marketing tables are not promoted.** `landing_pages` and `content_items` exist only in `migrations/archive/DRAFT_marketing.sql`. `requireMarketingSchema` in `server/modules/marketing/schema-readiness.ts` checks for those two tables and for forced RLS, so startup throws. The RLS candidate is `migrations/candidates/0017_marketing_tenant_rls.sql`.
2. **Campaign links are always refused.** `verified-marketing-routes.ts` passes `unavailableCampaignReferences()` unless a real campaign adapter is supplied. That adapter returns `false` for every campaign ID.
3. **There is no marketing send path.** Publication is not a send (the service header says so). This means the marketing flag by itself does not send messages. It still publishes pages, so the publication routes need review before go.
4. **The drizzle marketing adapter is a placeholder.** `server/modules/marketing/drizzle-adapter.ts` throws on every call. The production path uses `sql-store.ts`, but the placeholder should be removed or clearly marked before go.

### Verification needed before go

- Promote the marketing tables and RLS through the normal review process. Run `requireMarketingSchema` against staging.
- Test that a cross-tenant read of a landing page or content item returns nothing.
- Confirm there is no public route that serves a published landing page without authentication. I found no mounted public renderer in this review, but this was not exhaustively checked.
- Decide whether campaign links stay refused in production. If yes, record that as an accepted limit.

## Campaigns (not in the owner's flags, but on the same comms surface)

This is outside the two flags, but a single environment change would reach it, so it is recorded here.

1. **Approvals and transport throw by design.** In `server/routes/core/workforce-comms-routes.ts`, `commsNotConfigured` throws for `gateAction`, `getApproval`, `markExecuted` and `send`. The audit's finding is confirmed. The campaigns module header in `server/modules/campaigns/index.ts` says the same.
2. **The store is a placeholder.** `createDrizzleCampaignStore` throws until `migrations/archive/DRAFT_campaigns.sql` is promoted.
3. **Suppression is in memory.** `createSuppressionList` in `server/modules/comms/suppression.ts` keeps all state in a process-local `Map`. A restart loses every bounce, complaint and unsubscribe. This is a blocker for any send path, not just campaigns.
4. **Campaign-level consent checks exist.** `campaign-service.ts` refuses a send when nothing is opted in (lines around 443 to 446). These checks are not reached in production because of blocker 1.

Decision: keep `COMMS_CAMPAIGNS_ENABLED` unset. Do not set it until items 1 to 3 are fixed.

## Suppression, quiet hours and opt-out

- **Suppression.** The in-memory list is the only implementation used by the comms surface. It must be backed by a durable, company-scoped store before any send. Verify that a bounce or STOP survives a restart.
- **Quiet hours.** `migrations/0015_company_quiet_hours.sql` creates the company quiet-hours table. The provider adapters (`email-provider-adapter.ts`, `sms-provider-adapter.ts`, `whatsapp-provider-adapter.ts`, `telegram-provider-adapter.ts`, `messenger-provider-adapter.ts`) call `checkConsent` with quiet hours, but none of them is imported by the inbox or marketing paths. Quiet hours are not enforced on those paths. Verify each adapter's quiet-hours check with a test before wiring it.
- **Opt-out.** Consent records and STOP / START parsing exist (`consent.ts`, `inbound-optout.ts`). They are used only by the SMS inbound route in the Plivo engine. Verify the Plivo path separately if it is reachable in production.
- **Outbound adapters are not wired.** Telegram, WhatsApp, Meta and email inbound and webhook routes (`telegram-webhook-route.ts`, `meta-webhook.ts`, `email-inbound-route.ts`) have no importers in the server code, so they are not mounted. The Meta send module (`meta-send.ts`) performs no network I/O on its own.
- **Email campaign adapter.** `email-campaign-adapter.ts` turns transport refusals into thrown errors, which is the campaign port contract. It has no importers.

## Other notes

- The chatbot booking reminder path (`server/modules/chatbot/booking-providers/reminder-senders.ts`) uses the email provider adapter, which has suppression and quiet-hours checks. It is gated by `CHATBOT_REMINDERS_ENABLED`, not by the comms flags, and was not reviewed in depth here.
- The flag-on mount tests in `tests/modules/` (for example `marketing-production-service.test.mjs`, `inbox-sql-updates.test.mjs`) were not run for this review.

## Go / no-go summary

| Item | Decision | Owner action |
|---|---|---|
| `COMMS_INBOX_ENABLED` | NO-GO | Set to `false` in production now. Re-review after blockers 1 to 6 are closed. |
| `COMMS_MARKETING_ENABLED` | NO-GO | Set to `false` in production now. Re-review after the marketing tables and RLS are promoted. |
| `COMMS_CAMPAIGNS_ENABLED` | NO-GO | Leave unset. |
| Outbound messaging, all channels | NO-GO | No transport is wired. Add one only after the compliance gate and durable suppression exist. |
| Suppression | NO-GO | Make durable and company-scoped. |
| Quiet hours | NO-GO on inbox and marketing paths | Wire and test on every send path. |
| Opt-out (STOP / START) | NO-GO on inbox | Wire inbound opt-out into the inbox and test it. |

## Decisions made in this review

- Scope is the two flags plus `COMMS_CAMPAIGNS_ENABLED`, which shares the mount code.
- The review is static. Nothing was deployed, and no test suite was run.
- No code was changed. This document is the only change.

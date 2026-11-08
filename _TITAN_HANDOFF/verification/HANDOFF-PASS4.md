# Titan Field ↔ Desk: Pass 4 — queued visit-reminder shadow projection

**Date:** 2026-11-02. **Status:** cumulative **Pass 3 + Pass 4 source patch** and delta. Not a full installable app. Not deployed. No real provider messages. No database migrations. Desk's DB-backed company mapping, consent and event-claim ports remain unavailable until the separate database agent implements them.

## Source basis and preserved ownership

- Field server-delta donor: `titan-field-SERVER-SOURCE-DELTA-20261101-233807.zip` (partial server source only), audited against Titan Field GitHub `main` `b6fed9da4ab411dc8f147b30e418854e015b216c`. The server has a separate Git history and a PostgreSQL `ai_fsm` business database.
- Desk donor: `Desk backup.zip` (`agentlabs` 5.4.5, Express/Drizzle/PostgreSQL). Exact deployed source equality is not verified. Its `titan_desk` database belongs to the other agent.
- Pass 3 source is preserved byte-identically. Pass 3's `desk-routes.patch` remains the sole addition to the existing Desk router.
- Pass 4 adds **only** a read-only Field-side reminder projector and a role-protected Next.js endpoint. No existing worker, email, SMS, database, or Desk source file is replaced.

## New files (relative to each application's root)

1. `field/apps/web/lib/titan/desk-bridge/reminder-shadow.mjs`
   - Reads due `notification_queue` entries for `visit_reminder` using the existing Field queue, joining `visits`, `jobs`, and `clients` within one `account_id`.
   - The existing Field worker sends **email** for these rows. This projector uses a queued email reminder as an **eligibility signal for a separate SMS shadow simulation**, **not** proof of consent for SMS and **not** proof of an actual SMS being sent.
   - Rejects visits no longer scheduled, reminders outside 0–24 hours before the visit, SMS opt-outs, missing explicit SMS consent, missing consent timestamp, malformed IDs, and absent phone data.
   - Generates deterministic event/correlation IDs from company, queue, visit and schedule, and a stable `requested_at` timestamp from the 24-hour reminder window. This prevents the same event from changing its payload across retries.
   - Uses the existing Pass 3 signed transport and requires an exact correlated `not_sent` receipt.
   - Batch size capped at 10, with no PII included in the request/response. The original notification queue and audit log are never mutated.
2. `field/apps/web/app/api/v1/titan/desk-bridge/reminders/route.ts`
   - `POST /api/v1/titan/desk-bridge/reminders` only for owner/admin, feature switch `TITAN_FIELD_DESK_SHADOW_MODE=1`.
   - Request JSON `{ "limit": 5, "dry_run": true }` (both optional; defaults 5 and true).
   - `dry_run=true` reads eligible rows and produces a **local** preview; no Desk HTTP request occurs.
   - `dry_run=false` submits a *simulation-only* signed intent to Desk. Desk's production router remains disabled/fail-closed until verified mapping, consent and atomic event ledger ports are provided.
   - Never claims that a simulated receipt means a message was sent.
3. `verification/reminder-shadow.test.mjs` — 19 node:test assertions including real loopback HTTP and consent-revocation race.

## Dependency and integration boundaries

- Uses Field's existing `@/lib/db.query` (PostgreSQL `notification_queue`) and `withRole`. No new dependency or SQL migration.
- Uses Pass 3's `protocol.mjs` and `client.mjs`; Desk continues to validate HMAC signature, verified tenant mapping, current consent, atomic event claim and persisted receipt. The present Desk mount intentionally has no ports.
- The SQL references columns found in Field source usage: `notification_queue.id/account_id/client_id/entity_id/entity_type/automation_type/status/next_attempt_at`, `visits.id/account_id/job_id/status/scheduled_start`, `jobs.id/account_id/client_id`, `clients.id/account_id/phone/sms_consent/sms_consent_at/sms_consent_source`. They have not been validated against a live database schema in this pass.
- Company IDs are currently Field's authenticated `account_id`. A canonical `company_id` mapping/alias must be validated by the other agent before cross-app commissioning.

## Tests actually executed

```bash
cd <extracted cumulative package>
node --test verification/bridge.integration.test.mjs verification/reminder-shadow.test.mjs
```

**35 passed, 0 failed** in the isolated Node.js `v22.16.0` environment: 16 prior Pass 3 tests + 19 Pass 4 tests. Includes a locally hosted HTTP simulation (not live Desk), deterministic replay, revocation after Field planning, cross-company denial, missing/future consent evidence, invalid queue rows, fake success receipts, bounded batch and fail-closed transport errors.

TypeScript's transpile parser reported 0 syntax diagnostics for the Pass 3 Desk router, Pass 3 Field preview route, and new Pass 4 Next.js route. **No full application build, typecheck, actual database integration, hosted provider test or production install was performed.**

## Staging application guide (NOT production instructions)

1. Retain the original server and Desk backups. Open a fresh **isolated** working tree from the exact source version currently used by the team; never overwrite a running directory or apply a `git clean`.
2. Carry forward all Pass 3 files and its Desk router patch as documented in `verification/HANDOFF.md`. The existing `server/routes.ts` must be checked against your real current Desk code before modifying it.
3. Copy `field/apps/web/lib/titan/desk-bridge/reminder-shadow.mjs` to `apps/web/lib/titan/desk-bridge/reminder-shadow.mjs` in the Field staging tree. Copy the new Field `reminders/route.ts` to the matching `apps/web/app/api/v1/titan/desk-bridge/reminders/route.ts` path.
4. Run the packaged tests, then full Desk and Field typechecks/integration tests in the actual staging trees. Confirm `notification_queue` column definitions on staging only. Verify existing visit reminder email jobs are unaffected.
5. Keep all feature switches off until the DB agent's **trusted company resolver**, **current-consent** checker and **durable atomic ledger** have full tests. First acceptance in Desk must still be `simulated/not_sent`; no SMS provider adapter is attached.
6. The new API is intentionally **operator-triggered**, not a background scheduler. Automatic projection can be considered only after staging approvals, a durable source outbox/retry policy and the governed Desk mapping are operational.

## Known risks and next pass

- Existing Field SMS webhook routes select a first owner account; they are untouched but need an independently governed routing migration before multi-company live delivery.
- Pass 3's *manual job-preview endpoint* accepts caller-provided event IDs with a changing request timestamp; it should not be treated as a retry-stable automatic delivery producer. This Pass 4 reminder projector uses a separate stable event identity.
- Desk cannot currently accept a production event because its identity/consent/event ledger ports are unconfigured. Do **not** bypass this fail-closed behavior.
- Canonical GitHub Field's workforce service and DirectAdmin modules are **not** folded into the shipped apps here.
- Both live databases, authentication and customer messaging remain untouched. The other agent remains the owner of DB mapping and migration work.

## Measured change vs Pass 3

- **New production source files:** 2 (read-only Field projector, role-protected Field route).
- **Existing application source files changed:** 0.
- **New test files:** 1 (19 Pass 4 cases).
- **New documentation files:** 1; new manifests and ZIPs are packaging metadata.
- **Production readiness:** not verified; **live integrations commissioned:** 0.

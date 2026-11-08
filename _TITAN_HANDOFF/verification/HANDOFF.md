# Titan Field ↔ Desk Convergence — Implementation Pass 3

**Date:** 2026-11-02. **Status:** Source patch and mock-runtime verification completed; **not installed on DirectAdmin**, **no database migrations**, **no production messages**, **not production-ready**.

## Pinned source basis

- Desk: user-supplied `Desk backup.zip`, `agentlabs` v5.4.5; running instance's exact source equivalence is unverified.
- Field: user-supplied `titan-field-SERVER-SOURCE-DELTA-20261101-233807.zip`, audited against GitHub head `b6fed9da4ab411dc8f147b30e418854e015b216c`. Source delta lacks complete dependency tree.
- Separate GitHub Titan Field `main` also includes the canonical `services/workforce` runtime; this patch does **not** install or alter it.

## Functional work implemented

1. **Signed wire protocol** shared byte-identically between Field and Desk (`protocol.mjs`). HMAC-SHA256 over exact raw JSON bytes and timestamp, max five-minute clock difference, max 8 KiB, strict schema/tenant/event/template/consent/resource checks.
2. **Field outbound client** (`client.mjs`), rejects insecure external HTTP, invalid receipts, unavailable transport and missing 32-byte secret; configurable 3s timeout. No phone number, email address, message text or provider key crosses this contract.
3. **Desk inbound governed receiver** (`receiver.mjs`), requires explicit server-side company→Desk identity resolver, current consent verification, durable atomic idempotency claim and receipt recording ports. Rejects any missing port; never looks up first owner or trusts caller's company string as mapping authority.
4. **Desk Express route** (`route.ts`) and **minimal 21-line registration patch** (`verification/desk-routes.patch`), disabled by default and shadow-only. No real SMS/email provider implementation or database mutation included.
5. **Field Next.js owner/admin preview endpoint** (`.../desk-bridge/preview/route.ts`), disabled by default, uses authenticated `accountId`, verifies client/job association and recorded SMS consent before preparing a signed intent. This is additive; the existing customer SMS send endpoint remains untouched.
6. **Mock contract and HTTP tests** (`verification/bridge.integration.test.mjs`) covering signature tampering, replay, tenant rejection, consent rejection, ledger unavailability, concurrent claims, event ID conflicts and an actual loopback HTTP round-trip. No external calls.

## Required DB-agent integration contract

The Desk `createTitanFieldBridgeRouter(ports)` signature accepts:

- `resolveCompany(company_id)` → trusted `{ company_id, desk_user_id, active: true }` or null. Mapping must come from verified company/tenant binding, not caller input or phone number matching.
- `verifyConsent({intent, mapping})` → current authoritative `true` only if consent, suppression and approved template permit this intent. Must re-query the appropriate Field/Desk policy owner for current state; provided consent reference alone is insufficient.
- `claimEvent({companyId,eventId,correlationId,payloadHash,intent,deskUserId})` → **atomic, durable** `{state:'claimed'}` or `{state:'duplicate',payloadHash,receipt}`, or `{state:'conflict'}`. Key on `(companyId,eventId)`; conflicting hashes must not be accepted. A concurrent pending record without receipt is 409, not accepted.
- `recordResult({intent,mapping,receipt})` → durably persist the simulation receipt; must not send a message.

**Current Desk mount passes no ports and intentionally returns 503**. Do not fake a mapping by equating Desk `user_id` and Field `company_id`. DB owner should provide ports and staged tests; changing the registration line is necessary once those ports exist.

## Environment switches (do not set on live systems yet)

**Field (Next.js):** `TITAN_FIELD_DESK_SHADOW_MODE=1`, `TITAN_DESK_BRIDGE_URL=https://<trusted-host>/api/titan-bridge/v1/communication-intents` (or loopback HTTP), `TITAN_DESK_BRIDGE_SECRET=<distinct high-entropy secret>`.

**Desk (Express):** `TITAN_FIELD_BRIDGE_MODE=shadow`, `TITAN_FIELD_BRIDGE_SECRET=<same secret>`.

No provider dispatch exists in this pass. A `202 simulated/not_sent` result is evidence only of the shadow handoff, **not a delivered message**.

## Staging apply procedure (after backups and review)

1. Create a **separate** clean Desk working tree from the exact Desk backup and a Field working tree from the exact server source. **Do not edit the production directories.**
2. Copy contents of `desk/server/integrations/titan-field/` into the Desk working tree at the same relative path.
3. `cd` to the Desk staging repository root, run `git apply --check /path/to/verification/desk-routes.patch` and then `git apply /path/to/verification/desk-routes.patch`. If the patch no longer applies, manually port only the import and `app.use()` lines. Never replace a newer `server/routes.ts` blindly.
4. Copy contents of `field/apps/web/lib/titan/desk-bridge/` and the additive Next.js preview `route.ts` into the Field staging repository, retaining existing files.
5. Run `node --test verification/bridge.integration.test.mjs` **from this handoff root**, and run full Desk/Field typechecks and integration tests in their own dependency-installed staging trees before any deployment. This standalone archive did not contain node_modules, so complete application typecheck/build were not run.
6. Have the DB integration agent implement tenant and ledger ports; test a cross-company mismatch and revoke-consent race before commissioning even shadow traffic.

## Tested evidence

- Node.js `v22.16.0` built-in test runner: **16 passed, 0 failed**.
- A local HTTP server accepted a signed request, simulated an event and returned a correlated `not_sent` receipt, with zero external provider calls.
- TypeScript `transpileModule` parsed **3 changed TypeScript files with 0 syntax diagnostics**. This is **not** a full typecheck.
- The 21-line Desk registration diff passed `git apply --check` against the supplied Desk backup; application of the patch produced exactly the intended changed file (SHA-256 verified).
- No live API, database, email, SMS, checkout or server runtime test was run.

## Work still needed

- Wire DB-agent scoped identity/consent/atomic ledger ports and cross-service audit/recovery semantics.
- Implement a safe live provider adapter **only after** customer consent/approval and shadow parity signoff.
- Integrate Field's actual event-outbox and selected reminders/notifications, preserving email/SMS owner alerts distinctly from customer messages; current preview is intentionally not a live send-path replacement.
- Port distinct server-only Field reports/portal/Titan Go changes to GitHub source under semantic test gates.
- Integrate the GitHub canonical shared Workforce runtime separately after checking authorisation, provider readiness and environment deployment.

## Change measurements (new patch payload, not live production)

- New code files: 6 (2 copies of shared protocol, Field client, Field API preview route, Desk receiver, Desk Express router).
- Existing source files modified: 1 (`server/routes.ts`, **5 added lines**: 1 import + 2 comments + 1 registration call + 1 blank line; exact patch above).
- Test files: 1 (16 passing tests); documentation: 1; patch artifact: 1.
- GitHub changes: none. Live DirectAdmin changes: none. Database changes: none. 

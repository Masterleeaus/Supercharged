# Titan Field + Desk — Pass 5 cumulative source patch

**Status:** implemented and isolated-tested; **not deployed**. This is an additive/modified **source PATCH**, not a complete runnable copy of either application. The ZIP preserves Passes 3 and 4, adds Pass 5, and records all modified files by checksum. The other agent owns database connections, migrations, identity mapping, durable replay ledger and persistence. This pass makes zero database changes.

## Implemented source (substantial coherent batch)

- Three read-only customer-communication projections: **booking confirmations**, **sent-estimate follow-ups**, and **invoice follow-up simulations**. All operate on existing Field business data. They are separate from the existing email automations, which are unchanged.
- Shared **company-scoped batch engine** (`shadow-foundation.mjs`): strict UUID/account checks, current explicit SMS consent, deterministic event/correlation IDs, bounded reads, failure-isolated event output, exact correlated `not_sent` receipt validation, customer/phone-redacted responses.
- Owner/admin-only `POST /api/v1/titan/desk-bridge/revenue-shadow`, feature-gated by **both** `TITAN_FIELD_DESK_SHADOW_MODE=1` and `TITAN_FIELD_DESK_REVENUE_SHADOW_MODE=1`; defaults to **dry run**. Only source reads and synthetic Desk receipts are supported. No scheduled worker added.
- Desk **template policy allowlist** used by the authenticated receiver: channel/resource restrictions for reminder, update, booking confirmation, estimate and invoice; unknown/unapproved templates denied before mapping/ledger calls.
- PII-minimizing activity stream summary (`response-projection.mjs`), now returned from the new Field route in addition to the existing bounded event report.
- Pass 3 manual preview retry hardening: caller supplies stable `requested_at`; `correlation_id` is stable based on `event_id`; repeated requests do not change signature payload inadvertently. Both deployed wire-protocol copies are byte-identical and now support a test-injected clock for reproducible projection tests.
- Financial source check preserves invoice paid/balance controls and excludes whole-job invoices on open jobs. **An operator-provided billing date is NOT certification of invoice eligibility, legal collection authority, or timezone policy; this flow is simulation-only.** It will require canonical billing policy integration and approval before sending any real customer payment reminder.

## Exact source basis

- Field partial server source: `titan-field-SERVER-SOURCE-DELTA-20261101-233807.zip` (703 original files), separate from GitHub Titan Field `main` at `b6fed9da4ab411dc8f147b30e418854e015b216c`.
- Desk: user-supplied `Desk backup.zip` (`agentlabs` 5.4.5), Express/Drizzle. Full build/deploy code is not bundled or claimed.
- Pass 4 cumulative source checkpoint: preserved and extended. No original Desk source files are distributed here except the narrow additive router patch.

## Files and test commands

```bash
cd <unpacked cumulative archive>
node --test verification/*.test.mjs
```

Pass 5 was checked with Node.js v22.16.0: **75 focused tests passed, 0 failed**, counting the preserved 35 Pass 3/4 tests and 40 added in Pass 5. All .mjs files passed `node --check`; four application TypeScript route files passed the TypeScript syntax parser (0 diagnostics). Neither full app was built or typechecked against all dependencies, and no live provider/database/DirectAdmin integration was exercised.

## Deployment and merge blockers

1. Do not merge ZIPs directly into the live DirectAdmin application. Apply changed files on an isolated source tree with current GitHub/server sources compared at exact heads.
2. **DB agent dependency:** one verified `company_id` resolver, current consent verification and atomic durable event claim + recordResult ports. Keep Desk's `createTitanFieldBridgeRouter()` **unconfigured** until these ports are available and integration-tested. Never select the first owner account.
3. Preserve the original `server/routes.ts`; `verification/desk-routes.patch` is a historical additive patch and must be reviewed against current Desk code, not applied blindly.
4. No provider adapters or message delivery in these source files. `simulated/not_sent` can never be rendered as delivered or billed as a send.
5. Field billing and follow-up workers continue unchanged. Owner-only source shadow must not be confused with a real customer send or a completed original notification queue item.
6. Full Field Next.js build, Desk TypeScript/Express build, authenticated staging E2E, tenant isolation, replay recovery, provider opt-out and deployment rollback remain outstanding.

## Measured per-pass source diff vs Pass 4

- Application source files added: 8
- Existing application source files changed: 4
- Application source files deleted: 0
- Lines added: 348; removed: 5; net: 343
- Cumulative application source files: 16 (1020 source lines)
- Added isolated test files: 3

This ZIP contains **all source patch files through Pass 5**, not the full apps or a live deployment.

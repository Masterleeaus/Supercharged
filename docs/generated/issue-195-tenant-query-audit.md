# Issue #195: tenant query audit

Date: 2026-11-18. Scope: `server/` query sites. Method: text scan with a short node script (not committed). A file counts as
"company-scoped" when its source mentions `companyId`, `company_id`, `tenant`, `withTenant` or `orgId`. A
file that does not is flagged for review. The flag is a review queue, not a finding of a leak.

## Default scope done in this change: the Central-link path

Every SQL site under `server/infrastructure/central-link` and `server/infrastructure/central-sso` is listed.

- `central-sso/link-query.ts`: runs inside `withTenant(pool, companyId)` and calls `app_central_desk_resolve_link($1,$2,$3::uuid)`. Scoped. Test: `central-link-query-scope.test.mjs` ("carry the verified company key").
- `central-sso/tenant-membership.ts`: `WHERE company_id = $1::uuid AND user_id = $2`. Scoped. Tests: `central-tenant-membership.test.mjs` (two memberships; revoked membership refused).
- `central-sso/account-resolver.ts`: refuses a link row whose `company_id` differs from the verified company. Test: `central-sso-account-resolver.test.mjs`.
- `central-link/link-assertion.ts`: `link_nonces` replay table. Global by design (no tenant data). Reviewed in `GLOBAL_SITES`.
- `central-sso/pending-store-db.ts`: pending sign-in state keyed by state hash, before the company is known. Global by design. The insert cap counts all rows, not per company. Reviewed in `GLOBAL_SITES`.

Guard: `tests/infrastructure/central-link-query-scope.test.mjs` fails when a new SQL site appears on this path without a company key or a reviewed global entry.

## Rest of `server/`: review queue (owner decision needed on order and scope)

Scan result: 367 files with query sites, about 3,500 sites. 190 files mention a company key. 177 files do not
(about 1,457 sites). Largest unscoped groups, by site count:

- `seed-all.ts` (236 sites): seed script, not a request path. Likely global.
- `routes/admin` (10 files, 132 sites): admin routes. Need an owner decision on whether admin is cross-tenant by design.
- `engines/plivo` (7 unscoped of 12 files, 100 sites): telephony engine.
- `storage/analytics-helpers.ts` (74), `storage/crm-storage.ts` (48): storage helpers. Check callers for company filters.
- `routes/user-sip-gateways.routes.ts` (70), `routes/transactions-routes.ts` (22), `routes/phone-routes.ts` (11), `routes/refund-routes.ts` (10), `routes/user-address-routes.ts` (10): user-facing routes. Highest priority for review.
- `routes/webhook-modules` (10 unscoped files, 62 sites): webhook handlers. Review with the webhook secret work (#2).
- `services/elevenlabs-pool.ts` (58), `services/sip-credit-guard.ts` (24), `services/recording-service.ts` (18), `services/post-call-messaging.ts` (18): services.
- `engines/elevenlabs-migration` (32), `engines/kyc` (23), `engines/payment` (12): engines.
- `infrastructure/bullmq` (24): queue jobs. Jobs must carry the company key.
- `middleware/admin-auth.ts` (19), `plugins/loader.ts` (16), `routes/plugin-installer.ts` (16), `demo-mode/index.ts` (16).
- `modules/chatbot` (8 unscoped of 92 files, 21 sites), `modules/widget`, `modules/comms`, `modules/inbox`: mostly scoped already.



## Decisions and open items

- Default chosen: close the audit for the Central-link path only. The rest is listed above for the owner to order.
- Owner decision needed: which areas are cross-tenant by design (admin, seed, global settings), and the order of review for user-facing routes.
- Not done: per-query review of the 177 flagged files. Not done: a route-level tenant test for each area.

## Full list of groups (sorted by unscoped sites; top 60)

- seed-all.ts: 1 sites, =236 unscoped
- routes/admin: 10 sites, =132 unscoped
- engines/plivo: 12 sites, =100 unscoped
- storage/analytics-helpers.ts: 1 sites, =74 unscoped
- routes/user-sip-gateways.routes.ts: 1 sites, =70 unscoped
- routes/webhook-modules: 19 sites, =62 unscoped
- services/elevenlabs-pool.ts: 1 sites, =58 unscoped
- storage/crm-storage.ts: 1 sites, =48 unscoped
- engines/elevenlabs-migration: 4 sites, =32 unscoped
- routes/core: 9 sites, =28 unscoped
- infrastructure/bullmq: 2 sites, =24 unscoped
- services/sip-credit-guard.ts: 1 sites, =24 unscoped
- engines/kyc: 2 sites, =23 unscoped
- routes/transactions-routes.ts: 1 sites, =22 unscoped
- modules/chatbot: 92 sites, =21 unscoped
- middleware/admin-auth.ts: 1 sites, =19 unscoped
- services/post-call-messaging.ts: 1 sites, =18 unscoped
- services/recording-service.ts: 1 sites, =18 unscoped
- demo-mode/index.ts: 1 sites, =16 unscoped
- plugins/loader.ts: 1 sites, =16 unscoped
- routes/plugin-installer.ts: 1 sites, =16 unscoped
- engines/plivo-elevenlabs: 6 sites, =15 unscoped
- services/sip-transfer-resync.ts: 1 sites, =14 unscoped
- engines/payment: 8 sites, =12 unscoped
- infrastructure/central-sso: 6 sites, =12 unscoped
- services/elevenlabs.ts: 1 sites, =12 unscoped
- services/google-calendar: 2 sites, =12 unscoped
- routes/phone-routes.ts: 1 sites, =11 unscoped
- services/system-update-service.ts: 1 sites, =11 unscoped
- routes/agent: 3 sites, =10 unscoped
- routes/refund-routes.ts: 1 sites, =10 unscoped
- routes/user-address-routes.ts: 1 sites, =10 unscoped
- scripts/inspect-calls.ts: 1 sites, =10 unscoped
- services/voice-sync.ts: 1 sites, =10 unscoped
- routes/platform-languages-routes.ts: 1 sites, =9 unscoped
- services/call-matcher.ts: 1 sites, =8 unscoped
- services/call-sync.ts: 1 sites, =8 unscoped
- services/credit-backfill-monitor.ts: 1 sites, =8 unscoped
- services/startup-health-check.ts: 1 sites, =8 unscoped
- routes/analytics-routes.ts: 1 sites, =7 unscoped
- routes/public-marketing-routes.ts: 1 sites, =7 unscoped
- routes/public-routes.ts: 1 sites, =7 unscoped
- services/google-sheets: 2 sites, =7 unscoped
- engines/twilio-openai: 7 sites, =6 unscoped
## Full list of groups (sorted by unscoped sites; top 60)

    seed-all.ts  files=1  sites=236  unscopedFiles=1  unscopedSites=236
    routes/admin  files=10  sites=132  unscopedFiles=10  unscopedSites=132
    engines/plivo  files=12  sites=173  unscopedFiles=7  unscopedSites=100
    storage/analytics-helpers.ts  files=1  sites=74  unscopedFiles=1  unscopedSites=74
    routes/user-sip-gateways.routes.ts  files=1  sites=70  unscopedFiles=1  unscopedSites=70
    routes/webhook-modules  files=19  sites=177  unscopedFiles=10  unscopedSites=62
    services/elevenlabs-pool.ts  files=1  sites=58  unscopedFiles=1  unscopedSites=58
    storage/crm-storage.ts  files=1  sites=48  unscopedFiles=1  unscopedSites=48
    engines/elevenlabs-migration  files=4  sites=32  unscopedFiles=4  unscopedSites=32
    routes/core  files=9  sites=32  unscopedFiles=7  unscopedSites=28
    infrastructure/bullmq  files=2  sites=24  unscopedFiles=2  unscopedSites=24
    services/sip-credit-guard.ts  files=1  sites=24  unscopedFiles=1  unscopedSites=24
    engines/kyc  files=2  sites=23  unscopedFiles=2  unscopedSites=23
    routes/transactions-routes.ts  files=1  sites=22  unscopedFiles=1  unscopedSites=22
    modules/chatbot  files=92  sites=647  unscopedFiles=8  unscopedSites=21
    middleware/admin-auth.ts  files=1  sites=19  unscopedFiles=1  unscopedSites=19
    services/post-call-messaging.ts  files=1  sites=18  unscopedFiles=1  unscopedSites=18
    services/recording-service.ts  files=1  sites=18  unscopedFiles=1  unscopedSites=18
    demo-mode/index.ts  files=1  sites=16  unscopedFiles=1  unscopedSites=16
    plugins/loader.ts  files=1  sites=16  unscopedFiles=1  unscopedSites=16
    routes/plugin-installer.ts  files=1  sites=16  unscopedFiles=1  unscopedSites=16
    engines/plivo-elevenlabs  files=6  sites=15  unscopedFiles=6  unscopedSites=15
    services/sip-transfer-resync.ts  files=1  sites=14  unscopedFiles=1  unscopedSites=14
    engines/payment  files=8  sites=14  unscopedFiles=7  unscopedSites=12
    infrastructure/central-sso  files=6  sites=14  unscopedFiles=4  unscopedSites=12
    services/elevenlabs.ts  files=1  sites=12  unscopedFiles=1  unscopedSites=12
    services/google-calendar  files=2  sites=12  unscopedFiles=2  unscopedSites=12
    routes/phone-routes.ts  files=1  sites=11  unscopedFiles=1  unscopedSites=11
    services/system-update-service.ts  files=1  sites=11  unscopedFiles=1  unscopedSites=11
    routes/agent  files=3  sites=10  unscopedFiles=3  unscopedSites=10
    routes/refund-routes.ts  files=1  sites=10  unscopedFiles=1  unscopedSites=10
    routes/user-address-routes.ts  files=1  sites=10  unscopedFiles=1  unscopedSites=10
    scripts/inspect-calls.ts  files=1  sites=10  unscopedFiles=1  unscopedSites=10
    services/voice-sync.ts  files=1  sites=10  unscopedFiles=1  unscopedSites=10
    routes/platform-languages-routes.ts  files=1  sites=9  unscopedFiles=1  unscopedSites=9
    services/call-matcher.ts  files=1  sites=8  unscopedFiles=1  unscopedSites=8
    services/call-sync.ts  files=1  sites=8  unscopedFiles=1  unscopedSites=8
    services/credit-backfill-monitor.ts  files=1  sites=8  unscopedFiles=1  unscopedSites=8
    services/startup-health-check.ts  files=1  sites=8  unscopedFiles=1  unscopedSites=8
    routes/analytics-routes.ts  files=1  sites=7  unscopedFiles=1  unscopedSites=7
    routes/public-marketing-routes.ts  files=1  sites=7  unscopedFiles=1  unscopedSites=7
    routes/public-routes.ts  files=1  sites=7  unscopedFiles=1  unscopedSites=7
    services/google-sheets  files=2  sites=7  unscopedFiles=2  unscopedSites=7
    engines/twilio-openai  files=7  sites=71  unscopedFiles=1  unscopedSites=6
    infrastructure/openai  files=1  sites=6  unscopedFiles=1  unscopedSites=6
    modules/comms  files=7  sites=15  unscopedFiles=3  unscopedSites=6
    modules/widget  files=4  sites=75  unscopedFiles=1  unscopedSites=6
    routes/public-system-routes.ts  files=1  sites=6  unscopedFiles=1  unscopedSites=6
    scripts/test-credit-backfill-monitor.ts  files=1  sites=6  unscopedFiles=1  unscopedSites=6
    services/crm-lead.service.ts  files=1  sites=6  unscopedFiles=1  unscopedSites=6
    infrastructure/database  files=3  sites=10  unscopedFiles=1  unscopedSites=4
    infrastructure/websocket  files=1  sites=4  unscopedFiles=1  unscopedSites=4
    modules/inbox  files=7  sites=32  unscopedFiles=2  unscopedSites=4
    scripts/update-sarvam.ts  files=1  sites=4  unscopedFiles=1  unscopedSites=4
    seed-global-settings.ts  files=1  sites=4  unscopedFiles=1  unscopedSites=4
    seed-platform-languages.ts  files=1  sites=4  unscopedFiles=1  unscopedSites=4
    seed-seo-settings.ts  files=1  sites=4  unscopedFiles=1  unscopedSites=4
    services/elevenlabs-phone-resync.ts  files=1  sites=4  unscopedFiles=1  unscopedSites=4
    services/phone-billing-cron.ts  files=1  sites=4  unscopedFiles=1  unscopedSites=4
    utils/stream-token.ts  files=1  sites=4  unscopedFiles=1  unscopedSites=4

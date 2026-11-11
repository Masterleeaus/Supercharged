# Marketing SQL rollout sequence

1. Review the archived `migrations/archive/DRAFT_marketing.sql` for current schema and tenancy requirements. Do not run an archived draft as an ad-hoc production migration.
2. Promote it into the numbered, reviewed migration system. Ensure the restricted `desk_app` role has minimal privileges and row-level security is enabled and tested for both `landing_pages` and `content_items`.
3. Verify the `(company_id, slug)` unique constraint and test slug conflicts under simultaneous inserts.
4. Inject `createSqlMarketingStore({pool})` into the existing `createMarketingService` after wiring company-scoped campaign and chatbot reference ports.
5. Exercise company A/B reads, writes, publishing and cross-company reference denial against actual PostgreSQL transactions.
6. Only then inject the durable service into `registerOptionalCommsRoutes` and opt in to `COMMS_MARKETING_ENABLED=true`.

Pass 8 prepares an adapter, **not** a promoted migration, verified RLS policy or public marketing deployment. Production mounting stays disabled and fail closed until every dependency is explicitly supplied.

## Proposed reviewed migration

A candidate that includes both table definitions and restricted-role RLS is in `migrations/candidates/0017_marketing_tenant_rls.sql`. Verify it against a disposable PostgreSQL database before promoting it into the automatic migration manifest. Run `node scripts/check-marketing-migration.mjs` as a static preflight; this is not a database integration test. No runtime flags were changed in Pass 9.

## PostgreSQL integration gate

The dedicated `marketing-postgres` workflow uses an ephemeral PostgreSQL service to exercise direct RLS policies and actual SQL store writes. Even a green result is not production deployment: the candidate remains excluded from `scripts/run-safe-migration.mjs`, pending review and target-environment verification.

## Pass 11: deployment readiness gate

Even with passing PostgreSQL CI, the production database must be inspected before a SQL-backed Marketing service is constructed. Call `createVerifiedMarketingService` with the tenant pool, a PostgreSQL catalog probe, and real campaign/chatbot reference ports. Its read-only readiness check verifies FORCE RLS, role restrictions, table privileges and company-bound policies. An absent schema or unavailable reference port aborts construction. The production flag remains disabled until the verified instance is integrated with auth and route registration.

## Row-level security review check

Before enabling Marketing, run the read-only schema verifier against the target database and audit **every** RLS policy affecting desk_app and PUBLIC. The required policy alone is insufficient if an additional permissive policy broadens access. Pass 12 introduces strict predicate and policy combination validation. Keep the feature disabled until passing production-equivalent checks.

## Pass 13 — actual server registration

The main Workforce/Comms route registrar now uses the verified asynchronous Marketing composition root. In an un-migrated environment the default disabled flag causes no Marketing database lookup and no route mount. Setting `COMMS_MARKETING_ENABLED=true` requires a verified Marketing schema, forced RLS and restricted database roles, otherwise server startup refuses activation. Chatbot links use existing canonical ChatbotStorage; campaign links are refused until the new campaigns schema is deployed.

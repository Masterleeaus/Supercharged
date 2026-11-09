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

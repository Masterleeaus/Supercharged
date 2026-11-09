# Marketing RLS candidate (Pass 9)

The SQL file `migrations/candidates/0017_marketing_tenant_rls.sql` combines the archived Marketing table structure with row-level policies for both tables. It is a **candidate**, deliberately excluded from `scripts/run-safe-migration.mjs` and from automated deployment.

Required prerequisite: an existing restricted `desk_app` database role, NOT SUPERUSER and WITHOUT BYPASSRLS, plus a login role permitted to `SET LOCAL ROLE desk_app`. The migration intentionally does not create a role or assign a password.

Tables use company_id UUID, `FORCE ROW LEVEL SECURITY`, and both `USING` and `WITH CHECK` comparing to transaction-local `app.company_id`. A static preflight script at `scripts/check-marketing-migration.mjs` verifies the shape but **cannot** substitute for a real two-tenant PostgreSQL integration test.

Before review approval, test reapplication against a disposable database, verify row ownership, confirm application login role membership, review default privileges and confirm that `landing_pages` and `content_items` are not already owned or named differently in the target database. Promote into the production manifest only after those gates pass.

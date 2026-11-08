# Desk tenancy model

Status: primitives added, no live table scoped yet.

## Tenant key

The tenant key is `company_id`, a UUID. Desk has no `company_id` columns yet.
The value comes from the authenticated user and never from a request body,
query string, route parameter or header.

## Which code path sets the tenant

1. **Authentication** puts the user on `req.user`. Today `server/middleware/auth.ts`
   sets `{ id, role }` from the JWT. A company claim has to be added to token
   issuance and copied onto `req.user.company_id` before scoped routes can work.
2. **`requireCompanyScope()`** (`server/middleware/company-scope.ts`) answers 403
   when `req.user.company_id` is missing or not a UUID.
3. **`getCompanyScope(req)`** returns that same validated value in a route handler.
4. **`withTenant(pool, companyId, fn)`** (`server/infrastructure/database/tenant-context.ts`)
   is the only place the database session is scoped. It:
   - validates the UUID and the role name before taking a connection,
   - runs `BEGIN`, then `SET LOCAL ROLE desk_app`,
   - runs `set_config('app.company_id', $1, true)` with a bind parameter,
   - runs `fn(client)`, then `COMMIT`, or `ROLLBACK` and rethrows on error.

Because the setting is transaction-local, it is cleared on commit or rollback.
A pooled connection cannot carry one company's id into the next request.

Queries on the plain pool, outside `withTenant`, run with no company setting.
Policies match zero rows for them, so the default is to see nothing.

## Why the app role must not own tables

A policy only applies to a role that is subject to it. The table owner is exempt
unless the table has `FORCE ROW LEVEL SECURITY`. An owner can also run
`ALTER TABLE ... NO FORCE` or `DROP POLICY`, which turns the policy off. A
superuser or a role with `BYPASSRLS` skips policies entirely.

So the role that runs tenant queries (`desk_app`) must:

- not own any table,
- not be a superuser,
- not have `BYPASSRLS`.

The app logs in with a separate login role. `withTenant` runs `SET LOCAL ROLE desk_app`
so that the tenant queries run as the restricted role for that one transaction, even
if the login role owns tables. The login role needs `GRANT desk_app TO <login role>`
for that switch to be allowed.

## Migration plan for existing tables

No existing table or query has been changed. The steps below are a plan.

1. **Primitives (this pass).** `withTenant`, the middleware, and the draft SQL.
   The draft is in `migrations/DRAFT_company_scope.sql` and is not in the
   migration runner's list.
2. **Add nullable columns.** For each table that holds company data, add
   `company_id uuid NULL`. Index it. This is additive and does not block writes.
3. **Backfill.** Fill `company_id` from the owning record (for example, through
   the user's company). Run as the owner, outside any policy. Check that no rows
   are left NULL.
4. **Route by route.** Move each route to `withTenant(pool, getCompanyScope(req), ...)`
   and to `requireCompanyScope()`. Test each route before the next.
5. **Enable policies.** Turn on `ENABLE` and `FORCE ROW LEVEL SECURITY` and create
   the policy for each table. Grant `desk_app` only the verbs it needs. Do this
   after step 4 for that table, since queries outside `withTenant` return no rows
   once FORCE is on.
6. **Enforce.** Set `company_id` to `NOT NULL` and add the foreign keys that
   apply.

Each step is a separate, reviewed change. Steps 2 and 3 run against a database
only in an approved window, and step 5 needs a rollback path (`NO FORCE`,
`DISABLE`, drop the policy).

## Open items

- Token issuance must include `company_id`, and auth must copy it onto `req.user`.
- The `desk_app` password is set out of band.
- Choose the real example table for step 5.
- Team-member sessions (`hybrid-auth.ts`) set `req.userId` to the parent user.
  They need the same company claim before they can use scoped routes.

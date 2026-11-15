# Widget tenancy decision (issue #127)

Status: decision brief for the owner. No code changed.

## The question

Should website widgets belong to a company (`company_id`) instead of a user (`user_id`)?

## What the code does today

- `website_widgets` has `user_id NOT NULL` (FK to `users`). All dashboard routes in `server/modules/widget/widget-routes.ts` and all storage methods in `server/modules/widget/widget-storage.ts` filter by `user_id` only.
- `shared/schema.ts` also has a nullable `company_id` column on `website_widgets`, with an index. It is omitted from the insert schema.
- `createWidget` never sets `company_id`, so new widgets get `NULL`.
- `server/modules/widget/public-widget-routes.ts` reads `widget.companyId` and fails closed when it is `NULL`. Session end and appointment booking return 403 for those widgets.
- No applied migration in `migrations/` adds `company_id` to `website_widgets`. Only archived drafts (`migrations/archive/DRAFT_company_scope.sql`, `DRAFT_companies_foundation.sql`) do. The live database state still needs checking.
- `docs/TENANCY-INVENTORY.md` lists `website_widgets` as a user-tenant table.

So the code is half-moved: the public side expects a company, the dashboard side uses a user.

## Option A: scope widgets by company

What it means: every widget row carries `company_id`. Dashboard reads and writes filter by the company of the signed-in user.

Steps (additive, in order):
1. Migration: add `company_id uuid NULL` and its index (the draft already has this). Additive only.
2. Backfill: set `company_id` from `users.company_id` where `user_id` matches. Check no `NULL` rows remain before the next step.
3. Code: `createWidget` sets `company_id` from the signed-in user. Dashboard list, get, update and delete filter by company.
4. Optional later step: add `NOT NULL` once the backfill is clean and code always writes it.
5. Tests: unit tests for company filtering, and a cross-company test (user from company B cannot read company A's widget).

Rollback:
- Steps 1 and 2 are additive. Reverting code to user scope is safe, because `user_id` stays.
- Dropping the column is only needed if the whole change is abandoned. Do it only after code no longer reads it.

Costs:
- Medium work: schema, backfill, storage, routes, tests.
- Owner decision needed: a user can belong to more than one company (`user_company_memberships`, migration 0017). Which company does a request act as? Without an answer, Option A is not buildable.
- Team behaviour changes: other people in the same company would see each other's widgets. That may be wanted, but it is a product change.

## Option B: keep user scope and document the risk

What it means: widgets stay owned by one user. Write down that the public side reads `company_id`, and accept the gap.

Costs:
- Almost no code work.
- The 403 problem stays. Widgets created today cannot end sessions or book appointments, unless someone fixes `createWidget` or backfills by hand.
- Company-level features (credits, reports, team access) will keep disagreeing with widget ownership.
- Real cross-company leakage from user scope is low today, because each user only sees their own rows. The risk is mostly broken features and future drift, not an open data leak.

## Recommendation

Choose Option A, in two parts:

1. Now, small and safe: make `createWidget` write `company_id` and backfill existing rows. This fixes the live 403 path and needs no product decision. It is additive.
2. After the owner answers the open questions below, switch the dashboard reads and writes to company scope.

Reasons:
- The public routes already assume a company. Staying on user scope keeps the two halves disagreeing.
- Part 1 is additive, reversible, and stops current breakage.
- Part 2 waits for the owner, because it changes who can see what.

## Open questions for the owner (one at a time)

1. When a user belongs to several companies, which one does a widget belong to? Proposed default: the user's primary company (`users.company_id`).
2. Should other users in the same company see and edit a company's widgets? Proposed default: yes, admins only for delete.

Until these are answered, nothing in Option A's part 2 should be built.

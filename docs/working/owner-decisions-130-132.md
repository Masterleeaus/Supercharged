# Owner decisions: #130, #131, #132

Recorded 2026-11-15 by the issue-triage run. Each entry is the choice this repository follows. The owner should confirm it on the issue.

## #132: Database for the boot check

- **Choice:** native PostgreSQL (CI or Docker service), not PGlite.
- **Why:** the migrations use Postgres features that PGlite may not support. A native service is closest to production (`infra/compose.garonhome.yml`).
- **Consequence:** boot-check and tenant-isolation jobs need a real Postgres service. They read `TEST_DATABASE_URL`.
- **Related:** #26.

## #130: Membership table or company_id column

- **Choice:** membership table, `user_company_memberships` (migration `0017_user_company_memberships.sql`).
- **Why:** one user can belong to more than one company. This avoids a second migration later.
- **Status on main:** implemented. The migration is additive and has rollback SQL in its header (`DROP TABLE IF EXISTS user_company_memberships;`). Tests: `tests/infrastructure/user-company-memberships.test.mjs`, `tests/postgres/tenant-postgres-memberships.test.mjs`.
- **Related:** #51.

## #131: Unnumbered `add_missing_columns.sql` migration

- **Choice on main:** the file was removed in commit `dc7b6e3`, which also added migration 0017.
- **Open question for the owner:** the issue asks for a decision and the choice is not yet recorded on the issue. Confirm that removal is final. If the file was needed, it must get a number and a journal entry. It must not be restored unnumbered.
- **Related:** #34.

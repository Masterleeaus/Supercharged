# Real PostgreSQL CI integration (Pass 10)

The `marketing-postgres` GitHub Actions job starts a disposable Postgres 16 service. It expressly opts into `MARKETING_PG_DISPOSABLE=true`, creates a restricted **NOLOGIN** test role, applies the Marketing migration candidate to that ephemeral instance, and runs the `tests/postgres/marketing-postgres-*.test.mjs` suite.

Test coverage: restricted database role, enabled and forced RLS, actual two-tenant reads and writes, direct cross-company SQL denial, the company-bound unique slug constraint, and database-backed publication/approval transitions.

**Safety:** The fixture never runs without both the disposable opt-in and an integration database URL. The production migration list and production database remain unchanged. This is a CI-only candidate proof, not authorization to deploy the schema. Run this job successfully before changing production flags.

## Pass 11: environment-specific validation

Passing disposable PostgreSQL tests is necessary but not enough for production. A new read-only schema verifier queries `pg_roles`, `pg_class` and `pg_policies` against the database that will serve the application. Runtime service construction fails closed when role privileges, FORCE RLS, or tenant policies are absent or invalid. The catalog-checking connection must have sufficient metadata visibility; it must not be used for tenant data operations.

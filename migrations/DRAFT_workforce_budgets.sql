-- DRAFT - NOT APPLIED. Do not run. Not part of the numbered migration sequence and not in the journal
-- (migrations/meta). Not run by any migration tooling.
-- Persists the counters that server/workforce/runtime/budgets.ts keeps in memory, for pg-budgets.ts.
--
-- This table is NOT in shared/schema.ts and is NOT declared there. It is used only through raw SQL in
-- server/workforce/runtime/pg-budgets.ts. shared/schema.ts was not edited.
--
-- Row meaning (scope and scope_key):
--   scope = 'company', scope_key = '', day = UTC calendar day. runs = runs started that day,
--     spend_cents = company spend that day. Mirrors CompanyDay in budgets.ts.
--   scope = 'run', scope_key = run id, day = the sentinel 1970-01-01. tool_calls, tokens, spend_cents are the
--     run's totals. Run usage is not day-scoped in budgets.ts, so the sentinel keeps it across UTC midnight.
--     runs = 1 once the run has been started and counted against its company's daily run quota, 0 before.
--
-- Tenant key is company_id, NOT NULL. Every query in pg-budgets.ts filters on it.
-- There is no companies table yet, so no foreign keys.

CREATE TABLE IF NOT EXISTS workforce_budget_usage (
  company_id    uuid NOT NULL,
  scope         text NOT NULL CHECK (scope IN ('company', 'run')),
  scope_key     text NOT NULL,
  day           date NOT NULL,
  tool_calls    integer NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
  tokens        integer NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  spend_cents   integer NOT NULL DEFAULT 0 CHECK (spend_cents >= 0),
  runs          integer NOT NULL DEFAULT 0 CHECK (runs >= 0),
  PRIMARY KEY (company_id, scope, scope_key, day)
);

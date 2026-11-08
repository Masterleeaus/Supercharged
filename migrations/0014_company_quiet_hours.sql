-- ============================================================
-- Migration 0014: company quiet-hours settings in the database.
--
-- Before this, server/modules/settings/company-settings.ts kept quiet hours in a process-local Map.
-- They were lost on restart and not shared across instances. This table holds one row per company.
--
-- Tenant key is company_id. The primary key is company_id, so it is also the index used for
-- lookups by company. There is no companies table yet, so no foreign key to one.
-- Row-level security for this table is not included here. Add it with the tenancy plan in
-- migrations/DRAFT_company_scope.sql.
--
-- Idempotent (IF NOT EXISTS) so a later re-run is safe.
-- ============================================================

CREATE TABLE IF NOT EXISTS company_quiet_hours (
  company_id  uuid PRIMARY KEY,
  start_hour  integer NOT NULL CHECK (start_hour BETWEEN 0 AND 23),
  end_hour    integer NOT NULL CHECK (end_hour BETWEEN 0 AND 23),
  timezone    varchar(64) NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

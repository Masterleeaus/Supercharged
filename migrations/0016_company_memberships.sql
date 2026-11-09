-- ============================================================
-- Migration 0016: user-to-company membership.
--
-- The live schema had no link from a user to a company (users has no company_id in any migration).
-- Workforce writes that set an assignee (visits.assigned_user_id, staff_tasks.assignee_user_id) need
-- to check that the assignee belongs to the caller's company. This table holds that link.
--
-- Additive only: one new table, nothing altered or backfilled. Rows are added by the owner or by a later
-- change; this migration does not create any memberships.
--
-- Reversal (no data depends on it outside this table):
--   DROP TABLE IF EXISTS company_memberships;
--
-- Idempotent (IF NOT EXISTS) so a later re-run is safe.
-- ============================================================

CREATE TABLE IF NOT EXISTS company_memberships (
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id)
);

CREATE INDEX IF NOT EXISTS company_memberships_user_id_idx ON company_memberships (user_id);

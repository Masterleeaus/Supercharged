-- ============================================================
-- Migration 0017: user to company membership table (issue #130).
--
-- Owner decision: a membership table, not a users.company_id column, so one user
-- can belong to more than one company. Each row links one user to one company.
--
-- Additive only. Existing tables are not changed. users.company_id (declared in
-- shared/schema.ts, not created by any numbered SQL file) is left in place and is
-- copied into this table when that column exists.
--
-- Tenant key is company_id. There is no companies table yet, so no foreign key
-- to one (same as 0015). The primary key (user_id, company_id) stops duplicate
-- memberships and serves lookups by user.
--
-- ROLLBACK (reversible; run by hand only if this migration must be undone):
--   DROP TABLE IF EXISTS user_company_memberships;
--
-- Idempotent (IF NOT EXISTS / ON CONFLICT) so a later re-run is safe.
-- ============================================================

CREATE TABLE IF NOT EXISTS user_company_memberships (
  user_id     varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, company_id)
);

CREATE INDEX IF NOT EXISTS user_company_memberships_company_id_idx
  ON user_company_memberships (company_id);

-- Backfill from the legacy users.company_id column, only when that column exists.
DO $backfill$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'users'
      AND column_name = 'company_id'
  ) THEN
    INSERT INTO user_company_memberships (user_id, company_id)
    SELECT u.id, u.company_id
    FROM users u
    WHERE u.company_id IS NOT NULL
    ON CONFLICT (user_id, company_id) DO NOTHING;
  END IF;
END $backfill$;

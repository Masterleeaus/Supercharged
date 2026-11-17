-- ============================================================
-- Migration 0026 (renumbered from 0018 at merge, main already uses 0018): company_id on website widgets (issue #127, additive step).
--
-- Owner approved the additive step only. Widgets get a company_id column, and
-- existing rows are backfilled from the owner's users.company_id. Dashboard reads and
-- writes stay user-scoped (user_id) until the owner answers the open questions in
-- docs/working/widget-tenancy-decision.md. Public widget routes already read company_id.
--
-- Additive only: one nullable column and one index. No NOT NULL, no DROP, no RENAME.
-- The backfill runs only when users.company_id exists, the same way 0017 does it.
-- Rows whose owner has no company stay NULL. Public routes keep failing closed for them.
--
-- ROLLBACK (reversible; run by hand only after the code no longer writes company_id):
--   DROP INDEX IF EXISTS website_widgets_company_id_idx;
--   ALTER TABLE website_widgets DROP COLUMN IF EXISTS company_id;
--
-- Idempotent (IF NOT EXISTS, and the backfill only touches rows where company_id IS NULL).
-- ============================================================

ALTER TABLE website_widgets ADD COLUMN IF NOT EXISTS company_id uuid;

CREATE INDEX IF NOT EXISTS website_widgets_company_id_idx
  ON website_widgets (company_id);

-- Backfill from the owner's company, only when users.company_id exists.
DO $backfill$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'users'
      AND column_name = 'company_id'
  ) THEN
    UPDATE website_widgets w
    SET company_id = u.company_id
    FROM users u
    WHERE u.id = w.user_id
      AND w.company_id IS NULL
      AND u.company_id IS NOT NULL;
  END IF;
END $backfill$;

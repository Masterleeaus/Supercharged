-- ============================================================
-- DOWN for migrations/0026_website_widgets_company_id.sql (issue #127, issue #251).
-- Reviewed reversal of the additive company_id step. Run by hand only, on a disposable
-- database or after the code no longer writes company_id. The runner never runs down files.
-- ============================================================
BEGIN;
DROP INDEX IF EXISTS website_widgets_company_id_idx;
ALTER TABLE website_widgets DROP COLUMN IF EXISTS company_id;
COMMIT;

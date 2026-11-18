-- ============================================================
-- DOWN for migrations/0028_desk_app_companies_select.sql.
-- Reviewed reversal of the SELECT grant on companies. Run by hand only; the runner never runs down files.
-- ============================================================
BEGIN;
DO $revoke$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'desk_app')
     AND to_regclass('public.companies') IS NOT NULL THEN
    REVOKE SELECT ON public.companies FROM desk_app;
  END IF;
END $revoke$;
COMMIT;

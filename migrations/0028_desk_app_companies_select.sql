-- ============================================================
-- Migration 0028: SELECT on companies for the restricted desk_app role (central SSO company binding).
--
-- server/routes/core/central-sso-routes.ts checks that a company exists inside withTenant, which
-- runs as desk_app. Without this grant that lookup is denied.
--
-- Additive only: one GRANT. Read-only on companies; no write privilege, no RLS change.
-- Guarded so it does nothing when desk_app or companies is absent (fresh databases boot).
-- Reversed by 0028_desk_app_companies_select.down.sql.
-- ============================================================
BEGIN;
DO $grant$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'desk_app')
     AND to_regclass('public.companies') IS NOT NULL THEN
    GRANT SELECT ON public.companies TO desk_app;
  END IF;
END $grant$;
COMMIT;

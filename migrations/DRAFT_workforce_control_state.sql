-- ============================================================================
-- DRAFT - NOT APPLIED. DO NOT RUN.
--
-- Creates workforce_control_state, the persistent store for operator controls
-- (pause, resume, disable, retire an agent; stop a run). Read and written by
-- server/workforce/runtime/controls-pg.ts, which uses compare-and-set on status:
--   * insert only when no row exists (ON CONFLICT DO NOTHING),
--   * update only while the stored status still equals the status that was read.
--
--   * company_id uuid NOT NULL, no foreign keys (same convention as the
--     workforce_* drafts, which have no companies table yet).
--   * Primary key (company_id, kind, entry_id) is required by the ON CONFLICT
--     target in controls-pg.ts. Do not change it without changing that file.
--   * Row-level security uses the same pattern as DRAFT_shadow_changes.sql:
--     ENABLE and FORCE RLS, one FOR ALL policy keyed on current_company_id(),
--     and grants to desk_app only.
--   * Depends on the prerequisites in DRAFT_company_scope.sql (sections 1 and 2:
--     role desk_app and function public.current_company_id()).
--   * Not in scripts/run-safe-migration.mjs. Do not add it there until the
--     tenancy plan in docs/TENANCY.md is approved.
-- ============================================================================

-- GUARD: stops any accidental run of this whole file. Remove only in the approved pass.
DO $$ BEGIN RAISE EXCEPTION 'DRAFT_workforce_control_state.sql must not be executed; see server/workforce/runtime/controls-pg.ts'; END $$;

-- 0. Prerequisite check (runs only after the guard is removed) ------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'desk_app') THEN
    RAISE EXCEPTION 'desk_app role missing: apply DRAFT_company_scope.sql section 1 first';
  END IF;
  IF to_regprocedure('public.current_company_id()') IS NULL THEN
    RAISE EXCEPTION 'public.current_company_id() missing: apply DRAFT_company_scope.sql section 2 first';
  END IF;
END
$$;

-- 1. workforce_control_state ----------------------------------------------

CREATE TABLE IF NOT EXISTS workforce_control_state (
  company_id   uuid NOT NULL,
  kind         varchar(16) NOT NULL,
  entry_id     varchar(128) NOT NULL,
  status       varchar(16) NOT NULL,
  changed_by   varchar(160) NOT NULL,
  changed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, kind, entry_id),
  CONSTRAINT workforce_control_state_kind_check CHECK (kind IN ('agent', 'run')),
  CONSTRAINT workforce_control_state_status_check CHECK (
    (kind = 'agent' AND status IN ('active', 'paused', 'disabled', 'retired'))
    OR (kind = 'run' AND status = 'stopped'))
);

-- 2. Row-level security (same pattern as DRAFT_shadow_changes.sql) --------

ALTER TABLE public.workforce_control_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workforce_control_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workforce_control_state_company_isolation ON public.workforce_control_state;
CREATE POLICY workforce_control_state_company_isolation
  ON public.workforce_control_state
  AS PERMISSIVE
  FOR ALL
  TO desk_app
  USING (company_id = public.current_company_id())
  WITH CHECK (company_id = public.current_company_id());
GRANT SELECT, INSERT, UPDATE ON public.workforce_control_state TO desk_app;

-- 3. Verification (read-only, run after apply) ---------------------------
-- SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
--   FROM pg_class c
--  WHERE c.relnamespace = 'public'::regnamespace
--    AND c.relname = 'workforce_control_state';

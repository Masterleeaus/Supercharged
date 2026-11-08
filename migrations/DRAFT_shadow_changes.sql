-- ============================================================================
-- DRAFT - NOT APPLIED. DO NOT RUN.
--
-- Creates shadow_changes, the staging table for agent writes described in
-- docs/SHADOW_WRITES_DESIGN.md. An agent write lands here as a pending row.
-- Only an approval copies it into the real desk tables.
--
--   * company_id uuid NOT NULL, no foreign keys (same convention as the
--     workforce_* drafts, which have no companies table yet).
--   * Row-level security uses the same pattern as DRAFT_company_scope_extension.sql:
--     ENABLE and FORCE RLS, one FOR ALL policy keyed on current_company_id(),
--     and grants to desk_app only.
--   * Depends on the prerequisites in DRAFT_company_scope.sql (sections 1 and 2:
--     role desk_app and function public.current_company_id()).
--   * Not in scripts/run-safe-migration.mjs. Do not add it there until the
--     tenancy plan in docs/TENANCY.md is approved.
-- ============================================================================

-- GUARD: stops any accidental run of this whole file. Remove only in the approved pass.
DO $$ BEGIN RAISE EXCEPTION 'DRAFT_shadow_changes.sql must not be executed; see docs/SHADOW_WRITES_DESIGN.md'; END $$;

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

-- 1. shadow_changes -------------------------------------------------------

CREATE TABLE IF NOT EXISTS shadow_changes (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              uuid NOT NULL,
  run_id                  uuid,
  tool_id                 varchar(128) NOT NULL,
  category                varchar(32) NOT NULL,
  target_table            varchar(128) NOT NULL,
  target_id               varchar(128),
  operation               varchar(16) NOT NULL,
  before_json             jsonb,
  after_json              jsonb,
  base_version            integer,
  requested_by_agent_id   varchar(128),
  requested_by_role_id    varchar(128),
  policy_version          varchar(64),
  status                  varchar(16) NOT NULL DEFAULT 'pending',
  approved_by_kind        varchar(16),
  approved_by_id          varchar(128),
  created_at              timestamptz NOT NULL DEFAULT now(),
  decided_at              timestamptz,
  applied_at              timestamptz,
  CONSTRAINT shadow_changes_status_check CHECK (status IN (
    'pending', 'approved', 'rejected', 'applied', 'conflict')),
  CONSTRAINT shadow_changes_approved_by_kind_check CHECK (approved_by_kind IS NULL OR approved_by_kind IN (
    'human', 'agent')),
  CONSTRAINT shadow_changes_category_check CHECK (category IN (
    'money', 'customer_send', 'delete', 'other')),
  CONSTRAINT shadow_changes_operation_check CHECK (operation IN (
    'insert', 'update', 'delete'))
);

CREATE INDEX IF NOT EXISTS shadow_changes_company_status_idx
  ON shadow_changes (company_id, status);

-- 2. Row-level security (same pattern as DRAFT_company_scope_extension.sql) --

ALTER TABLE public.shadow_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_changes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shadow_changes_company_isolation ON public.shadow_changes;
CREATE POLICY shadow_changes_company_isolation
  ON public.shadow_changes
  AS PERMISSIVE
  FOR ALL
  TO desk_app
  USING (company_id = public.current_company_id())
  WITH CHECK (company_id = public.current_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shadow_changes TO desk_app;

-- 3. Verification (read-only, run after apply) ---------------------------
-- SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
--   FROM pg_class c
--  WHERE c.relnamespace = 'public'::regnamespace
--    AND c.relname = 'shadow_changes';

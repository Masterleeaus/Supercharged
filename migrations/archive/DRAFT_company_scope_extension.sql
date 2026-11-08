-- ============================================================================
-- DRAFT - NOT APPLIED. DO NOT RUN.
--
-- Extension to migrations/DRAFT_company_scope.sql. It covers the eight
-- company-owned tables that the main draft does not scope:
--   chatbots, chatbot_conversations, chatbot_messages       (DRAFT_chatbot.sql)
--   workforce_agents, workforce_runs, workforce_tasks,
--   workforce_tool_calls, workforce_audit_events           (DRAFT_workforce_*.sql)
--
--   * Each of these tables is created with company_id uuid NOT NULL by its own
--     draft. This file does NOT add company_id columns, indexes, backfills,
--     or foreign keys. It only adds row-level security and grants.
--   * It applies the policy pattern from section 3 of DRAFT_company_scope.sql:
--     ENABLE and FORCE RLS, one FOR ALL policy keyed on current_company_id(),
--     and grants to desk_app only.
--   * workforce_audit_events is append-only. It gets SELECT and INSERT policies
--     and grants only, with no UPDATE or DELETE. See the note in that section.
--   * It depends on the prerequisites in DRAFT_company_scope.sql (sections 1
--     and 2: role desk_app and function public.current_company_id()), and on
--     the tables from DRAFT_chatbot.sql and DRAFT_workforce_agents.sql /
--     DRAFT_workforce_runs.sql. Apply those first.
--   * Not in scripts/run-safe-migration.mjs. Do not add it there until the
--     tenancy plan in docs/TENANCY.md is approved.
-- ============================================================================

-- GUARD: stops any accidental run of this whole file. Remove only in the approved pass.
DO $$ BEGIN RAISE EXCEPTION 'DRAFT_company_scope_extension.sql must not be executed; see docs/TENANCY.md'; END $$;

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

-- 1. Chatbot tables -------------------------------------------------------
-- Same pattern as DRAFT_company_scope.sql section 3.
-- chatbot_conversations and chatbot_messages keep their composite FKs from
-- DRAFT_chatbot.sql. RLS does not change them.

ALTER TABLE public.chatbots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chatbots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chatbots_company_isolation ON public.chatbots;
CREATE POLICY chatbots_company_isolation
  ON public.chatbots
  AS PERMISSIVE
  FOR ALL
  TO desk_app
  USING (company_id = public.current_company_id())
  WITH CHECK (company_id = public.current_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chatbots TO desk_app;

ALTER TABLE public.chatbot_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chatbot_conversations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chatbot_conversations_company_isolation ON public.chatbot_conversations;
CREATE POLICY chatbot_conversations_company_isolation
  ON public.chatbot_conversations
  AS PERMISSIVE
  FOR ALL
  TO desk_app
  USING (company_id = public.current_company_id())
  WITH CHECK (company_id = public.current_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chatbot_conversations TO desk_app;

ALTER TABLE public.chatbot_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chatbot_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chatbot_messages_company_isolation ON public.chatbot_messages;
CREATE POLICY chatbot_messages_company_isolation
  ON public.chatbot_messages
  AS PERMISSIVE
  FOR ALL
  TO desk_app
  USING (company_id = public.current_company_id())
  WITH CHECK (company_id = public.current_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chatbot_messages TO desk_app;

-- 2. Workforce tables (mutable) ------------------------------------------
-- Same pattern. Each table has company_id uuid NOT NULL and no foreign key.

ALTER TABLE public.workforce_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workforce_agents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workforce_agents_company_isolation ON public.workforce_agents;
CREATE POLICY workforce_agents_company_isolation
  ON public.workforce_agents
  AS PERMISSIVE
  FOR ALL
  TO desk_app
  USING (company_id = public.current_company_id())
  WITH CHECK (company_id = public.current_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workforce_agents TO desk_app;

ALTER TABLE public.workforce_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workforce_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workforce_runs_company_isolation ON public.workforce_runs;
CREATE POLICY workforce_runs_company_isolation
  ON public.workforce_runs
  AS PERMISSIVE
  FOR ALL
  TO desk_app
  USING (company_id = public.current_company_id())
  WITH CHECK (company_id = public.current_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workforce_runs TO desk_app;

ALTER TABLE public.workforce_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workforce_tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workforce_tasks_company_isolation ON public.workforce_tasks;
CREATE POLICY workforce_tasks_company_isolation
  ON public.workforce_tasks
  AS PERMISSIVE
  FOR ALL
  TO desk_app
  USING (company_id = public.current_company_id())
  WITH CHECK (company_id = public.current_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workforce_tasks TO desk_app;

ALTER TABLE public.workforce_tool_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workforce_tool_calls FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workforce_tool_calls_company_isolation ON public.workforce_tool_calls;
CREATE POLICY workforce_tool_calls_company_isolation
  ON public.workforce_tool_calls
  AS PERMISSIVE
  FOR ALL
  TO desk_app
  USING (company_id = public.current_company_id())
  WITH CHECK (company_id = public.current_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workforce_tool_calls TO desk_app;

-- 3. workforce_audit_events (append-only) --------------------------------
-- This table does NOT fit the FOR ALL pattern. The store has no update or
-- delete path, and DRAFT_workforce_append_only.sql requires the app role to
-- hold INSERT and SELECT only. So this section uses separate SELECT and
-- INSERT policies and no UPDATE or DELETE policy. Grants match.

ALTER TABLE public.workforce_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workforce_audit_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workforce_audit_events_company_select ON public.workforce_audit_events;
CREATE POLICY workforce_audit_events_company_select
  ON public.workforce_audit_events
  AS PERMISSIVE
  FOR SELECT
  TO desk_app
  USING (company_id = public.current_company_id());

DROP POLICY IF EXISTS workforce_audit_events_company_insert ON public.workforce_audit_events;
CREATE POLICY workforce_audit_events_company_insert
  ON public.workforce_audit_events
  AS PERMISSIVE
  FOR INSERT
  TO desk_app
  WITH CHECK (company_id = public.current_company_id());

GRANT SELECT, INSERT ON public.workforce_audit_events TO desk_app;
-- The serial sequence needs USAGE for INSERT. Confirm the sequence name before applying.
GRANT USAGE, SELECT ON SEQUENCE public.workforce_audit_events_seq_seq TO desk_app;

-- 4. Verification (read-only, run after apply) ---------------------------
-- Every table below should show relrowsecurity and relforcerowsecurity = true.
-- SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
--   FROM pg_class c
--  WHERE c.relnamespace = 'public'::regnamespace
--    AND c.relname IN ('chatbots', 'chatbot_conversations', 'chatbot_messages',
--                      'workforce_agents', 'workforce_runs', 'workforce_tasks',
--                      'workforce_tool_calls', 'workforce_audit_events');

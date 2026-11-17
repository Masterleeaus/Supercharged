-- Promoted from migrations/candidates/0018_inbox_tenant_rls.sql as 0024, the next free number after 0023 on main. Registered in scripts/run-safe-migration.mjs after 0023.
-- Existing schema is migrations/0010a_inbox.sql. Requires the restricted desk_app role to exist before it runs (guard below).
DO $guard$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='desk_app' AND NOT rolsuper AND NOT rolbypassrls) THEN
  RAISE EXCEPTION 'Inbox RLS requires restricted desk_app';
 END IF;
END $guard$;
GRANT USAGE ON SCHEMA public TO desk_app;
ALTER TABLE public.inbox_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_participants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inbox_participants_tenant_boundary ON public.inbox_participants;
CREATE POLICY inbox_participants_tenant_boundary ON public.inbox_participants
 FOR ALL TO desk_app
 USING (company_id = nullif(current_setting('app.company_id',true),'')::uuid)
 WITH CHECK (company_id = nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inbox_participants TO desk_app;

ALTER TABLE public.inbox_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_threads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inbox_threads_tenant_boundary ON public.inbox_threads;
CREATE POLICY inbox_threads_tenant_boundary ON public.inbox_threads
 FOR ALL TO desk_app
 USING (company_id = nullif(current_setting('app.company_id',true),'')::uuid)
 WITH CHECK (company_id = nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inbox_threads TO desk_app;

ALTER TABLE public.inbox_thread_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_thread_participants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inbox_thread_participants_tenant_boundary ON public.inbox_thread_participants;
CREATE POLICY inbox_thread_participants_tenant_boundary ON public.inbox_thread_participants
 FOR ALL TO desk_app
 USING (company_id = nullif(current_setting('app.company_id',true),'')::uuid)
 WITH CHECK (company_id = nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inbox_thread_participants TO desk_app;

ALTER TABLE public.inbox_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inbox_messages_tenant_boundary ON public.inbox_messages;
CREATE POLICY inbox_messages_tenant_boundary ON public.inbox_messages
 FOR ALL TO desk_app
 USING (company_id = nullif(current_setting('app.company_id',true),'')::uuid)
 WITH CHECK (company_id = nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inbox_messages TO desk_app;

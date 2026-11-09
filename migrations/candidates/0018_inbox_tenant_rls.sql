-- REVIEW CANDIDATE ONLY: not in automatic migrations. Existing schema is migrations/0010a_inbox.sql.
-- Apply only after role grants and ownership have been audited. NO production activation.
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

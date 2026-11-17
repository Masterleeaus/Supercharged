-- ============================================================
-- DOWN for migrations/0024_inbox_tenant_rls.sql (issue #251).
-- Removes the four Inbox tenant policies, turns row-level security off and revokes the desk_app grants.
-- The tables and their rows stay. This restores the pre-0024 access model; it does not drop data.
-- ============================================================
DROP POLICY IF EXISTS inbox_participants_tenant_boundary ON public.inbox_participants;
DROP POLICY IF EXISTS inbox_threads_tenant_boundary ON public.inbox_threads;
DROP POLICY IF EXISTS inbox_thread_participants_tenant_boundary ON public.inbox_thread_participants;
DROP POLICY IF EXISTS inbox_messages_tenant_boundary ON public.inbox_messages;

ALTER TABLE public.inbox_participants NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_participants DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_threads NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_threads DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_thread_participants NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_thread_participants DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_messages NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_messages DISABLE ROW LEVEL SECURITY;

REVOKE SELECT, INSERT, UPDATE, DELETE ON public.inbox_participants FROM desk_app;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.inbox_threads FROM desk_app;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.inbox_thread_participants FROM desk_app;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.inbox_messages FROM desk_app;

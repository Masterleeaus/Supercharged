-- ============================================================
-- DOWN for migrations/0018a_desk_app_role.sql (issue #251).
-- Written plan: the role itself is NOT dropped. desk_app is cluster-wide, may own grants used by 0023 and 0024
-- and by other databases on the same server, and DROP ROLE fails while any grant or owned object exists.
-- This down removes only what this migration gave the role on the public schema, which is the reversible part.
-- Re-applying the up migration is idempotent.
-- ============================================================
BEGIN;
DO $role$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='desk_app') THEN
  REVOKE USAGE ON SCHEMA public FROM desk_app;
 END IF;
END $role$;
COMMIT;

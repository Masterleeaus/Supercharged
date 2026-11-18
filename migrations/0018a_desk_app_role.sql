-- Migration 0018a: restricted desk_app role bootstrap (split from 0018, issue #398).
-- Runs unattended. Later migrations (0023, 0024) require desk_app to exist, so a fresh
-- database cannot boot without this. Operator-only Central SSO tables stay in 0018 and 0019.
-- Idempotent: an existing role is not changed. Attributes and schema usage match
-- scripts/tenant-postgres-prepare.mjs.
BEGIN;
DO $role$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='desk_app') THEN
  CREATE ROLE desk_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  GRANT USAGE ON SCHEMA public TO desk_app;
 END IF;
END $role$;
COMMIT;

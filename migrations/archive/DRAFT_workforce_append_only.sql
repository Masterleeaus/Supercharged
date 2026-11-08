-- ============================================================================
-- DRAFT - NOT APPLIED. Do not run. NOT in journal.
-- Not part of the numbered migration sequence (0000..0010). Review before promoting.
--
-- Checklist section 11: append-only audit trail.
-- Makes workforce_audit_events append-only for the application role.
--
-- DEPENDENCY: workforce_audit_events is created by DRAFT_workforce_runs.sql,
-- which MUST run first. This file fails if that table does not exist.
--
-- Re-runnable: CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS before each
-- CREATE TRIGGER (works on any PostgreSQL version, not only 14+), and REVOKE is
-- idempotent.
--
-- Approvals audit: DRAFT_approvals.sql defines approval_rules and approvals only.
-- It has NO audit table (grep for "audit" finds nothing), so no approvals audit
-- trigger or revoke is added here.
-- ============================================================================

-- 1. Trigger function: reject any UPDATE or DELETE on workforce_audit_events.
CREATE OR REPLACE FUNCTION workforce_audit_events_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'workforce_audit_events is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- Row-level trigger: fires on UPDATE and DELETE of each row.
DROP TRIGGER IF EXISTS workforce_audit_events_no_update_delete ON workforce_audit_events;
CREATE TRIGGER workforce_audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON workforce_audit_events
  FOR EACH ROW
  EXECUTE FUNCTION workforce_audit_events_block_mutation();

-- Row-level triggers do NOT fire on TRUNCATE, so a statement-level trigger is needed.
DROP TRIGGER IF EXISTS workforce_audit_events_no_truncate ON workforce_audit_events;
CREATE TRIGGER workforce_audit_events_no_truncate
  BEFORE TRUNCATE ON workforce_audit_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION workforce_audit_events_block_mutation();

-- 2. Privileges: remove UPDATE, DELETE and TRUNCATE from PUBLIC.
--
-- The application role must be granted INSERT and SELECT ONLY on this table.
-- Grant them in a separate step once the role name is confirmed, for example:
--   GRANT INSERT, SELECT ON workforce_audit_events TO <app_role>;
--   GRANT USAGE, SELECT ON SEQUENCE workforce_audit_events_seq_seq TO <app_role>;
-- (The seq column is serial, so INSERT needs USAGE on its sequence.)
--
-- The table OWNER role is excluded from this revoke: the owner keeps its
-- privileges, so it is not locked out of its own table. The triggers above
-- still apply to the owner, so an owner UPDATE or DELETE is also rejected unless
-- session_replication_role is set to 'replica' (a superuser-only setting that
-- bypasses triggers). Do not grant that setting to the application role.
REVOKE UPDATE, DELETE, TRUNCATE ON workforce_audit_events FROM PUBLIC;

-- ============================================================================
-- Verification (read-only, run manually after promotion, not part of this draft):
--   SELECT tgname FROM pg_trigger
--    WHERE tgrelid = 'workforce_audit_events'::regclass AND NOT tgisinternal;
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_name = 'workforce_audit_events';
-- ============================================================================

-- ============================================================
-- Migration 0013: approvals status check accepts 'revoked'.
--
-- ApprovalService.revokeApproval (server/modules/approvals/approval-service.ts) writes
-- status 'revoked'. The status check created by DRAFT_approvals.sql allows only
-- pending, approved, rejected and expired, so a revoke would fail at the database.
--
-- Depends on the approvals table from migrations/DRAFT_approvals.sql. The guard below
-- stops the run with a clear error if that table is missing.
--
-- Changes:
--   1. The approvals_status_check constraint is dropped and re-added with the same
--      five-value set plus 'revoked'. Every existing value stays valid (the set only grows).
--
-- Idempotent: safe to re-run.
-- ============================================================

DO $$
BEGIN
  IF to_regclass('public.approvals') IS NULL THEN
    RAISE EXCEPTION 'migration 0013: approvals table is missing. Apply migrations/DRAFT_approvals.sql first.';
  END IF;
END
$$;

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_status_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'revoked'));

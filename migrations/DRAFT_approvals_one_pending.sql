-- DRAFT - NOT APPLIED. DO NOT RUN against any database.
-- Not part of the numbered migration sequence and not in migrations/meta/_journal.json.
-- Depends on the approvals table in migrations/DRAFT_approvals.sql.
--
-- Guard: the first statement raises, so running this file by accident fails at once.
-- Remove the DO block only after review and when promoting this to a numbered migration.
DO $$
BEGIN
  RAISE EXCEPTION 'DRAFT_approvals_one_pending.sql is a draft and must not be run';
END
$$;

-- 1. Revoked state. ApprovalService.revokeApproval writes status 'revoked'. The status
--    check in DRAFT_approvals.sql allows only pending, approved, rejected and expired,
--    so a revoke would fail at the database. Drop and re-add the check (idempotent).
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_status_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'revoked'));

-- 2. At most one pending approval per source approval. ApprovalService.resubmitApproval
--    claims the source with a conditional UPDATE (context.resubmittedTo) and inserts the
--    new row in the same transaction. This partial unique index is the database backstop:
--    a second pending row that points at the same source (company + context.resubmittedFrom)
--    fails with 23505. Non-pending rows are not limited by it.
--    Fails with 23505 if two pending rows already share a source; resolve those first.
CREATE UNIQUE INDEX IF NOT EXISTS approvals_one_pending_per_source_uidx
  ON approvals (company_id, (context ->> 'resubmittedFrom'))
  WHERE status = 'pending' AND context ->> 'resubmittedFrom' IS NOT NULL;

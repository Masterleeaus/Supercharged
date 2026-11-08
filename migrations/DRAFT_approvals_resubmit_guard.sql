-- DRAFT - NOT APPLIED. DO NOT RUN against any database.
-- Not part of the numbered migration sequence and not in migrations/meta/_journal.json.
-- Depends on the approvals table in migrations/DRAFT_approvals.sql.
--
-- Guard for ApprovalService.resubmitApproval: at most one resubmission per source
-- approval. buildResubmission stores the link as context.resubmittedFrom on the NEW
-- row. This partial unique index rejects a second row that points at the same source.
-- The service also claims the source with a conditional UPDATE (context.resubmittedTo),
-- so this index is the database backstop, not the only check.
-- Idempotent (IF NOT EXISTS). Fails with 23505 if duplicate links already exist.

CREATE UNIQUE INDEX IF NOT EXISTS approvals_resubmitted_from_uidx
  ON approvals ((context ->> 'resubmittedFrom'))
  WHERE context ->> 'resubmittedFrom' IS NOT NULL;

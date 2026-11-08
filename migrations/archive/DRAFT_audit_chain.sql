-- ============================================================
-- DRAFT - NOT FOR EXECUTION
-- This file is a draft for review only. It is NOT applied by any
-- migration runner, has NOT been run against any database, and must
-- not be added to the automatic migration sequence without review.
-- ============================================================
-- Adds nullable columns for the optional audit hash chain to audit_logs.
-- Existing rows keep NULL in both columns (unchained history).

ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "prev_hash" text;
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "entry_hash" text;

-- Optional lookup index for chain verification (review before enabling):
-- CREATE INDEX IF NOT EXISTS "audit_logs_entry_hash_idx" ON "audit_logs" ("entry_hash");

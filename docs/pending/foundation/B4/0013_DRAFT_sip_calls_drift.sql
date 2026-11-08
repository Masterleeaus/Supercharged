-- ============================================================
-- DRAFT 0013 - NOT RUNNABLE. REVIEW ONLY.
-- Not in migrations/meta/_journal.json. Not in scripts/run-safe-migration.mjs.
-- Target: public.sip_calls. Source of truth: shared/schema.ts (sipCalls, line 2991).
-- Adds the 10 columns absent by name, the sip_trunk_id FK, and 7 indexes.
-- Does NOT drop or rename transcript_json or conversation_data.
-- Does NOT change nullability or types (see sip_calls_column_diff.md).
-- The runner wraps each file in a transaction, so no BEGIN/COMMIT here.
-- Plain CREATE INDEX (not CONCURRENTLY): needs a transaction-free runner. Decision D-B4-3.
-- ============================================================

ALTER TABLE "sip_calls" ADD COLUMN IF NOT EXISTS "sip_trunk_id" varchar;
ALTER TABLE "sip_calls" ADD COLUMN IF NOT EXISTS "openai_call_id" varchar(255);
ALTER TABLE "sip_calls" ADD COLUMN IF NOT EXISTS "elevenlabs_conversation_id" varchar(255);
ALTER TABLE "sip_calls" ADD COLUMN IF NOT EXISTS "credits_used" numeric(10, 2) DEFAULT 0;
ALTER TABLE "sip_calls" ADD COLUMN IF NOT EXISTS "recording_url" text;
ALTER TABLE "sip_calls" ADD COLUMN IF NOT EXISTS "transcript" jsonb;
ALTER TABLE "sip_calls" ADD COLUMN IF NOT EXISTS "ai_summary" text;
ALTER TABLE "sip_calls" ADD COLUMN IF NOT EXISTS "sentiment" varchar(50);
ALTER TABLE "sip_calls" ADD COLUMN IF NOT EXISTS "classification" varchar(50);
ALTER TABLE "sip_calls" ADD COLUMN IF NOT EXISTS "sip_headers" jsonb;
ALTER TABLE "sip_calls" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
ALTER TABLE "sip_calls" ADD COLUMN IF NOT EXISTS "answered_at" timestamp;

-- FK for sip_trunk_id (schema has no ON DELETE clause, so NO ACTION). Guarded for re-runs.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sip_calls_sip_trunk_id_sip_trunks_id_fk') THEN
    ALTER TABLE "sip_calls" ADD CONSTRAINT "sip_calls_sip_trunk_id_sip_trunks_id_fk"
      FOREIGN KEY ("sip_trunk_id") REFERENCES "sip_trunks"("id");
  END IF;
END
$$;

-- Indexes declared in schema.ts, absent from migrations
CREATE INDEX IF NOT EXISTS "sip_calls_user_id_idx" ON "sip_calls" ("user_id");
CREATE INDEX IF NOT EXISTS "sip_calls_campaign_id_idx" ON "sip_calls" ("campaign_id");
CREATE INDEX IF NOT EXISTS "sip_calls_contact_id_idx" ON "sip_calls" ("contact_id");
CREATE INDEX IF NOT EXISTS "sip_calls_status_idx" ON "sip_calls" ("status");
CREATE INDEX IF NOT EXISTS "sip_calls_created_at_idx" ON "sip_calls" ("created_at");
CREATE INDEX IF NOT EXISTS "sip_calls_external_call_id_idx" ON "sip_calls" ("external_call_id");
CREATE INDEX IF NOT EXISTS "sip_calls_elevenlabs_conversation_id_idx" ON "sip_calls" ("elevenlabs_conversation_id");

-- OPTIONAL backfill (decision D-B4-2). Keep commented until the owner confirms that
-- transcript_json and conversation_data hold the same data as the schema names.
-- UPDATE "sip_calls" SET "transcript" = "transcript_json"
--   WHERE "transcript" IS NULL AND "transcript_json" IS NOT NULL;
-- UPDATE "sip_calls" SET "metadata" = "conversation_data"
--   WHERE "metadata" IS NULL AND "conversation_data" IS NOT NULL;

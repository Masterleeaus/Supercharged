-- ============================================================
-- Migration 0006: Add default value to campaign type column
--
-- Safe to run on existing databases.
-- ============================================================

-- Ensure any existing NULL values in "type" column are set to 'outbound'
UPDATE "campaigns" SET "type" = 'outbound' WHERE "type" IS NULL;

-- Set default value for "type" column to 'outbound'
ALTER TABLE "campaigns" ALTER COLUMN "type" SET DEFAULT 'outbound';

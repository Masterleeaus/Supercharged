-- ============================================================
-- Migration 0007: Add external_fonoster_phone_id column
--
-- Safe to run on existing databases.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sip_phone_numbers' AND column_name = 'external_fonoster_phone_id') THEN
    ALTER TABLE "sip_phone_numbers" ADD COLUMN "external_fonoster_phone_id" text;
  END IF;
END $$;

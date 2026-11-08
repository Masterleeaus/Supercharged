-- ============================================================
-- Migration 0011: inbox channels telegram and meta, and a provider key for inbound dedupe.
--
-- Depends on migrations/DRAFT_inbox.sql having been applied first. The guard below
-- stops the run with a clear error if the inbox tables are missing.
--
-- Changes:
--   1. The channel CHECK on inbox_participants, inbox_threads and inbox_messages also
--      accepts 'telegram' and 'meta'. Existing rows stay valid (the set only grows).
--   2. inbox_messages gets a provider column. Existing rows get 'legacy', which is valid.
--      New rows must name their provider (lowercase id, same rule as comms inbound-dedupe).
--   3. The inbound external-id unique index becomes (company_id, channel, provider, external_id),
--      so two providers on one channel no longer share a key. The old index is dropped
--      only after the new one exists, so the guard is never absent.
--
-- Idempotent: safe to re-run.
-- ============================================================

DO $$
BEGIN
  IF to_regclass('public.inbox_participants') IS NULL
     OR to_regclass('public.inbox_threads') IS NULL
     OR to_regclass('public.inbox_messages') IS NULL THEN
    RAISE EXCEPTION 'migration 0011: inbox tables are missing. Apply migrations/DRAFT_inbox.sql first.';
  END IF;
END
$$;

-- 1. Widen the channel CHECK. The DRAFT used inline CHECKs, so Postgres named them <table>_channel_check.
ALTER TABLE inbox_participants DROP CONSTRAINT IF EXISTS inbox_participants_channel_check;
ALTER TABLE inbox_participants ADD CONSTRAINT inbox_participants_channel_check
  CHECK (channel IN ('email', 'sms', 'whatsapp', 'web_chat', 'phone', 'telegram', 'meta'));

ALTER TABLE inbox_threads DROP CONSTRAINT IF EXISTS inbox_threads_channel_check;
ALTER TABLE inbox_threads ADD CONSTRAINT inbox_threads_channel_check
  CHECK (channel IN ('email', 'sms', 'whatsapp', 'web_chat', 'phone', 'telegram', 'meta'));

ALTER TABLE inbox_messages DROP CONSTRAINT IF EXISTS inbox_messages_channel_check;
ALTER TABLE inbox_messages ADD CONSTRAINT inbox_messages_channel_check
  CHECK (channel IN ('email', 'sms', 'whatsapp', 'web_chat', 'phone', 'telegram', 'meta'));

-- 2. Provider column. The default keeps existing rows valid.
ALTER TABLE inbox_messages ADD COLUMN IF NOT EXISTS provider varchar(32) NOT NULL DEFAULT 'legacy';

ALTER TABLE inbox_messages DROP CONSTRAINT IF EXISTS inbox_messages_provider_check;
ALTER TABLE inbox_messages ADD CONSTRAINT inbox_messages_provider_check
  CHECK (provider ~ '^[a-z0-9_-]{1,32}$');

-- 3. Provider-scoped external id uniqueness. Create the new index before dropping the old one.
CREATE UNIQUE INDEX IF NOT EXISTS inbox_messages_provider_external_uidx
  ON inbox_messages (company_id, channel, provider, external_id) WHERE external_id IS NOT NULL;

DROP INDEX IF EXISTS inbox_messages_external_uidx;

-- ============================================================================
-- DRAFT: NOT FOR EXECUTION
--
-- Design draft for company_id on company-owned communication records, and
-- append-only audit storage for comms changes (merge, audience export,
-- suppression changes). Matches server/modules/comms/*.ts.
--   * Not in the numbered migration sequence. Not in scripts/run-safe-migration.mjs.
--   * Do not apply to any database. No backfill is run here; the backfill is a
--     commented block that needs an owner decision on orphaned rows.
--   * Tenant key is company_id. There is no companies table yet, so no FK to one
--     (same convention as DRAFT_inbox.sql and DRAFT_campaigns.sql).
--   * The comms suppression list, saved replies and segments are in-memory today.
--     Their tables below are the target shape for persistence, not a description of
--     anything that exists.
-- ============================================================================

DO $$
BEGIN
  RAISE EXCEPTION 'DRAFT_comms_company_id.sql is a draft. Do not run it. Promote it to a numbered migration after review.';
END
$$;

-- ----------------------------------------------------------------------------
-- 1. contacts: company_id already exists as a nullable column on shared/schema.ts.
--    Target: NOT NULL with a composite key so a row can be referenced only within its company.
-- ----------------------------------------------------------------------------

-- Step 1a (not run): report orphans first. Each one needs an owner decision, never a guessed tenant.
-- SELECT count(*) FROM contacts WHERE company_id IS NULL;

-- Step 1b (not run): once orphans are resolved.
-- ALTER TABLE contacts ALTER COLUMN company_id SET NOT NULL;
-- CREATE UNIQUE INDEX IF NOT EXISTS contacts_company_id_uidx ON contacts (company_id, id);

-- ----------------------------------------------------------------------------
-- 2. Suppression list. One row per company, channel and normalised address.
--    Only the hash of the address goes to the audit table; the row keeps the address
--    because the send path must check it.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS comms_suppressions (
  company_id   uuid         NOT NULL,
  channel      varchar(16)  NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp', 'telegram', 'messenger', 'instagram', 'phone')),
  address      varchar(320) NOT NULL,
  reason       varchar(24)  NOT NULL CHECK (reason IN ('bounce_hard', 'complaint', 'invalid_address', 'unsubscribed', 'soft_bounce_count')),
  created_at   timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, channel, address)
);

-- ----------------------------------------------------------------------------
-- 3. Saved replies and segments. Both are company-owned and keyed by company_id first.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS comms_saved_replies (
  id           varchar      PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid         NOT NULL,
  channel      varchar(16)  NOT NULL,
  title        varchar(80)  NOT NULL,
  body         varchar(1600) NOT NULL,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT comms_saved_replies_company_id_uidx UNIQUE (company_id, id)
);

CREATE TABLE IF NOT EXISTS comms_segments (
  id           varchar      PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid         NOT NULL,
  name         varchar(120) NOT NULL,
  rules        jsonb        NOT NULL,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT comms_segments_company_id_uidx UNIQUE (company_id, id)
);

-- ----------------------------------------------------------------------------
-- 4. Append-only audit events for comms changes. Same shape as workforce_audit_events:
--    company_id NOT NULL, no FK, and UPDATE/DELETE blocked by trigger.
--    Actions: contacts_merged (contact-merge.ts), comms.audience_export, comms.suppression_changed.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS comms_audit_events (
  id           bigserial    PRIMARY KEY,
  company_id   uuid         NOT NULL,
  action       varchar(64)  NOT NULL CHECK (action IN ('contacts_merged', 'comms.audience_export', 'comms.suppression_changed')),
  actor_id     varchar(128) NOT NULL,
  payload      jsonb        NOT NULL DEFAULT '{}'::jsonb,
  occurred_at  timestamptz  NOT NULL,
  recorded_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS comms_audit_events_company_time_idx ON comms_audit_events (company_id, occurred_at);

CREATE OR REPLACE FUNCTION comms_audit_events_block_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'comms_audit_events is append-only';
END
$$;

DROP TRIGGER IF EXISTS comms_audit_events_no_update ON comms_audit_events;
CREATE TRIGGER comms_audit_events_no_update
  BEFORE UPDATE OR DELETE ON comms_audit_events
  FOR EACH ROW EXECUTE FUNCTION comms_audit_events_block_change();

-- Row-level security is not included. Add it with migrations/DRAFT_company_scope.sql.

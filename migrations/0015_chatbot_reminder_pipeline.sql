-- Issue #19: company-wide webhook subscriptions, the chatbot event outbox, webhook delivery attempts, and the
-- appointment reminder delivery ledger.
--
-- Matches the Drizzle definitions in server/modules/chatbot/db/events.ts (chatbot_event_outbox,
-- chatbot_webhook_subscriptions, chatbot_webhook_deliveries) and server/modules/chatbot/booking-providers/db.ts
-- (chatbot_booking_reminder_sends). None of these four tables was in migrations/ before this file.
--
-- Scope: every row is keyed by company_id. A subscription belongs to a company, not to a user, so the outbox
-- drain delivers a company's events to that company's subscriptions.
--
-- Deviation from db/booking-providers/db.ts: chatbot_booking_reminder_sends has no composite foreign key to
-- chatbot_appointments. That table is not in migrations/ yet. Add the FK in a later migration once it is.
--
-- Additive and idempotent (IF NOT EXISTS). Nothing reads these tables unless CHATBOT_WORKERS_ENABLED or
-- CHATBOT_REMINDERS_ENABLED is "true".
--
-- Rollback (manual, in this order, only if no data must be kept):
--   DROP TABLE IF EXISTS chatbot_webhook_deliveries;
--   DROP TABLE IF EXISTS chatbot_booking_reminder_sends;
--   DROP TABLE IF EXISTS chatbot_webhook_subscriptions;
--   DROP TABLE IF EXISTS chatbot_event_outbox;

-- ---------------------------------------------------------------- event outbox

CREATE TABLE IF NOT EXISTS chatbot_event_outbox (
  company_id            uuid NOT NULL,
  id                    varchar(191) NOT NULL,
  topic                 varchar(191) NOT NULL,
  aggregate_id          varchar(191) NOT NULL,
  payload               jsonb NOT NULL,
  dedupe_key            varchar(191) NOT NULL,
  status                varchar(16) NOT NULL DEFAULT 'pending',
  attempts              integer NOT NULL DEFAULT 0,
  available_at          timestamptz NOT NULL DEFAULT now(),
  locked_at             timestamptz,
  locked_by             varchar(191),
  realtime_published_at timestamptz,
  published_at          timestamptz,
  failed_at             timestamptz,
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_event_outbox_pk PRIMARY KEY (company_id, id),
  CONSTRAINT chatbot_event_outbox_status_check CHECK (status IN ('pending', 'published', 'failed'))
);

-- A second append with the same dedupe key returns the first row. It never creates a second one.
CREATE UNIQUE INDEX IF NOT EXISTS chatbot_event_outbox_dedupe_uidx
  ON chatbot_event_outbox (company_id, dedupe_key);
CREATE INDEX IF NOT EXISTS chatbot_event_outbox_company_status_idx
  ON chatbot_event_outbox (company_id, status, available_at);

-- ---------------------------------------------------------------- company webhook subscriptions

CREATE TABLE IF NOT EXISTS chatbot_webhook_subscriptions (
  company_id     uuid NOT NULL,
  id             varchar(191) NOT NULL,
  url            text NOT NULL,
  topics         jsonb NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  signing_secret jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_webhook_subscriptions_pk PRIMARY KEY (company_id, id)
);

CREATE INDEX IF NOT EXISTS chatbot_webhook_subscriptions_company_idx
  ON chatbot_webhook_subscriptions (company_id, active);

-- ---------------------------------------------------------------- webhook delivery attempts

CREATE TABLE IF NOT EXISTS chatbot_webhook_deliveries (
  company_id      uuid NOT NULL,
  event_id        varchar(191) NOT NULL,
  subscription_id varchar(191) NOT NULL,
  attempt         integer NOT NULL,
  http_status     integer,
  ok              boolean NOT NULL,
  error_message   text,
  delivered_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_webhook_deliveries_pk PRIMARY KEY (company_id, event_id, subscription_id, attempt),
  CONSTRAINT chatbot_webhook_deliveries_company_event_fk
    FOREIGN KEY (company_id, event_id) REFERENCES chatbot_event_outbox (company_id, id),
  CONSTRAINT chatbot_webhook_deliveries_company_subscription_fk
    FOREIGN KEY (company_id, subscription_id) REFERENCES chatbot_webhook_subscriptions (company_id, id)
);

-- ---------------------------------------------------------------- reminder delivery ledger

-- One row per (company, appointment, channel). The row is the once-per-booking guarantee: the dispatcher claims
-- it before a send, and a later run finds it and skips. Status is one of sending, sent, failed, cancelled.
CREATE TABLE IF NOT EXISTS chatbot_booking_reminder_sends (
  id                  varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
  company_id          uuid NOT NULL,
  appointment_id      varchar NOT NULL,
  channel             varchar(16) NOT NULL,
  status              varchar(16) NOT NULL,
  idempotency_key     varchar(255) NOT NULL,
  external_message_id varchar(255),
  reason              varchar(255),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_booking_reminder_sends_status_chk
    CHECK (status IN ('sending', 'sent', 'failed', 'cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS chatbot_booking_reminder_sends_once_uidx
  ON chatbot_booking_reminder_sends (company_id, appointment_id, channel);

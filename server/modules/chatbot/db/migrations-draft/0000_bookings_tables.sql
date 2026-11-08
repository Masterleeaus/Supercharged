-- DRAFT. NOT APPLIED. UNVERIFIED against a live database. The harness applies it to a fresh database only.
--
-- SQL DDL for the chatbot booking tables, generated from server/modules/chatbot/db/bookings.ts.
-- Must run before 0001_bookings_exclusion.sql, which alters chatbot_appointments.
-- Parent tables (chatbots, chatbot_conversations) come from migrations/DRAFT_chatbot.sql.
--
-- Tenant key is company_id. Child rows use composite foreign keys on (company_id, id).
-- The EXCLUDE constraint is NOT created here. It stays in 0001_bookings_exclusion.sql.
-- Idempotent: IF NOT EXISTS on every table and index.

CREATE TABLE IF NOT EXISTS chatbot_booking_calendars (
  id              varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid    NOT NULL,
  calendar_number serial  NOT NULL,
  name            varchar(255) NOT NULL,
  timezone        varchar(64) NOT NULL DEFAULT 'UTC',
  availability    jsonb,
  buffer_minutes  integer NOT NULL DEFAULT 0,
  created_at      timestamp NOT NULL DEFAULT now(),
  updated_at      timestamp NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_booking_calendars_buffer_chk CHECK (buffer_minutes >= 0 AND buffer_minutes <= 240)
);

CREATE UNIQUE INDEX IF NOT EXISTS chatbot_booking_calendars_company_id_uidx
  ON chatbot_booking_calendars (company_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS chatbot_booking_calendars_company_number_uidx
  ON chatbot_booking_calendars (company_id, calendar_number);

CREATE TABLE IF NOT EXISTS chatbot_appointments (
  id               varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid    NOT NULL,
  calendar_id      varchar NOT NULL,
  conversation_id  varchar,
  customer_name    varchar(255) NOT NULL,
  customer_email   varchar(254),
  customer_phone   varchar(16),
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  blocked_range    tstzrange,
  status           varchar(16) NOT NULL DEFAULT 'confirmed',
  status_reason    varchar(500),
  metadata         jsonb,
  created_at       timestamp NOT NULL DEFAULT now(),
  updated_at       timestamp NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_appointments_company_calendar_fk
    FOREIGN KEY (company_id, calendar_id) REFERENCES chatbot_booking_calendars (company_id, id),
  -- Nullable column: MATCH SIMPLE skips this foreign key when conversation_id is null.
  CONSTRAINT chatbot_appointments_company_conversation_fk
    FOREIGN KEY (company_id, conversation_id) REFERENCES chatbot_conversations (company_id, id),
  CONSTRAINT chatbot_appointments_status_chk CHECK (status IN ('confirmed', 'waitlisted', 'cancelled')),
  CONSTRAINT chatbot_appointments_range_chk CHECK (ends_at > starts_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS chatbot_appointments_company_id_uidx
  ON chatbot_appointments (company_id, id);
-- Layer 1 of the double-booking guard. Same start, same calendar, both confirmed: rejected.
CREATE UNIQUE INDEX IF NOT EXISTS chatbot_appointments_confirmed_start_uidx
  ON chatbot_appointments (company_id, calendar_id, starts_at) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS chatbot_appointments_company_calendar_time_idx
  ON chatbot_appointments (company_id, calendar_id, starts_at);

CREATE TABLE IF NOT EXISTS chatbot_booking_reminders (
  id             varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid    NOT NULL,
  appointment_id varchar NOT NULL,
  channel        varchar(16) NOT NULL,
  send_at        timestamptz NOT NULL,
  status         varchar(16) NOT NULL DEFAULT 'queued',
  created_at     timestamp NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_booking_reminders_company_appointment_fk
    FOREIGN KEY (company_id, appointment_id) REFERENCES chatbot_appointments (company_id, id)
);

CREATE INDEX IF NOT EXISTS chatbot_booking_reminders_due_idx
  ON chatbot_booking_reminders (company_id, status, send_at);

-- One row per company. Token columns: all null (no token), or the legacy three-column form, or the versioned string form (see bookings/secret-box.ts).
CREATE TABLE IF NOT EXISTS chatbot_booking_settings (
  id                          varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid    NOT NULL,
  calendly_token_iv           varchar(32),
  calendly_token_tag          varchar(32),
  calendly_token_ciphertext   text,
  booking_assistant_conditions jsonb,
  created_at                  timestamp NOT NULL DEFAULT now(),
  updated_at                  timestamp NOT NULL DEFAULT now(),
  -- Allows the legacy three-column form (iv, tag and ciphertext all set) and the versioned
  -- string form (iv and tag NULL, ciphertext holds "v<n>:iv:tag:ciphertext"). Updated 2026-11-09.
  CONSTRAINT chatbot_booking_settings_token_chk CHECK (
    ((calendly_token_iv IS NULL) = (calendly_token_tag IS NULL))
    AND (calendly_token_ciphertext IS NOT NULL OR calendly_token_iv IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS chatbot_booking_settings_company_uidx
  ON chatbot_booking_settings (company_id);

-- Booking-assistant columns on chatbots (bookingAssistantChatbotColumns in bookings.ts).
ALTER TABLE chatbots ADD COLUMN IF NOT EXISTS is_booking_assistant boolean NOT NULL DEFAULT false;
ALTER TABLE chatbots ADD COLUMN IF NOT EXISTS booking_assistant_conditions jsonb;
ALTER TABLE chatbots ADD COLUMN IF NOT EXISTS booking_assistant_iframe text;

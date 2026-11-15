
-- ============================================================
-- Migration 0020: read-only mirror of Scheduled bookings (Sc3, Central integration).
--
-- Scheduled owns bookings. This migration only adds a local copy of the booking
-- state that Scheduled announces through Central's signed events
-- (booking_created, booking_cancelled, booking_rescheduled, schemaVersion 1).
--
-- Additive only. No existing table is changed. Nothing here writes to chatbot
-- or widget booking tables, and the widget's own appointment flow does not read
-- this table yet.
--
-- Two tables:
--   scheduled_booking_events  one row per applied event, keyed by the event's
--                             idempotency key (per company). A repeated key is a
--                             no-op. This is the dedupe ledger.
--   scheduled_booking_mirror  one row per booking. The consumer upserts it and
--                             only moves it forward (a stale event never
--                             overwrites a newer one).
--
-- Tenant key is company_id, as in 0017. The envelope's organisationId is stored
-- here as company_id (see the PR decision list).
--
-- ROLLBACK (run by hand only if this migration must be undone; the mirror holds
-- no data that Scheduled does not also hold):
--   DROP TABLE IF EXISTS scheduled_booking_mirror;
--   DROP TABLE IF EXISTS scheduled_booking_events;
--
-- Idempotent (IF NOT EXISTS) so a later re-run is safe.
-- ============================================================

CREATE TABLE IF NOT EXISTS scheduled_booking_events (
  company_id       uuid NOT NULL,
  idempotency_key  varchar(200) NOT NULL,
  event_id         varchar(128) NOT NULL,
  event_type       varchar(64) NOT NULL,
  booking_id       varchar(128) NOT NULL,
  occurred_at      timestamptz NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS scheduled_booking_mirror (
  company_id       uuid NOT NULL,
  booking_id       varchar(128) NOT NULL,
  status           varchar(16) NOT NULL CHECK (status IN ('booked', 'cancelled')),
  starts_at        timestamptz,
  ends_at          timestamptz,
  last_event_key   varchar(200) NOT NULL,
  last_occurred_at timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, booking_id)
);

CREATE INDEX IF NOT EXISTS scheduled_booking_mirror_company_starts_idx
  ON scheduled_booking_mirror (company_id, starts_at);

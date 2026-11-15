
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

-- Tenant isolation in the database, not only in application code (R10).
-- Same pattern as 0018: forced RLS keyed on app.company_id, which the consumer
-- sets per transaction with set_config(..., true).
-- Fail closed: RLS is forced on both tables unconditionally, so with no policy
-- nothing is readable or writable. The policies and grants need the restricted
-- desk_app role (no BYPASSRLS, not the table owner). If that role is missing this
-- migration does NOT stop the run (see the F19 decision); it emits a NOTICE and the
-- policies and grants must be applied by the operator once the role exists.
ALTER TABLE scheduled_booking_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_booking_events FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_booking_mirror ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_booking_mirror FORCE ROW LEVEL SECURITY;

REVOKE ALL ON scheduled_booking_events FROM PUBLIC;
REVOKE ALL ON scheduled_booking_mirror FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'desk_app' AND NOT rolsuper AND NOT rolbypassrls) THEN
    RAISE NOTICE 'Migration 0020: restricted desk_app role not found; RLS policies and grants not applied (operator step)';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'scheduled_booking_events' AND policyname = 'scheduled_booking_events_tenant_boundary') THEN
    CREATE POLICY scheduled_booking_events_tenant_boundary ON scheduled_booking_events
      FOR ALL TO desk_app
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'scheduled_booking_mirror' AND policyname = 'scheduled_booking_mirror_tenant_boundary') THEN
    CREATE POLICY scheduled_booking_mirror_tenant_boundary ON scheduled_booking_mirror
      FOR ALL TO desk_app
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
  END IF;
  -- Least privilege: the consumer claims keys (insert) and moves the mirror forward (select, insert, update).
  -- No row removal is granted: the consumer only claims keys and moves rows forward.
  GRANT SELECT, INSERT ON scheduled_booking_events TO desk_app;
  GRANT SELECT, INSERT, UPDATE ON scheduled_booking_mirror TO desk_app;
END
$$;

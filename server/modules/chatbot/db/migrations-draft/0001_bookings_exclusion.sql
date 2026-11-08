-- DRAFT. NOT APPLIED. UNVERIFIED against Postgres: no test has run this file on a database.
--
-- Double-booking guard, layer 2 (see db/bookings.ts header and bookings/DECISIONS.md).
-- Two confirmed appointments in one company on one calendar cannot have overlapping blocked ranges.
-- blocked_range already includes the calendar buffer; the storage writes it on every insert.
--
-- Column names follow db/bookings.ts (calendar_id, blocked_range, status). The names resource_id,
-- start_at and end_at do not exist in that table, so they are not used here.
--
-- Only status = 'confirmed' blocks a slot. 'waitlisted' and 'cancelled' rows do not.
-- A NULL blocked_range never conflicts, so the storage must keep writing it.
--
-- btree_gist lets company_id (uuid) and calendar_id (varchar) take part in a GiST index with '='.
-- btree_gist is a trusted extension on PostgreSQL 13 and later, so the table owner can create it.

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE chatbot_appointments
  ADD CONSTRAINT chatbot_appointments_no_overlap
  EXCLUDE USING gist (
    company_id WITH =,
    calendar_id WITH =,
    blocked_range WITH &&
  )
  WHERE (status = 'confirmed');

-- Rollback (draft):
-- ALTER TABLE chatbot_appointments DROP CONSTRAINT chatbot_appointments_no_overlap;

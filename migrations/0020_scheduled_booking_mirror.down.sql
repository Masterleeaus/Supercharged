-- ============================================================
-- DOWN for migrations/0020_scheduled_booking_mirror.sql (issue #251).
-- Drops the mirror table before the events table it was created alongside.
-- DATA LOSS: removes mirrored booking rows and events. Disposable database or verified backup only.
-- ============================================================
DROP TABLE IF EXISTS scheduled_booking_mirror;
DROP TABLE IF EXISTS scheduled_booking_events;

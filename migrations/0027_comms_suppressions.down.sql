-- ============================================================
-- DOWN for migrations/0027_comms_suppressions.sql (issue #251).
-- Reviewed reversal of the durable suppression tables. Run by hand only, on a disposable
-- database or after the code no longer reads or writes these tables. The runner never runs down files.
-- ============================================================
BEGIN;
DROP TABLE IF EXISTS comms_soft_bounces;
DROP TABLE IF EXISTS comms_suppressions;
COMMIT;

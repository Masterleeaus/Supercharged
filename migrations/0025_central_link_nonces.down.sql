-- ============================================================
-- DOWN for migrations/0025_central_link_nonces.sql (issue #251).
-- The table holds only single-use nonces and expiry times, no tenant data, so dropping it is safe.
-- Run only when no Central link assertion is in flight: a dropped nonce store lets an assertion be replayed
-- until the forward migration is re-applied.
-- ============================================================
BEGIN;
DROP INDEX IF EXISTS central_link_issued_nonces_expiry_idx;
DROP TABLE IF EXISTS central_link_issued_nonces;
COMMIT;

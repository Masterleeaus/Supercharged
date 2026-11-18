-- ============================================================
-- DOWN for migrations/0025_central_link_nonces.sql (issue #192).
-- Removes the shared Central link nonce table. The table holds only random nonces and expiry times, no tenant data.
-- Dropping it loses only nonces not yet expired. Central still enforces single use, so no replay is possible after the drop.
-- ============================================================
BEGIN;
DROP INDEX IF EXISTS central_link_issued_nonces_expiry_idx;
DROP TABLE IF EXISTS central_link_issued_nonces;
COMMIT;

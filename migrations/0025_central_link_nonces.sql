-- Migration 0025: shared single-use nonce store for Central link assertions (#192, #196).
-- Product-global table: it holds only random nonces and expiry times, no tenant data.
-- Forward-only. Operator action only: not applied to any database by the repository.
BEGIN;
CREATE TABLE IF NOT EXISTS central_link_issued_nonces (
 nonce text PRIMARY KEY CHECK (length(nonce) BETWEEN 22 AND 128),
 expires_at_seconds bigint NOT NULL CHECK (expires_at_seconds > 0)
);
CREATE INDEX IF NOT EXISTS central_link_issued_nonces_expiry_idx
 ON central_link_issued_nonces (expires_at_seconds);
REVOKE ALL ON central_link_issued_nonces FROM PUBLIC;
COMMIT;

-- ============================================================
-- DOWN for migrations/0025_central_link_nonces.sql (#192, #196).
-- Drops the shared link-assertion nonce ledger. It holds only random nonces and expiry times.
-- Removing it means shared single-use enforcement is gone until the table is re-applied.
-- ============================================================
DROP TABLE IF EXISTS central_link_issued_nonces;

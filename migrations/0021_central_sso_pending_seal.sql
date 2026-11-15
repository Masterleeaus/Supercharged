-- Migration 0021: seal the PKCE code_verifier at rest in central_sso_pending_logins.
--
-- Migration 0019 (already on main, not edited) stores code_verifier as plaintext in
-- varchar(128). The app now stores "v1:<iv>:<tag>:<ciphertext>" (AES-256-GCM, base64 parts),
-- which is longer than 128 characters, so the column is widened to text here.
--
-- The new CHECK is NOT VALID: rows written before this migration (plaintext, 10 minute TTL)
-- are not re-checked. They cannot be opened by the new store, so take() returns null for them
-- and they expire on their own.
--
-- Forward-only: there is no down script.
-- Not applied to any database by the repository. Operator action only.

ALTER TABLE central_sso_pending_logins
  ALTER COLUMN code_verifier TYPE text;

ALTER TABLE central_sso_pending_logins
  DROP CONSTRAINT IF EXISTS central_sso_pending_logins_code_verifier_check;

ALTER TABLE central_sso_pending_logins
  ADD CONSTRAINT central_sso_pending_logins_code_verifier_sealed_check
  CHECK (code_verifier ~ '^v1:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$') NOT VALID;

-- Migration 0019: database-backed Central SSO pending logins.
--
-- Holds one row per started sign-in (OIDC authorization code + PKCE) until the
-- callback consumes it. Shared by every app process, so a callback can be
-- handled by a different process than the one that started the login.
--
-- Keyed by SHA-256 hex of the state value, so the state itself is not stored.
-- No company_id: the company is not known until the verified callback, so this
-- table is not tenant-scoped and has no row-level security policy. Access is
-- limited by grants. Only the operator grants it, to the app role.
--
-- Forward-only: there is no down script.
-- Not applied to any database by the repository. Operator action only.

CREATE TABLE IF NOT EXISTS central_sso_pending_logins (
  state_hash    char(64) PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  code_verifier varchar(128) NOT NULL CHECK (length(code_verifier) BETWEEN 43 AND 128),
  nonce         varchar(256) NOT NULL CHECK (length(nonce) BETWEEN 1 AND 256),
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS central_sso_pending_logins_expires_idx
  ON central_sso_pending_logins (expires_at);

REVOKE ALL ON central_sso_pending_logins FROM PUBLIC;
-- Operator: GRANT SELECT, INSERT, DELETE ON central_sso_pending_logins TO <app role>;

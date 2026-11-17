-- ============================================================
-- Migration 0027: durable, company-scoped comms suppression list.
--
-- Before this, server/modules/comms/suppression.ts kept bounces, complaints, invalid
-- addresses and unsubscribes in a process-local Map. A restart lost all of them. These
-- tables hold the same state. server/modules/comms/suppression-postgres.ts reads and writes them.
--
-- Tenant key is company_id. There is no companies table yet, so no foreign key to one.
-- Row-level security is enabled and forced on both tables. The tenant policy applies to the
-- restricted role desk_app, which withTenant() switches into for each query. If desk_app does
-- not exist, the policy is not created and the tables are closed to the application (fail closed).
--
-- The address is stored in normalised form because the send path checks it. Audit records keep
-- only a hash (see suppression.ts), and that is unchanged here.
--
-- Numbered 0027 (renumbered from 0025 at merge; main already uses 0025 for central link nonces). 0023 is the marketing tables migration and 0024 the Inbox RLS migration on main,
-- and 0021 is reserved for the central SSO pending seal (PR #284).
--
-- ROLLBACK (run by hand only if this migration must be undone):
--   DROP TABLE IF EXISTS comms_soft_bounces;
--   DROP TABLE IF EXISTS comms_suppressions;
--
-- Idempotent (IF NOT EXISTS / DROP POLICY IF EXISTS) so a later re-run is safe.
-- ============================================================

CREATE TABLE IF NOT EXISTS comms_suppressions (
  company_id  uuid         NOT NULL,
  channel     varchar(16)  NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp', 'telegram', 'messenger', 'instagram', 'phone')),
  address     varchar(320) NOT NULL,
  reason      varchar(24)  NOT NULL CHECK (reason IN ('bounce_hard', 'complaint', 'invalid_address', 'unsubscribed', 'soft_bounce_count')),
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, channel, address)
);

CREATE TABLE IF NOT EXISTS comms_soft_bounces (
  company_id  uuid         NOT NULL,
  channel     varchar(16)  NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp', 'telegram', 'messenger', 'instagram', 'phone')),
  address     varchar(320) NOT NULL,
  count       integer      NOT NULL CHECK (count >= 1),
  updated_at  timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, channel, address)
);

ALTER TABLE comms_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms_suppressions FORCE ROW LEVEL SECURITY;
ALTER TABLE comms_soft_bounces ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms_soft_bounces FORCE ROW LEVEL SECURITY;

DO $tenant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'desk_app') THEN
    DROP POLICY IF EXISTS comms_suppressions_tenant_boundary ON comms_suppressions;
    CREATE POLICY comms_suppressions_tenant_boundary ON comms_suppressions
      FOR ALL TO desk_app
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
    GRANT SELECT, INSERT, UPDATE, DELETE ON comms_suppressions TO desk_app;

    DROP POLICY IF EXISTS comms_soft_bounces_tenant_boundary ON comms_soft_bounces;
    CREATE POLICY comms_soft_bounces_tenant_boundary ON comms_soft_bounces
      FOR ALL TO desk_app
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
    GRANT SELECT, INSERT, UPDATE, DELETE ON comms_soft_bounces TO desk_app;
  ELSE
    RAISE NOTICE 'desk_app role not found: comms suppression tenant policies not created; the tables stay closed to the application until it exists';
  END IF;
END $tenant$;

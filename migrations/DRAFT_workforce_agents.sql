-- DRAFT - NOT APPLIED. Do not run. Not part of the numbered migration sequence and not in the journal.
-- Matches the workforce_agents table in shared/schema.ts (and shared/schema.js) and the store in
-- server/workforce/pg-roster.ts. Idempotent (IF NOT EXISTS) so a later re-run is safe.
-- Tenant key is company_id, NOT NULL. Primary key is (company_id, id), so an agent id is unique per company.
-- There is no companies table yet, so no foreign keys.

CREATE TABLE IF NOT EXISTS workforce_agents (
  id          text NOT NULL,
  company_id  uuid NOT NULL,
  role_id     text NOT NULL,
  team_id     text,
  channels    jsonb NOT NULL DEFAULT '[]'::jsonb,
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  autonomy    text NOT NULL,
  status      text NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  CONSTRAINT workforce_agents_autonomy_check CHECK (autonomy IN ('assist', 'suggest', 'auto', 'predictive')),
  CONSTRAINT workforce_agents_status_check CHECK (status IN ('active', 'paused', 'retired'))
);

CREATE INDEX IF NOT EXISTS workforce_agents_company_idx
  ON workforce_agents (company_id);

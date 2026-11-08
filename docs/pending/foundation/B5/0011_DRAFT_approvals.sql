-- ============================================================
-- DRAFT 0011 - NOT RUNNABLE. REVIEW ONLY. Promoted from migrations/DRAFT_approvals.sql (body unchanged).
-- Not in migrations/meta/_journal.json. Not in scripts/run-safe-migration.mjs.
-- UNRESOLVED TYPE CONFLICT (B4 in TENANCY-INVENTORY): company_id is varchar here and in
-- server/modules/approvals/schema.ts (companyId: varchar). withTenant() in
-- server/infrastructure/database/tenant-context.ts (assertCompanyId) and DRAFT_company_scope.sql
-- use uuid. One type must win before this runs. Not chosen.
-- ============================================================
-- DRAFT - DO NOT RUN. Not part of the numbered migration sequence.
-- Matches server/modules/approvals/schema.ts. Review before promoting to a
-- numbered migration. Idempotent (IF NOT EXISTS) so a later re-run is safe.
-- Tenant key is company_id; there is no companies table yet, so no foreign key.

CREATE TABLE IF NOT EXISTS approval_rules (
  id           varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   varchar NOT NULL,
  name         text NOT NULL,
  priority     integer NOT NULL DEFAULT 100,
  enabled      boolean NOT NULL DEFAULT true,
  scope        varchar(16) NOT NULL DEFAULT 'global'
               CHECK (scope IN ('global', 'per_agent', 'per_tool')),
  agent_ids    jsonb NOT NULL DEFAULT '[]'::jsonb,
  tool_ids     jsonb NOT NULL DEFAULT '[]'::jsonb,
  rules        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamp NOT NULL DEFAULT now(),
  updated_at   timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS approval_rules_company_name_uidx
  ON approval_rules (company_id, name);
CREATE INDEX IF NOT EXISTS approval_rules_company_enabled_idx
  ON approval_rules (company_id, enabled, priority);

CREATE TABLE IF NOT EXISTS approvals (
  id              varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      varchar NOT NULL,
  requested_by    varchar,
  agent_id        varchar,
  action          text NOT NULL,
  urgency         varchar(16) NOT NULL DEFAULT 'normal'
                  CHECK (urgency IN ('low', 'normal', 'high', 'critical')),
  params          jsonb NOT NULL DEFAULT '{}'::jsonb,
  context         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          varchar(16) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  decision        varchar(24),
  policy_id       varchar,
  decided_by      text,
  decision_reason text,
  expires_at      timestamp NOT NULL,
  decided_at      timestamp,
  executed_at     timestamp,
  created_at      timestamp NOT NULL DEFAULT now(),
  updated_at      timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS approvals_company_status_idx
  ON approvals (company_id, status, created_at);
CREATE INDEX IF NOT EXISTS approvals_company_created_idx
  ON approvals (company_id, created_at);

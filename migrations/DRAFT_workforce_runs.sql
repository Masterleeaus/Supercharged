-- DRAFT - NOT APPLIED. Do not run. Not part of the numbered migration sequence and not in the journal.
-- Matches the workforce_* tables in shared/schema.ts (workforceRuns, workforceTasks,
-- workforceToolCalls, workforceAuditEvents) and the store in server/workforce/runtime/pg-store.ts.
-- Idempotent (IF NOT EXISTS) so a later re-run is safe.
-- Tenant key is company_id, NOT NULL on every table. There is no companies table yet, so no foreign keys.
-- workforce_audit_events is append-only: the store exposes no update or delete for it.

CREATE TABLE IF NOT EXISTS workforce_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL,
  status              varchar(24) NOT NULL,
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  team                jsonb NOT NULL,
  path                jsonb NOT NULL DEFAULT '[]'::jsonb,
  delegations         jsonb NOT NULL DEFAULT '[]'::jsonb,
  limits              jsonb NOT NULL,
  budget_max_tokens   integer NOT NULL,
  budget_max_tool_calls integer NOT NULL,
  budget_tokens_used  integer NOT NULL DEFAULT 0,
  budget_tool_calls   integer NOT NULL DEFAULT 0,
  retry               jsonb NOT NULL,
  pending_approval    jsonb,
  reason              text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workforce_runs_status_check CHECK (status IN (
    'queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'budget_exhausted'))
);

CREATE INDEX IF NOT EXISTS workforce_runs_company_status_idx
  ON workforce_runs (company_id, status);
CREATE INDEX IF NOT EXISTS workforce_runs_company_created_idx
  ON workforce_runs (company_id, created_at);

CREATE TABLE IF NOT EXISTS workforce_tasks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL,
  run_id      uuid NOT NULL,
  role_id     varchar(128) NOT NULL,
  status      varchar(24) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workforce_tasks_company_run_idx
  ON workforce_tasks (company_id, run_id);

CREATE TABLE IF NOT EXISTS workforce_tool_calls (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL,
  run_id        uuid NOT NULL,
  attempt       integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  tool_name     varchar(128) NOT NULL,
  params_sha256 varchar(64) NOT NULL,
  outcome       varchar(24) NOT NULL,
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workforce_tool_calls_outcome_check CHECK (outcome IN (
    'executed', 'failed', 'awaiting_approval', 'refused'))
);

CREATE INDEX IF NOT EXISTS workforce_tool_calls_company_run_idx
  ON workforce_tool_calls (company_id, run_id, created_at);

CREATE TABLE IF NOT EXISTS workforce_audit_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq         serial NOT NULL UNIQUE,
  company_id  uuid NOT NULL,
  run_id      uuid,
  kind        varchar(32) NOT NULL,
  actor       varchar(128),
  outcome     varchar(32),
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workforce_audit_events_kind_check CHECK (kind IN (
    'run.created', 'run.status', 'run.retry', 'run.handoff', 'run.delegation',
    'run.delegation_closed', 'run.approval_resumed', 'tool.decision', 'tool.execution',
    'workforce.export'))
);

CREATE INDEX IF NOT EXISTS workforce_audit_events_company_run_idx
  ON workforce_audit_events (company_id, run_id, seq);

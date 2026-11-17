-- REVIEW CANDIDATE ONLY. NOT in the automatic migration manifest. NOT promoted.
-- Phase 1 W12. Separate `voltagent` schema. Tenant rows are scoped by company_id.
-- No vector tables here (those belong to W5). No payloads are stored: tool calls keep names and
-- timings only, and eval rows keep numbers and the agent and session names.
-- Tenant rule matches the other candidates: app.company_id is set per transaction.
-- Prerequisite: the restricted application role (NO BYPASSRLS, not table owner) must be in place
-- before promotion. This file creates no roles and no passwords.

CREATE SCHEMA IF NOT EXISTS voltagent;

CREATE TABLE IF NOT EXISTS voltagent.agent_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL,
 agent_name varchar(120) NOT NULL,
 session_id varchar(200) NOT NULL,
 status varchar(16) NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','blocked')),
 started_at timestamptz NOT NULL DEFAULT now(),
 ended_at timestamptz,
 CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX IF NOT EXISTS voltagent_agent_runs_company_started_idx ON voltagent.agent_runs (company_id, started_at DESC);

CREATE TABLE IF NOT EXISTS voltagent.tool_calls (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL,
 run_id uuid NOT NULL REFERENCES voltagent.agent_runs(id) ON DELETE CASCADE,
 tool_name varchar(120) NOT NULL,
 status varchar(16) NOT NULL CHECK (status IN ('success','dry_run','blocked','failed','timed_out')),
 duration_ms integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voltagent_tool_calls_company_run_idx ON voltagent.tool_calls (company_id, run_id);

CREATE TABLE IF NOT EXISTS voltagent.eval_scores (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL,
 run_id uuid REFERENCES voltagent.agent_runs(id) ON DELETE SET NULL,
 agent_name varchar(120) NOT NULL,
 session_id varchar(200) NOT NULL,
 task_completion_rate numeric(5,2) NOT NULL CHECK (task_completion_rate BETWEEN 0 AND 100),
 hallucination_flag smallint NOT NULL CHECK (hallucination_flag IN (0,1)),
 tool_accuracy numeric(5,2) NOT NULL CHECK (tool_accuracy BETWEEN 0 AND 100),
 response_latency_ms integer NOT NULL DEFAULT 0 CHECK (response_latency_ms >= 0),
 composite_score numeric(5,2) NOT NULL CHECK (composite_score BETWEEN 0 AND 100),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voltagent_eval_scores_company_idx ON voltagent.eval_scores (company_id, created_at DESC);

ALTER TABLE voltagent.agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE voltagent.agent_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE voltagent.tool_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE voltagent.tool_calls FORCE ROW LEVEL SECURITY;
ALTER TABLE voltagent.eval_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE voltagent.eval_scores FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS voltagent_agent_runs_tenant ON voltagent.agent_runs;
CREATE POLICY voltagent_agent_runs_tenant ON voltagent.agent_runs
 USING (company_id = nullif(current_setting('app.company_id',true),'')::uuid)
 WITH CHECK (company_id = nullif(current_setting('app.company_id',true),'')::uuid);

DROP POLICY IF EXISTS voltagent_tool_calls_tenant ON voltagent.tool_calls;
CREATE POLICY voltagent_tool_calls_tenant ON voltagent.tool_calls
 USING (company_id = nullif(current_setting('app.company_id',true),'')::uuid)
 WITH CHECK (company_id = nullif(current_setting('app.company_id',true),'')::uuid);

DROP POLICY IF EXISTS voltagent_eval_scores_tenant ON voltagent.eval_scores;
CREATE POLICY voltagent_eval_scores_tenant ON voltagent.eval_scores
 USING (company_id = nullif(current_setting('app.company_id',true),'')::uuid)
 WITH CHECK (company_id = nullif(current_setting('app.company_id',true),'')::uuid);

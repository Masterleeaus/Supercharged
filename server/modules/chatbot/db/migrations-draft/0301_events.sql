-- DRAFT. Not applied. Owner promotes to the root migrations folder after integration.
-- Area: events (workflows, structured actions, outbox, webhooks).
-- Tables: chatbot_workflow_runs, chatbot_workflow_steps, chatbot_structured_actions,
--         chatbot_event_outbox, chatbot_webhook_subscriptions, chatbot_webhook_deliveries.
-- Constraints: chatbot_workflow_runs_pk, chatbot_workflow_runs_idempotency_uidx (partial),
--   chatbot_workflow_runs_company_conversation_fk, chatbot_workflow_runs_status_check,
--   chatbot_workflow_steps_pk, chatbot_workflow_steps_company_run_fk, chatbot_workflow_steps_status_check,
--   chatbot_structured_actions_pk, chatbot_structured_actions_idempotency_uidx (partial),
--   chatbot_structured_actions_company_conversation_fk, chatbot_structured_actions_status_check,
--   chatbot_event_outbox_pk, chatbot_event_outbox_dedupe_uidx, chatbot_event_outbox_status_check,
--   chatbot_webhook_subscriptions_pk, chatbot_webhook_deliveries_pk,
--   chatbot_webhook_deliveries_company_event_fk, chatbot_webhook_deliveries_company_subscription_fk.
-- Depends on shared tables chatbot_conversations (company_id, id).

CREATE TABLE chatbot_workflow_runs (
  company_id uuid NOT NULL,
  id varchar(191) NOT NULL,
  workflow varchar(191) NOT NULL,
  conversation_id varchar(191),
  idempotency_key varchar(191),
  status varchar(16) NOT NULL DEFAULT 'queued',
  attempt integer NOT NULL DEFAULT 1,
  max_attempts integer NOT NULL DEFAULT 3,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb,
  error text,
  next_run_at timestamptz,
  locked_at timestamptz,
  lock_token varchar(64),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_workflow_runs_pk PRIMARY KEY (company_id, id),
  CONSTRAINT chatbot_workflow_runs_company_conversation_fk FOREIGN KEY (company_id, conversation_id)
    REFERENCES chatbot_conversations (company_id, id),
  CONSTRAINT chatbot_workflow_runs_status_check CHECK (status IN ('queued', 'running', 'waiting', 'completed', 'failed', 'cancelled'))
);
CREATE UNIQUE INDEX chatbot_workflow_runs_idempotency_uidx ON chatbot_workflow_runs (company_id, workflow, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX chatbot_workflow_runs_company_status_idx ON chatbot_workflow_runs (company_id, status, next_run_at);

CREATE TABLE chatbot_workflow_steps (
  company_id uuid NOT NULL,
  run_id varchar(191) NOT NULL,
  step_key varchar(191) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'running',
  lock_token varchar(64) NOT NULL,
  locked_at timestamptz NOT NULL DEFAULT now(),
  output jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_workflow_steps_pk PRIMARY KEY (company_id, run_id, step_key),
  CONSTRAINT chatbot_workflow_steps_company_run_fk FOREIGN KEY (company_id, run_id)
    REFERENCES chatbot_workflow_runs (company_id, id),
  CONSTRAINT chatbot_workflow_steps_status_check CHECK (status IN ('running', 'completed'))
);

CREATE TABLE chatbot_structured_actions (
  company_id uuid NOT NULL,
  id varchar(191) NOT NULL,
  conversation_id varchar(191) NOT NULL,
  kind varchar(64) NOT NULL,
  args jsonb NOT NULL,
  presentation jsonb,
  status varchar(16) NOT NULL DEFAULT 'proposed',
  requires_approval boolean NOT NULL,
  approved_by varchar(191),
  result_ref varchar(191),
  failure_reason text,
  expires_at timestamptz,
  idempotency_key varchar(191),
  execution_token varchar(64),
  execution_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_structured_actions_pk PRIMARY KEY (company_id, id),
  CONSTRAINT chatbot_structured_actions_company_conversation_fk FOREIGN KEY (company_id, conversation_id)
    REFERENCES chatbot_conversations (company_id, id),
  CONSTRAINT chatbot_structured_actions_status_check CHECK (status IN ('proposed', 'approved', 'rejected', 'executed', 'failed', 'expired'))
);
CREATE UNIQUE INDEX chatbot_structured_actions_idempotency_uidx ON chatbot_structured_actions (company_id, conversation_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX chatbot_structured_actions_company_conv_status_idx ON chatbot_structured_actions (company_id, conversation_id, status);

CREATE TABLE chatbot_event_outbox (
  company_id uuid NOT NULL,
  id varchar(191) NOT NULL,
  topic varchar(191) NOT NULL,
  aggregate_id varchar(191) NOT NULL,
  payload jsonb NOT NULL,
  dedupe_key varchar(191) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by varchar(191),
  realtime_published_at timestamptz,
  published_at timestamptz,
  failed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_event_outbox_pk PRIMARY KEY (company_id, id),
  CONSTRAINT chatbot_event_outbox_status_check CHECK (status IN ('pending', 'published', 'failed'))
);
CREATE UNIQUE INDEX chatbot_event_outbox_dedupe_uidx ON chatbot_event_outbox (company_id, dedupe_key);
CREATE INDEX chatbot_event_outbox_company_status_idx ON chatbot_event_outbox (company_id, status, available_at);

CREATE TABLE chatbot_webhook_subscriptions (
  company_id uuid NOT NULL,
  id varchar(191) NOT NULL,
  url text NOT NULL,
  topics jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  signing_secret jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_webhook_subscriptions_pk PRIMARY KEY (company_id, id)
);
CREATE INDEX chatbot_webhook_subscriptions_company_idx ON chatbot_webhook_subscriptions (company_id, active);

CREATE TABLE chatbot_webhook_deliveries (
  company_id uuid NOT NULL,
  event_id varchar(191) NOT NULL,
  subscription_id varchar(191) NOT NULL,
  attempt integer NOT NULL,
  http_status integer,
  ok boolean NOT NULL,
  error_message text,
  delivered_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_webhook_deliveries_pk PRIMARY KEY (company_id, event_id, subscription_id, attempt),
  CONSTRAINT chatbot_webhook_deliveries_company_event_fk FOREIGN KEY (company_id, event_id)
    REFERENCES chatbot_event_outbox (company_id, id),
  CONSTRAINT chatbot_webhook_deliveries_company_subscription_fk FOREIGN KEY (company_id, subscription_id)
    REFERENCES chatbot_webhook_subscriptions (company_id, id)
);

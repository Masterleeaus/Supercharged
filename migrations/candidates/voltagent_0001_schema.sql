-- CANDIDATE, not promoted. Review only, never applied by the production migration runner.
-- Creates the VoltAgent PostgreSQL memory tables in their own schema, "voltagent".
-- Table names and columns match @voltagent/postgres 2.1.3 (PostgreSQLMemoryAdapter, default tablePrefix "voltagent_memory").
-- Depends on the W5 decision for vector tables: this file has no vector extension and no vector columns.
-- The @voltagent/postgres vector adapter table (voltagent_vector_vectors) is deliberately left out until W5 decides.
-- Promotion path (per STATUS.md): review, then move to migrations/ with the next free number, after the W12 narrow checks pass.
-- Every statement is idempotent (IF NOT EXISTS) and schema-qualified. It touches no public-schema table.

CREATE SCHEMA IF NOT EXISTS voltagent;

CREATE TABLE IF NOT EXISTS voltagent.voltagent_memory_users (
  id TEXT PRIMARY KEY,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS voltagent.voltagent_memory_conversations (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  metadata JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS voltagent.voltagent_memory_messages (
  conversation_id TEXT NOT NULL REFERENCES voltagent.voltagent_memory_conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  parts JSONB,
  metadata JSONB,
  format_version INTEGER DEFAULT 2,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  PRIMARY KEY (conversation_id, message_id)
);

CREATE TABLE IF NOT EXISTS voltagent.voltagent_memory_workflow_states (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  status TEXT NOT NULL,
  input JSONB,
  context JSONB,
  workflow_state JSONB,
  suspension JSONB,
  events JSONB,
  output JSONB,
  cancellation JSONB,
  user_id TEXT,
  conversation_id TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS voltagent.voltagent_memory_steps (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES voltagent.voltagent_memory_conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT,
  operation_id TEXT,
  step_index INTEGER NOT NULL,
  type TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  arguments JSONB,
  result JSONB,
  usage JSONB,
  sub_agent_id TEXT,
  sub_agent_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_voltagent_memory_conversations_user_id ON voltagent.voltagent_memory_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_voltagent_memory_conversations_resource_id ON voltagent.voltagent_memory_conversations(resource_id);
CREATE INDEX IF NOT EXISTS idx_voltagent_memory_messages_conversation_id ON voltagent.voltagent_memory_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_voltagent_memory_messages_created_at ON voltagent.voltagent_memory_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_voltagent_memory_workflow_states_workflow_id ON voltagent.voltagent_memory_workflow_states(workflow_id);
CREATE INDEX IF NOT EXISTS idx_voltagent_memory_workflow_states_status ON voltagent.voltagent_memory_workflow_states(status);
CREATE INDEX IF NOT EXISTS idx_voltagent_memory_steps_conversation ON voltagent.voltagent_memory_steps(conversation_id, step_index);
CREATE INDEX IF NOT EXISTS idx_voltagent_memory_steps_operation ON voltagent.voltagent_memory_steps(conversation_id, operation_id);

-- DRAFT. NOT APPLIED. UNVERIFIED against Postgres: no test has run this file on a database.
--
-- Voice-call sessions (server/modules/chatbot/voice-call/). Number 0030 is provisional; renumber at promotion.
-- Tables: chatbot_voice_calls.
-- Constraints: primary key id; FK (company_id, chatbot_id) -> chatbots (company_id, id);
--   unique (company_id, provider, provider_call_id); unique (company_id, chatbot_id, idempotency_key).
--   Nulls are distinct in PostgreSQL, so rows without a provider id or idempotency key do not collide.
-- Indexes: (company_id, chatbot_id, status), (company_id, chatbot_id, ended_at).

CREATE TABLE IF NOT EXISTS chatbot_voice_calls (
  id                 varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL,
  chatbot_id         varchar NOT NULL,
  conversation_id    varchar,
  direction          varchar(16) NOT NULL,
  provider           varchar(32) NOT NULL,
  provider_call_id   varchar(255),
  idempotency_key    varchar(128),
  status             varchar(16) NOT NULL DEFAULT 'ringing',
  end_reason         varchar(32),
  from_number        varchar(32) NOT NULL,
  to_number          varchar(32) NOT NULL,
  max_seconds        integer,
  started_at         timestamptz,
  ended_at           timestamptz,
  duration_seconds   integer,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS chatbot_voice_calls_company_provider_call_uidx
  ON chatbot_voice_calls (company_id, provider, provider_call_id);

CREATE UNIQUE INDEX IF NOT EXISTS chatbot_voice_calls_company_chatbot_idem_uidx
  ON chatbot_voice_calls (company_id, chatbot_id, idempotency_key);

CREATE INDEX IF NOT EXISTS chatbot_voice_calls_company_chatbot_status_idx
  ON chatbot_voice_calls (company_id, chatbot_id, status);

CREATE INDEX IF NOT EXISTS chatbot_voice_calls_company_chatbot_ended_idx
  ON chatbot_voice_calls (company_id, chatbot_id, ended_at);

ALTER TABLE chatbot_voice_calls
  ADD CONSTRAINT chatbot_voice_calls_company_chatbot_fk
  FOREIGN KEY (company_id, chatbot_id) REFERENCES chatbots (company_id, id);

-- Rollback (draft):
-- DROP TABLE IF EXISTS chatbot_voice_calls;

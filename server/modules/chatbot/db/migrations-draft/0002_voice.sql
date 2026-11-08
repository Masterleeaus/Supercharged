-- DRAFT. NOT APPLIED. UNVERIFIED against Postgres: no test has run this file on a database.
--
-- Voice chat pipeline (server/modules/chatbot/db/voice.ts, voice/DECISIONS.md).
-- Tables: chatbot_voice_sessions, chatbot_voice_turns.
-- Constraints: chatbot_voice_sessions_pk, chatbot_voice_sessions_company_chatbot_fk,
--   chatbot_voice_sessions_company_conversation_fk, chatbot_voice_sessions_status_check,
--   chatbot_voice_sessions_end_reason_check, chatbot_voice_sessions_limit_check, chatbot_voice_sessions_usage_check,
--   chatbot_voice_turns_pk, chatbot_voice_turns_company_session_fk.
-- Parent tables (chatbots, chatbot_conversations) come from shared/schema.ts and must exist first.
-- No audio column exists on purpose. Transcripts are stored as chatbot_messages rows.

CREATE TABLE IF NOT EXISTS chatbot_voice_sessions (
  company_id       uuid        NOT NULL,
  id               varchar(191) NOT NULL,
  chatbot_id       varchar(191) NOT NULL,
  conversation_id  varchar(191) NOT NULL,
  status           varchar(16) NOT NULL DEFAULT 'active',
  end_reason       varchar(32),
  limit_ms         bigint,
  used_ms          bigint      NOT NULL DEFAULT 0,
  turn_count       integer     NOT NULL DEFAULT 0,
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_voice_sessions_pk PRIMARY KEY (company_id, id),
  CONSTRAINT chatbot_voice_sessions_company_chatbot_fk
    FOREIGN KEY (company_id, chatbot_id) REFERENCES chatbots (company_id, id),
  CONSTRAINT chatbot_voice_sessions_company_conversation_fk
    FOREIGN KEY (company_id, conversation_id) REFERENCES chatbot_conversations (company_id, id),
  CONSTRAINT chatbot_voice_sessions_status_check CHECK (status IN ('active', 'ended')),
  CONSTRAINT chatbot_voice_sessions_end_reason_check
    CHECK (end_reason IS NULL OR end_reason IN ('customer', 'limit_reached', 'failed', 'idle')),
  CONSTRAINT chatbot_voice_sessions_limit_check CHECK (limit_ms IS NULL OR limit_ms >= 0),
  CONSTRAINT chatbot_voice_sessions_usage_check CHECK (used_ms >= 0)
);

CREATE INDEX IF NOT EXISTS chatbot_voice_sessions_company_idx ON chatbot_voice_sessions (company_id, started_at);
CREATE INDEX IF NOT EXISTS chatbot_voice_sessions_company_chatbot_idx ON chatbot_voice_sessions (company_id, chatbot_id);

CREATE TABLE IF NOT EXISTS chatbot_voice_turns (
  company_id            uuid        NOT NULL,
  session_id            varchar(191) NOT NULL,
  seq                   integer     NOT NULL,
  duration_ms           integer,
  customer_message_id   varchar(191) NOT NULL,
  assistant_message_id  varchar(191),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_voice_turns_pk PRIMARY KEY (company_id, session_id, seq),
  CONSTRAINT chatbot_voice_turns_company_session_fk
    FOREIGN KEY (company_id, session_id) REFERENCES chatbot_voice_sessions (company_id, id)
);

CREATE INDEX IF NOT EXISTS chatbot_voice_turns_company_idx ON chatbot_voice_turns (company_id);

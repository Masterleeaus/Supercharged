-- SUPERSEDED 2026-11-09: promoted to migrations/0010c_chatbot.sql. Do not run; kept for history.
-- DRAFT - DO NOT RUN. Not part of the numbered migration sequence.
-- Matches server/modules/chatbot/schema.DRAFT.ts. Review both before promoting to a numbered migration.
-- Idempotent (IF NOT EXISTS) so a later re-run is safe.
-- Tenant key is company_id; there is no companies table yet, so no foreign key to one.
-- Row-level security policies for these tables are not included here. Add them with the tenancy plan
-- in migrations/DRAFT_company_scope.sql.

CREATE TABLE IF NOT EXISTS chatbots (
  id                    varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid    NOT NULL,
  title                 varchar(200) NOT NULL,
  language              varchar(10) NOT NULL DEFAULT 'en',
  welcome_message       text,
  instructions          text,
  generative_ui_enabled boolean NOT NULL DEFAULT true,
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamp NOT NULL DEFAULT now(),
  updated_at            timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS chatbots_company_id_uidx
  ON chatbots (company_id, id);
CREATE INDEX IF NOT EXISTS chatbots_company_active_idx
  ON chatbots (company_id, active);

CREATE TABLE IF NOT EXISTS chatbot_conversations (
  id                  varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid    NOT NULL,
  chatbot_id          varchar NOT NULL,
  session_id          varchar(128) NOT NULL,
  channel             varchar(32) NOT NULL DEFAULT 'web',
  connect_agent_at    timestamp,
  is_shown_on_history boolean NOT NULL DEFAULT true,
  ticket_status       varchar(16) NOT NULL DEFAULT 'new'
                      CHECK (ticket_status IN ('new', 'closed')),
  pinned              boolean NOT NULL DEFAULT false,
  last_activity_at    timestamp NOT NULL DEFAULT now(),
  created_at          timestamp NOT NULL DEFAULT now(),
  updated_at          timestamp NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_conversations_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT chatbot_conversations_company_chatbot_fk
    FOREIGN KEY (company_id, chatbot_id) REFERENCES chatbots (company_id, id)
);

CREATE INDEX IF NOT EXISTS chatbot_conversations_company_activity_idx
  ON chatbot_conversations (company_id, last_activity_at);
CREATE INDEX IF NOT EXISTS chatbot_conversations_company_session_idx
  ON chatbot_conversations (company_id, session_id);

CREATE TABLE IF NOT EXISTS chatbot_messages (
  id                varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid    NOT NULL,
  conversation_id   varchar NOT NULL,
  role              varchar(16) NOT NULL CHECK (role IN ('user', 'assistant', 'staff', 'system')),
  message           text NOT NULL,
  content_type      varchar(16) NOT NULL DEFAULT 'text' CHECK (content_type IN ('text', 'titan-ui')),
  ui_spec           jsonb,
  media_url         text,
  media_name        text,
  is_internal_note  boolean NOT NULL DEFAULT false,
  read_at           timestamp,
  created_at        timestamp NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_messages_company_conversation_fk
    FOREIGN KEY (company_id, conversation_id) REFERENCES chatbot_conversations (company_id, id)
);

CREATE INDEX IF NOT EXISTS chatbot_messages_company_conversation_idx
  ON chatbot_messages (company_id, conversation_id, created_at);
CREATE INDEX IF NOT EXISTS chatbot_messages_unread_idx
  ON chatbot_messages (company_id, conversation_id, role, read_at);

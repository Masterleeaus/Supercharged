-- DRAFT. NOT APPLIED. UNVERIFIED against Postgres: no test has run this file on a database.
--
-- Conversation and reply runtime: reply turn claims and staff drafts. Mirrors db/runtime.ts.
-- Tables: chatbot_reply_turns, chatbot_staff_drafts.
-- Constraints:
--   chatbot_reply_turns_pk                                      (company_id, conversation_id, turn_key)
--   chatbot_reply_turns_state_check                             state IN ('pending', 'done')
--   chatbot_reply_turns_company_conversation_fk                 (company_id, conversation_id) -> chatbot_conversations
--   chatbot_staff_drafts_pk                                     (company_id, id)
--   chatbot_staff_drafts_company_conversation_staff_uidx        (company_id, conversation_id, staff_id)
--   chatbot_staff_drafts_company_conversation_fk                (company_id, conversation_id) -> chatbot_conversations
-- Parent key: chatbot_conversations_company_id_uidx (company_id, id) in shared/schema.ts.
-- staff_id is '' when the caller has no staff id, so the unique key holds for anonymous drafts.

CREATE TABLE IF NOT EXISTS chatbot_reply_turns (
  company_id uuid NOT NULL,
  conversation_id varchar(191) NOT NULL,
  turn_key varchar(191) NOT NULL,
  state varchar(16) NOT NULL,
  message_id varchar(191),
  claimed_at timestamptz NOT NULL,
  completed_at timestamptz,
  CONSTRAINT chatbot_reply_turns_pk PRIMARY KEY (company_id, conversation_id, turn_key),
  CONSTRAINT chatbot_reply_turns_state_check CHECK (state IN ('pending', 'done')),
  CONSTRAINT chatbot_reply_turns_company_conversation_fk
    FOREIGN KEY (company_id, conversation_id) REFERENCES chatbot_conversations (company_id, id)
);

CREATE INDEX IF NOT EXISTS chatbot_reply_turns_company_idx ON chatbot_reply_turns (company_id);

CREATE TABLE IF NOT EXISTS chatbot_staff_drafts (
  company_id uuid NOT NULL,
  id varchar(191) NOT NULL,
  conversation_id varchar(191) NOT NULL,
  staff_id varchar(191) NOT NULL DEFAULT '',
  content text,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_staff_drafts_pk PRIMARY KEY (company_id, id),
  CONSTRAINT chatbot_staff_drafts_company_conversation_fk
    FOREIGN KEY (company_id, conversation_id) REFERENCES chatbot_conversations (company_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS chatbot_staff_drafts_company_conversation_staff_uidx
  ON chatbot_staff_drafts (company_id, conversation_id, staff_id);

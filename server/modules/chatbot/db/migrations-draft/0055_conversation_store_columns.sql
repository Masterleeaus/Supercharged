-- DRAFT. NOT APPLIED. UNVERIFIED against a live database. The harness applies it to a fresh database only.
--
-- Columns on chatbot_conversations that the conversation store needs (runtime/conversation-store.ts,
-- runtime/DECISIONS.md change request dated 2026-11-09):
--   status            open | archived | merged            (ConversationStatus, contracts/runtime.ts)
--   handler           ai | human                           (Handler, inbox/types.ts)
--   merged_into_id    same company, composite FK, set only when status = 'merged'
--   summary           text cache, null until first summary
--   summary_updated_at timestamp of the cached summary
--   customer_id, external_thread_id   runtime identifiers (ConversationRecord), varchar(191)
--
-- Also widens chatbot_messages_role_check to the roles the runtime stores (user, assistant, staff, system).
-- migrations/0010c_chatbot.sql and migrations/DRAFT_chatbot.sql now carry the same widened check, so a fresh
-- database already has it; the DROP/ADD below only matters for a database created from the older narrow base.
-- The Drizzle definitions live in shared/schema.ts (chatbotConversations, chatbotMessages) and match this file.
-- Requires migrations/DRAFT_chatbot.sql (or 0010c_chatbot.sql) first.
-- Idempotent: ADD COLUMN IF NOT EXISTS, and constraints are dropped before they are added.

ALTER TABLE chatbot_conversations ADD COLUMN IF NOT EXISTS status varchar(16) NOT NULL DEFAULT 'open';
ALTER TABLE chatbot_conversations ADD COLUMN IF NOT EXISTS handler varchar(8) NOT NULL DEFAULT 'ai';
ALTER TABLE chatbot_conversations ADD COLUMN IF NOT EXISTS merged_into_id varchar;
ALTER TABLE chatbot_conversations ADD COLUMN IF NOT EXISTS summary text;
ALTER TABLE chatbot_conversations ADD COLUMN IF NOT EXISTS summary_updated_at timestamp;
ALTER TABLE chatbot_conversations ADD COLUMN IF NOT EXISTS customer_id varchar(191);
ALTER TABLE chatbot_conversations ADD COLUMN IF NOT EXISTS external_thread_id varchar(191);

ALTER TABLE chatbot_messages DROP CONSTRAINT IF EXISTS chatbot_messages_role_check;
ALTER TABLE chatbot_messages ADD CONSTRAINT chatbot_messages_role_check
  CHECK (role IN ('user', 'assistant', 'staff', 'system'));

ALTER TABLE chatbot_conversations DROP CONSTRAINT IF EXISTS chatbot_conversations_status_check;
ALTER TABLE chatbot_conversations ADD CONSTRAINT chatbot_conversations_status_check
  CHECK (status IN ('open', 'archived', 'merged'));

ALTER TABLE chatbot_conversations DROP CONSTRAINT IF EXISTS chatbot_conversations_handler_check;
ALTER TABLE chatbot_conversations ADD CONSTRAINT chatbot_conversations_handler_check
  CHECK (handler IN ('ai', 'human'));

-- A merged row names its target, and only a merged row does.
ALTER TABLE chatbot_conversations DROP CONSTRAINT IF EXISTS chatbot_conversations_merged_state_check;
ALTER TABLE chatbot_conversations ADD CONSTRAINT chatbot_conversations_merged_state_check
  CHECK ((status = 'merged') = (merged_into_id IS NOT NULL));

-- Composite FK: a merge target must be in the same company. MATCH SIMPLE skips it when merged_into_id is null.
ALTER TABLE chatbot_conversations DROP CONSTRAINT IF EXISTS chatbot_conversations_company_merged_into_fk;
ALTER TABLE chatbot_conversations ADD CONSTRAINT chatbot_conversations_company_merged_into_fk
  FOREIGN KEY (company_id, merged_into_id) REFERENCES chatbot_conversations (company_id, id);

CREATE INDEX IF NOT EXISTS chatbot_conversations_company_status_idx
  ON chatbot_conversations (company_id, status, last_activity_at);

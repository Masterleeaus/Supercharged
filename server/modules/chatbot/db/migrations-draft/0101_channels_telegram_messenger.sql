-- DRAFT. NOT APPLIED. UNVERIFIED against Postgres: no test has run this file on a database.
-- Keeps the name the harness apply order uses (migration-order.json). Owner renumbers at integration.
-- Replaces the earlier version of this file, which held only the accounts and send-key tables.
--
-- Tables: chatbot_channel_accounts (encrypted credentials, all channel kinds),
--         chatbot_channel_send_keys (provider send ledger), chatbot_channel_outbox (outbound messages and their state).
-- Source: server/modules/chatbot/db/channels-core.ts. Keep the two in step.
-- Constraints:
--   chatbot_channel_accounts_company_kind_account_uidx  unique (company_id, kind, account_id)
--   chatbot_channel_accounts_kind_check                 kind is one of the six channel kinds
--   chatbot_channel_accounts_status_check               status is active or disabled
--   chatbot_channel_send_keys_company_key_uq            unique (company_id, channel, account_id, idempotency_key)
--   chatbot_channel_outbox_company_key_uq               unique (company_id, idempotency_key)
--   chatbot_channel_outbox_status_check                 status is pending, sending, sent or failed
--   chatbot_channel_outbox_attempts_check               attempts >= 0
-- Indexes: company_id on accounts and send keys; (company_id, status, next_attempt_at) on the outbox.
-- Secrets: sealed and sealed_credentials hold SealedSecret JSON. No plaintext credential column exists.

CREATE TABLE IF NOT EXISTS chatbot_channel_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL,
  kind          varchar(16) NOT NULL,
  account_id    varchar(191) NOT NULL,
  display_name  varchar(191),
  sealed        jsonb NOT NULL,
  status        varchar(16) NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_channel_accounts_company_kind_account_uidx UNIQUE (company_id, kind, account_id),
  CONSTRAINT chatbot_channel_accounts_kind_check CHECK (kind IN ('whatsapp', 'telegram', 'messenger', 'instagram', 'voice', 'web')),
  CONSTRAINT chatbot_channel_accounts_status_check CHECK (status IN ('active', 'disabled'))
);
CREATE INDEX IF NOT EXISTS chatbot_channel_accounts_company_idx ON chatbot_channel_accounts (company_id);

CREATE TABLE IF NOT EXISTS chatbot_channel_send_keys (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL,
  channel             varchar(16) NOT NULL,
  account_id          varchar(191) NOT NULL,
  idempotency_key     varchar(256) NOT NULL,
  status              varchar(16) NOT NULL,
  external_message_id varchar(256),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_channel_send_keys_company_key_uq UNIQUE (company_id, channel, account_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS chatbot_channel_send_keys_company_idx ON chatbot_channel_send_keys (company_id);

CREATE TABLE IF NOT EXISTS chatbot_channel_outbox (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL,
  channel                     varchar(16) NOT NULL,
  account_id                  varchar(191) NOT NULL,
  recipient                   varchar(256) NOT NULL,
  content_kind                varchar(16) NOT NULL,
  text                        text,
  attachment_url              text,
  template_name               varchar(191),
  template_params             jsonb,
  reply_to_external_message_id varchar(256),
  idempotency_key             varchar(256) NOT NULL,
  status                      varchar(16) NOT NULL DEFAULT 'pending',
  attempts                    integer NOT NULL DEFAULT 0,
  next_attempt_at             timestamptz NOT NULL DEFAULT now(),
  lease_until                 timestamptz,
  external_message_id         varchar(256),
  last_error_code             varchar(64),
  last_error_message          varchar(300),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  sent_at                     timestamptz,
  CONSTRAINT chatbot_channel_outbox_company_key_uq UNIQUE (company_id, idempotency_key),
  CONSTRAINT chatbot_channel_outbox_status_check CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  CONSTRAINT chatbot_channel_outbox_attempts_check CHECK (attempts >= 0)
);
CREATE INDEX IF NOT EXISTS chatbot_channel_outbox_due_idx ON chatbot_channel_outbox (company_id, status, next_attempt_at);

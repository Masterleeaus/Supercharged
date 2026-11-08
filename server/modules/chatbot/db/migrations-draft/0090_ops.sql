-- DRAFT. NOT APPLIED. UNVERIFIED against Postgres: no test has run this file on a database.
--
-- Attachment metadata for the ops slice (server/modules/chatbot/ops/). Source: db/ops.ts.
-- Tables: chatbot_attachments.
-- Constraints: chatbot_attachments_pkey (company_id, id), chatbot_attachments_company_storage_key_uidx,
--              chatbot_attachments_size_check, and two non-unique indexes on (company_id, created_at) and (company_id, sha256).
-- Parent tables are not referenced: attachments are not yet tied to a conversation (see ops/DECISIONS.md).

CREATE TABLE IF NOT EXISTS chatbot_attachments (
  company_id uuid NOT NULL,
  id varchar(191) NOT NULL,
  filename varchar(255) NOT NULL,
  content_type varchar(127) NOT NULL,
  size_bytes integer NOT NULL,
  sha256 char(64) NOT NULL,
  storage_key varchar(512) NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  deleted_at timestamp,
  CONSTRAINT chatbot_attachments_pkey PRIMARY KEY (company_id, id),
  CONSTRAINT chatbot_attachments_size_check CHECK (size_bytes > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS chatbot_attachments_company_storage_key_uidx ON chatbot_attachments (company_id, storage_key);
CREATE INDEX IF NOT EXISTS chatbot_attachments_company_created_idx ON chatbot_attachments (company_id, created_at);
CREATE INDEX IF NOT EXISTS chatbot_attachments_company_sha256_idx ON chatbot_attachments (company_id, sha256);

-- Rollback (draft):
-- DROP TABLE IF EXISTS chatbot_attachments;

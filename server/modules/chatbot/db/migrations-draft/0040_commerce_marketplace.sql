-- DRAFT. NOT APPLIED. UNVERIFIED against Postgres: no test has run this file on a database.
--
-- Tables: chatbot_marketplace_listings, chatbot_marketplace_write_proposals,
--         chatbot_marketplace_bulk_batches, chatbot_marketplace_bulk_items.
-- Constraints: primary keys start with company_id; unique indexes
--         chatbot_marketplace_write_proposals_company_connection_key_uidx (company_id, connection_id, idempotency_key),
--         chatbot_marketplace_bulk_batches_company_connection_key_uidx (company_id, connection_id, idempotency_key),
--         chatbot_marketplace_bulk_items_batch_listing_uidx (company_id, batch_id, external_listing_id).
-- Checks: provider in (ebay, amazon, etsy, generic); status lists match WRITE_STATES and BULK_ITEM_STATES.
-- Source: server/modules/chatbot/db/commerce-marketplace.ts. Keep the two in step.
-- No foreign keys yet: the connection table belongs to the credentials area and is referenced at promotion.
-- File number 0040 is a placeholder; 0030 is taken by 0030_voice_call.sql. Renumber at promotion if another area takes it.

CREATE TABLE IF NOT EXISTS chatbot_marketplace_listings (
  company_id           uuid         NOT NULL,
  connection_id        varchar(191) NOT NULL,
  external_listing_id  varchar(191) NOT NULL,
  provider             varchar(16)  NOT NULL,
  source_hash          varchar(64)  NOT NULL,
  snapshot             jsonb        NOT NULL,
  first_seen_at        timestamptz  NOT NULL DEFAULT now(),
  last_seen_at         timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_marketplace_listings_pk PRIMARY KEY (company_id, connection_id, external_listing_id),
  CONSTRAINT chatbot_marketplace_listings_provider_check CHECK (provider IN ('ebay', 'amazon', 'etsy', 'generic'))
);
CREATE INDEX IF NOT EXISTS chatbot_marketplace_listings_company_seen_idx
  ON chatbot_marketplace_listings (company_id, connection_id, last_seen_at);

CREATE TABLE IF NOT EXISTS chatbot_marketplace_write_proposals (
  company_id            uuid         NOT NULL,
  id                    varchar(191) NOT NULL,
  connection_id         varchar(191) NOT NULL,
  owner_user_id         varchar(191) NOT NULL,
  provider              varchar(16)  NOT NULL,
  external_listing_id   varchar(191) NOT NULL,
  operation             varchar(32)  NOT NULL,
  status                varchar(32)  NOT NULL,
  idempotency_key       varchar(191) NOT NULL,
  action_hash           varchar(64)  NOT NULL,
  expected_source_hash  varchar(64)  NOT NULL,
  requested_changes     jsonb        NOT NULL,
  before_state          jsonb        NOT NULL,
  after_state           jsonb,
  after_source_hash     varchar(64),
  rollback_state        jsonb        NOT NULL,
  conflicts             jsonb        NOT NULL,
  warnings              jsonb        NOT NULL,
  approval_token_hash   varchar(64),
  approval_expires_at   timestamptz,
  approved_by           varchar(191),
  approved_at           timestamptz,
  approval_snapshot     jsonb,
  batch_id              varchar(191),
  error_code            varchar(64),
  created_at            timestamptz  NOT NULL DEFAULT now(),
  updated_at            timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_marketplace_write_proposals_pk PRIMARY KEY (company_id, id),
  CONSTRAINT chatbot_marketplace_write_proposals_status_check CHECK (status IN (
    'prepared', 'conflict_blocked', 'approved', 'queued', 'executing', 'executed',
    'failed', 'cancelled', 'rolled_back', 'rollback_failed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS chatbot_marketplace_write_proposals_company_connection_key_uidx
  ON chatbot_marketplace_write_proposals (company_id, connection_id, idempotency_key);
CREATE INDEX IF NOT EXISTS chatbot_marketplace_write_proposals_batch_idx
  ON chatbot_marketplace_write_proposals (company_id, batch_id);

CREATE TABLE IF NOT EXISTS chatbot_marketplace_bulk_batches (
  company_id           uuid         NOT NULL,
  id                   varchar(191) NOT NULL,
  connection_id        varchar(191) NOT NULL,
  owner_user_id        varchar(191) NOT NULL,
  provider             varchar(16)  NOT NULL,
  operation            varchar(32)  NOT NULL,
  status               varchar(32)  NOT NULL,
  idempotency_key      varchar(191) NOT NULL,
  batch_hash           varchar(64)  NOT NULL,
  selection_filters    jsonb        NOT NULL,
  change_template      jsonb        NOT NULL,
  selected_count       integer      NOT NULL DEFAULT 0,
  eligible_count       integer      NOT NULL DEFAULT 0,
  blocked_count        integer      NOT NULL DEFAULT 0,
  succeeded_count      integer      NOT NULL DEFAULT 0,
  failed_count         integer      NOT NULL DEFAULT 0,
  rolled_back_count    integer      NOT NULL DEFAULT 0,
  impact_summary       jsonb        NOT NULL,
  approval_token_hash  varchar(64),
  approval_expires_at  timestamptz,
  approved_by          varchar(191),
  approved_at          timestamptz,
  created_at           timestamptz  NOT NULL DEFAULT now(),
  updated_at           timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_marketplace_bulk_batches_pk PRIMARY KEY (company_id, id),
  CONSTRAINT chatbot_marketplace_bulk_batches_selected_check CHECK (selected_count >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS chatbot_marketplace_bulk_batches_company_connection_key_uidx
  ON chatbot_marketplace_bulk_batches (company_id, connection_id, idempotency_key);

CREATE TABLE IF NOT EXISTS chatbot_marketplace_bulk_items (
  company_id           uuid         NOT NULL,
  id                   varchar(191) NOT NULL,
  batch_id             varchar(191) NOT NULL,
  proposal_id          varchar(191),
  external_listing_id  varchar(191) NOT NULL,
  status               varchar(32)  NOT NULL,
  error_code           varchar(64),
  proposed_changes     jsonb        NOT NULL,
  impact               jsonb        NOT NULL,
  conflicts            jsonb        NOT NULL,
  updated_at           timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_marketplace_bulk_items_pk PRIMARY KEY (company_id, id),
  CONSTRAINT chatbot_marketplace_bulk_items_status_check CHECK (status IN (
    'ready', 'blocked', 'failed', 'succeeded', 'rolled_back', 'rollback_failed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS chatbot_marketplace_bulk_items_batch_listing_uidx
  ON chatbot_marketplace_bulk_items (company_id, batch_id, external_listing_id);

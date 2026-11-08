-- DRAFT. Not applied. Not copied to the root migrations folder until the owner promotes it.
-- Area: commerce conversational (approval actions, commerce credentials, customer communications,
-- listing proposals and rules, shopping session state).
-- Tables: chatbot_commerce_approval_actions, chatbot_commerce_credentials, chatbot_commerce_comm_threads,
--         chatbot_commerce_comm_messages, chatbot_commerce_comm_policies, chatbot_commerce_escalations,
--         chatbot_commerce_listing_rules, chatbot_commerce_listing_proposals, chatbot_commerce_shopping_sessions.
-- Unique constraints (all include company_id):
--         chatbot_commerce_actions_company_idem_uidx, chatbot_commerce_credentials_company_provider_uidx,
--         chatbot_commerce_comm_threads_company_external_uidx, chatbot_commerce_comm_messages_company_external_uidx,
--         chatbot_commerce_listing_proposals_company_hash_uidx.
-- Column names are snake_case. No plaintext credential column exists: credentials are stored as a sealed JSON value.

CREATE TABLE IF NOT EXISTS chatbot_commerce_approval_actions (
  company_id uuid NOT NULL,
  id uuid NOT NULL,
  chatbot_id varchar(191) NOT NULL,
  scope varchar(20) NOT NULL CHECK (scope IN ('conversational', 'communication')),
  subject_id varchar(191) NOT NULL,
  action_type varchar(100) NOT NULL,
  status varchar(30) NOT NULL CHECK (status IN ('awaiting_approval', 'ready', 'approved', 'executed', 'failed', 'expired')),
  authority_level varchar(40) NOT NULL,
  amount_minor bigint,
  currency char(3),
  idempotency_key varchar(191) NOT NULL,
  approval_token_hash char(64),
  approved_by varchar(191),
  executed_by varchar(191),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  failure_reason text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  CONSTRAINT chatbot_commerce_actions_company_idem_uidx UNIQUE (company_id, chatbot_id, scope, idempotency_key)
);
CREATE INDEX IF NOT EXISTS chatbot_commerce_approval_actions_company_subject_idx ON chatbot_commerce_approval_actions (company_id, subject_id);
CREATE INDEX IF NOT EXISTS chatbot_commerce_approval_actions_company_status_idx ON chatbot_commerce_approval_actions (company_id, status, expires_at);

CREATE TABLE IF NOT EXISTS chatbot_commerce_credentials (
  company_id uuid NOT NULL,
  id uuid NOT NULL,
  chatbot_id varchar(191) NOT NULL,
  owner_user_id varchar(191) NOT NULL,
  provider varchar(40) NOT NULL CHECK (provider IN ('shopify', 'woocommerce')),
  sealed jsonb,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  fingerprint char(64),
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  version integer NOT NULL DEFAULT 1,
  last_test_succeeded boolean,
  last_tested_at timestamptz,
  rotated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  CONSTRAINT chatbot_commerce_credentials_company_provider_uidx UNIQUE (company_id, chatbot_id, provider)
);

CREATE TABLE IF NOT EXISTS chatbot_commerce_comm_threads (
  company_id uuid NOT NULL,
  id uuid NOT NULL,
  chatbot_id varchar(191) NOT NULL,
  channel varchar(60) NOT NULL,
  external_thread_id varchar(191),
  customer_id bigint,
  session_id varchar(191),
  identity_verified boolean NOT NULL DEFAULT false,
  intent varchar(100),
  confidence_bps integer,
  priority varchar(20) NOT NULL DEFAULT 'normal',
  sentiment varchar(20) NOT NULL DEFAULT 'neutral',
  status varchar(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'handoff', 'closed')),
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  CONSTRAINT chatbot_commerce_comm_threads_company_external_uidx UNIQUE (company_id, chatbot_id, channel, external_thread_id)
);
CREATE INDEX IF NOT EXISTS chatbot_commerce_comm_threads_company_session_idx ON chatbot_commerce_comm_threads (company_id, session_id);

CREATE TABLE IF NOT EXISTS chatbot_commerce_comm_messages (
  company_id uuid NOT NULL,
  id uuid NOT NULL,
  thread_id uuid NOT NULL,
  chatbot_id varchar(191) NOT NULL,
  channel varchar(60) NOT NULL,
  external_message_id varchar(191),
  direction varchar(20) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  actor_type varchar(40) NOT NULL,
  body text NOT NULL DEFAULT '',
  intent varchar(100),
  confidence_bps integer,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  CONSTRAINT chatbot_commerce_comm_messages_company_external_uidx UNIQUE (company_id, chatbot_id, channel, external_message_id)
);
CREATE INDEX IF NOT EXISTS chatbot_commerce_comm_messages_company_thread_idx ON chatbot_commerce_comm_messages (company_id, thread_id, received_at);

CREATE TABLE IF NOT EXISTS chatbot_commerce_comm_policies (
  company_id uuid NOT NULL,
  chatbot_id varchar(191) NOT NULL,
  auto_reply_enabled boolean NOT NULL DEFAULT false,
  auto_reply_confidence_bps integer NOT NULL DEFAULT 9000,
  automatic_refund_limit_minor bigint NOT NULL DEFAULT 0,
  automatic_discount_limit_minor bigint NOT NULL DEFAULT 0,
  automatic_store_credit_limit_minor bigint NOT NULL DEFAULT 0,
  automatic_replacement_limit_minor bigint NOT NULL DEFAULT 0,
  automatic_cancellation_limit_minor bigint NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'USD',
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, chatbot_id)
);

CREATE TABLE IF NOT EXISTS chatbot_commerce_escalations (
  company_id uuid NOT NULL,
  id uuid NOT NULL,
  thread_id uuid NOT NULL,
  chatbot_id varchar(191) NOT NULL,
  reason varchar(100) NOT NULL,
  severity varchar(20) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'open',
  summary text NOT NULL,
  recommended_action text,
  context_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);
CREATE INDEX IF NOT EXISTS chatbot_commerce_escalations_company_thread_idx ON chatbot_commerce_escalations (company_id, thread_id);

CREATE TABLE IF NOT EXISTS chatbot_commerce_listing_rules (
  company_id uuid NOT NULL,
  id uuid NOT NULL,
  chatbot_id varchar(191),
  provider varchar(40) NOT NULL,
  code varchar(100) NOT NULL,
  severity varchar(20) NOT NULL CHECK (severity IN ('info', 'warning', 'block')),
  terms jsonb NOT NULL DEFAULT '[]'::jsonb,
  field_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  message text NOT NULL,
  remediation text NOT NULL,
  priority integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (company_id, id)
);
CREATE INDEX IF NOT EXISTS chatbot_commerce_listing_rules_company_provider_idx ON chatbot_commerce_listing_rules (company_id, provider, active);

CREATE TABLE IF NOT EXISTS chatbot_commerce_listing_proposals (
  company_id uuid NOT NULL,
  id uuid NOT NULL,
  chatbot_id varchar(191) NOT NULL,
  provider varchar(40) NOT NULL,
  product_id bigint,
  source_hash char(64) NOT NULL,
  status varchar(20) NOT NULL CHECK (status IN ('ready', 'blocked')),
  proposed_content jsonb NOT NULL,
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  proposal_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  CONSTRAINT chatbot_commerce_listing_proposals_company_hash_uidx UNIQUE (company_id, chatbot_id, proposal_hash)
);

CREATE TABLE IF NOT EXISTS chatbot_commerce_shopping_sessions (
  company_id uuid NOT NULL,
  chatbot_id varchar(191) NOT NULL,
  session_id varchar(191) NOT NULL,
  customer_id bigint,
  current_product_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  selected_product_id bigint,
  selected_variant_id bigint,
  last_query text,
  context_version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, chatbot_id, session_id)
);

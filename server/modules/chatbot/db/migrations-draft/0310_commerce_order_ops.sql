-- DRAFT. NOT APPLIED. UNVERIFIED against Postgres: no test has run this file on a database.
--
-- Commerce order ops: marketplace inventory reconciliation, marketplace order import, the unified order
-- projection, order exceptions and their audit trail, workbench actions, and settlement.
-- Source: db/commerce-order-ops.ts and commerce/order-ops/DECISIONS.md.
--
-- Tables (17):
--   chatbot_commerce_inventory_policies, chatbot_commerce_listing_snapshots, chatbot_commerce_inventory_mappings,
--   chatbot_commerce_inventory_scan_runs, chatbot_commerce_inventory_conflicts, chatbot_commerce_inventory_conflict_events,
--   chatbot_commerce_sync_cursors, chatbot_commerce_import_runs, chatbot_commerce_marketplace_orders,
--   chatbot_commerce_marketplace_order_lines, chatbot_commerce_unified_orders, chatbot_commerce_unified_order_snapshots,
--   chatbot_commerce_order_exceptions, chatbot_commerce_order_exception_events, chatbot_commerce_workbench_actions,
--   chatbot_commerce_settlement_entries, chatbot_commerce_settlement_reconciliations.
--
-- Constraints: every table has company_id NOT NULL and a primary key (company_id, id). Every unique index
-- includes company_id. Money is bigint in integer minor units. Percentages are basis points.
-- The outbox is not created here; the runtime owns it.
-- Append-only tables (conflict events, exception events) need a trigger before promotion. Not included.

CREATE TABLE IF NOT EXISTS chatbot_commerce_inventory_policies (
  id varchar(191) NOT NULL DEFAULT gen_random_uuid()::text,
  company_id uuid NOT NULL,
  chatbot_id varchar(191) NOT NULL,
  connection_id varchar(191),
  active boolean NOT NULL DEFAULT true,
  source_of_truth varchar(16) NOT NULL DEFAULT 'internal',
  resolution_mode varchar(24) NOT NULL DEFAULT 'suggest_only',
  allocation_mode varchar(24) NOT NULL DEFAULT 'equal_share',
  allocation_bps integer NOT NULL DEFAULT 10000,
  buffer_quantity integer NOT NULL DEFAULT 0,
  minimum_quantity integer NOT NULL DEFAULT 0,
  maximum_quantity integer,
  maximum_sync_age_seconds integer NOT NULL DEFAULT 300,
  quantity_tolerance integer NOT NULL DEFAULT 0,
  maximum_auto_delta integer NOT NULL DEFAULT 0,
  require_fresh_snapshot boolean NOT NULL DEFAULT true,
  auto_map_by_sku boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  CONSTRAINT chatbot_commerce_inventory_policies_bps_chk CHECK (allocation_bps BETWEEN 0 AND 10000)
);
CREATE INDEX IF NOT EXISTS chatbot_commerce_inventory_policies_company_chatbot_idx ON chatbot_commerce_inventory_policies (company_id, chatbot_id);

CREATE TABLE IF NOT EXISTS chatbot_commerce_listing_snapshots (
  id varchar(191) NOT NULL DEFAULT gen_random_uuid()::text,
  company_id uuid NOT NULL,
  chatbot_id varchar(191) NOT NULL,
  connection_id varchar(191) NOT NULL,
  provider varchar(24) NOT NULL,
  external_listing_id varchar(191) NOT NULL,
  source_hash varchar(64) NOT NULL,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamp NOT NULL DEFAULT now(),
  last_seen_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS chatbot_commerce_listing_snapshots_company_listing_uidx ON chatbot_commerce_listing_snapshots (company_id, connection_id, external_listing_id);
CREATE INDEX IF NOT EXISTS chatbot_commerce_listing_snapshots_company_chatbot_idx ON chatbot_commerce_listing_snapshots (company_id, chatbot_id);

CREATE TABLE IF NOT EXISTS chatbot_commerce_inventory_mappings (
  id varchar(191) NOT NULL DEFAULT gen_random_uuid()::text,
  company_id uuid NOT NULL,
  chatbot_id varchar(191) NOT NULL,
  connection_id varchar(191) NOT NULL,
  listing_snapshot_id varchar(191),
  variant_id varchar(191) NOT NULL,
  location_id varchar(191),
  external_listing_id varchar(191) NOT NULL,
  sku varchar(191),
  active boolean NOT NULL DEFAULT true,
  verified boolean NOT NULL DEFAULT false,
  allocation_mode varchar(24),
  allocation_bps integer,
  buffer_quantity integer,
  minimum_quantity integer,
  maximum_quantity integer,
  last_external_quantity integer,
  last_target_quantity integer,
  last_source_hash varchar(64),
  last_scanned_at timestamp,
  last_in_sync_at timestamp,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (company_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS chatbot_commerce_inventory_mappings_company_listing_uidx ON chatbot_commerce_inventory_mappings (company_id, connection_id, external_listing_id);
CREATE INDEX IF NOT EXISTS chatbot_commerce_inventory_mappings_company_variant_idx ON chatbot_commerce_inventory_mappings (company_id, variant_id);

CREATE TABLE IF NOT EXISTS chatbot_commerce_inventory_scan_runs (
  id varchar(191) NOT NULL DEFAULT gen_random_uuid()::text,
  company_id uuid NOT NULL,
  chatbot_id varchar(191) NOT NULL,
  connection_id varchar(191) NOT NULL,
  owner_user_id varchar(191),
  status varchar(16) NOT NULL,
  mapping_count integer NOT NULL DEFAULT 0,
  in_sync_count integer NOT NULL DEFAULT 0,
  conflict_count integer NOT NULL DEFAULT 0,
  critical_count integer NOT NULL DEFAULT 0,
  corrections_prepared integer NOT NULL DEFAULT 0,
  failure_hash varchar(64),
  started_at timestamp NOT NULL DEFAULT now(),
  completed_at timestamp,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (company_id, id)
);
CREATE INDEX IF NOT EXISTS chatbot_commerce_inventory_scan_runs_company_connection_idx ON chatbot_commerce_inventory_scan_runs (company_id, connection_id);

CREATE TABLE IF NOT EXISTS chatbot_commerce_inventory_conflicts (
  id varchar(191) NOT NULL DEFAULT gen_random_uuid()::text,
  company_id uuid NOT NULL,
  chatbot_id varchar(191) NOT NULL,
  connection_id varchar(191) NOT NULL,
  mapping_id varchar(191) NOT NULL,
  scan_run_id varchar(191),
  provider varchar(24) NOT NULL,
  external_listing_id varchar(191) NOT NULL,
  code varchar(40) NOT NULL,
  severity varchar(16) NOT NULL,
  status varchar(24) NOT NULL,
  canonical_quantity integer NOT NULL,
  target_quantity integer NOT NULL,
  external_quantity integer NOT NULL,
  delta integer NOT NULL,
  oversell_exposure integer NOT NULL DEFAULT 0,
  canonical_version integer NOT NULL DEFAULT 0,
  source_hash varchar(64) NOT NULL,
  observed_at timestamp NOT NULL,
  first_detected_at timestamp NOT NULL,
  last_detected_at timestamp NOT NULL,
  assessment jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolution_mode varchar(24),
  acknowledged_by_user_id varchar(191),
  acknowledged_at timestamp,
  ignored_by_user_id varchar(191),
  ignored_at timestamp,
  ignored_until timestamp,
  ignore_reason varchar(500),
  resolved_by_user_id varchar(191),
  resolved_at timestamp,
  write_proposal_id varchar(191),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (company_id, id)
);
CREATE INDEX IF NOT EXISTS chatbot_commerce_inventory_conflicts_company_connection_status_idx ON chatbot_commerce_inventory_conflicts (company_id, connection_id, status);
CREATE INDEX IF NOT EXISTS chatbot_commerce_inventory_conflicts_company_mapping_idx ON chatbot_commerce_inventory_conflicts (company_id, mapping_id);

CREATE TABLE IF NOT EXISTS chatbot_commerce_inventory_conflict_events (
  id varchar(191) NOT NULL DEFAULT gen_random_uuid()::text,
  company_id uuid NOT NULL,
  conflict_id varchar(191) NOT NULL,
  event_type varchar(40) NOT NULL,
  actor_type varchar(16) NOT NULL,
  actor_user_id varchar(191),
  status_before varchar(24),
  status_after varchar(24),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);
CREATE INDEX IF NOT EXISTS chatbot_commerce_inventory_conflict_events_company_conflict_idx ON chatbot_commerce_inventory_conflict_events (company_id, conflict_id);

CREATE TABLE IF NOT EXISTS chatbot_commerce_sync_cursors (
  id varchar(191) NOT NULL DEFAULT gen_random_uuid()::text,
  company_id uuid NOT NULL,
  connection_id varchar(191) NOT NULL,
  scope varchar(40) NOT NULL,
  cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at timestamp,
  PRIMARY KEY (company_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS chatbot_commerce_sync_cursors_company_connection_scope_uidx ON chatbot_commerce_sync_cursors (company_id, connection_id, scope);

CREATE TABLE IF NOT EXISTS chatbot_commerce_import_runs (
  id varchar(191) NOT NULL DEFAULT gen_random_uuid()::text,
  company_id uuid NOT NULL,
  chatbot_id varchar(191) NOT NULL,
  connection_id varchar(191) NOT NULL,
  scope varchar(40) NOT NULL,
  status varchar(16) NOT NULL,
  cursor_before jsonb NOT NULL DEFAULT '{}'::jsonb,
  cursor_after jsonb,
  records_read integer NOT NULL DEFAULT 0,
  records_rejected integer NOT NULL DEFAULT 0,
  records_created integer NOT NULL DEFAULT 0,
  records_updated integer NOT NULL DEFAULT 0,
  failure_reason varchar(500),
  started_at timestamp NOT NULL DEFAULT now(),
  completed_at timestamp,
  PRIMARY KEY (company_id, id)
);
CREATE INDEX IF NOT EXISTS chatbot_commerce_import_runs_company_connection_idx ON chatbot_commerce_import_runs (company_id, connection_id);

CREATE TABLE IF NOT EXISTS chatbot_commerce_marketplace_orders (
  id varchar(191) NOT NULL DEFAULT gen_random_uuid()::text,
  company_id uuid NOT NULL,
  chatbot_id varchar(191) NOT NULL,
  connection_id varchar(191) NOT NULL,
  provider varchar(24) NOT NULL,
  external_order_id varchar(191) NOT NULL,
  status varchar(40) NOT NULL,
  fulfillment_status varchar(40),
  currency varchar(3) NOT NULL,
  total_amount bigint NOT NULL,
  buyer_display_name varchar(191),
  source_hash varchar(64) NOT NULL,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  placed_at timestamp,
  provider_updated_at timestamp,
  first_imported_at timestamp NOT NULL DEFAULT now(),
  last_imported_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  CONSTRAINT chatbot_commerce_marketplace_orders_total_chk CHECK (total_amount >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS chatbot_commerce_marketplace_orders_company_external_uidx ON chatbot_commerce_marketplace_orders (company_id, connection_id, external_order_id);
CREATE INDEX IF NOT EXISTS chatbot_commerce_marketplace_orders_company_chatbot_idx ON chatbot_commerce_marketplace_orders (company_id, chatbot_id);

CREATE TABLE IF NOT EXISTS chatbot_commerce_marketplace_order_lines (
  id varchar(191) NOT NULL DEFAULT gen_random_uuid()::text,
  company_id uuid NOT NULL,
  order_id varchar(191) NOT NULL,
  external_line_id varchar(191) NOT NULL,
  sku varchar(191),
  title varchar(500) NOT NULL,
  quantity integer NOT NULL,
  unit_amount bigint NOT NULL,
  tax_amount bigint NOT NULL DEFAULT 0,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (company_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS chatbot_commerce_marketplace_order_lines_company_line_uidx ON chatbot_commerce_marketplace_order_lines (company_id, order_id, external_line_id);

CREATE TABLE IF NOT EXISTS chatbot_commerce_unified_orders (
  id varchar(191) NOT NULL DEFAULT gen_random_uuid()::text,
  company_id uuid NOT NULL,
  chatbot_id varchar(191) NOT NULL,
  source_type varchar(40) NOT NULL,
  source_scope varchar(191) NOT NULL,
  source_order_id varchar(191) NOT NULL,
  native_order_id varchar(191),
  marketplace_order_id varchar(191),
  connection_id varchar(191),
  external_authoritative boolean NOT NULL,
  status varchar(40) NOT NULL,
  fulfillment_status varchar(40) NOT NULL,
  payment_status varchar(40) NOT NULL,
  currency varchar(3) NOT NULL,
  gross_total bigint NOT NULL DEFAULT 0,
  discount_total bigint NOT NULL DEFAULT 0,
  tax_total bigint NOT NULL DEFAULT 0,
  shipping_total bigint NOT NULL DEFAULT 0,
  refund_total bigint NOT NULL DEFAULT 0,
  chargeback_total bigint NOT NULL DEFAULT 0,
  fee_total bigint NOT NULL DEFAULT 0,
  shipping_cost_total bigint NOT NULL DEFAULT 0,
  expected_net_payout bigint NOT NULL DEFAULT 0,
  reported_net_payout bigint NOT NULL DEFAULT 0,
  settlement_variance bigint NOT NULL DEFAULT 0,
  reconciliation_status varchar(24) NOT NULL DEFAULT 'unreconciled',
  buyer_display_name varchar(191),
  shipping_address jsonb NOT NULL DEFAULT '{}'::jsonb,
  placed_at timestamp,
  source_updated_at timestamp,
  source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_hash varchar(64) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_projected_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  CONSTRAINT chatbot_commerce_unified_orders_refund_chk CHECK (refund_total >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS chatbot_commerce_unified_orders_company_source_uidx ON chatbot_commerce_unified_orders (company_id, chatbot_id, source_type, source_scope, source_order_id);
CREATE INDEX IF NOT EXISTS chatbot_commerce_unified_orders_company_chatbot_placed_idx ON chatbot_commerce_unified_orders (company_id, chatbot_id, placed_at);

CREATE TABLE IF NOT EXISTS chatbot_commerce_unified_order_snapshots (
  id varchar(191) NOT NULL DEFAULT gen_random_uuid()::text,
  company_id uuid NOT NULL,
  unified_order_id varchar(191) NOT NULL,
  sequence integer NOT NULL,
  source_hash varchar(64) NOT NULL,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  captured_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS chatbot_commerce_unified_order_snapshots_company_hash_uidx ON chatbot_commerce_unified_order_snapshots (company_id, unified_order_id, source_hash);

CREATE TABLE IF NOT EXISTS chatbot_commerce_order_exceptions (
  id varchar(191) NOT NULL DEFAULT gen_random_uuid()::text,
  company_id uuid NOT NULL,
  chatbot_id varchar(191) NOT NULL,
  unified_order_id varchar(191) NOT NULL,
  exception_type varchar(40) NOT NULL,
  fingerprint varchar(64) NOT NULL,
  severity varchar(16) NOT NULL,
  status varchar(16) NOT NULL,
  title varchar(191) NOT NULL,
  summary varchar(500) NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_detected_at timestamp NOT NULL,
  last_detected_at timestamp NOT NULL,
  assigned_user_id varchar(191),
  acknowledged_by_user_id varchar(191),
  acknowledged_at timestamp,
  resolved_by_user_id varchar(191),
  resolved_at timestamp,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (company_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS chatbot_commerce_order_exceptions_company_fingerprint_uidx ON chatbot_commerce_order_exceptions (company_id, unified_order_id, fingerprint);
CREATE INDEX IF NOT EXISTS chatbot_commerce_order_exceptions_company_status_idx ON chatbot_commerce_order_exceptions (company_id, chatbot_id, status);

CREATE TABLE IF NOT EXISTS chatbot_commerce_order_exception_events (
  id varchar(191) NOT NULL DEFAULT gen_random_uuid()::text,
  company_id uuid NOT NULL,
  exception_id varchar(191) NOT NULL,
  event_type varchar(40) NOT NULL,
  actor_type varchar(16),
  actor_user_id varchar(191),
  before_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  after_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);
CREATE INDEX IF NOT EXISTS chatbot_commerce_order_exception_events_company_exception_idx ON chatbot_commerce_order_exception_events (company_id, exception_id);

CREATE TABLE IF NOT EXISTS chatbot_commerce_workbench_actions (
  id varchar(191) NOT NULL DEFAULT gen_random_uuid()::text,
  company_id uuid NOT NULL,
  chatbot_id varchar(191) NOT NULL,
  unified_order_id varchar(191) NOT NULL,
  exception_id varchar(191),
  action_type varchar(40) NOT NULL,
  status varchar(24) NOT NULL,
  idempotency_key varchar(191) NOT NULL,
  request_hash varchar(64) NOT NULL,
  requested_by_user_id varchar(191) NOT NULL,
  assigned_to_user_id varchar(191),
  amount bigint,
  currency varchar(3),
  source_hash varchar(64) NOT NULL,
  proposal jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  expires_at timestamp,
  executed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS chatbot_commerce_workbench_actions_company_chatbot_key_uidx ON chatbot_commerce_workbench_actions (company_id, chatbot_id, idempotency_key);
CREATE INDEX IF NOT EXISTS chatbot_commerce_workbench_actions_company_order_idx ON chatbot_commerce_workbench_actions (company_id, unified_order_id);

CREATE TABLE IF NOT EXISTS chatbot_commerce_settlement_entries (
  id varchar(191) NOT NULL DEFAULT gen_random_uuid()::text,
  company_id uuid NOT NULL,
  chatbot_id varchar(191) NOT NULL,
  unified_order_id varchar(191) NOT NULL,
  provider varchar(40) NOT NULL,
  source_scope varchar(191) NOT NULL,
  external_entry_id varchar(191) NOT NULL,
  source_batch_id varchar(191),
  entry_type varchar(40) NOT NULL,
  amount bigint NOT NULL,
  currency varchar(3) NOT NULL,
  source_hash varchar(64) NOT NULL,
  source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamp,
  imported_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS chatbot_commerce_settlement_entries_company_external_uidx ON chatbot_commerce_settlement_entries (company_id, chatbot_id, provider, source_scope, external_entry_id);
CREATE INDEX IF NOT EXISTS chatbot_commerce_settlement_entries_company_order_idx ON chatbot_commerce_settlement_entries (company_id, unified_order_id);

CREATE TABLE IF NOT EXISTS chatbot_commerce_settlement_reconciliations (
  id varchar(191) NOT NULL DEFAULT gen_random_uuid()::text,
  company_id uuid NOT NULL,
  chatbot_id varchar(191) NOT NULL,
  unified_order_id varchar(191) NOT NULL,
  calculation_hash varchar(64) NOT NULL,
  calculation jsonb NOT NULL DEFAULT '{}'::jsonb,
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  reconciled_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS chatbot_commerce_settlement_reconciliations_company_hash_uidx ON chatbot_commerce_settlement_reconciliations (company_id, unified_order_id, calculation_hash);

-- DRAFT, NOT APPLIED. Commerce money: payments, BNPL, tax, shipping, pricing, rental and hire.
-- Promote to the root migrations/ folder only when the owner says so. Renumber if 0101 is taken.
-- Needs the btree_gist extension for the rental exclusion constraint (CREATE EXTENSION needs privilege).
--
-- Tables:
--   commerce_payment_intents, commerce_payment_operations, commerce_payment_webhook_events,
--   commerce_bnpl_offers, commerce_tax_zones, commerce_tax_rates, commerce_shipping_methods,
--   commerce_pricing_rules, commerce_rental_items, commerce_rental_bookings.
-- Constraints (every unique key includes company_id):
--   commerce_payment_intents_company_key_uidx, commerce_payment_intents_company_provider_uidx,
--   commerce_payment_operations_company_key_uidx, commerce_payment_webhook_events_company_event_uidx,
--   commerce_bnpl_offers_company_key_uidx, commerce_shipping_methods_company_code_uidx,
--   commerce_rental_items_company_sku_uidx, commerce_rental_bookings_company_key_uidx,
--   commerce_rental_bookings_no_overlap (exclusion: no two holding bookings share a day for one item).

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE commerce_payment_intents (
  company_id uuid NOT NULL,
  id varchar(191) NOT NULL,
  provider_name varchar(64) NOT NULL,
  provider_intent_id varchar(191) NOT NULL,
  idempotency_key varchar(191) NOT NULL,
  request_hash char(64) NOT NULL,
  order_ref varchar(191) NOT NULL,
  method varchar(64) NOT NULL,
  currency char(3) NOT NULL,
  amount_minor bigint NOT NULL,
  authorized_minor bigint NOT NULL DEFAULT 0,
  captured_minor bigint NOT NULL DEFAULT 0,
  refunded_minor bigint NOT NULL DEFAULT 0,
  status varchar(32) NOT NULL,
  customer_ref varchar(191),
  client_token varchar(191),
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  CONSTRAINT commerce_payment_intents_company_key_uidx UNIQUE (company_id, idempotency_key),
  CONSTRAINT commerce_payment_intents_company_provider_uidx UNIQUE (company_id, provider_name, provider_intent_id),
  CONSTRAINT commerce_payment_intents_status_check CHECK (status IN ('requires_payment_method','requires_capture','succeeded','canceled','failed','refunded','expired')),
  CONSTRAINT commerce_payment_intents_amounts_check CHECK (
    amount_minor > 0 AND captured_minor >= 0 AND refunded_minor >= 0
    AND refunded_minor <= captured_minor AND captured_minor <= authorized_minor AND authorized_minor <= amount_minor
  )
);
CREATE INDEX commerce_payment_intents_company_order_idx ON commerce_payment_intents (company_id, order_ref);

CREATE TABLE commerce_payment_operations (
  company_id uuid NOT NULL,
  id varchar(191) NOT NULL,
  intent_id varchar(191) NOT NULL,
  operation varchar(16) NOT NULL,
  idempotency_key varchar(191) NOT NULL,
  request_hash char(64) NOT NULL,
  amount_minor bigint,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  CONSTRAINT commerce_payment_operations_company_key_uidx UNIQUE (company_id, idempotency_key),
  CONSTRAINT commerce_payment_operations_kind_check CHECK (operation IN ('authorize','capture','refund','cancel'))
);
CREATE INDEX commerce_payment_operations_company_intent_idx ON commerce_payment_operations (company_id, intent_id);

CREATE TABLE commerce_payment_webhook_events (
  company_id uuid NOT NULL,
  id varchar(191) NOT NULL,
  provider varchar(64) NOT NULL,
  event_key char(64) NOT NULL,
  provider_event_id varchar(191),
  event_type varchar(128),
  intent_id varchar(191),
  outcome varchar(16) NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  CONSTRAINT commerce_payment_webhook_events_company_event_uidx UNIQUE (company_id, provider, event_key),
  CONSTRAINT commerce_payment_webhook_events_outcome_check CHECK (outcome IN ('processed','ignored','unmatched'))
);

CREATE TABLE commerce_bnpl_offers (
  company_id uuid NOT NULL,
  id varchar(191) NOT NULL,
  provider_code varchar(64) NOT NULL,
  provider_offer_id varchar(191) NOT NULL,
  order_ref varchar(191) NOT NULL,
  idempotency_key varchar(191) NOT NULL,
  request_hash char(64) NOT NULL,
  status varchar(32) NOT NULL,
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL,
  installment_count integer NOT NULL,
  merchant_fee_minor bigint NOT NULL DEFAULT 0,
  schedule jsonb NOT NULL,
  hosted_checkout_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  CONSTRAINT commerce_bnpl_offers_company_key_uidx UNIQUE (company_id, idempotency_key),
  CONSTRAINT commerce_bnpl_offers_status_check CHECK (status IN ('eligible','declined','accepted','active','completed','cancelled')),
  CONSTRAINT commerce_bnpl_offers_installments_check CHECK (installment_count BETWEEN 2 AND 60)
);

CREATE TABLE commerce_tax_zones (
  company_id uuid NOT NULL,
  id varchar(191) NOT NULL,
  name varchar(191) NOT NULL,
  country_code char(2) NOT NULL,
  region varchar(64),
  countries jsonb NOT NULL DEFAULT '[]'::jsonb,
  regions jsonb NOT NULL DEFAULT '[]'::jsonb,
  postcode_patterns jsonb NOT NULL DEFAULT '[]'::jsonb,
  prices_include_tax boolean,
  priority integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (company_id, id)
);
CREATE INDEX commerce_tax_zones_company_active_idx ON commerce_tax_zones (company_id, active, priority);

CREATE TABLE commerce_tax_rates (
  company_id uuid NOT NULL,
  id varchar(191) NOT NULL,
  zone_id varchar(191),
  tax_class varchar(64) NOT NULL DEFAULT 'default',
  rate_bps integer NOT NULL,
  inclusive boolean NOT NULL DEFAULT false,
  label varchar(191) NOT NULL,
  applies_to_products boolean NOT NULL DEFAULT true,
  applies_to_shipping boolean NOT NULL DEFAULT false,
  priority integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (company_id, id),
  CONSTRAINT commerce_tax_rates_bps_check CHECK (rate_bps BETWEEN 0 AND 100000)
);
CREATE INDEX commerce_tax_rates_company_class_idx ON commerce_tax_rates (company_id, tax_class, active);

CREATE TABLE commerce_shipping_methods (
  company_id uuid NOT NULL,
  id varchar(191) NOT NULL,
  code varchar(64) NOT NULL,
  name varchar(191) NOT NULL,
  method_type varchar(16) NOT NULL,
  currency char(3) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 0,
  rate_type varchar(16) NOT NULL,
  amount_minor bigint NOT NULL DEFAULT 0,
  base_amount_minor bigint NOT NULL DEFAULT 0,
  per_kilogram_minor bigint NOT NULL DEFAULT 0,
  free_above_minor bigint,
  tiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  minimum_subtotal_minor bigint NOT NULL DEFAULT 0,
  maximum_subtotal_minor bigint,
  minimum_weight_grams integer NOT NULL DEFAULT 0,
  maximum_weight_grams integer,
  zone jsonb,
  estimated_days_min integer,
  estimated_days_max integer,
  PRIMARY KEY (company_id, id),
  CONSTRAINT commerce_shipping_methods_company_code_uidx UNIQUE (company_id, code),
  CONSTRAINT commerce_shipping_methods_type_check CHECK (method_type IN ('delivery','pickup','digital')),
  CONSTRAINT commerce_shipping_methods_rate_check CHECK (rate_type IN ('flat','weight','subtotal','free'))
);

CREATE TABLE commerce_pricing_rules (
  company_id uuid NOT NULL,
  id varchar(191) NOT NULL,
  name varchar(191) NOT NULL,
  rule_type varchar(32) NOT NULL,
  scope varchar(16) NOT NULL,
  target_type varchar(16) NOT NULL,
  target_id bigint,
  value bigint NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  stackable boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  currency char(3),
  channel varchar(32),
  starts_at timestamptz,
  ends_at timestamptz,
  min_quantity integer NOT NULL DEFAULT 1,
  min_subtotal_minor bigint NOT NULL DEFAULT 0,
  customer_ref varchar(191),
  per_unit boolean NOT NULL DEFAULT false,
  PRIMARY KEY (company_id, id),
  CONSTRAINT commerce_pricing_rules_type_check CHECK (rule_type IN ('percentage_discount','fixed_discount','price_override')),
  CONSTRAINT commerce_pricing_rules_scope_check CHECK (scope IN ('line','cart')),
  CONSTRAINT commerce_pricing_rules_value_check CHECK (value >= 0)
);
CREATE INDEX commerce_pricing_rules_company_active_idx ON commerce_pricing_rules (company_id, active, priority);

CREATE TABLE commerce_rental_items (
  company_id uuid NOT NULL,
  id varchar(191) NOT NULL,
  sku varchar(191) NOT NULL,
  name varchar(191) NOT NULL,
  currency char(3) NOT NULL,
  daily_rate_minor bigint NOT NULL,
  deposit_minor bigint NOT NULL DEFAULT 0,
  late_fee_per_day_minor bigint NOT NULL DEFAULT 0,
  late_fee_cap_minor bigint,
  grace_days integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (company_id, id),
  CONSTRAINT commerce_rental_items_company_sku_uidx UNIQUE (company_id, sku),
  CONSTRAINT commerce_rental_items_money_check CHECK (daily_rate_minor >= 0 AND deposit_minor >= 0 AND late_fee_per_day_minor >= 0)
);

CREATE TABLE commerce_rental_bookings (
  company_id uuid NOT NULL,
  id varchar(191) NOT NULL,
  item_id varchar(191) NOT NULL,
  customer_ref varchar(191),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  currency char(3) NOT NULL,
  rental_minor bigint NOT NULL,
  deposit_minor bigint NOT NULL,
  status varchar(16) NOT NULL,
  returned_on date,
  late_days integer NOT NULL DEFAULT 0,
  late_fee_minor bigint NOT NULL DEFAULT 0,
  deposit_returned_minor bigint NOT NULL DEFAULT 0,
  amount_due_minor bigint NOT NULL DEFAULT 0,
  idempotency_key varchar(191) NOT NULL,
  request_hash char(64) NOT NULL,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  CONSTRAINT commerce_rental_bookings_company_key_uidx UNIQUE (company_id, idempotency_key),
  CONSTRAINT commerce_rental_bookings_status_check CHECK (status IN ('reserved','active','returned','cancelled')),
  CONSTRAINT commerce_rental_bookings_dates_check CHECK (ends_on >= starts_on),
  -- Two holding bookings (reserved or active) for one item may not share a day. Inclusive date ranges.
  CONSTRAINT commerce_rental_bookings_no_overlap EXCLUDE USING gist (
    company_id WITH =,
    item_id WITH =,
    daterange(starts_on, ends_on, '[]') WITH &&
  ) WHERE (status IN ('reserved', 'active'))
);
CREATE INDEX commerce_rental_bookings_company_item_idx ON commerce_rental_bookings (company_id, item_id, starts_on, ends_on);

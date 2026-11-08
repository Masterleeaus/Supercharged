-- DRAFT, NOT APPLIED. Commerce money gaps: coupons and usages, tax exemptions, recurring rental series.
-- Owner step: move to server/modules/chatbot/db/migrations-draft/ under the next free number after 0101 and 0310.
-- Depends on 0101_commerce_money.sql (commerce_rental_bookings and its no_overlap exclusion, which guards occurrences).
--
-- Tables:
--   commerce_coupons, commerce_coupon_usages, commerce_tax_exemptions,
--   commerce_rental_series, commerce_rental_series_bookings.
-- Constraints (every unique key includes company_id):
--   commerce_coupons_company_code_uidx, commerce_coupon_usages_company_coupon_cart_uidx,
--   commerce_rental_series_company_key_uidx, commerce_rental_series_bookings_company_booking_uidx.

CREATE TABLE commerce_coupons (
  company_id uuid NOT NULL,
  id varchar(191) NOT NULL,
  code varchar(64) NOT NULL,
  type varchar(16) NOT NULL,
  value bigint NOT NULL DEFAULT 0,
  currency char(3),
  minimum_minor bigint NOT NULL DEFAULT 0,
  max_discount_minor bigint,
  active boolean NOT NULL DEFAULT true,
  starts_at timestamptz,
  ends_at timestamptz,
  usage_limit integer,
  usage_limit_per_customer integer,
  first_order_only boolean NOT NULL DEFAULT false,
  channels jsonb NOT NULL DEFAULT '[]'::jsonb,
  applies_to varchar(16) NOT NULL DEFAULT 'cart',
  target_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  stackable boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  CONSTRAINT commerce_coupons_company_code_uidx UNIQUE (company_id, code),
  CONSTRAINT commerce_coupons_type_check CHECK (type IN ('percentage','fixed','free_shipping')),
  CONSTRAINT commerce_coupons_applies_check CHECK (applies_to IN ('cart','products','variants','categories')),
  CONSTRAINT commerce_coupons_value_check CHECK (value >= 0 AND (type <> 'percentage' OR value <= 10000)),
  CONSTRAINT commerce_coupons_limits_check CHECK (minimum_minor >= 0 AND (usage_limit IS NULL OR usage_limit >= 1) AND (usage_limit_per_customer IS NULL OR usage_limit_per_customer >= 1))
);
CREATE INDEX commerce_coupons_company_active_idx ON commerce_coupons (company_id, active);

CREATE TABLE commerce_coupon_usages (
  company_id uuid NOT NULL,
  id varchar(191) NOT NULL,
  coupon_id varchar(191) NOT NULL,
  cart_id varchar(191) NOT NULL,
  customer_ref varchar(191),
  status varchar(16) NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  redeemed_at timestamptz,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  CONSTRAINT commerce_coupon_usages_company_coupon_cart_uidx UNIQUE (company_id, coupon_id, cart_id),
  CONSTRAINT commerce_coupon_usages_status_check CHECK (status IN ('reserved','redeemed','released','expired'))
);
CREATE INDEX commerce_coupon_usages_company_coupon_status_idx ON commerce_coupon_usages (company_id, coupon_id, status);

CREATE TABLE commerce_tax_exemptions (
  company_id uuid NOT NULL,
  id varchar(191) NOT NULL,
  exemption_key varchar(191),
  customer_ref varchar(191),
  tax_class varchar(64),
  reason varchar(191),
  active boolean NOT NULL DEFAULT true,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  CONSTRAINT commerce_tax_exemptions_binding_check CHECK ((exemption_key IS NULL) <> (customer_ref IS NULL))
);
CREATE INDEX commerce_tax_exemptions_company_active_idx ON commerce_tax_exemptions (company_id, active);
CREATE INDEX commerce_tax_exemptions_company_key_idx ON commerce_tax_exemptions (company_id, exemption_key);
CREATE INDEX commerce_tax_exemptions_company_customer_idx ON commerce_tax_exemptions (company_id, customer_ref);

CREATE TABLE commerce_rental_series (
  company_id uuid NOT NULL,
  id varchar(191) NOT NULL,
  item_id varchar(191) NOT NULL,
  customer_ref varchar(191),
  starts_on date NOT NULL,
  frequency varchar(16) NOT NULL,
  interval_days integer NOT NULL,
  duration_days integer NOT NULL,
  occurrences integer NOT NULL,
  currency char(3) NOT NULL,
  status varchar(16) NOT NULL,
  idempotency_key varchar(191) NOT NULL,
  request_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  CONSTRAINT commerce_rental_series_company_key_uidx UNIQUE (company_id, idempotency_key),
  CONSTRAINT commerce_rental_series_frequency_check CHECK (frequency IN ('weekly','fortnightly','custom')),
  CONSTRAINT commerce_rental_series_status_check CHECK (status IN ('active','cancelled')),
  CONSTRAINT commerce_rental_series_shape_check CHECK (occurrences BETWEEN 1 AND 52 AND duration_days BETWEEN 1 AND 365 AND interval_days >= duration_days)
);
CREATE INDEX commerce_rental_series_company_item_idx ON commerce_rental_series (company_id, item_id);

CREATE TABLE commerce_rental_series_bookings (
  company_id uuid NOT NULL,
  series_id varchar(191) NOT NULL,
  booking_id varchar(191) NOT NULL,
  ordinal integer NOT NULL,
  PRIMARY KEY (company_id, series_id, booking_id),
  CONSTRAINT commerce_rental_series_bookings_company_booking_uidx UNIQUE (company_id, booking_id)
);
CREATE INDEX commerce_rental_series_bookings_company_series_idx ON commerce_rental_series_bookings (company_id, series_id);

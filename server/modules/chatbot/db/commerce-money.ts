/**
 * Drizzle tables for the commerce money domain: payment intents, payment operations, payment webhook events,
 * BNPL offers, tax zones and rates, shipping methods, pricing rules, rental items and hire bookings.
 * Not applied by any migration. The SQL draft is in migrations-draft/0101_commerce_money.sql.
 *
 * Conventions (CONVENTIONS.md sections 3, 7):
 * - Every table has company_id. Primary keys are (company_id, id), and every unique constraint includes company_id.
 * - Money is an integer count of minor units, stored as bigint and read back as a JS number. No floats.
 * - Percentages are basis points. Calendar dates are date columns. Timestamps are timestamptz.
 * - No foreign keys to shared/schema.ts. The owner adds them when the tables are promoted.
 */
import { sql } from "drizzle-orm";
import { bigint, boolean, char, check, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

/** Constraint names. The storage maps database errors to MoneyError codes using these names. */
export const COMMERCE_MONEY_CONSTRAINTS = {
  paymentKey: "commerce_payment_intents_company_key_uidx",
  paymentProviderId: "commerce_payment_intents_company_provider_uidx",
  operationKey: "commerce_payment_operations_company_key_uidx",
  webhookEvent: "commerce_payment_webhook_events_company_event_uidx",
  bnplKey: "commerce_bnpl_offers_company_key_uidx",
  hireBookingKey: "commerce_rental_bookings_company_key_uidx",
  hireBookingOverlap: "commerce_rental_bookings_no_overlap",
} as const;

const PAYMENT_STATUS_LIST = "'requires_payment_method','requires_capture','succeeded','canceled','failed','refunded','expired'";

export const commercePaymentIntents = pgTable(
  "commerce_payment_intents",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    providerName: varchar("provider_name", { length: 64 }).notNull(),
    providerIntentId: varchar("provider_intent_id", { length: 191 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
    requestHash: char("request_hash", { length: 64 }).notNull(),
    orderRef: varchar("order_ref", { length: 191 }).notNull(),
    method: varchar("method", { length: 64 }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    authorizedMinor: bigint("authorized_minor", { mode: "number" }).notNull().default(0),
    capturedMinor: bigint("captured_minor", { mode: "number" }).notNull().default(0),
    refundedMinor: bigint("refunded_minor", { mode: "number" }).notNull().default(0),
    status: varchar("status", { length: 32 }).notNull(),
    customerRef: varchar("customer_ref", { length: 191 }),
    clientToken: varchar("client_token", { length: 191 }),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "commerce_payment_intents_pk", columns: [table.companyId, table.id] }),
    uniqueIndex(COMMERCE_MONEY_CONSTRAINTS.paymentKey).on(table.companyId, table.idempotencyKey),
    uniqueIndex(COMMERCE_MONEY_CONSTRAINTS.paymentProviderId).on(table.companyId, table.providerName, table.providerIntentId),
    check("commerce_payment_intents_status_check", sql.raw(`status IN (${PAYMENT_STATUS_LIST})`)),
    check("commerce_payment_intents_amounts_check", sql`${table.amountMinor} > 0 AND ${table.capturedMinor} >= 0 AND ${table.refundedMinor} >= 0 AND ${table.refundedMinor} <= ${table.capturedMinor} AND ${table.capturedMinor} <= ${table.authorizedMinor} AND ${table.authorizedMinor} <= ${table.amountMinor}`),
    index("commerce_payment_intents_company_order_idx").on(table.companyId, table.orderRef),
  ],
);

export const commercePaymentOperations = pgTable(
  "commerce_payment_operations",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    intentId: varchar("intent_id", { length: 191 }).notNull(),
    operation: varchar("operation", { length: 16 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
    requestHash: char("request_hash", { length: 64 }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }),
    result: jsonb("result").$type<Record<string, string | number | null>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "commerce_payment_operations_pk", columns: [table.companyId, table.id] }),
    uniqueIndex(COMMERCE_MONEY_CONSTRAINTS.operationKey).on(table.companyId, table.idempotencyKey),
    check("commerce_payment_operations_kind_check", sql`${table.operation} IN ('authorize','capture','refund','cancel')`),
    index("commerce_payment_operations_company_intent_idx").on(table.companyId, table.intentId),
  ],
);

export const commercePaymentWebhookEvents = pgTable(
  "commerce_payment_webhook_events",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    provider: varchar("provider", { length: 64 }).notNull(),
    eventKey: char("event_key", { length: 64 }).notNull(),
    providerEventId: varchar("provider_event_id", { length: 191 }),
    eventType: varchar("event_type", { length: 128 }),
    intentId: varchar("intent_id", { length: 191 }),
    outcome: varchar("outcome", { length: 16 }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "commerce_payment_webhook_events_pk", columns: [table.companyId, table.id] }),
    uniqueIndex(COMMERCE_MONEY_CONSTRAINTS.webhookEvent).on(table.companyId, table.provider, table.eventKey),
    check("commerce_payment_webhook_events_outcome_check", sql`${table.outcome} IN ('processed','ignored','unmatched')`),
  ],
);

export const commerceBnplOffers = pgTable(
  "commerce_bnpl_offers",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    providerCode: varchar("provider_code", { length: 64 }).notNull(),
    providerOfferId: varchar("provider_offer_id", { length: 191 }).notNull(),
    orderRef: varchar("order_ref", { length: 191 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
    requestHash: char("request_hash", { length: 64 }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    installmentCount: integer("installment_count").notNull(),
    merchantFeeMinor: bigint("merchant_fee_minor", { mode: "number" }).notNull().default(0),
    schedule: jsonb("schedule").$type<Array<{ number: number; amountMinor: number; dueOn: string }>>().notNull(),
    hostedCheckoutUrl: text("hosted_checkout_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "commerce_bnpl_offers_pk", columns: [table.companyId, table.id] }),
    uniqueIndex(COMMERCE_MONEY_CONSTRAINTS.bnplKey).on(table.companyId, table.idempotencyKey),
    check("commerce_bnpl_offers_status_check", sql`${table.status} IN ('eligible','declined','accepted','active','completed','cancelled')`),
    check("commerce_bnpl_offers_installments_check", sql`${table.installmentCount} BETWEEN 2 AND 60`),
  ],
);

export const commerceTaxZones = pgTable(
  "commerce_tax_zones",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    name: varchar("name", { length: 191 }).notNull(),
    countryCode: char("country_code", { length: 2 }).notNull(),
    region: varchar("region", { length: 64 }),
    countries: jsonb("countries").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    regions: jsonb("regions").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    postcodePatterns: jsonb("postcode_patterns").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    pricesIncludeTax: boolean("prices_include_tax"),
    priority: integer("priority").notNull().default(0),
    active: boolean("active").notNull().default(true),
  },
  (table) => [
    primaryKey({ name: "commerce_tax_zones_pk", columns: [table.companyId, table.id] }),
    index("commerce_tax_zones_company_active_idx").on(table.companyId, table.active, table.priority),
  ],
);

export const commerceTaxRates = pgTable(
  "commerce_tax_rates",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    zoneId: varchar("zone_id", { length: 191 }),
    taxClass: varchar("tax_class", { length: 64 }).notNull().default("default"),
    rateBps: integer("rate_bps").notNull(),
    inclusive: boolean("inclusive").notNull().default(false),
    label: varchar("label", { length: 191 }).notNull(),
    appliesToProducts: boolean("applies_to_products").notNull().default(true),
    appliesToShipping: boolean("applies_to_shipping").notNull().default(false),
    priority: integer("priority").notNull().default(0),
    active: boolean("active").notNull().default(true),
  },
  (table) => [
    primaryKey({ name: "commerce_tax_rates_pk", columns: [table.companyId, table.id] }),
    check("commerce_tax_rates_bps_check", sql`${table.rateBps} BETWEEN 0 AND 100000`),
    index("commerce_tax_rates_company_class_idx").on(table.companyId, table.taxClass, table.active),
  ],
);

export const commerceShippingMethods = pgTable(
  "commerce_shipping_methods",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    code: varchar("code", { length: 64 }).notNull(),
    name: varchar("name", { length: 191 }).notNull(),
    methodType: varchar("method_type", { length: 16 }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    active: boolean("active").notNull().default(true),
    priority: integer("priority").notNull().default(0),
    rateType: varchar("rate_type", { length: 16 }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull().default(0),
    baseAmountMinor: bigint("base_amount_minor", { mode: "number" }).notNull().default(0),
    perKilogramMinor: bigint("per_kilogram_minor", { mode: "number" }).notNull().default(0),
    freeAboveMinor: bigint("free_above_minor", { mode: "number" }),
    tiers: jsonb("tiers").$type<Array<{ minMinor: number; maxMinor: number | null; amountMinor: number }>>().notNull().default(sql`'[]'::jsonb`),
    minimumSubtotalMinor: bigint("minimum_subtotal_minor", { mode: "number" }).notNull().default(0),
    maximumSubtotalMinor: bigint("maximum_subtotal_minor", { mode: "number" }),
    minimumWeightGrams: integer("minimum_weight_grams").notNull().default(0),
    maximumWeightGrams: integer("maximum_weight_grams"),
    zone: jsonb("zone").$type<{ countries: string[]; regions: string[]; postcodePatterns: string[] } | null>(),
    estimatedDaysMin: integer("estimated_days_min"),
    estimatedDaysMax: integer("estimated_days_max"),
  },
  (table) => [
    primaryKey({ name: "commerce_shipping_methods_pk", columns: [table.companyId, table.id] }),
    uniqueIndex("commerce_shipping_methods_company_code_uidx").on(table.companyId, table.code),
    check("commerce_shipping_methods_type_check", sql`${table.methodType} IN ('delivery','pickup','digital')`),
    check("commerce_shipping_methods_rate_check", sql`${table.rateType} IN ('flat','weight','subtotal','free')`),
  ],
);

export const commercePricingRules = pgTable(
  "commerce_pricing_rules",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    name: varchar("name", { length: 191 }).notNull(),
    ruleType: varchar("rule_type", { length: 32 }).notNull(),
    scope: varchar("scope", { length: 16 }).notNull(),
    targetType: varchar("target_type", { length: 16 }).notNull(),
    targetId: bigint("target_id", { mode: "number" }),
    value: bigint("value", { mode: "number" }).notNull(),
    priority: integer("priority").notNull().default(0),
    stackable: boolean("stackable").notNull().default(false),
    active: boolean("active").notNull().default(true),
    currency: char("currency", { length: 3 }),
    channel: varchar("channel", { length: 32 }),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    minQuantity: integer("min_quantity").notNull().default(1),
    minSubtotalMinor: bigint("min_subtotal_minor", { mode: "number" }).notNull().default(0),
    customerRef: varchar("customer_ref", { length: 191 }),
    perUnit: boolean("per_unit").notNull().default(false),
  },
  (table) => [
    primaryKey({ name: "commerce_pricing_rules_pk", columns: [table.companyId, table.id] }),
    check("commerce_pricing_rules_type_check", sql`${table.ruleType} IN ('percentage_discount','fixed_discount','price_override')`),
    check("commerce_pricing_rules_scope_check", sql`${table.scope} IN ('line','cart')`),
    check("commerce_pricing_rules_value_check", sql`${table.value} >= 0`),
    index("commerce_pricing_rules_company_active_idx").on(table.companyId, table.active, table.priority),
  ],
);

export const commerceRentalItems = pgTable(
  "commerce_rental_items",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    sku: varchar("sku", { length: 191 }).notNull(),
    name: varchar("name", { length: 191 }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    dailyRateMinor: bigint("daily_rate_minor", { mode: "number" }).notNull(),
    depositMinor: bigint("deposit_minor", { mode: "number" }).notNull().default(0),
    lateFeePerDayMinor: bigint("late_fee_per_day_minor", { mode: "number" }).notNull().default(0),
    lateFeeCapMinor: bigint("late_fee_cap_minor", { mode: "number" }),
    graceDays: integer("grace_days").notNull().default(0),
    active: boolean("active").notNull().default(true),
  },
  (table) => [
    primaryKey({ name: "commerce_rental_items_pk", columns: [table.companyId, table.id] }),
    uniqueIndex("commerce_rental_items_company_sku_uidx").on(table.companyId, table.sku),
    check("commerce_rental_items_money_check", sql`${table.dailyRateMinor} >= 0 AND ${table.depositMinor} >= 0 AND ${table.lateFeePerDayMinor} >= 0`),
  ],
);

export const commerceRentalBookings = pgTable(
  "commerce_rental_bookings",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    itemId: varchar("item_id", { length: 191 }).notNull(),
    customerRef: varchar("customer_ref", { length: 191 }),
    startsOn: date("starts_on", { mode: "string" }).notNull(),
    endsOn: date("ends_on", { mode: "string" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    rentalMinor: bigint("rental_minor", { mode: "number" }).notNull(),
    depositMinor: bigint("deposit_minor", { mode: "number" }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    returnedOn: date("returned_on", { mode: "string" }),
    lateDays: integer("late_days").notNull().default(0),
    lateFeeMinor: bigint("late_fee_minor", { mode: "number" }).notNull().default(0),
    depositReturnedMinor: bigint("deposit_returned_minor", { mode: "number" }).notNull().default(0),
    amountDueMinor: bigint("amount_due_minor", { mode: "number" }).notNull().default(0),
    idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
    requestHash: char("request_hash", { length: 64 }).notNull(),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "commerce_rental_bookings_pk", columns: [table.companyId, table.id] }),
    uniqueIndex(COMMERCE_MONEY_CONSTRAINTS.hireBookingKey).on(table.companyId, table.idempotencyKey),
    check("commerce_rental_bookings_status_check", sql`${table.status} IN ('reserved','active','returned','cancelled')`),
    check("commerce_rental_bookings_dates_check", sql`${table.endsOn} >= ${table.startsOn}`),
    index("commerce_rental_bookings_company_item_idx").on(table.companyId, table.itemId, table.startsOn, table.endsOn),
  ],
);

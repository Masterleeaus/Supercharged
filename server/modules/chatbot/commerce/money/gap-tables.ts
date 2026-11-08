/**
 * Drizzle tables for the money gaps: coupons and their usages, tax exemption records, and recurring rental series.
 *
 * Placement: CONVENTIONS.md section 7 puts tables in db/<area>.ts. This file sits in the money folder because the
 * money slice may only write there. The owner should move these tables into db/commerce-money.ts at integration, and
 * the SQL draft in gap-draft.sql into migrations-draft/. See DECISIONS.md.
 *
 * Conventions: every table has company_id, every unique constraint includes company_id, money is bigint minor units,
 * percentages are basis points, calendar dates are date columns, and timestamps are timestamptz.
 */
import { sql } from "drizzle-orm";
import { bigint, boolean, char, check, date, index, integer, jsonb, pgTable, primaryKey, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

export const COMMERCE_GAP_CONSTRAINTS = {
  couponCode: "commerce_coupons_company_code_uidx",
  couponUsageCart: "commerce_coupon_usages_company_coupon_cart_uidx",
  seriesKey: "commerce_rental_series_company_key_uidx",
  seriesBookingUnique: "commerce_rental_series_bookings_company_booking_uidx",
} as const;

export const commerceCoupons = pgTable(
  "commerce_coupons",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    code: varchar("code", { length: 64 }).notNull(),
    type: varchar("type", { length: 16 }).notNull(),
    value: bigint("value", { mode: "number" }).notNull().default(0),
    currency: char("currency", { length: 3 }),
    minimumMinor: bigint("minimum_minor", { mode: "number" }).notNull().default(0),
    maxDiscountMinor: bigint("max_discount_minor", { mode: "number" }),
    active: boolean("active").notNull().default(true),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    usageLimit: integer("usage_limit"),
    usageLimitPerCustomer: integer("usage_limit_per_customer"),
    firstOrderOnly: boolean("first_order_only").notNull().default(false),
    channels: jsonb("channels").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    appliesTo: varchar("applies_to", { length: 16 }).notNull().default("cart"),
    targetIds: jsonb("target_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    stackable: boolean("stackable").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "commerce_coupons_pk", columns: [table.companyId, table.id] }),
    uniqueIndex(COMMERCE_GAP_CONSTRAINTS.couponCode).on(table.companyId, table.code),
    check("commerce_coupons_type_check", sql`${table.type} IN ('percentage','fixed','free_shipping')`),
    check("commerce_coupons_applies_check", sql`${table.appliesTo} IN ('cart','products','variants','categories')`),
    check("commerce_coupons_value_check", sql`${table.value} >= 0 AND (${table.type} <> 'percentage' OR ${table.value} <= 10000)`),
    check("commerce_coupons_limits_check", sql`${table.minimumMinor} >= 0 AND (${table.usageLimit} IS NULL OR ${table.usageLimit} >= 1) AND (${table.usageLimitPerCustomer} IS NULL OR ${table.usageLimitPerCustomer} >= 1)`),
    index("commerce_coupons_company_active_idx").on(table.companyId, table.active),
  ],
);

export const commerceCouponUsages = pgTable(
  "commerce_coupon_usages",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    couponId: varchar("coupon_id", { length: 191 }).notNull(),
    cartId: varchar("cart_id", { length: 191 }).notNull(),
    customerRef: varchar("customer_ref", { length: 191 }),
    status: varchar("status", { length: 16 }).notNull(),
    reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "commerce_coupon_usages_pk", columns: [table.companyId, table.id] }),
    uniqueIndex(COMMERCE_GAP_CONSTRAINTS.couponUsageCart).on(table.companyId, table.couponId, table.cartId),
    check("commerce_coupon_usages_status_check", sql`${table.status} IN ('reserved','redeemed','released','expired')`),
    index("commerce_coupon_usages_company_coupon_status_idx").on(table.companyId, table.couponId, table.status),
  ],
);

export const commerceTaxExemptions = pgTable(
  "commerce_tax_exemptions",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    exemptionKey: varchar("exemption_key", { length: 191 }),
    customerRef: varchar("customer_ref", { length: 191 }),
    taxClass: varchar("tax_class", { length: 64 }),
    reason: varchar("reason", { length: 191 }),
    active: boolean("active").notNull().default(true),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "commerce_tax_exemptions_pk", columns: [table.companyId, table.id] }),
    check("commerce_tax_exemptions_binding_check", sql`(${table.exemptionKey} IS NULL) <> (${table.customerRef} IS NULL)`),
    index("commerce_tax_exemptions_company_active_idx").on(table.companyId, table.active),
    index("commerce_tax_exemptions_company_key_idx").on(table.companyId, table.exemptionKey),
    index("commerce_tax_exemptions_company_customer_idx").on(table.companyId, table.customerRef),
  ],
);

export const commerceRentalSeries = pgTable(
  "commerce_rental_series",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    itemId: varchar("item_id", { length: 191 }).notNull(),
    customerRef: varchar("customer_ref", { length: 191 }),
    startsOn: date("starts_on", { mode: "string" }).notNull(),
    frequency: varchar("frequency", { length: 16 }).notNull(),
    intervalDays: integer("interval_days").notNull(),
    durationDays: integer("duration_days").notNull(),
    occurrences: integer("occurrences").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
    requestHash: char("request_hash", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "commerce_rental_series_pk", columns: [table.companyId, table.id] }),
    uniqueIndex(COMMERCE_GAP_CONSTRAINTS.seriesKey).on(table.companyId, table.idempotencyKey),
    check("commerce_rental_series_frequency_check", sql`${table.frequency} IN ('weekly','fortnightly','custom')`),
    check("commerce_rental_series_status_check", sql`${table.status} IN ('active','cancelled')`),
    check("commerce_rental_series_shape_check", sql`${table.occurrences} BETWEEN 1 AND 52 AND ${table.durationDays} BETWEEN 1 AND 365 AND ${table.intervalDays} >= ${table.durationDays}`),
    index("commerce_rental_series_company_item_idx").on(table.companyId, table.itemId),
  ],
);

/** Links each occurrence booking to its series. The bookings table itself is not changed. */
export const commerceRentalSeriesBookings = pgTable(
  "commerce_rental_series_bookings",
  {
    companyId: uuid("company_id").notNull(),
    seriesId: varchar("series_id", { length: 191 }).notNull(),
    bookingId: varchar("booking_id", { length: 191 }).notNull(),
    ordinal: integer("ordinal").notNull(),
  },
  (table) => [
    primaryKey({ name: "commerce_rental_series_bookings_pk", columns: [table.companyId, table.seriesId, table.bookingId] }),
    uniqueIndex(COMMERCE_GAP_CONSTRAINTS.seriesBookingUnique).on(table.companyId, table.bookingId),
    index("commerce_rental_series_bookings_company_series_idx").on(table.companyId, table.seriesId),
  ],
);

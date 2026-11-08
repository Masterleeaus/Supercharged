/*
 * DRAFT - not wired into shared/schema.ts and not applied to any database. Nothing imports this file.
 * The integration agent merges these tables into shared/schema.ts and writes the matching SQL.
 *
 * Every table carries company_id. Child tables use composite foreign keys on (company_id, id), so a
 * fulfilment cannot point at another company's order, and an item cannot point at another company's
 * fulfilment, even when application code has a bug.
 *
 * Stock rows with location_id NULL (the company-wide row) need a partial unique index WHERE
 * location_id IS NULL. A plain unique index does not stop duplicate NULL keys in Postgres.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
  uuid,
} from "drizzle-orm/pg-core";

export const fulfilmentLocations = pgTable(
  "fulfilment_locations",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    code: varchar("code", { length: 100 }).notNull(),
    name: varchar("name", { length: 191 }).notNull(),
    active: boolean("active").notNull().default(true),
    priority: integer("priority").notNull().default(100),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("fulfilment_locations_company_id_uidx").on(table.companyId, table.id),
    uniqueIndex("fulfilment_locations_company_code_uidx").on(table.companyId, table.code),
  ]
);

export const inventoryStock = pgTable(
  "inventory_stock",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    variantId: varchar("variant_id").notNull(),
    locationId: varchar("location_id"), // null = company-wide row
    quantity: integer("quantity").notNull().default(0),
    reserved: integer("reserved").notNull().default(0),
    committed: integer("committed").notNull().default(0),
    allocated: integer("allocated").notNull().default(0),
    damaged: integer("damaged").notNull().default(0),
    safetyStock: integer("safety_stock").notNull().default(0),
    incoming: integer("incoming").notNull().default(0),
    lowStockThreshold: integer("low_stock_threshold").notNull().default(0),
    allowBackorder: boolean("allow_backorder").notNull().default(false),
    version: integer("version").notNull().default(0),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("inventory_stock_company_variant_location_uidx").on(table.companyId, table.variantId, table.locationId),
    check("inventory_stock_non_negative", sql`${table.reserved} >= 0 AND ${table.committed} >= 0 AND ${table.allocated} >= 0`),
    check("inventory_stock_allocated_within_committed", sql`${table.allocated} <= ${table.committed}`),
    check(
      "inventory_stock_quantity_covers_holds",
      sql`${table.quantity} >= ${table.reserved} + ${table.committed} + ${table.damaged}`
    ),
    index("inventory_stock_company_location_idx").on(table.companyId, table.locationId),
  ]
);

export const inventoryReservations = pgTable(
  "inventory_reservations",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    holderId: varchar("holder_id").notNull(), // cart id
    variantId: varchar("variant_id").notNull(),
    locationId: varchar("location_id"),
    quantity: integer("quantity").notNull(),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    committedAt: timestamp("committed_at"),
    releasedAt: timestamp("released_at"),
    releaseReason: varchar("release_reason", { length: 100 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("inventory_reservations_company_id_uidx").on(table.companyId, table.id),
    uniqueIndex("inventory_reservations_company_key_uidx").on(table.companyId, table.idempotencyKey),
    check("inventory_reservations_quantity_positive", sql`${table.quantity} > 0`),
    index("inventory_reservations_stock_status_idx").on(table.companyId, table.variantId, table.locationId, table.status),
    index("inventory_reservations_due_idx").on(table.companyId, table.status, table.expiresAt),
  ]
);

export const inventoryAdjustments = pgTable(
  "inventory_adjustments",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    variantId: varchar("variant_id").notNull(),
    locationId: varchar("location_id"),
    delta: integer("delta").notNull(),
    reason: varchar("reason", { length: 100 }).notNull(),
    balanceAfter: integer("balance_after").notNull(),
    version: integer("version").notNull(),
    actorId: varchar("actor_id"),
    idempotencyKey: varchar("idempotency_key", { length: 191 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("inventory_adjustments_company_key_uidx").on(table.companyId, table.idempotencyKey),
    check("inventory_adjustments_delta_nonzero", sql`${table.delta} <> 0`),
  ]
);

export const fulfilmentOrders = pgTable(
  "fulfilment_orders",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    reference: varchar("reference", { length: 191 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("fulfilment_orders_company_id_uidx").on(table.companyId, table.id)]
);

export const fulfilmentOrderLines = pgTable(
  "fulfilment_order_lines",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    orderId: varchar("order_id").notNull(),
    variantId: varchar("variant_id").notNull(),
    productId: varchar("product_id"),
    sku: varchar("sku", { length: 191 }),
    name: varchar("name", { length: 255 }).notNull(),
    quantity: integer("quantity").notNull(),
  },
  (table) => [
    uniqueIndex("fulfilment_order_lines_company_id_uidx").on(table.companyId, table.id),
    foreignKey({
      name: "fulfilment_order_lines_company_order_fk",
      columns: [table.companyId, table.orderId],
      foreignColumns: [fulfilmentOrders.companyId, fulfilmentOrders.id],
    }),
    check("fulfilment_order_lines_quantity_positive", sql`${table.quantity} > 0`),
  ]
);

export const fulfilments = pgTable(
  "fulfilments",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    orderId: varchar("order_id").notNull(),
    status: varchar("status", { length: 30 }).notNull().default("pending"),
    methodType: varchar("method_type", { length: 30 }).notNull().default("delivery"),
    locationId: varchar("location_id"),
    carrier: varchar("carrier", { length: 120 }),
    service: varchar("service", { length: 120 }),
    trackingNumber: varchar("tracking_number", { length: 191 }),
    trackingUrl: text("tracking_url"),
    customerNote: text("customer_note"),
    internalNote: text("internal_note"),
    idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    processingAt: timestamp("processing_at"),
    shippedAt: timestamp("shipped_at"),
    deliveredAt: timestamp("delivered_at"),
    cancelledAt: timestamp("cancelled_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("fulfilments_company_id_uidx").on(table.companyId, table.id),
    uniqueIndex("fulfilments_company_key_uidx").on(table.companyId, table.idempotencyKey),
    foreignKey({
      name: "fulfilments_company_order_fk",
      columns: [table.companyId, table.orderId],
      foreignColumns: [fulfilmentOrders.companyId, fulfilmentOrders.id],
    }),
    index("fulfilments_company_order_idx").on(table.companyId, table.orderId),
  ]
);

export const fulfilmentItems = pgTable(
  "fulfilment_items",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    fulfilmentId: varchar("fulfilment_id").notNull(),
    orderLineId: varchar("order_line_id").notNull(),
    variantId: varchar("variant_id").notNull(),
    productId: varchar("product_id"),
    sku: varchar("sku", { length: 191 }),
    name: varchar("name", { length: 255 }).notNull(),
    quantity: integer("quantity").notNull(),
  },
  (table) => [
    foreignKey({
      name: "fulfilment_items_company_fulfilment_fk",
      columns: [table.companyId, table.fulfilmentId],
      foreignColumns: [fulfilments.companyId, fulfilments.id],
    }),
    foreignKey({
      name: "fulfilment_items_company_line_fk",
      columns: [table.companyId, table.orderLineId],
      foreignColumns: [fulfilmentOrderLines.companyId, fulfilmentOrderLines.id],
    }),
    check("fulfilment_items_quantity_positive", sql`${table.quantity} > 0`),
  ]
);

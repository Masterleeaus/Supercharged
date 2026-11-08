/**
 * Drizzle tables for the fulfilment slice (stock, reservations, adjustments, order snapshots,
 * fulfilments and their items). Not imported by shared/schema.ts and no migration is applied here.
 *
 * Conventions:
 * - Table names carry the chatbot_ prefix. Columns are snake_case. Money is not stored in this slice.
 * - Every table has company_id. Primary keys are (company_id, id), so an id is only unique inside a
 *   company, and an upsert on the primary key cannot overwrite another tenant's row.
 * - Child tables use composite foreign keys on (company_id, id), so a row cannot point at another
 *   company's parent.
 * - Stock rows with location_id NULL (the company-wide row) are unique through a partial index,
 *   because a plain unique index does not stop duplicate NULL keys in Postgres.
 * - Stock invariants are CHECK constraints, so the database refuses a write that would take committed
 *   or reserved stock below zero, even if application code is wrong.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const chatbotFulfilmentLocations = pgTable(
  "chatbot_fulfilment_locations",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    code: varchar("code", { length: 100 }).notNull(),
    name: varchar("name", { length: 191 }).notNull(),
    active: boolean("active").notNull().default(true),
    priority: integer("priority").notNull().default(100),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "chatbot_fulfilment_locations_pk", columns: [table.companyId, table.id] }),
    uniqueIndex("chatbot_fulfilment_locations_company_code_uidx").on(table.companyId, table.code),
  ]
);

export const chatbotInventoryStock = pgTable(
  "chatbot_inventory_stock",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    variantId: varchar("variant_id", { length: 191 }).notNull(),
    locationId: varchar("location_id", { length: 191 }), // null = company-wide row
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
    uniqueIndex("chatbot_inventory_stock_company_variant_location_uidx").on(table.companyId, table.variantId, table.locationId),
    uniqueIndex("chatbot_inventory_stock_company_variant_null_location_uidx")
      .on(table.companyId, table.variantId)
      .where(sql`${table.locationId} IS NULL`),
    foreignKey({
      name: "chatbot_inventory_stock_company_location_fk",
      columns: [table.companyId, table.locationId],
      foreignColumns: [chatbotFulfilmentLocations.companyId, chatbotFulfilmentLocations.id],
    }),
    check("chatbot_inventory_stock_non_negative_check", sql`${table.reserved} >= 0 AND ${table.committed} >= 0 AND ${table.allocated} >= 0`),
    check("chatbot_inventory_stock_allocated_within_committed_check", sql`${table.allocated} <= ${table.committed}`),
    check(
      "chatbot_inventory_stock_quantity_covers_holds_check",
      sql`${table.quantity} >= ${table.reserved} + ${table.committed} + ${table.damaged}`
    ),
    index("chatbot_inventory_stock_company_location_idx").on(table.companyId, table.locationId),
  ]
);

export const chatbotInventoryReservations = pgTable(
  "chatbot_inventory_reservations",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    holderId: varchar("holder_id", { length: 191 }).notNull(), // cart id
    variantId: varchar("variant_id", { length: 191 }).notNull(),
    locationId: varchar("location_id", { length: 191 }),
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
    primaryKey({ name: "chatbot_inventory_reservations_pk", columns: [table.companyId, table.id] }),
    uniqueIndex("chatbot_inventory_reservations_company_key_uidx").on(table.companyId, table.idempotencyKey),
    foreignKey({
      name: "chatbot_inventory_reservations_company_location_fk",
      columns: [table.companyId, table.locationId],
      foreignColumns: [chatbotFulfilmentLocations.companyId, chatbotFulfilmentLocations.id],
    }),
    check("chatbot_inventory_reservations_quantity_check", sql`${table.quantity} > 0`),
    check(
      "chatbot_inventory_reservations_status_check",
      sql`${table.status} IN ('active', 'committed', 'released', 'expired')`
    ),
    index("chatbot_inventory_reservations_stock_status_idx").on(table.companyId, table.variantId, table.locationId, table.status),
    index("chatbot_inventory_reservations_due_idx").on(table.companyId, table.status, table.expiresAt),
  ]
);

export const chatbotInventoryAdjustments = pgTable(
  "chatbot_inventory_adjustments",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    variantId: varchar("variant_id", { length: 191 }).notNull(),
    locationId: varchar("location_id", { length: 191 }),
    delta: integer("delta").notNull(),
    reason: varchar("reason", { length: 100 }).notNull(),
    balanceAfter: integer("balance_after").notNull(),
    version: integer("version").notNull(),
    actorId: varchar("actor_id", { length: 191 }),
    idempotencyKey: varchar("idempotency_key", { length: 191 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "chatbot_inventory_adjustments_pk", columns: [table.companyId, table.id] }),
    uniqueIndex("chatbot_inventory_adjustments_company_key_uidx").on(table.companyId, table.idempotencyKey),
    check("chatbot_inventory_adjustments_delta_check", sql`${table.delta} <> 0`),
  ]
);

export const chatbotFulfilmentOrders = pgTable(
  "chatbot_fulfilment_orders",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    reference: varchar("reference", { length: 191 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ name: "chatbot_fulfilment_orders_pk", columns: [table.companyId, table.id] })]
);

export const chatbotFulfilmentOrderLines = pgTable(
  "chatbot_fulfilment_order_lines",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    orderId: varchar("order_id", { length: 191 }).notNull(),
    variantId: varchar("variant_id", { length: 191 }).notNull(),
    productId: varchar("product_id", { length: 191 }),
    sku: varchar("sku", { length: 191 }),
    name: varchar("name", { length: 255 }).notNull(),
    quantity: integer("quantity").notNull(),
  },
  (table) => [
    primaryKey({ name: "chatbot_fulfilment_order_lines_pk", columns: [table.companyId, table.id] }),
    foreignKey({
      name: "chatbot_fulfilment_order_lines_company_order_fk",
      columns: [table.companyId, table.orderId],
      foreignColumns: [chatbotFulfilmentOrders.companyId, chatbotFulfilmentOrders.id],
    }),
    check("chatbot_fulfilment_order_lines_quantity_check", sql`${table.quantity} > 0`),
  ]
);

export const chatbotFulfilments = pgTable(
  "chatbot_fulfilments",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    orderId: varchar("order_id", { length: 191 }).notNull(),
    status: varchar("status", { length: 30 }).notNull().default("pending"),
    methodType: varchar("method_type", { length: 30 }).notNull().default("delivery"),
    locationId: varchar("location_id", { length: 191 }),
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
    primaryKey({ name: "chatbot_fulfilments_pk", columns: [table.companyId, table.id] }),
    uniqueIndex("chatbot_fulfilments_company_key_uidx").on(table.companyId, table.idempotencyKey),
    foreignKey({
      name: "chatbot_fulfilments_company_order_fk",
      columns: [table.companyId, table.orderId],
      foreignColumns: [chatbotFulfilmentOrders.companyId, chatbotFulfilmentOrders.id],
    }),
    check(
      "chatbot_fulfilments_status_check",
      sql`${table.status} IN ('pending', 'processing', 'shipped', 'delivered', 'cancelled')`
    ),
    check("chatbot_fulfilments_method_check", sql`${table.methodType} IN ('delivery', 'pickup', 'digital')`),
    index("chatbot_fulfilments_company_order_idx").on(table.companyId, table.orderId),
  ]
);

export const chatbotFulfilmentItems = pgTable(
  "chatbot_fulfilment_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    fulfilmentId: varchar("fulfilment_id", { length: 191 }).notNull(),
    orderLineId: varchar("order_line_id", { length: 191 }).notNull(),
    variantId: varchar("variant_id", { length: 191 }).notNull(),
    productId: varchar("product_id", { length: 191 }),
    sku: varchar("sku", { length: 191 }),
    name: varchar("name", { length: 255 }).notNull(),
    quantity: integer("quantity").notNull(),
  },
  (table) => [
    foreignKey({
      name: "chatbot_fulfilment_items_company_fulfilment_fk",
      columns: [table.companyId, table.fulfilmentId],
      foreignColumns: [chatbotFulfilments.companyId, chatbotFulfilments.id],
    }),
    foreignKey({
      name: "chatbot_fulfilment_items_company_line_fk",
      columns: [table.companyId, table.orderLineId],
      foreignColumns: [chatbotFulfilmentOrderLines.companyId, chatbotFulfilmentOrderLines.id],
    }),
    check("chatbot_fulfilment_items_quantity_check", sql`${table.quantity} > 0`),
  ]
);

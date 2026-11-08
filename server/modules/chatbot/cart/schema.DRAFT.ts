/*
 * DRAFT - not wired into shared/schema.ts and not applied to any database.
 * Fragment for the cart and checkout slice. The integration agent merges these tables into the
 * chatbot schema. Until then, this file imports the parent chatbot tables from the module's own draft.
 *
 * Every table carries company_id. Child tables use composite foreign keys on (company_id, id), so a cart
 * cannot point at another company's conversation, and a line cannot point at another company's cart.
 * Money columns are bigint in minor units. The partial unique indexes enforce one active cart per
 * conversation and one open checkout per cart, matching the in-memory storage.
 */
import { sql } from "drizzle-orm";
import { bigint, boolean, char, check, date, foreignKey, index, integer, jsonb, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { chatbotConversations, chatbots } from "../schema.DRAFT.ts";

export const chatbotCarts = pgTable(
  "chatbot_carts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    chatbotId: varchar("chatbot_id").notNull(),
    conversationId: varchar("conversation_id").notNull(),
    customerId: varchar("customer_id"),
    status: varchar("status", { length: 16 }).notNull().default("active"), // active | converted | expired
    currency: char("currency", { length: 3 }), // null until the first line is added
    subtotalMinor: bigint("subtotal_minor", { mode: "number" }).notNull().default(0),
    discountMinor: bigint("discount_minor", { mode: "number" }).notNull().default(0),
    totalMinor: bigint("total_minor", { mode: "number" }).notNull().default(0),
    version: integer("version").notNull().default(0),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_carts_company_id_uidx").on(table.companyId, table.id),
    uniqueIndex("chatbot_carts_one_active_per_conversation_uidx")
      .on(table.companyId, table.conversationId)
      .where(sql`${table.status} = 'active'`),
    foreignKey({
      name: "chatbot_carts_company_chatbot_fk",
      columns: [table.companyId, table.chatbotId],
      foreignColumns: [chatbots.companyId, chatbots.id],
    }),
    foreignKey({
      name: "chatbot_carts_company_conversation_fk",
      columns: [table.companyId, table.conversationId],
      foreignColumns: [chatbotConversations.companyId, chatbotConversations.id],
    }),
    index("chatbot_carts_company_expires_idx").on(table.companyId, table.expiresAt),
  ]
);

export const chatbotCartLines = pgTable(
  "chatbot_cart_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    cartId: uuid("cart_id").notNull(),
    lineKey: varchar("line_key", { length: 64 }).notNull(),
    variantId: varchar("variant_id").notNull(),
    productId: varchar("product_id").notNull(),
    sku: varchar("sku"),
    name: varchar("name", { length: 255 }).notNull(),
    quantity: integer("quantity").notNull(),
    unitPriceMinor: bigint("unit_price_minor", { mode: "number" }).notNull(),
    lineTotalMinor: bigint("line_total_minor", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    customisation: jsonb("customisation").$type<Record<string, string | number | boolean>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_cart_lines_cart_key_uidx").on(table.companyId, table.cartId, table.lineKey),
    foreignKey({
      name: "chatbot_cart_lines_company_cart_fk",
      columns: [table.companyId, table.cartId],
      foreignColumns: [chatbotCarts.companyId, chatbotCarts.id],
    }),
    check("chatbot_cart_lines_quantity_check", sql`${table.quantity} BETWEEN 1 AND 999`),
  ]
);

export const chatbotCartOperations = pgTable(
  "chatbot_cart_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    cartId: uuid("cart_id").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    operation: varchar("operation", { length: 80 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_cart_operations_idempotency_uidx").on(table.companyId, table.cartId, table.idempotencyKey),
    foreignKey({
      name: "chatbot_cart_operations_company_cart_fk",
      columns: [table.companyId, table.cartId],
      foreignColumns: [chatbotCarts.companyId, chatbotCarts.id],
    }),
  ]
);

export const chatbotCheckoutSessions = pgTable(
  "chatbot_checkout_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    cartId: uuid("cart_id").notNull(),
    chatbotId: varchar("chatbot_id").notNull(),
    conversationId: varchar("conversation_id").notNull(),
    customerId: varchar("customer_id"),
    status: varchar("status", { length: 16 }).notNull().default("open"), // open | submitted | cancelled | expired
    currency: char("currency", { length: 3 }).notNull(),
    lines: jsonb("lines").$type<Record<string, unknown>[]>().notNull().default(sql`'[]'::jsonb`),
    subtotalMinor: bigint("subtotal_minor", { mode: "number" }).notNull().default(0),
    discountMinor: bigint("discount_minor", { mode: "number" }).notNull().default(0),
    totalMinor: bigint("total_minor", { mode: "number" }).notNull().default(0),
    contactEmail: varchar("contact_email", { length: 254 }),
    contactPhone: varchar("contact_phone", { length: 80 }),
    contactName: varchar("contact_name", { length: 191 }),
    orderRequest: jsonb("order_request").$type<Record<string, unknown>>(),
    version: integer("version").notNull().default(0),
    expiresAt: timestamp("expires_at").notNull(),
    submittedAt: timestamp("submitted_at"),
    cancelledAt: timestamp("cancelled_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_checkout_sessions_company_id_uidx").on(table.companyId, table.id),
    uniqueIndex("chatbot_checkout_sessions_one_open_per_cart_uidx")
      .on(table.companyId, table.cartId)
      .where(sql`${table.status} = 'open'`),
    foreignKey({
      name: "chatbot_checkout_sessions_company_cart_fk",
      columns: [table.companyId, table.cartId],
      foreignColumns: [chatbotCarts.companyId, chatbotCarts.id],
    }),
    index("chatbot_checkout_sessions_company_status_idx").on(table.companyId, table.status),
  ]
);

export const chatbotCheckoutOperations = pgTable(
  "chatbot_checkout_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    checkoutId: uuid("checkout_id").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    operation: varchar("operation", { length: 80 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_checkout_operations_idempotency_uidx").on(table.companyId, table.checkoutId, table.idempotencyKey),
    foreignKey({
      name: "chatbot_checkout_operations_company_checkout_fk",
      columns: [table.companyId, table.checkoutId],
      foreignColumns: [chatbotCheckoutSessions.companyId, chatbotCheckoutSessions.id],
    }),
  ]
);

export const chatbotSpendLimits = pgTable(
  "chatbot_spend_limits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    scopeType: varchar("scope_type", { length: 16 }).notNull(), // conversation | customer
    scopeId: varchar("scope_id").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    maxOrderMinor: bigint("max_order_minor", { mode: "number" }),
    dailyLimitMinor: bigint("daily_limit_minor", { mode: "number" }),
    spentMinor: bigint("spent_minor", { mode: "number" }).notNull().default(0),
    periodDate: date("period_date"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_spend_limits_scope_uidx").on(table.companyId, table.scopeType, table.scopeId),
  ]
);

export type ChatbotCartRow = typeof chatbotCarts.$inferSelect;
export type ChatbotCartLineRow = typeof chatbotCartLines.$inferSelect;
export type ChatbotCartOperationRow = typeof chatbotCartOperations.$inferSelect;
export type ChatbotCheckoutSessionRow = typeof chatbotCheckoutSessions.$inferSelect;
export type ChatbotCheckoutOperationRow = typeof chatbotCheckoutOperations.$inferSelect;
export type ChatbotSpendLimitRow = typeof chatbotSpendLimits.$inferSelect;

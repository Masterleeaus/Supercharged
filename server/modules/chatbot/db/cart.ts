/**
 * Drizzle tables for the cart and checkout slice: carts, cart lines, checkout sessions, the
 * idempotency keys for cart and checkout operations, and spend limits. Not applied by any migration.
 *
 * Conventions:
 * - Table names carry the chatbot_ prefix. Columns are snake_case.
 * - Every table has company_id. Primary keys are (company_id, id), so an upsert on the primary key
 *   cannot overwrite another tenant's row.
 * - Parent tables (chatbots, chatbot_conversations) come from shared/schema.ts. Child tables use
 *   composite foreign keys on (company_id, id).
 * - Money is an integer count of minor units, stored as bigint and read back as a JS number.
 * - Partial unique indexes enforce one active cart per conversation and one open checkout per cart.
 *   The idempotency unique index is scoped by company, owner type and owner id.
 */
import { sql } from "drizzle-orm";
import { bigint, boolean, char, check, date, foreignKey, index, integer, jsonb, pgTable, primaryKey, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { chatbotConversations, chatbots } from "../../../../shared/schema.ts";

/** Constraint names the storage maps to CartError codes. Keep them in step with cart-storage.ts. */
export const CART_CONSTRAINTS = {
  activeCartPerConversation: "chatbot_carts_one_active_per_conversation_uidx",
  openCheckoutPerCart: "chatbot_checkout_sessions_one_open_per_cart_uidx",
  idempotencyKey: "chatbot_cart_idempotency_keys_company_owner_key_uidx",
  spendLimitScope: "chatbot_spend_limits_scope_uidx",
} as const;

export const chatbotCarts = pgTable(
  "chatbot_carts",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    chatbotId: varchar("chatbot_id", { length: 191 }).notNull(),
    conversationId: varchar("conversation_id", { length: 191 }).notNull(),
    customerId: varchar("customer_id", { length: 191 }),
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
    primaryKey({ name: "chatbot_carts_pk", columns: [table.companyId, table.id] }),
    uniqueIndex(CART_CONSTRAINTS.activeCartPerConversation)
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
    check("chatbot_carts_status_check", sql`${table.status} IN ('active', 'converted', 'expired')`),
    index("chatbot_carts_company_expires_idx").on(table.companyId, table.expiresAt),
  ]
);

export const chatbotCartLines = pgTable(
  "chatbot_cart_lines",
  {
    companyId: uuid("company_id").notNull(),
    cartId: varchar("cart_id", { length: 191 }).notNull(),
    lineKey: varchar("line_key", { length: 64 }).notNull(),
    position: integer("position").notNull(), // keeps the order the lines were written in
    variantId: varchar("variant_id", { length: 191 }).notNull(),
    productId: varchar("product_id", { length: 191 }).notNull(),
    sku: varchar("sku", { length: 191 }),
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
    primaryKey({ name: "chatbot_cart_lines_pk", columns: [table.companyId, table.cartId, table.lineKey] }),
    foreignKey({
      name: "chatbot_cart_lines_company_cart_fk",
      columns: [table.companyId, table.cartId],
      foreignColumns: [chatbotCarts.companyId, chatbotCarts.id],
    }),
    check("chatbot_cart_lines_quantity_check", sql`${table.quantity} BETWEEN 1 AND 999`),
    check("chatbot_cart_lines_money_check", sql`${table.unitPriceMinor} >= 0 AND ${table.lineTotalMinor} >= 0`),
  ]
);

/**
 * One row per (company, owner, key). The owner is a cart or a checkout, so the owner type and owner
 * id are part of the key. The unique index is the database-level guarantee that a key is used once.
 */
export const chatbotCartIdempotencyKeys = pgTable(
  "chatbot_cart_idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    ownerType: varchar("owner_type", { length: 16 }).notNull(), // cart | checkout
    ownerId: varchar("owner_id", { length: 191 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    operation: varchar("operation", { length: 80 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex(CART_CONSTRAINTS.idempotencyKey).on(table.companyId, table.ownerType, table.ownerId, table.idempotencyKey),
    check("chatbot_cart_idempotency_keys_owner_check", sql`${table.ownerType} IN ('cart', 'checkout')`),
  ]
);

export const chatbotCheckoutSessions = pgTable(
  "chatbot_checkout_sessions",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    cartId: varchar("cart_id", { length: 191 }).notNull(),
    chatbotId: varchar("chatbot_id", { length: 191 }).notNull(),
    conversationId: varchar("conversation_id", { length: 191 }).notNull(),
    customerId: varchar("customer_id", { length: 191 }),
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
    primaryKey({ name: "chatbot_checkout_sessions_pk", columns: [table.companyId, table.id] }),
    uniqueIndex(CART_CONSTRAINTS.openCheckoutPerCart)
      .on(table.companyId, table.cartId)
      .where(sql`${table.status} = 'open'`),
    foreignKey({
      name: "chatbot_checkout_sessions_company_cart_fk",
      columns: [table.companyId, table.cartId],
      foreignColumns: [chatbotCarts.companyId, chatbotCarts.id],
    }),
    check("chatbot_checkout_sessions_status_check", sql`${table.status} IN ('open', 'submitted', 'cancelled', 'expired')`),
    index("chatbot_checkout_sessions_company_status_idx").on(table.companyId, table.status),
  ]
);

export const chatbotSpendLimits = pgTable(
  "chatbot_spend_limits",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    scopeType: varchar("scope_type", { length: 16 }).notNull(), // conversation | customer
    scopeId: varchar("scope_id", { length: 191 }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    maxOrderMinor: bigint("max_order_minor", { mode: "number" }),
    dailyLimitMinor: bigint("daily_limit_minor", { mode: "number" }),
    spentMinor: bigint("spent_minor", { mode: "number" }).notNull().default(0),
    periodDate: date("period_date", { mode: "string" }),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "chatbot_spend_limits_pk", columns: [table.companyId, table.id] }),
    uniqueIndex(CART_CONSTRAINTS.spendLimitScope).on(table.companyId, table.scopeType, table.scopeId),
    check("chatbot_spend_limits_scope_check", sql`${table.scopeType} IN ('conversation', 'customer')`),
    check("chatbot_spend_limits_spent_check", sql`${table.spentMinor} >= 0`),
  ]
);

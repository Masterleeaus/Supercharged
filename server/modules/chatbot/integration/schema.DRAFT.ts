/*
 * INTEGRATION DRAFT. One merged schema for the chatbot slices. Not applied to any database.
 * Not wired into shared/schema.ts (the integration brief said not to edit shared/schema.ts in this pass).
 * Nothing imports this file yet. The matching SQL is not written.
 *
 * Parent tables come from shared/schema.ts, which holds the promoted chatbots, chatbot_conversations and
 * chatbot_messages. The slice fragments used to point at server/modules/chatbot/schema.DRAFT.ts, which is an
 * older copy of the same tables. See server/modules/chatbot/integration/INTEGRATION.md, section "Schema".
 *
 * Column maps that must be spread into the promoted parent tables when they are promoted:
 *   chatbotMessageStaffColumns         -> chatbot_messages.staff_id
 *   chatbotConversationHandlerColumns  -> chatbot_conversations.handler_staff_id
 *   bookingAssistantChatbotColumns     -> chatbots (is_booking_assistant, booking_assistant_conditions, booking_assistant_iframe)
 *   builderChatbotColumns              -> chatbots (builder fields, public uuid, builder settings JSON)
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { chatbotConversations, chatbotMessages, chatbots } from "../../../../shared/schema.ts";

// ---------------------------------------------------------------------------
// Orders slice: commerce_* tables (order, returns, coupons)
// Source: server/modules/chatbot/orders/schema.DRAFT.ts
// ---------------------------------------------------------------------------

export const commerceOrders = pgTable(
  "commerce_orders",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    orderNumber: varchar("order_number", { length: 80 }).notNull(),
    chatbotId: varchar("chatbot_id").notNull(),
    cartId: varchar("cart_id"),
    checkoutId: varchar("checkout_id").notNull(),
    paymentIntentId: varchar("payment_intent_id"),
    customerIdentityId: varchar("customer_identity_id"),
    conversationId: varchar("conversation_id"),
    sessionId: varchar("session_id", { length: 191 }),
    source: varchar("source", { length: 40 }).notNull().default("internal"),
    status: varchar("status", { length: 40 }).notNull().default("pending"),
    fulfillmentStatus: varchar("fulfillment_status", { length: 40 }).notNull().default("unfulfilled"),
    currency: varchar("currency", { length: 3 }).notNull(),
    subtotal: bigint("subtotal", { mode: "number" }).notNull().default(0),
    discountTotal: bigint("discount_total", { mode: "number" }).notNull().default(0),
    taxTotal: bigint("tax_total", { mode: "number" }).notNull().default(0),
    shippingTotal: bigint("shipping_total", { mode: "number" }).notNull().default(0),
    total: bigint("total", { mode: "number" }).notNull().default(0),
    refundedTotal: bigint("refunded_total", { mode: "number" }).notNull().default(0),
    customerSnapshot: jsonb("customer_snapshot").notNull().default(sql`'{}'::jsonb`),
    billingAddress: jsonb("billing_address").notNull().default(sql`'{}'::jsonb`),
    shippingAddress: jsonb("shipping_address").notNull().default(sql`'{}'::jsonb`),
    paymentSnapshot: jsonb("payment_snapshot").notNull().default(sql`'{}'::jsonb`),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    placedAt: timestamp("placed_at").notNull().defaultNow(),
    confirmedAt: timestamp("confirmed_at"),
    completedAt: timestamp("completed_at"),
    cancelledAt: timestamp("cancelled_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("commerce_orders_company_id_uidx").on(table.companyId, table.id),
    uniqueIndex("commerce_orders_company_number_uidx").on(table.companyId, table.orderNumber),
    uniqueIndex("commerce_orders_company_checkout_uidx").on(table.companyId, table.checkoutId),
    foreignKey({
      name: "commerce_orders_company_chatbot_fk",
      columns: [table.companyId, table.chatbotId],
      foreignColumns: [chatbots.companyId, chatbots.id],
    }),
    index("commerce_orders_company_session_idx").on(table.companyId, table.sessionId),
    index("commerce_orders_company_status_idx").on(table.companyId, table.status),
  ]
);

export const commerceOrderItems = pgTable(
  "commerce_order_items",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    orderId: varchar("order_id").notNull(),
    productId: varchar("product_id"),
    variantId: varchar("variant_id"),
    sku: varchar("sku", { length: 191 }),
    name: varchar("name", { length: 255 }).notNull(),
    variantName: varchar("variant_name", { length: 255 }),
    quantity: integer("quantity").notNull(),
    fulfilledQuantity: integer("fulfilled_quantity").notNull().default(0),
    returnedQuantity: integer("returned_quantity").notNull().default(0),
    listUnitPrice: bigint("list_unit_price", { mode: "number" }).notNull().default(0),
    unitPrice: bigint("unit_price", { mode: "number" }).notNull().default(0),
    discountTotal: bigint("discount_total", { mode: "number" }).notNull().default(0),
    taxTotal: bigint("tax_total", { mode: "number" }).notNull().default(0),
    lineTotal: bigint("line_total", { mode: "number" }).notNull().default(0),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("commerce_order_items_company_id_uidx").on(table.companyId, table.id),
    foreignKey({
      name: "commerce_order_items_company_order_fk",
      columns: [table.companyId, table.orderId],
      foreignColumns: [commerceOrders.companyId, commerceOrders.id],
    }),
    index("commerce_order_items_company_order_idx").on(table.companyId, table.orderId),
    // Returned quantity may never exceed ordered quantity. The service checks this first. The CHECK is a backstop.
    check("commerce_order_items_returned_lte_quantity", sql`${table.returnedQuantity} <= ${table.quantity}`),
  ]
);

export const commerceOrderEvents = pgTable(
  "commerce_order_events",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    orderId: varchar("order_id").notNull(),
    eventType: varchar("event_type", { length: 80 }).notNull(),
    actorType: varchar("actor_type", { length: 40 }).notNull().default("system"),
    actorId: varchar("actor_id", { length: 191 }),
    beforeState: jsonb("before_state"),
    afterState: jsonb("after_state"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    // Append-only. The application exposes no update or delete. A DB trigger that rejects UPDATE and
    // DELETE on this table is recommended when this is promoted. See DECISIONS.md.
    uniqueIndex("commerce_order_events_company_sequence_uidx").on(table.companyId, table.sequence),
    foreignKey({
      name: "commerce_order_events_company_order_fk",
      columns: [table.companyId, table.orderId],
      foreignColumns: [commerceOrders.companyId, commerceOrders.id],
    }),
    index("commerce_order_events_company_order_idx").on(table.companyId, table.orderId),
  ]
);

export const commerceReturns = pgTable(
  "commerce_returns",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    rmaNumber: varchar("rma_number", { length: 80 }).notNull(),
    orderId: varchar("order_id").notNull(),
    customerIdentityId: varchar("customer_identity_id"),
    status: varchar("status", { length: 40 }).notNull().default("requested"),
    reasonCode: varchar("reason_code", { length: 80 }),
    reason: text("reason"),
    requestedResolution: varchar("requested_resolution", { length: 40 }).notNull().default("refund"),
    requestedAmount: bigint("requested_amount", { mode: "number" }).notNull().default(0),
    refundedAmount: bigint("refunded_amount", { mode: "number" }).notNull().default(0),
    currency: varchar("currency", { length: 3 }).notNull(),
    quantitiesReleased: boolean("quantities_released").notNull().default(false),
    paymentRefunds: jsonb("payment_refunds").notNull().default(sql`'[]'::jsonb`),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    approvedAt: timestamp("approved_at"),
    receivedAt: timestamp("received_at"),
    resolvedAt: timestamp("resolved_at"),
    cancelledAt: timestamp("cancelled_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("commerce_returns_company_id_uidx").on(table.companyId, table.id),
    uniqueIndex("commerce_returns_company_rma_uidx").on(table.companyId, table.rmaNumber),
    foreignKey({
      name: "commerce_returns_company_order_fk",
      columns: [table.companyId, table.orderId],
      foreignColumns: [commerceOrders.companyId, commerceOrders.id],
    }),
    index("commerce_returns_company_status_idx").on(table.companyId, table.status),
  ]
);

export const commerceReturnItems = pgTable(
  "commerce_return_items",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    returnId: varchar("return_id").notNull(),
    orderItemId: varchar("order_item_id").notNull(),
    quantity: integer("quantity").notNull(),
    reasonCode: varchar("reason_code", { length: 80 }),
    condition: varchar("condition", { length: 80 }),
    amount: bigint("amount", { mode: "number" }).notNull().default(0),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("commerce_return_items_company_id_uidx").on(table.companyId, table.id),
    foreignKey({
      name: "commerce_return_items_company_return_fk",
      columns: [table.companyId, table.returnId],
      foreignColumns: [commerceReturns.companyId, commerceReturns.id],
    }),
    foreignKey({
      name: "commerce_return_items_company_order_item_fk",
      columns: [table.companyId, table.orderItemId],
      foreignColumns: [commerceOrderItems.companyId, commerceOrderItems.id],
    }),
  ]
);

export const commerceCoupons = pgTable(
  "commerce_coupons",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    chatbotId: varchar("chatbot_id").notNull(),
    code: varchar("code", { length: 64 }).notNull(),
    type: varchar("type", { length: 20 }).notNull(),
    value: bigint("value", { mode: "number" }).notNull(),
    minimumAmount: bigint("minimum_amount", { mode: "number" }).notNull().default(0),
    maxDiscountAmount: bigint("max_discount_amount", { mode: "number" }),
    active: boolean("active").notNull().default(true),
    startsAt: timestamp("starts_at"),
    endsAt: timestamp("ends_at"),
    currency: varchar("currency", { length: 3 }),
    channels: jsonb("channels").notNull().default(sql`'[]'::jsonb`),
    firstOrderOnly: boolean("first_order_only").notNull().default(false),
    usageLimit: integer("usage_limit"),
    usageLimitPerCustomer: integer("usage_limit_per_customer"),
    appliesTo: varchar("applies_to", { length: 30 }).notNull().default("cart"),
    targetIds: jsonb("target_ids").notNull().default(sql`'[]'::jsonb`),
    stackable: boolean("stackable").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("commerce_coupons_company_id_uidx").on(table.companyId, table.id),
    uniqueIndex("commerce_coupons_company_chatbot_code_uidx").on(table.companyId, table.chatbotId, table.code),
    foreignKey({
      name: "commerce_coupons_company_chatbot_fk",
      columns: [table.companyId, table.chatbotId],
      foreignColumns: [chatbots.companyId, chatbots.id],
    }),
  ]
);

export const commerceCouponUsages = pgTable(
  "commerce_coupon_usages",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    couponId: varchar("coupon_id").notNull(),
    cartId: varchar("cart_id").notNull(),
    customerIdentityId: varchar("customer_identity_id"),
    status: varchar("status", { length: 20 }).notNull().default("reserved"),
    channel: varchar("channel", { length: 40 }),
    currency: varchar("currency", { length: 3 }),
    reservedAt: timestamp("reserved_at"),
    redeemedAt: timestamp("redeemed_at"),
    releasedAt: timestamp("released_at"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("commerce_coupon_usages_company_id_uidx").on(table.companyId, table.id),
    uniqueIndex("commerce_coupon_usages_company_coupon_cart_uidx").on(table.companyId, table.couponId, table.cartId),
    foreignKey({
      name: "commerce_coupon_usages_company_coupon_fk",
      columns: [table.companyId, table.couponId],
      foreignColumns: [commerceCoupons.companyId, commerceCoupons.id],
    }),
    index("commerce_coupon_usages_company_status_expiry_idx").on(table.companyId, table.status, table.expiresAt),
  ]
);

// ---------------------------------------------------------------------------
// Cart and checkout slice
// Source: server/modules/chatbot/cart/schema.DRAFT.ts
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Customers and tags slice
// Source: server/modules/chatbot/customers/schema.DRAFT.ts
// ---------------------------------------------------------------------------

export const chatbotCustomers = pgTable(
  "chatbot_customers",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    userId: varchar("user_id", { length: 64 }), // linked Desk user; data only, never used for authorization
    avatar: text("avatar"),
    name: varchar("name", { length: 255 }),
    email: varchar("email", { length: 255 }),
    phone: varchar("phone", { length: 255 }),
    chatbotId: varchar("chatbot_id"),
    sessionId: varchar("session_id", { length: 128 }),
    countryCode: varchar("country_code", { length: 32 }),
    ipAddress: varchar("ip_address", { length: 64 }), // personal data: never logged
    chatbotChannel: varchar("chatbot_channel", { length: 32 }),
    enabledSound: boolean("enabled_sound").notNull().default(true),
    preferredLanguage: varchar("preferred_language", { length: 16 }),
    communicationPreferences: jsonb("communication_preferences").$type<Record<string, unknown>>(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_customers_company_id_uidx").on(table.companyId, table.id),
    index("chatbot_customers_company_email_idx").on(table.companyId, table.email),
    foreignKey({
      name: "chatbot_customers_company_chatbot_fk",
      columns: [table.companyId, table.chatbotId],
      foreignColumns: [chatbots.companyId, chatbots.id],
    }),
  ]
);

export const chatbotContactIdentities = pgTable(
  "chatbot_contact_identities",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    customerId: varchar("customer_id").notNull(),
    channel: varchar("channel", { length: 32 }).notNull(),
    identifier: varchar("identifier", { length: 255 }).notNull(),
    normalizedIdentifier: varchar("normalized_identifier", { length: 255 }).notNull(),
    verifiedAt: timestamp("verified_at"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // Unique per company. The source index is global, which would let one tenant match another's contacts.
    uniqueIndex("chatbot_contact_identities_company_value_uidx").on(
      table.companyId,
      table.channel,
      table.normalizedIdentifier
    ),
    index("chatbot_contact_identities_company_customer_idx").on(table.companyId, table.customerId),
    foreignKey({
      name: "chatbot_contact_identities_company_customer_fk",
      columns: [table.companyId, table.customerId],
      foreignColumns: [chatbotCustomers.companyId, chatbotCustomers.id],
    }),
  ]
);

/** One row per conversation. Replaces the chatbot_customer_id column the source adds to conversations. */
export const chatbotCustomerConversations = pgTable(
  "chatbot_customer_conversations",
  {
    companyId: uuid("company_id").notNull(),
    conversationId: varchar("conversation_id").notNull(),
    customerId: varchar("customer_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_customer_conversations_company_conversation_uidx").on(table.companyId, table.conversationId),
    index("chatbot_customer_conversations_company_customer_idx").on(table.companyId, table.customerId),
    foreignKey({
      name: "chatbot_customer_conversations_company_conversation_fk",
      columns: [table.companyId, table.conversationId],
      foreignColumns: [chatbotConversations.companyId, chatbotConversations.id],
    }),
    foreignKey({
      name: "chatbot_customer_conversations_company_customer_fk",
      columns: [table.companyId, table.customerId],
      foreignColumns: [chatbotCustomers.companyId, chatbotCustomers.id],
    }),
  ]
);

export const chatbotCustomerTags = pgTable(
  "chatbot_customer_tags",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    tag: varchar("tag", { length: 255 }).notNull(),
    tagColor: varchar("tag_color", { length: 50 }),
    backgroundColor: varchar("background_color", { length: 50 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_customer_tags_company_id_uidx").on(table.companyId, table.id),
    // Not unique: the source allows two tags with the same name. See DECISIONS.md.
    index("chatbot_customer_tags_company_tag_idx").on(table.companyId, table.tag),
  ]
);

export const chatbotConversationCustomerTags = pgTable(
  "chatbot_conversation_customer_tags",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    conversationId: varchar("conversation_id").notNull(),
    customerTagId: varchar("customer_tag_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // The pair is unique, so a tag can be assigned to a conversation only once.
    uniqueIndex("chatbot_conversation_customer_tags_pair_uidx").on(
      table.companyId,
      table.conversationId,
      table.customerTagId
    ),
    index("chatbot_conversation_customer_tags_company_tag_idx").on(table.companyId, table.customerTagId),
    foreignKey({
      name: "chatbot_conversation_customer_tags_company_conversation_fk",
      columns: [table.companyId, table.conversationId],
      foreignColumns: [chatbotConversations.companyId, chatbotConversations.id],
    }),
    foreignKey({
      name: "chatbot_conversation_customer_tags_company_tag_fk",
      columns: [table.companyId, table.customerTagId],
      foreignColumns: [chatbotCustomerTags.companyId, chatbotCustomerTags.id],
    }),
  ]
);

export type ChatbotCustomerRow = typeof chatbotCustomers.$inferSelect;
export type ChatbotCustomerInsertRow = typeof chatbotCustomers.$inferInsert;
export type ChatbotContactIdentityRow = typeof chatbotContactIdentities.$inferSelect;
export type ChatbotContactIdentityInsertRow = typeof chatbotContactIdentities.$inferInsert;
export type ChatbotCustomerConversationRow = typeof chatbotCustomerConversations.$inferSelect;
export type ChatbotCustomerTagRow = typeof chatbotCustomerTags.$inferSelect;
export type ChatbotCustomerTagInsertRow = typeof chatbotCustomerTags.$inferInsert;
export type ChatbotConversationCustomerTagRow = typeof chatbotConversationCustomerTags.$inferSelect;

// ---------------------------------------------------------------------------
// Bookings slice (plus booking-assistant columns for chatbots)
// Source: server/modules/chatbot/bookings/schema.DRAFT.ts
// ---------------------------------------------------------------------------

export const chatbotBookingCalendars = pgTable(
  "chatbot_booking_calendars",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    timezone: varchar("timezone", { length: 64 }).notNull().default("UTC"),
    // Same shape as appointment_settings.working_hours in shared/schema.ts. Null means no bookable hours.
    availability: jsonb("availability").$type<Record<string, { enabled: boolean; start: string; end: string }>>(),
    bufferMinutes: integer("buffer_minutes").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_booking_calendars_company_id_uidx").on(table.companyId, table.id),
    check("chatbot_booking_calendars_buffer_chk", sql`${table.bufferMinutes} >= 0 AND ${table.bufferMinutes} <= 240`),
  ]
);

export const chatbotAppointments = pgTable(
  "chatbot_appointments",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    calendarId: varchar("calendar_id").notNull(),
    conversationId: varchar("conversation_id"),
    customerName: varchar("customer_name", { length: 255 }).notNull(),
    customerEmail: varchar("customer_email", { length: 254 }),
    customerPhone: varchar("customer_phone", { length: 16 }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    // Range including the buffer after the appointment. Written on insert and read by the exclusion constraint.
    blockedRange: text("blocked_range"),
    status: varchar("status", { length: 16 }).notNull().default("confirmed"), // confirmed | waitlisted | cancelled
    statusReason: varchar("status_reason", { length: 500 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_appointments_company_id_uidx").on(table.companyId, table.id),
    foreignKey({
      name: "chatbot_appointments_company_calendar_fk",
      columns: [table.companyId, table.calendarId],
      foreignColumns: [chatbotBookingCalendars.companyId, chatbotBookingCalendars.id],
    }),
    // Nullable column: MATCH SIMPLE skips this foreign key when conversation_id is null.
    foreignKey({
      name: "chatbot_appointments_company_conversation_fk",
      columns: [table.companyId, table.conversationId],
      foreignColumns: [chatbotConversations.companyId, chatbotConversations.id],
    }),
    check("chatbot_appointments_status_chk", sql`${table.status} IN ('confirmed', 'waitlisted', 'cancelled')`),
    check("chatbot_appointments_range_chk", sql`${table.endsAt} > ${table.startsAt}`),
    index("chatbot_appointments_company_calendar_time_idx").on(table.companyId, table.calendarId, table.startsAt),
  ]
);

export const chatbotBookingReminders = pgTable(
  "chatbot_booking_reminders",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    appointmentId: varchar("appointment_id").notNull(),
    channel: varchar("channel", { length: 16 }).notNull(), // email | sms | whatsapp | telegram | web
    sendAt: timestamp("send_at", { withTimezone: true }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("queued"), // queued | sent | failed | cancelled
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "chatbot_booking_reminders_company_appointment_fk",
      columns: [table.companyId, table.appointmentId],
      foreignColumns: [chatbotAppointments.companyId, chatbotAppointments.id],
    }),
    index("chatbot_booking_reminders_due_idx").on(table.companyId, table.status, table.sendAt),
  ]
);

/*
 * Booking-assistant columns for the chatbots table. They belong on chatbots in ../schema.DRAFT.ts, which the
 * chatbot slice owns. Spread these into that table definition when the fragments are merged. They mirror
 * 2026_03_04_110258_add_booking_assistant_conditions_to_ext_chatbots.php.
 */
export const bookingAssistantChatbotColumns = {
  isBookingAssistant: boolean("is_booking_assistant").notNull().default(false),
  bookingAssistantConditions: jsonb("booking_assistant_conditions").$type<string[]>(),
  bookingAssistantIframe: text("booking_assistant_iframe"),
};

export type ChatbotCalendarRow = typeof chatbotBookingCalendars.$inferSelect;
export type ChatbotCalendarInsertRow = typeof chatbotBookingCalendars.$inferInsert;
export type ChatbotAppointmentRow = typeof chatbotAppointments.$inferSelect;
export type ChatbotAppointmentInsertRow = typeof chatbotAppointments.$inferInsert;
export type ChatbotBookingReminderRow = typeof chatbotBookingReminders.$inferSelect;
export type ChatbotBookingReminderInsertRow = typeof chatbotBookingReminders.$inferInsert;

// ---------------------------------------------------------------------------
// Fulfilment, inventory and dispatch slice
// Source: server/modules/chatbot/fulfilment/schema.DRAFT.ts
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Unified inbox slice
// Source: server/modules/chatbot/inbox/schema.DRAFT.ts
// ---------------------------------------------------------------------------

export const chatbotInboxConversationStates = pgTable(
  "chatbot_inbox_conversation_states",
  {
    companyId: uuid("company_id").notNull(),
    conversationId: varchar("conversation_id").notNull(),
    assignedTo: varchar("assigned_to", { length: 191 }), // staff user id, null when unassigned
    priority: varchar("priority", { length: 16 }).notNull().default("normal"), // low | normal | high | urgent
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_inbox_states_company_conversation_uidx").on(table.companyId, table.conversationId),
    foreignKey({
      name: "chatbot_inbox_states_company_conversation_fk",
      columns: [table.companyId, table.conversationId],
      foreignColumns: [chatbotConversations.companyId, chatbotConversations.id],
    }),
    index("chatbot_inbox_states_company_assignee_idx").on(table.companyId, table.assignedTo),
  ]
);

export const chatbotInboxParticipants = pgTable(
  "chatbot_inbox_participants",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull(),
    conversationId: varchar("conversation_id").notNull(),
    type: varchar("type", { length: 64 }).notNull(),
    reference: varchar("reference", { length: 191 }), // null for participants with no external reference
    displayName: varchar("display_name", { length: 191 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    lastReadMessageId: varchar("last_read_message_id"), // cursor: message id, null when nothing has been read
    lastReadMessageCreatedAt: timestamp("last_read_message_created_at"), // cursor: message createdAt, paired with the id
    lastReadAt: timestamp("last_read_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // coalesce() makes a null reference compare equal, so a second reference-less row of the same type is refused.
    uniqueIndex("chatbot_inbox_participants_key_uidx").on(
      table.companyId,
      table.conversationId,
      table.type,
      sql`coalesce(${table.reference}, '')`,
    ),
    uniqueIndex("chatbot_inbox_participants_company_id_uidx").on(table.companyId, table.id),
    foreignKey({
      name: "chatbot_inbox_participants_company_conversation_fk",
      columns: [table.companyId, table.conversationId],
      foreignColumns: [chatbotConversations.companyId, chatbotConversations.id],
    }),
    index("chatbot_inbox_participants_company_conversation_idx").on(table.companyId, table.conversationId),
  ]
);

export const chatbotInboxPresence = pgTable(
  "chatbot_inbox_presence",
  {
    companyId: uuid("company_id").notNull(),
    conversationId: varchar("conversation_id").notNull(),
    participantKey: varchar("participant_key", { length: 191 }).notNull(),
    state: varchar("state", { length: 16 }).notNull().default("online"), // online | away | busy | offline
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  },
  (table) => [
    uniqueIndex("chatbot_inbox_presence_key_uidx").on(table.companyId, table.conversationId, table.participantKey),
    foreignKey({
      name: "chatbot_inbox_presence_company_conversation_fk",
      columns: [table.companyId, table.conversationId],
      foreignColumns: [chatbotConversations.companyId, chatbotConversations.id],
    }),
    index("chatbot_inbox_presence_company_seen_idx").on(table.companyId, table.conversationId, table.lastSeenAt),
  ]
);

export type ChatbotInboxParticipantRow = typeof chatbotInboxParticipants.$inferSelect;
export type ChatbotInboxParticipantInsertRow = typeof chatbotInboxParticipants.$inferInsert;
export type ChatbotInboxPresenceRow = typeof chatbotInboxPresence.$inferSelect;
export type ChatbotInboxConversationStateRow = typeof chatbotInboxConversationStates.$inferSelect;

// ---------------------------------------------------------------------------
// Staff reply and handoff slice (two column maps)
// Source: server/modules/chatbot/agent-routes/schema.DRAFT.ts
// ---------------------------------------------------------------------------

/** Spread into chatbotMessages. Records which staff member wrote an assistant-side message. */
export const chatbotMessageStaffColumns = {
  staffId: varchar("staff_id", { length: 64 }),
};

/** Spread into chatbotConversations. Records which staff member is handling the chat while a human is connected. */
export const chatbotConversationHandlerColumns = {
  handlerStaffId: varchar("handler_staff_id", { length: 64 }),
};

// ---------------------------------------------------------------------------
// Builder wizard slice (builder columns and avatars)
// Source: server/modules/chatbot/builder-routes/schema.DRAFT.ts
// ---------------------------------------------------------------------------

/**
 * Two new columns on chatbots:
 *  - builder_settings: one JSON object holding the wire-named builder keys (configure, customize and
 *    embed.trustedDomains). Merged on write, never replaced.
 *  - public_uuid: the id shown in the embed snippet (embed.uuid). Unique, read-only from the API.
 */
export const builderChatbotColumns = {
  builderSettings: jsonb("builder_settings").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  publicUuid: uuid("public_uuid").notNull().default(sql`gen_random_uuid()`).unique(),
};

/**
 * Avatars. A null company_id marks a preset shared by every company. Uploads carry the company id and are
 * listed only to that company.
 */
export const chatbotAvatars = pgTable(
  "chatbot_avatars",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id"),
    path: varchar("path", { length: 512 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chatbot_avatars_path_uidx").on(table.path),
    index("chatbot_avatars_company_idx").on(table.companyId),
  ],
);

export type ChatbotAvatarRow = typeof chatbotAvatars.$inferSelect;
export type ChatbotAvatarInsertRow = typeof chatbotAvatars.$inferInsert;

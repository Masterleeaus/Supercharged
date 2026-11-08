/*
 * DRAFT - orders slice. Not wired into shared/schema.ts and not applied to any database.
 * The integration agent merges these tables. Matching SQL is not written in this slice.
 *
 * Every table carries company_id. Child tables use composite foreign keys on (company_id, id), so an
 * item cannot point at another company's order, and a return cannot point at another company's order
 * item, even when application code has a bug. Money columns are bigint in minor units. Never float.
 */
import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { chatbots } from "../schema.DRAFT.ts";

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

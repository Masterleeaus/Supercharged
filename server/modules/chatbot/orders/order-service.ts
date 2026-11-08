/**
 * Native order service: order creation from a completed checkout, the order lifecycle, returns, refund
 * recording, and coupon reservation. Ported from Services/NativeOrderRuntime.php and
 * Services/CouponRuntime.php.
 *
 * Out of scope and not called here: payment capture and refunds at the provider, BNPL, tax calculation,
 * shipping rules, marketplace sync and listing intelligence. Tax and shipping arrive as inputs.
 * Refund amounts arrive after the caller has confirmed them with the payment provider.
 *
 * The module is off unless `enabled: true` is passed. Every method checks the flag first.
 *
 * Storage is async (OrderStorage returns Promises), so every service method is async and every storage
 * call is awaited. The M1 refund guard is enforced here in transitionOrder as well as in the storage write
 * path, so it holds whichever storage is supplied.
 */
import { randomBytes } from "node:crypto";
import { requireCompanyId } from "../chatbot-scope.ts";
import {
  assertCouponApplicable,
  assertUsageAvailable,
  couponDiscount,
  DEFAULT_RESERVATION_TTL_MINUTES,
  isCouponInWindow,
  normaliseCouponCode,
  type CouponLine,
} from "./coupons.ts";
import {
  assertOrderTransition,
  assertReturnTransition,
  REFUNDABLE_RETURN_STATUSES,
  RETURNABLE_ORDER_STATUSES,
  type OrderStatus,
  type ReturnStatus,
} from "./lifecycle.ts";
import { OrderError } from "./order-errors.ts";
import { addMinor, assertNonNegativeMinor, assertPositiveQuantity, prorateHalfUp, type MinorUnits } from "./money.ts";
import { noopOrderEventPublisher, type OrderEventPublisher } from "./order-events.ts";
import {
  REFUND_RECORD_REQUIRED,
  type OrderEventInsert,
  type OrderInsert,
  type OrderItemInsert,
  type OrderStorage,
  type ReturnItemInsert,
} from "./order-storage.ts";
import { assertTotalsMatch, computeLineTotals, computeOrderTotals, type OrderTotals, type PricedLineInput } from "./totals.ts";
import type {
  CouponAppliesTo,
  CouponRecord,
  CouponType,
  CouponUsageRecord,
  OrderEventRecord,
  OrderItemRecord,
  OrderRecord,
  ReturnItemRecord,
  ReturnRecord,
  ReturnResolution,
} from "./order-types.ts";

const RETURN_RESOLUTIONS: readonly ReturnResolution[] = ["refund", "exchange", "store_credit"];
const COUPON_TYPES: readonly CouponType[] = ["percentage", "fixed"];
const COUPON_APPLIES_TO: readonly CouponAppliesTo[] = ["cart", "products", "variants", "categories"];
const MAX_COUPON_PERCENT_BASIS_POINTS = 10_000;
const MAX_COUPON_RESERVATION_SWEEP = 5_000;

export interface OrderServiceOptions {
  storage: OrderStorage;
  /** Feature flag. Defaults to false. The whole module refuses to run while off. */
  enabled?: boolean;
  publisher?: OrderEventPublisher;
  now?: () => Date;
  /** Random source for order and RMA numbers. Injectable for tests. */
  randomHex?: (bytes: number) => string;
  /** Minutes a reserved coupon holds its slot. */
  couponReservationTtlMinutes?: number;
}

export interface CheckoutLineInput extends PricedLineInput {
  productId?: string | null;
  variantId?: string | null;
  sku?: string | null;
  name: string;
  variantName?: string | null;
  listUnitPrice?: MinorUnits;
  metadata?: Record<string, unknown>;
}

export interface CheckoutOrderInput {
  checkoutId: string;
  checkoutStatus: string;
  chatbotId: string;
  cartId: string | null;
  paymentIntentId?: string | null;
  customerIdentityId?: string | null;
  conversationId?: string | null;
  sessionId?: string | null;
  currency: string;
  fulfillmentStatus?: string | null;
  shippingTotal: MinorUnits;
  /** Totals the checkout reports. They must match the recomputed totals or the order is refused. */
  reportedTotals: OrderTotals;
  lines: CheckoutLineInput[];
  customerSnapshot?: Record<string, unknown>;
  billingAddress?: Record<string, unknown>;
  shippingAddress?: Record<string, unknown>;
  paymentSnapshot?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface ReturnItemRequest {
  orderItemId: string;
  quantity: number;
  reasonCode?: string | null;
  condition?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ReturnRequestInput {
  items: ReturnItemRequest[];
  resolution: string;
  reason?: string | null;
  customerIdentityId?: string | null;
}

export interface ReturnDetail {
  returnRecord: ReturnRecord;
  items: ReturnItemRecord[];
}

export interface OrderDetail {
  order: OrderRecord;
  items: OrderItemRecord[];
  events: OrderEventRecord[];
  returns: ReturnDetail[];
}

export interface CouponInput {
  chatbotId: string;
  code: string;
  type: CouponType;
  value: number;
  minimumAmount?: number;
  maxDiscountAmount?: number | null;
  active?: boolean;
  startsAt?: Date | null;
  endsAt?: Date | null;
  currency?: string | null;
  channels?: string[];
  firstOrderOnly?: boolean;
  usageLimit?: number | null;
  usageLimitPerCustomer?: number | null;
  appliesTo?: CouponAppliesTo;
  targetIds?: string[];
  stackable?: boolean;
}

export interface CouponCartInput {
  subtotal: MinorUnits;
  lines: CouponLine[];
  currency: string;
  channel?: string | null;
  completedOrderCount?: number;
  cartId: string | null;
  customerIdentityId?: string | null;
}

export interface CouponQuote {
  coupon: CouponRecord;
  eligibleAmount: MinorUnits;
  discount: MinorUnits;
}

export interface CouponCartScope {
  cartId: string;
  customerIdentityId?: string | null;
  channel?: string | null;
  currency: string;
}

export interface OrderService {
  createOrderFromCheckout(companyId: string, input: CheckoutOrderInput): Promise<OrderDetail>;
  getOrder(companyId: string, orderId: string): Promise<OrderDetail>;
  getOrderForSession(
    companyId: string,
    scope: { chatbotId: string; sessionId: string; customerIdentityId?: string | null },
    orderId: string,
  ): Promise<OrderDetail>;
  listOrdersForSession(
    companyId: string,
    scope: { chatbotId: string; sessionId: string; customerIdentityId?: string | null },
    page?: { limit?: number; offset?: number },
  ): Promise<OrderRecord[]>;
  transitionOrder(companyId: string, orderId: string, status: string, metadata?: Record<string, unknown>): Promise<OrderDetail>;
  requestReturn(companyId: string, orderId: string, input: ReturnRequestInput): Promise<ReturnDetail>;
  transitionReturn(companyId: string, returnId: string, status: string, metadata?: Record<string, unknown>): Promise<ReturnDetail>;
  recordRefund(companyId: string, returnId: string, amount: number, paymentMetadata?: Record<string, unknown>): Promise<ReturnDetail>;

  createCoupon(companyId: string, input: CouponInput): Promise<CouponRecord>;
  quoteCoupon(
    companyId: string,
    chatbotId: string,
    code: string,
    cart: CouponCartInput,
    options?: { strict?: boolean },
  ): Promise<CouponQuote | null>;
  reserveCoupon(companyId: string, couponId: string, scope: CouponCartScope): Promise<CouponUsageRecord | null>;
  redeemCartCoupons(companyId: string, cartId: string): Promise<number>;
  releaseCartCoupons(companyId: string, cartId: string): Promise<number>;
  expireDueCouponUsages(companyId: string, limit?: number): Promise<number>;
}

function requireObject(value: unknown, name: string): void {
  if (value === null || typeof value !== "object") {
    throw new OrderError(`${name} is required`);
  }
}

function requireUuidLike(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new OrderError(`${name} is required`);
  }
  return value.trim();
}

function requireCurrency(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) {
    throw new OrderError("currency must be a three-letter upper-case ISO code");
  }
  return value;
}

function orderSummary(order: OrderRecord): Record<string, unknown> {
  return { status: order.status, fulfillmentStatus: order.fulfillmentStatus, total: order.total, currency: order.currency };
}

export function createOrderService(options: OrderServiceOptions): OrderService {
  const storage = options.storage;
  const enabled = options.enabled === true;
  const publisher = options.publisher ?? noopOrderEventPublisher;
  const clock = options.now ?? (() => new Date());
  const randomHex = options.randomHex ?? ((bytes: number) => randomBytes(bytes).toString("hex"));
  const ttlMinutes = options.couponReservationTtlMinutes ?? DEFAULT_RESERVATION_TTL_MINUTES;

  function assertEnabled(): void {
    if (!enabled) {
      throw new OrderError("Native orders are disabled for this deployment.", 503);
    }
  }

  function orderNumber(now: Date): string {
    const day = now.toISOString().slice(0, 10).replace(/-/g, "");
    return `EC-${day}-${randomHex(4).toUpperCase()}`;
  }

  function rmaNumber(now: Date): string {
    const day = now.toISOString().slice(0, 10).replace(/-/g, "");
    return `RMA-${day}-${randomHex(4).toUpperCase()}`;
  }

  async function appendEvent(
    companyId: string,
    order: OrderRecord,
    event: Omit<OrderEventInsert, "orderId">,
    store: OrderStorage = storage,
  ): Promise<OrderEventRecord> {
    return store.appendOrderEvent(companyId, { ...event, orderId: order.id });
  }

  async function loadOrder(companyId: string, orderId: string): Promise<OrderRecord> {
    const order = await storage.findOrder(companyId, orderId);
    if (!order) {
      throw new OrderError("Order not found.", 404);
    }
    return order;
  }

  async function loadReturn(companyId: string, returnId: string): Promise<ReturnRecord> {
    const record = await storage.findReturn(companyId, returnId);
    if (!record) {
      throw new OrderError("Return not found.", 404);
    }
    return record;
  }

  /** Locks the return row for the rest of the transaction. Used by recordRefund only. */
  async function lockReturn(store: OrderStorage, companyId: string, returnId: string): Promise<ReturnRecord> {
    const record = await store.findReturnForUpdate(companyId, returnId);
    if (!record) {
      throw new OrderError("Return not found.", 404);
    }
    return record;
  }

  /** Locks the order row for the rest of the transaction. Used by recordRefund only. */
  async function lockOrder(store: OrderStorage, companyId: string, orderId: string): Promise<OrderRecord> {
    const order = await store.findOrderForUpdate(companyId, orderId);
    if (!order) {
      throw new OrderError("Order not found.", 404);
    }
    return order;
  }

  /** M1: true when one of the order's returns carries a refund amount above zero. */
  async function hasRefundRecord(companyId: string, orderId: string): Promise<boolean> {
    const returns = await storage.listReturns(companyId, orderId);
    return returns.some((record) => record.refundedAmount > 0);
  }

  async function detail(companyId: string, order: OrderRecord): Promise<OrderDetail> {
    const items = await storage.listOrderItems(companyId, order.id);
    const events = await storage.listOrderEvents(companyId, order.id);
    const returnRows = await storage.listReturns(companyId, order.id);
    const returns: ReturnDetail[] = [];
    for (const record of returnRows) {
      returns.push({ returnRecord: record, items: await storage.listReturnItems(companyId, record.id) });
    }
    return { order, items, events, returns };
  }

  async function returnDetail(companyId: string, record: ReturnRecord): Promise<ReturnDetail> {
    return { returnRecord: record, items: await storage.listReturnItems(companyId, record.id) };
  }

  return {
    async createOrderFromCheckout(companyId, input) {
      assertEnabled();
      requireCompanyId(companyId);
      requireObject(input, "checkout");
      const checkoutId = requireUuidLike(input.checkoutId, "checkoutId");
      const chatbotId = requireUuidLike(input.chatbotId, "chatbotId");

      const existing = await storage.findOrderByCheckout(companyId, checkoutId);
      if (existing) {
        return detail(companyId, existing);
      }
      if (input.checkoutStatus !== "completed") {
        throw new OrderError("Only a completed checkout can become an order.");
      }
      const currency = requireCurrency(input.currency);
      if (!Array.isArray(input.lines) || input.lines.length === 0) {
        throw new OrderError("An order needs at least one line.");
      }

      const totals = computeOrderTotals(input.lines, assertNonNegativeMinor(input.shippingTotal, "shippingTotal"));
      assertTotalsMatch(totals, input.reportedTotals);

      const now = clock();
      const orderInsert: OrderInsert = {
        orderNumber: orderNumber(now),
        chatbotId,
        cartId: input.cartId ?? null,
        checkoutId,
        paymentIntentId: input.paymentIntentId ?? null,
        customerIdentityId: input.customerIdentityId ?? null,
        conversationId: input.conversationId ?? null,
        sessionId: input.sessionId ?? null,
        source: "internal",
        status: "confirmed",
        fulfillmentStatus: input.fulfillmentStatus ?? "unfulfilled",
        currency,
        subtotal: totals.subtotal,
        discountTotal: totals.discountTotal,
        taxTotal: totals.taxTotal,
        shippingTotal: totals.shippingTotal,
        total: totals.total,
        refundedTotal: 0,
        customerSnapshot: input.customerSnapshot ?? {},
        billingAddress: input.billingAddress ?? {},
        shippingAddress: input.shippingAddress ?? {},
        metadata: input.metadata ?? {},
        placedAt: now,
        confirmedAt: now,
        completedAt: null,
        cancelledAt: null,
        paymentSnapshot: input.paymentSnapshot ?? {},
      };

      const itemInserts: OrderItemInsert[] = input.lines.map((line) => {
        const computed = computeLineTotals(line);
        return {
          productId: line.productId ?? null,
          variantId: line.variantId ?? null,
          sku: line.sku ?? null,
          name: line.name,
          variantName: line.variantName ?? null,
          quantity: line.quantity,
          fulfilledQuantity: 0,
          returnedQuantity: 0,
          listUnitPrice: line.listUnitPrice ?? line.unitPrice,
          unitPrice: line.unitPrice,
          discountTotal: line.discountTotal,
          taxTotal: line.taxTotal,
          lineTotal: computed.lineTotal,
          metadata: line.metadata ?? {},
        };
      });

      const bundle = await storage.createOrder(companyId, orderInsert, itemInserts);
      await appendEvent(companyId, bundle.order, {
        eventType: "order.created",
        actorType: "system",
        actorId: null,
        beforeState: null,
        afterState: orderSummary(bundle.order),
        metadata: {},
      });
      publisher.publish({
        companyId,
        type: "commerce.order.created",
        payload: { orderId: bundle.order.id, orderNumber: bundle.order.orderNumber },
      });
      return detail(companyId, bundle.order);
    },

    async getOrder(companyId, orderId) {
      assertEnabled();
      requireCompanyId(companyId);
      return detail(companyId, await loadOrder(companyId, orderId));
    },

    async getOrderForSession(companyId, scope, orderId) {
      assertEnabled();
      requireCompanyId(companyId);
      const order = await storage.findOrder(companyId, orderId);
      if (!order || !sessionMayRead(order, scope)) {
        throw new OrderError("Order not found.", 404);
      }
      return detail(companyId, order);
    },

    async listOrdersForSession(companyId, scope, page = {}) {
      assertEnabled();
      requireCompanyId(companyId);
      const limit = Math.min(Math.max(page.limit ?? 20, 1), 100);
      const offset = Math.max(page.offset ?? 0, 0);
      return storage.listOrdersForSession(
        companyId,
        { chatbotId: scope.chatbotId, sessionId: scope.sessionId, customerIdentityId: scope.customerIdentityId ?? null },
        limit,
        offset,
      );
    },

    async transitionOrder(companyId, orderId, status, metadata = {}) {
      assertEnabled();
      requireCompanyId(companyId);
      const order = await loadOrder(companyId, orderId);
      if (order.status === status) {
        return detail(companyId, order);
      }
      const next: OrderStatus = assertOrderTransition(order.status, status);
      // M1: refunded needs a refund record on one of the order's returns. Checked here, so the rule does not
      // depend on the storage. The storage write path repeats the check as a second line of defence.
      if (next === "refunded" && !(await hasRefundRecord(companyId, order.id))) {
        throw new OrderError(REFUND_RECORD_REQUIRED);
      }
      const before = orderSummary(order);
      const patch = {
        status: next,
        completedAt: next === "completed" ? clock() : undefined,
        cancelledAt: next === "cancelled" ? clock() : undefined,
      };
      const updated = await storage.updateOrder(companyId, order.id, patch);
      if (!updated) {
        throw new OrderError("Order not found.", 404);
      }
      await appendEvent(companyId, updated, {
        eventType: "order.status_changed",
        actorType: "system",
        actorId: null,
        beforeState: before,
        afterState: orderSummary(updated),
        metadata,
      });
      return detail(companyId, updated);
    },

    async requestReturn(companyId, orderId, input) {
      assertEnabled();
      requireCompanyId(companyId);
      const order = await loadOrder(companyId, orderId);

      // Group duplicate order items. Blank ids are skipped, as in NativeOrderRuntime::requestReturn.
      const grouped = new Map<string, { quantity: number; request: ReturnItemRequest }>();
      for (const requested of input.items ?? []) {
        const orderItemId = typeof requested.orderItemId === "string" ? requested.orderItemId.trim() : "";
        if (orderItemId === "") {
          continue;
        }
        const quantity = assertPositiveQuantity(requested.quantity, "quantity");
        const existing = grouped.get(orderItemId);
        if (existing) {
          existing.quantity += quantity;
        } else {
          grouped.set(orderItemId, { quantity, request: requested });
        }
      }

      if (!RETURNABLE_ORDER_STATUSES.includes(order.status)) {
        throw new OrderError("Returns can only be requested after fulfilment.");
      }
      if (!RETURN_RESOLUTIONS.includes(input.resolution as ReturnResolution)) {
        throw new OrderError("Unsupported return resolution.");
      }
      if (grouped.size === 0) {
        throw new OrderError("At least one return item is required.");
      }

      // Validate every line before writing anything, so a failure leaves no partial return.
      let requestedAmount = 0;
      const validated: { item: OrderItemRecord; quantity: number; amount: MinorUnits; request: ReturnItemRequest }[] = [];
      for (const [orderItemId, entry] of grouped) {
        const item = await storage.findOrderItem(companyId, orderItemId);
        if (!item || item.orderId !== order.id) {
          throw new OrderError("A requested order item was not found.");
        }
        const available = item.quantity - item.returnedQuantity;
        if (entry.quantity > available) {
          throw new OrderError("Return quantity exceeds the remaining returnable quantity.");
        }
        const amount = prorateHalfUp(item.lineTotal, entry.quantity, Math.max(1, item.quantity));
        requestedAmount = addMinor(requestedAmount, amount);
        validated.push({ item, quantity: entry.quantity, amount, request: entry.request });
      }

      const now = clock();
      const itemInserts: ReturnItemInsert[] = validated.map((row) => ({
        orderItemId: row.item.id,
        quantity: row.quantity,
        reasonCode: row.request.reasonCode ?? null,
        condition: row.request.condition ?? null,
        amount: row.amount,
        metadata: row.request.metadata ?? {},
      }));
      const bundle = await storage.createReturn(
        companyId,
        {
          rmaNumber: rmaNumber(now),
          orderId: order.id,
          customerIdentityId: input.customerIdentityId ?? order.customerIdentityId,
          status: "requested",
          reasonCode: null,
          reason: input.reason ?? null,
          requestedResolution: input.resolution as ReturnResolution,
          requestedAmount,
          refundedAmount: 0,
          currency: order.currency,
          quantitiesReleased: false,
          paymentRefunds: [],
          metadata: {},
          approvedAt: null,
          receivedAt: null,
          resolvedAt: null,
          cancelledAt: null,
        },
        itemInserts,
      );
      for (const row of validated) {
        await storage.updateOrderItem(companyId, row.item.id, { returnedQuantity: row.item.returnedQuantity + row.quantity });
      }
      await appendEvent(companyId, order, {
        eventType: "return.requested",
        actorType: "system",
        actorId: null,
        beforeState: null,
        afterState: {
          returnId: bundle.returnRecord.id,
          rmaNumber: bundle.returnRecord.rmaNumber,
          requestedAmount,
        },
        metadata: {},
      });
      publisher.publish({
        companyId,
        type: "commerce.return.requested",
        payload: { returnId: bundle.returnRecord.id, orderId: order.id },
      });
      return returnDetail(companyId, bundle.returnRecord);
    },

    async transitionReturn(companyId, returnId, status, metadata = {}) {
      assertEnabled();
      requireCompanyId(companyId);
      const current = await loadReturn(companyId, returnId);
      if (status === "refunded") {
        throw new OrderError("Use the refund endpoint so payment and order records remain consistent.");
      }
      const next: ReturnStatus = assertReturnTransition(current.status, status);

      let quantitiesReleased = current.quantitiesReleased;
      if ((next === "rejected" || next === "cancelled") && !quantitiesReleased) {
        for (const returnItem of await storage.listReturnItems(companyId, current.id)) {
          const orderItem = await storage.findOrderItem(companyId, returnItem.orderItemId);
          if (orderItem) {
            await storage.updateOrderItem(companyId, orderItem.id, {
              returnedQuantity: Math.max(0, orderItem.returnedQuantity - returnItem.quantity),
            });
          }
        }
        quantitiesReleased = true;
      }

      const now = clock();
      const updated = await storage.updateReturn(companyId, current.id, {
        status: next,
        quantitiesReleased,
        metadata: { ...current.metadata, ...metadata },
        approvedAt: next === "approved" ? now : undefined,
        receivedAt: next === "received" ? now : undefined,
        resolvedAt: next === "exchanged" || next === "rejected" ? now : undefined,
        cancelledAt: next === "cancelled" ? now : undefined,
      });
      if (!updated) {
        throw new OrderError("Return not found.", 404);
      }
      await appendEvent(companyId, await loadOrder(companyId, current.orderId), {
        eventType: "return.status_changed",
        actorType: "system",
        actorId: null,
        beforeState: null,
        afterState: { returnId: updated.id, status: next },
        metadata: {},
      });
      return returnDetail(companyId, updated);
    },

    async recordRefund(companyId, returnId, amount, paymentMetadata = {}) {
      assertEnabled();
      requireCompanyId(companyId);
      // One storage transaction. The return row is locked first, then the order row. Every refund takes the
      // locks in this order, so two refunds cannot deadlock, and the second waits until the first commits.
      const { updatedReturn } = await storage.transaction(companyId, async (tx) => {
        const current = await lockReturn(tx, companyId, returnId);
        if (!REFUNDABLE_RETURN_STATUSES.includes(current.status)) {
          throw new OrderError("The return must be approved or received before refunding.");
        }
        const refund = assertPositiveQuantity(amount, "amount");
        const outstanding = current.requestedAmount - current.refundedAmount;
        if (refund > outstanding) {
          throw new OrderError("Refund amount exceeds the outstanding requested return amount.");
        }
        const order = await lockOrder(tx, companyId, current.orderId);

        // The refunded total is checked against the order total on the locked row, inside the transaction.
        const newReturnRefunded = addMinor(current.refundedAmount, refund);
        const newOrderRefunded = addMinor(order.refundedTotal, refund);
        if (newOrderRefunded > order.total) {
          // Not in the PHP runtime. Fails closed so refunds can never exceed what the order collected.
          throw new OrderError("Refund would exceed the order total.");
        }
        const returnComplete = newReturnRefunded >= current.requestedAmount;
        const nextOrderStatus: OrderStatus = newOrderRefunded >= order.total ? "refunded" : "partially_refunded";
        if (order.status !== nextOrderStatus) {
          try {
            assertOrderTransition(order.status, nextOrderStatus);
          } catch {
            throw new OrderError("The order cannot enter the required refund state.");
          }
        }

        const before = orderSummary(order);
        const refundHistory = [...current.paymentRefunds, paymentMetadata];
        // The return is written before the order, so the storage M1 check sees the refund record.
        const written = await tx.updateReturn(companyId, current.id, {
          refundedAmount: newReturnRefunded,
          status: returnComplete ? "refunded" : current.status,
          resolvedAt: returnComplete ? clock() : undefined,
          paymentRefunds: refundHistory,
        });
        const writtenOrder = await tx.updateOrder(companyId, order.id, { refundedTotal: newOrderRefunded, status: nextOrderStatus });
        if (!written || !writtenOrder) {
          throw new OrderError("Return or order not found.", 404);
        }
        await appendEvent(
          companyId,
          writtenOrder,
          {
            eventType: "return.refunded",
            actorType: "system",
            actorId: null,
            beforeState: before,
            afterState: orderSummary(writtenOrder),
            metadata: { returnId: current.id, amount: refund, ...paymentMetadata },
          },
          tx,
        );
        return { updatedReturn: written };
      });
      return returnDetail(companyId, updatedReturn);
    },

    async createCoupon(companyId, input) {
      assertEnabled();
      requireCompanyId(companyId);
      requireObject(input, "coupon");
      const chatbotId = requireUuidLike(input.chatbotId, "chatbotId");
      const code = normaliseCouponCode(input.code);
      if (code === null) {
        throw new OrderError("coupon code is required");
      }
      if (!COUPON_TYPES.includes(input.type)) {
        throw new OrderError("coupon type must be percentage or fixed");
      }
      const value = assertNonNegativeMinor(input.value, "value");
      if (input.type === "percentage" && value > MAX_COUPON_PERCENT_BASIS_POINTS) {
        throw new OrderError("percentage coupon value must be at most 10000 basis points");
      }
      const appliesTo = input.appliesTo ?? "cart";
      if (!COUPON_APPLIES_TO.includes(appliesTo)) {
        throw new OrderError("appliesTo is not supported");
      }
      const usageLimit = input.usageLimit ?? null;
      const usageLimitPerCustomer = input.usageLimitPerCustomer ?? null;
      if (usageLimit !== null) {
        assertPositiveQuantity(usageLimit, "usageLimit");
      }
      if (usageLimitPerCustomer !== null) {
        assertPositiveQuantity(usageLimitPerCustomer, "usageLimitPerCustomer");
      }
      const currency = input.currency === undefined || input.currency === null ? null : requireCurrency(input.currency);
      return storage.createCoupon(companyId, {
        chatbotId,
        code,
        type: input.type,
        value,
        minimumAmount: assertNonNegativeMinor(input.minimumAmount ?? 0, "minimumAmount"),
        maxDiscountAmount: input.maxDiscountAmount === undefined || input.maxDiscountAmount === null
          ? null
          : assertNonNegativeMinor(input.maxDiscountAmount, "maxDiscountAmount"),
        active: input.active ?? true,
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        currency,
        channels: input.channels ?? [],
        firstOrderOnly: input.firstOrderOnly ?? false,
        usageLimit,
        usageLimitPerCustomer,
        appliesTo,
        targetIds: input.targetIds ?? [],
        stackable: input.stackable ?? true,
      });
    },

    async quoteCoupon(companyId, chatbotId, code, cart, options = {}) {
      assertEnabled();
      requireCompanyId(companyId);
      const strict = options.strict === true;
      const fail = (message: string): null => {
        if (strict) {
          throw new OrderError(message);
        }
        return null;
      };
      const normalised = normaliseCouponCode(code);
      if (normalised === null) {
        return null;
      }
      if (typeof chatbotId !== "string" || chatbotId === "") {
        return fail("A tenant chatbot context is required to validate coupons.");
      }
      const coupon = await storage.findCouponByCode(companyId, chatbotId, normalised);
      if (!coupon || !isCouponInWindow(coupon, clock())) {
        return fail("The coupon is invalid or unavailable.");
      }
      const now = clock();
      const usages = await storage.listCouponUsages(companyId, coupon.id);
      try {
        const eligible = assertCouponApplicable(coupon, usages, {
          subtotal: assertNonNegativeMinor(cart.subtotal, "subtotal"),
          lines: cart.lines,
          currency: cart.currency,
          channel: cart.channel ?? null,
          completedOrderCount: cart.completedOrderCount ?? 0,
          cartId: cart.cartId,
          customerIdentityId: cart.customerIdentityId ?? null,
          now,
        });
        return { coupon, eligibleAmount: eligible, discount: couponDiscount(coupon, eligible) };
      } catch (error) {
        if (error instanceof OrderError && !strict) {
          return null;
        }
        throw error;
      }
    },

    async reserveCoupon(companyId, couponId, scope) {
      assertEnabled();
      requireCompanyId(companyId);
      if (typeof scope.cartId !== "string" || scope.cartId === "") {
        return null;
      }
      const coupon = await storage.findCouponById(companyId, couponId);
      if (!coupon) {
        throw new OrderError("Coupon not found.", 404);
      }
      const now = clock();
      const usages = await storage.listCouponUsages(companyId, coupon.id);
      assertUsageAvailable(coupon, usages, {
        cartId: scope.cartId,
        customerIdentityId: scope.customerIdentityId ?? null,
        now,
      });

      // A cart holds one reserved coupon. Reserving a new one releases the others.
      for (const other of await storage.listCartCouponUsages(companyId, scope.cartId)) {
        if (other.couponId !== coupon.id && other.status === "reserved") {
          await storage.updateCouponUsage(companyId, other.id, { status: "released", releasedAt: now, expiresAt: null });
        }
      }

      const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000);
      const existing = await storage.findCouponUsage(companyId, coupon.id, scope.cartId);
      if (existing?.status === "redeemed") {
        return existing;
      }
      const patch = {
        status: "reserved" as const,
        customerIdentityId: scope.customerIdentityId ?? null,
        reservedAt: existing?.reservedAt ?? now,
        redeemedAt: null,
        releasedAt: null,
        expiresAt,
        channel: scope.channel ?? null,
        currency: scope.currency,
      };
      if (existing) {
        return storage.updateCouponUsage(companyId, existing.id, patch);
      }
      return storage.insertCouponUsage(companyId, {
        couponId: coupon.id,
        cartId: scope.cartId,
        ...patch,
      });
    },

    async redeemCartCoupons(companyId, cartId) {
      assertEnabled();
      requireCompanyId(companyId);
      const now = clock();
      let count = 0;
      for (const usage of await storage.listCartCouponUsages(companyId, cartId)) {
        // Expired reservations are left for the sweep. Redeeming them would bypass the usage limit.
        if (usage.status !== "reserved" || (usage.expiresAt !== null && usage.expiresAt.getTime() <= now.getTime())) {
          continue;
        }
        await storage.updateCouponUsage(companyId, usage.id, { status: "redeemed", redeemedAt: now, expiresAt: null });
        count += 1;
      }
      return count;
    },

    async releaseCartCoupons(companyId, cartId) {
      assertEnabled();
      requireCompanyId(companyId);
      const now = clock();
      let count = 0;
      for (const usage of await storage.listCartCouponUsages(companyId, cartId)) {
        if (usage.status === "reserved") {
          await storage.updateCouponUsage(companyId, usage.id, { status: "released", releasedAt: now, expiresAt: null });
          count += 1;
        }
      }
      return count;
    },

    async expireDueCouponUsages(companyId, limit = 500) {
      assertEnabled();
      requireCompanyId(companyId);
      const now = clock();
      const cap = Math.min(Math.max(limit, 1), MAX_COUPON_RESERVATION_SWEEP);
      const due = (await storage.listReservedCouponUsages(companyId, cap))
        .filter((usage) => usage.expiresAt !== null && usage.expiresAt.getTime() <= now.getTime());
      for (const usage of due) {
        await storage.updateCouponUsage(companyId, usage.id, { status: "expired", releasedAt: now });
      }
      return due.length;
    },
  };
}

function sessionMayRead(
  order: OrderRecord,
  scope: { chatbotId: string; sessionId: string; customerIdentityId?: string | null },
): boolean {
  if (order.chatbotId !== scope.chatbotId) {
    return false;
  }
  const sessionMatch = order.sessionId === scope.sessionId;
  const customerMatch =
    scope.customerIdentityId !== undefined &&
    scope.customerIdentityId !== null &&
    order.customerIdentityId === scope.customerIdentityId;
  return sessionMatch || customerMatch;
}

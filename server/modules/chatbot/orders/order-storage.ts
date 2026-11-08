/**
 * Storage contract for the native orders domain.
 *
 * Every method takes companyId as its first argument and only reads or writes rows that carry it.
 * The service depends on this interface alone. Every method returns a Promise (integration fix 1), so the
 * in-memory store and the Drizzle store (db/orders-storage.ts) both implement it directly.
 *
 * The order event log is append-only. The interface has no update or delete method for events, and
 * the memory store returns frozen copies so callers cannot mutate what is stored.
 */
import { randomUUID } from "node:crypto";
import { requireCompanyId } from "../chatbot-scope.ts";
import { OrderError } from "./order-errors.ts";
import { assertOrderTransition, assertReturnTransition } from "./lifecycle.ts";
import type {
  CouponRecord,
  CouponUsageRecord,
  Insert,
  OrderEventRecord,
  OrderItemRecord,
  OrderRecord,
  ReturnItemRecord,
  ReturnRecord,
} from "./order-types.ts";

export type OrderInsert = Insert<OrderRecord>;
export type OrderItemInsert = Omit<Insert<OrderItemRecord>, "orderId">;
export type ReturnInsert = Insert<ReturnRecord>;
export type ReturnItemInsert = Omit<Insert<ReturnItemRecord>, "returnId">;
export type OrderEventInsert = Omit<Insert<OrderEventRecord>, "sequence">;
export type CouponInsert = Insert<CouponRecord>;
export type CouponUsageInsert = Insert<CouponUsageRecord>;

export interface OrderBundle {
  order: OrderRecord;
  items: OrderItemRecord[];
}

export interface ReturnBundle {
  returnRecord: ReturnRecord;
  items: ReturnItemRecord[];
}

export interface OrderSessionFilter {
  chatbotId: string;
  sessionId: string;
  customerIdentityId: string | null;
}

export interface OrderPatch {
  status?: OrderRecord["status"];
  fulfillmentStatus?: string;
  refundedTotal?: number;
  confirmedAt?: Date | null;
  completedAt?: Date | null;
  cancelledAt?: Date | null;
}

export interface ReturnPatch {
  status?: ReturnRecord["status"];
  refundedAmount?: number;
  quantitiesReleased?: boolean;
  paymentRefunds?: Record<string, unknown>[];
  metadata?: Record<string, unknown>;
  approvedAt?: Date | null;
  receivedAt?: Date | null;
  resolvedAt?: Date | null;
  cancelledAt?: Date | null;
}

export interface CouponUsagePatch {
  status?: CouponUsageRecord["status"];
  redeemedAt?: Date | null;
  releasedAt?: Date | null;
  expiresAt?: Date | null;
  reservedAt?: Date | null;
  customerIdentityId?: string | null;
  channel?: string | null;
  currency?: string | null;
}

export interface OrderStorage {
  /**
   * Runs fn as one unit: every write it makes is kept, or every write is rolled back if fn throws.
   * The Drizzle store maps this to a database transaction. The memory store serialises per company in process.
   * Nested calls on the same memory store would wait on themselves and must not be made.
   */
  transaction<T>(companyId: string, fn: (tx: OrderStorage) => Promise<T>): Promise<T>;
  /** Reads the return row and, on the database, locks it until the transaction ends (SELECT ... FOR UPDATE). */
  findReturnForUpdate(companyId: string, returnId: string): Promise<ReturnRecord | null>;
  /** Reads the order row and, on the database, locks it until the transaction ends (SELECT ... FOR UPDATE). */
  findOrderForUpdate(companyId: string, orderId: string): Promise<OrderRecord | null>;

  createOrder(companyId: string, order: OrderInsert, items: OrderItemInsert[]): Promise<OrderBundle>;
  findOrder(companyId: string, orderId: string): Promise<OrderRecord | null>;
  findOrderByCheckout(companyId: string, checkoutId: string): Promise<OrderRecord | null>;
  listOrdersForSession(companyId: string, filter: OrderSessionFilter, limit: number, offset: number): Promise<OrderRecord[]>;
  updateOrder(companyId: string, orderId: string, patch: OrderPatch): Promise<OrderRecord | null>;
  listOrderItems(companyId: string, orderId: string): Promise<OrderItemRecord[]>;
  findOrderItem(companyId: string, orderItemId: string): Promise<OrderItemRecord | null>;
  updateOrderItem(companyId: string, orderItemId: string, patch: { returnedQuantity: number }): Promise<OrderItemRecord | null>;

  createReturn(companyId: string, returnRecord: ReturnInsert, items: ReturnItemInsert[]): Promise<ReturnBundle>;
  findReturn(companyId: string, returnId: string): Promise<ReturnRecord | null>;
  listReturns(companyId: string, orderId: string): Promise<ReturnRecord[]>;
  listReturnItems(companyId: string, returnId: string): Promise<ReturnItemRecord[]>;
  updateReturn(companyId: string, returnId: string, patch: ReturnPatch): Promise<ReturnRecord | null>;

  appendOrderEvent(companyId: string, event: OrderEventInsert): Promise<OrderEventRecord>;
  listOrderEvents(companyId: string, orderId: string): Promise<OrderEventRecord[]>;

  createCoupon(companyId: string, coupon: CouponInsert): Promise<CouponRecord>;
  findCouponById(companyId: string, couponId: string): Promise<CouponRecord | null>;
  findCouponByCode(companyId: string, chatbotId: string, code: string): Promise<CouponRecord | null>;

  listCouponUsages(companyId: string, couponId: string): Promise<CouponUsageRecord[]>;
  listCartCouponUsages(companyId: string, cartId: string): Promise<CouponUsageRecord[]>;
  findCouponUsage(companyId: string, couponId: string, cartId: string): Promise<CouponUsageRecord | null>;
  insertCouponUsage(companyId: string, usage: CouponUsageInsert): Promise<CouponUsageRecord>;
  updateCouponUsage(companyId: string, usageId: string, patch: CouponUsagePatch): Promise<CouponUsageRecord | null>;
  listReservedCouponUsages(companyId: string, limit: number): Promise<CouponUsageRecord[]>;
}

export interface MemoryOrderStorageOptions {
  now?: () => Date;
}

/** Deep copy with dates kept as Date objects, frozen so callers cannot mutate stored rows. */
function snapshot<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/** Message used when an order is refused the refunded state for lack of a refund record. */
export const REFUND_RECORD_REQUIRED = "An order cannot move to refunded without a refund record.";

export function createMemoryOrderStorage(options: MemoryOrderStorageOptions = {}): OrderStorage {
  const clock = options.now ?? (() => new Date());

  // Outer key is companyId. Every lookup starts there, so rows never cross tenants.
  const orders = new Map<string, Map<string, OrderRecord>>();
  const items = new Map<string, Map<string, OrderItemRecord>>();
  const events = new Map<string, OrderEventRecord[]>();
  const sequences = new Map<string, number>();
  const returns = new Map<string, Map<string, ReturnRecord>>();
  const returnItems = new Map<string, Map<string, ReturnItemRecord>>();
  const coupons = new Map<string, Map<string, CouponRecord>>();
  const usages = new Map<string, Map<string, CouponUsageRecord>>();

  function bucket<T>(store: Map<string, Map<string, T>>, companyId: string): Map<string, T> {
    requireCompanyId(companyId);
    let rows = store.get(companyId);
    if (!rows) {
      rows = new Map<string, T>();
      store.set(companyId, rows);
    }
    return rows;
  }

  function nextSequence(companyId: string): number {
    requireCompanyId(companyId);
    const next = (sequences.get(companyId) ?? 0) + 1;
    sequences.set(companyId, next);
    return next;
  }

  function hasRefundRecord(companyId: string, orderId: string): boolean {
    return [...bucket(returns, companyId).values()].some((row) => row.orderId === orderId && row.refundedAmount > 0);
  }

  function eventLog(companyId: string): OrderEventRecord[] {
    requireCompanyId(companyId);
    let log = events.get(companyId);
    if (!log) {
      log = [];
      events.set(companyId, log);
    }
    return log;
  }

  // Per-company queue for transaction(). Records are replaced, never mutated, and events are copied, so a
  // snapshot of each company's bucket is a full copy for rollback.
  const locks = new Map<string, Promise<void>>();
  const perCompanyStores: Array<Map<string, Map<string, unknown>>> = [orders, items, returns, returnItems, coupons, usages];

  const storage: OrderStorage = {
    async transaction<T>(companyId: string, fn: (tx: OrderStorage) => Promise<T>): Promise<T> {
      const tenant = requireCompanyId(companyId);
      const previous = locks.get(tenant) ?? Promise.resolve();
      let release: () => void = () => undefined;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => current);
      locks.set(tenant, tail);
      await previous;

      const savedBuckets = perCompanyStores.map((store) => ({ store, rows: new Map(store.get(tenant) ?? []) }));
      const savedEvents = [...(events.get(tenant) ?? [])];
      const savedSequence = sequences.get(tenant);
      try {
        return await fn(storage);
      } catch (error) {
        for (const { store, rows } of savedBuckets) store.set(tenant, rows);
        events.set(tenant, savedEvents);
        if (savedSequence === undefined) sequences.delete(tenant);
        else sequences.set(tenant, savedSequence);
        throw error;
      } finally {
        release();
        if (locks.get(tenant) === tail) locks.delete(tenant);
      }
    },

    async findReturnForUpdate(companyId, returnId) {
      return storage.findReturn(companyId, returnId);
    },

    async findOrderForUpdate(companyId, orderId) {
      return storage.findOrder(companyId, orderId);
    },

    async createOrder(companyId, order, orderItems) {
      const orderRows = bucket(orders, companyId);
      const itemRows = bucket(items, companyId);
      const existing = [...orderRows.values()].find((row) => row.checkoutId === order.checkoutId);
      if (existing) {
        throw new OrderError("An order already exists for this checkout.", 409);
      }
      const now = clock();
      const id = randomUUID();
      const record: OrderRecord = { ...order, id, companyId, createdAt: now, updatedAt: now };
      orderRows.set(id, record);
      const created = orderItems.map((item) => {
        const itemRecord: OrderItemRecord = { ...item, id: randomUUID(), companyId, orderId: id, createdAt: now, updatedAt: now };
        itemRows.set(itemRecord.id, itemRecord);
        return itemRecord;
      });
      return snapshot({ order: record, items: created });
    },

    async findOrder(companyId, orderId) {
      return snapshot(bucket(orders, companyId).get(orderId) ?? null);
    },

    async findOrderByCheckout(companyId, checkoutId) {
      const row = [...bucket(orders, companyId).values()].find((order) => order.checkoutId === checkoutId);
      return snapshot(row ?? null);
    },

    async listOrdersForSession(companyId, filter, limit, offset) {
      const rows = [...bucket(orders, companyId).values()]
        .filter(
          (order) =>
            order.chatbotId === filter.chatbotId &&
            (order.sessionId === filter.sessionId ||
              (filter.customerIdentityId !== null && order.customerIdentityId === filter.customerIdentityId)),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return snapshot(rows.slice(offset, offset + limit));
    },

    async updateOrder(companyId, orderId, patch) {
      const row = bucket(orders, companyId).get(orderId);
      if (!row) {
        return null;
      }
      // M1: an order cannot enter refunded without a refund record on one of its returns.
      // Every status write goes through here, so transitionOrder cannot skip the check.
      if (patch.status === "refunded" && row.status !== "refunded" && !hasRefundRecord(companyId, orderId)) {
        throw new OrderError(REFUND_RECORD_REQUIRED);
      }
      const next: OrderRecord = { ...row, ...stripUndefined(patch), updatedAt: clock() };
      bucket(orders, companyId).set(orderId, next);
      return snapshot(next);
    },

    async listOrderItems(companyId, orderId) {
      return snapshot([...bucket(items, companyId).values()].filter((item) => item.orderId === orderId));
    },

    async findOrderItem(companyId, orderItemId) {
      return snapshot(bucket(items, companyId).get(orderItemId) ?? null);
    },

    async updateOrderItem(companyId, orderItemId, patch) {
      const row = bucket(items, companyId).get(orderItemId);
      if (!row) {
        return null;
      }
      const next: OrderItemRecord = { ...row, returnedQuantity: patch.returnedQuantity, updatedAt: clock() };
      bucket(items, companyId).set(orderItemId, next);
      return snapshot(next);
    },

    async createReturn(companyId, returnInsert, returnItemInserts) {
      const returnRows = bucket(returns, companyId);
      const itemRows = bucket(returnItems, companyId);
      const now = clock();
      const id = randomUUID();
      const record: ReturnRecord = { ...returnInsert, id, companyId, createdAt: now, updatedAt: now };
      returnRows.set(id, record);
      const created = returnItemInserts.map((item) => {
        const row: ReturnItemRecord = { ...item, id: randomUUID(), companyId, returnId: id, createdAt: now, updatedAt: now };
        itemRows.set(row.id, row);
        return row;
      });
      return snapshot({ returnRecord: record, items: created });
    },

    async findReturn(companyId, returnId) {
      return snapshot(bucket(returns, companyId).get(returnId) ?? null);
    },

    async listReturns(companyId, orderId) {
      return snapshot([...bucket(returns, companyId).values()].filter((row) => row.orderId === orderId));
    },

    async listReturnItems(companyId, returnId) {
      return snapshot([...bucket(returnItems, companyId).values()].filter((row) => row.returnId === returnId));
    },

    async updateReturn(companyId, returnId, patch) {
      const row = bucket(returns, companyId).get(returnId);
      if (!row) {
        return null;
      }
      const next: ReturnRecord = { ...row, ...stripUndefined(patch), updatedAt: clock() };
      bucket(returns, companyId).set(returnId, next);
      return snapshot(next);
    },

    async appendOrderEvent(companyId, event) {
      const record: OrderEventRecord = {
        ...event,
        id: randomUUID(),
        companyId,
        sequence: nextSequence(companyId),
        createdAt: clock(),
      };
      eventLog(companyId).push(record);
      return snapshot(record);
    },

    async listOrderEvents(companyId, orderId) {
      return snapshot(eventLog(companyId).filter((event) => event.orderId === orderId));
    },

    async createCoupon(companyId, coupon) {
      const rows = bucket(coupons, companyId);
      const duplicate = [...rows.values()].some((row) => row.chatbotId === coupon.chatbotId && row.code === coupon.code);
      if (duplicate) {
        throw new OrderError("A coupon with this code already exists for this chatbot.", 409);
      }
      const now = clock();
      const record: CouponRecord = { ...coupon, id: randomUUID(), companyId, createdAt: now, updatedAt: now };
      rows.set(record.id, record);
      return snapshot(record);
    },

    async findCouponById(companyId, couponId) {
      return snapshot(bucket(coupons, companyId).get(couponId) ?? null);
    },

    async findCouponByCode(companyId, chatbotId, code) {
      const row = [...bucket(coupons, companyId).values()].find((coupon) => coupon.chatbotId === chatbotId && coupon.code === code);
      return snapshot(row ?? null);
    },

    async listCouponUsages(companyId, couponId) {
      return snapshot([...bucket(usages, companyId).values()].filter((row) => row.couponId === couponId));
    },

    async listCartCouponUsages(companyId, cartId) {
      return snapshot([...bucket(usages, companyId).values()].filter((row) => row.cartId === cartId));
    },

    async findCouponUsage(companyId, couponId, cartId) {
      const row = [...bucket(usages, companyId).values()].find((usage) => usage.couponId === couponId && usage.cartId === cartId);
      return snapshot(row ?? null);
    },

    async insertCouponUsage(companyId, usage) {
      const rows = bucket(usages, companyId);
      const duplicate = [...rows.values()].some((row) => row.couponId === usage.couponId && row.cartId === usage.cartId);
      if (duplicate) {
        throw new OrderError("A usage already exists for this coupon and cart.", 409);
      }
      const now = clock();
      const record: CouponUsageRecord = { ...usage, id: randomUUID(), companyId, createdAt: now, updatedAt: now };
      rows.set(record.id, record);
      return snapshot(record);
    },

    async updateCouponUsage(companyId, usageId, patch) {
      const row = bucket(usages, companyId).get(usageId);
      if (!row) {
        return null;
      }
      const next: CouponUsageRecord = { ...row, ...stripUndefined(patch), updatedAt: clock() };
      bucket(usages, companyId).set(usageId, next);
      return snapshot(next);
    },

    async listReservedCouponUsages(companyId, limit) {
      return snapshot(
        [...bucket(usages, companyId).values()]
          .filter((row) => row.status === "reserved" && row.expiresAt !== null)
          .sort((a, b) => (a.expiresAt?.getTime() ?? 0) - (b.expiresAt?.getTime() ?? 0))
          .slice(0, limit),
      );
    },
  };
  return storage;
}

function stripUndefined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/** Event type written for every order status change. Same name the order service already uses. */
export const ORDER_STATUS_EVENT = "order.status_changed";
/** Event type written for every return status change. The event is stored on the return's order. */
export const RETURN_STATUS_EVENT = "return.status_changed";

export interface LifecycleTransitionInput {
  actorType?: string;
  actorId?: string | null;
  metadata?: Record<string, unknown>;
  /** Extra order or return columns written with the status (for example completedAt). */
  patch?: Omit<OrderPatch, "status"> | Omit<ReturnPatch, "status">;
}

export interface OrderTransitionResult {
  order: OrderRecord;
  event: OrderEventRecord;
}

export interface ReturnTransitionResult {
  returnRecord: ReturnRecord;
  event: OrderEventRecord;
}

/**
 * Moves an order to a new status and appends one order-events row with before and after status.
 *
 * Call this inside storage.transaction(). The status write and the event row then commit or roll back together.
 * The helper does not open a transaction itself, because nested memory-store transactions would wait on
 * themselves. The M1 refund guard runs inside updateOrder, so it applies here too.
 * The event stores the status in before_state and after_state (jsonb). The table has no status_before or
 * status_after columns.
 */
export async function writeOrderTransition(
  tx: OrderStorage,
  companyId: string,
  orderId: string,
  to: string,
  input: LifecycleTransitionInput = {},
): Promise<OrderTransitionResult> {
  requireCompanyId(companyId);
  const current = await tx.findOrderForUpdate(companyId, orderId);
  if (!current) {
    throw new OrderError("Order not found.", 404);
  }
  const next = assertOrderTransition(current.status, to);
  const updated = await tx.updateOrder(companyId, orderId, { ...(input.patch ?? {}), status: next } as OrderPatch);
  if (!updated) {
    throw new OrderError("Order not found.", 404);
  }
  const event = await tx.appendOrderEvent(companyId, {
    orderId,
    eventType: ORDER_STATUS_EVENT,
    actorType: input.actorType ?? "system",
    actorId: input.actorId ?? null,
    beforeState: { status: current.status },
    afterState: { status: updated.status },
    metadata: input.metadata ?? {},
  });
  return { order: updated, event };
}

/**
 * Moves a return to a new status and appends one order-events row on the return's order, with the return id
 * and before and after status in before_state and after_state. Same transaction rule as writeOrderTransition.
 * A move to refunded is refused here: it must go through the refund path, which writes the order as well.
 */
export async function writeReturnTransition(
  tx: OrderStorage,
  companyId: string,
  returnId: string,
  to: string,
  input: LifecycleTransitionInput = {},
): Promise<ReturnTransitionResult> {
  requireCompanyId(companyId);
  const current = await tx.findReturnForUpdate(companyId, returnId);
  if (!current) {
    throw new OrderError("Return not found.", 404);
  }
  if (to === "refunded") {
    throw new OrderError("Use the refund endpoint so payment and order records remain consistent.");
  }
  const next = assertReturnTransition(current.status, to);
  const updated = await tx.updateReturn(companyId, returnId, { ...(input.patch ?? {}), status: next } as ReturnPatch);
  if (!updated) {
    throw new OrderError("Return not found.", 404);
  }
  const event = await tx.appendOrderEvent(companyId, {
    orderId: current.orderId,
    eventType: RETURN_STATUS_EVENT,
    actorType: input.actorType ?? "system",
    actorId: input.actorId ?? null,
    beforeState: { returnId: current.id, status: current.status },
    afterState: { returnId: updated.id, status: updated.status },
    metadata: input.metadata ?? {},
  });
  return { returnRecord: updated, event };
}

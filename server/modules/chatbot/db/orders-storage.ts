/**
 * Drizzle implementation of the order storage contract (see ../orders/order-storage.ts).
 *
 * DRAFT. Not wired to a live database. Tests render the queries without connecting (see
 * tests/modules/chatbot-orders-drizzle.test.mjs).
 *
 * Every statement filters by company_id. The methods are async because Drizzle is async. OrderStorage is
 * async too (integration fix 1), so this class implements it directly. The service awaits every call.
 *
 * Refund rule (M1): setting status to refunded succeeds only when a return of the same order has a
 * refunded amount above zero. The check is a single UPDATE with an EXISTS subquery, so it cannot be
 * bypassed by a second statement.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNotNull, or, sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { requireCompanyId } from "../chatbot-scope.ts";
import { OrderError } from "../orders/order-errors.ts";
import { REFUND_RECORD_REQUIRED, type OrderBundle, type OrderInsert, type OrderItemInsert, type OrderPatch, type OrderSessionFilter, type OrderStorage, type ReturnBundle, type ReturnInsert, type ReturnItemInsert, type ReturnPatch, type CouponUsagePatch, type OrderEventInsert, type CouponInsert, type CouponUsageInsert } from "../orders/order-storage.ts";
import type { OrderStatus, ReturnStatus } from "../orders/lifecycle.ts";
import type { CouponRecord, CouponUsageRecord, OrderEventRecord, OrderItemRecord, OrderRecord, ReturnItemRecord, ReturnRecord, ReturnResolution } from "../orders/order-types.ts";
import {
  chatbotCommerceCouponUsages,
  chatbotCommerceCoupons,
  chatbotCommerceOrderEvents,
  chatbotCommerceOrderItems,
  chatbotCommerceOrders,
  chatbotCommerceReturnItems,
  chatbotCommerceReturns,
} from "./orders.ts";

/** Kept for existing imports. OrderStorage is async now, so this is the same type. */
export type AsyncOrderStorage = OrderStorage;

export type ChatbotPgDatabase = PgDatabase<PgQueryResultHKT>;

export interface DrizzleOrderStorageOptions {
  now?: () => Date;
  /** Test seam. Receives each query builder before it runs. Leave unset in production. */
  onQuery?: (query: { getSQL(): SQL }) => void;
}

type OrderRow = typeof chatbotCommerceOrders.$inferSelect;
type OrderItemRow = typeof chatbotCommerceOrderItems.$inferSelect;
type EventRow = typeof chatbotCommerceOrderEvents.$inferSelect;
type ReturnRow = typeof chatbotCommerceReturns.$inferSelect;
type ReturnItemRow = typeof chatbotCommerceReturnItems.$inferSelect;
type CouponRow = typeof chatbotCommerceCoupons.$inferSelect;
type CouponUsageRow = typeof chatbotCommerceCouponUsages.$inferSelect;

function toOrder(row: OrderRow): OrderRecord {
  return {
    ...row,
    status: row.status as OrderStatus,
    customerSnapshot: row.customerSnapshot ?? {},
    billingAddress: row.billingAddress ?? {},
    shippingAddress: row.shippingAddress ?? {},
    paymentSnapshot: row.paymentSnapshot ?? {},
    metadata: row.metadata ?? {},
  };
}

function toOrderItem(row: OrderItemRow): OrderItemRecord {
  return { ...row, metadata: row.metadata ?? {} };
}

function toEvent(row: EventRow): OrderEventRecord {
  return {
    ...row,
    sequence: Number(row.sequence),
    beforeState: row.beforeState ?? null,
    afterState: row.afterState ?? null,
    metadata: row.metadata ?? {},
  };
}

function toReturn(row: ReturnRow): ReturnRecord {
  return {
    ...row,
    status: row.status as ReturnStatus,
    requestedResolution: row.requestedResolution as ReturnResolution,
    paymentRefunds: row.paymentRefunds ?? [],
    metadata: row.metadata ?? {},
  };
}

function toReturnItem(row: ReturnItemRow): ReturnItemRecord {
  return { ...row, metadata: row.metadata ?? {} };
}

function toCoupon(row: CouponRow): CouponRecord {
  return {
    ...row,
    type: row.type as CouponRecord["type"],
    appliesTo: row.appliesTo as CouponRecord["appliesTo"],
    channels: row.channels ?? [],
    targetIds: row.targetIds ?? [],
  };
}

function toCouponUsage(row: CouponUsageRow): CouponUsageRecord {
  return { ...row, status: row.status as CouponUsageRecord["status"] };
}

function stripUndefined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/** SQL predicate: at least one return of this order in this company has a refunded amount above zero. */
function refundRecordExists(scope: string, orderId: string): SQL {
  return sql`exists (select 1 from ${chatbotCommerceReturns} where ${chatbotCommerceReturns.companyId} = ${scope} and ${chatbotCommerceReturns.orderId} = ${orderId} and ${chatbotCommerceReturns.refundedAmount} > 0)`;
}

export class DrizzleOrderStorage implements OrderStorage {
  private readonly clock: () => Date;

  constructor(
    private readonly db: ChatbotPgDatabase,
    private readonly options: DrizzleOrderStorageOptions = {},
  ) {
    this.clock = options.now ?? (() => new Date());
  }

  /** Passes a query builder through the test hook and returns it unchanged, so the caller can await it. */
  private q<T extends { getSQL(): SQL }>(query: T): T {
    this.options.onQuery?.(query);
    return query;
  }

  async createOrder(companyId: string, order: OrderInsert, items: OrderItemInsert[]): Promise<OrderBundle> {
    const scope = requireCompanyId(companyId);
    const now = this.clock();
    const id = randomUUID();
    return this.db.transaction(async (tx) => {
      const [inserted] = await this.q(
        tx
          .insert(chatbotCommerceOrders)
          .values({ ...order, id, companyId: scope, createdAt: now, updatedAt: now })
          .onConflictDoNothing({ target: [chatbotCommerceOrders.companyId, chatbotCommerceOrders.checkoutId] })
          .returning(),
      );
      if (!inserted) {
        throw new OrderError("An order already exists for this checkout.", 409);
      }
      const itemRows =
        items.length > 0
          ? await this.q(
              tx
                .insert(chatbotCommerceOrderItems)
                .values(items.map((item) => ({ ...item, id: randomUUID(), companyId: scope, orderId: id, createdAt: now, updatedAt: now })))
                .returning(),
            )
          : [];
      return { order: toOrder(inserted), items: itemRows.map(toOrderItem) };
    });
  }

  /** One database transaction. The callback gets a store bound to the transaction, so every write inside it commits or rolls back together. */
  async transaction<T>(companyId: string, fn: (tx: OrderStorage) => Promise<T>): Promise<T> {
    requireCompanyId(companyId);
    return this.db.transaction((tx) => fn(new DrizzleOrderStorage(tx, this.options)));
  }

  /** SELECT ... FOR UPDATE on the return row. The lock lasts until the surrounding transaction ends. */
  async findReturnForUpdate(companyId: string, returnId: string): Promise<ReturnRecord | null> {
    const scope = requireCompanyId(companyId);
    const [row] = await this.q(
      this.db
        .select()
        .from(chatbotCommerceReturns)
        .where(and(eq(chatbotCommerceReturns.companyId, scope), eq(chatbotCommerceReturns.id, returnId)))
        .limit(1)
        .for("update"),
    );
    return row ? toReturn(row) : null;
  }

  /** SELECT ... FOR UPDATE on the order row. The lock lasts until the surrounding transaction ends. */
  async findOrderForUpdate(companyId: string, orderId: string): Promise<OrderRecord | null> {
    const scope = requireCompanyId(companyId);
    const [row] = await this.q(
      this.db
        .select()
        .from(chatbotCommerceOrders)
        .where(and(eq(chatbotCommerceOrders.companyId, scope), eq(chatbotCommerceOrders.id, orderId)))
        .limit(1)
        .for("update"),
    );
    return row ? toOrder(row) : null;
  }

  async findOrder(companyId: string, orderId: string): Promise<OrderRecord | null> {
    const scope = requireCompanyId(companyId);
    const [row] = await this.q(
      this.db
        .select()
        .from(chatbotCommerceOrders)
        .where(and(eq(chatbotCommerceOrders.companyId, scope), eq(chatbotCommerceOrders.id, orderId)))
        .limit(1),
    );
    return row ? toOrder(row) : null;
  }

  async findOrderByCheckout(companyId: string, checkoutId: string): Promise<OrderRecord | null> {
    const scope = requireCompanyId(companyId);
    const [row] = await this.q(
      this.db
        .select()
        .from(chatbotCommerceOrders)
        .where(and(eq(chatbotCommerceOrders.companyId, scope), eq(chatbotCommerceOrders.checkoutId, checkoutId)))
        .limit(1),
    );
    return row ? toOrder(row) : null;
  }

  async listOrdersForSession(companyId: string, filter: OrderSessionFilter, limit: number, offset: number): Promise<OrderRecord[]> {
    const scope = requireCompanyId(companyId);
    const sessionMatch = eq(chatbotCommerceOrders.sessionId, filter.sessionId);
    const owner =
      filter.customerIdentityId !== null
        ? or(sessionMatch, eq(chatbotCommerceOrders.customerIdentityId, filter.customerIdentityId))
        : sessionMatch;
    const rows = await this.q(
      this.db
        .select()
        .from(chatbotCommerceOrders)
        .where(and(eq(chatbotCommerceOrders.companyId, scope), eq(chatbotCommerceOrders.chatbotId, filter.chatbotId), owner))
        .orderBy(desc(chatbotCommerceOrders.createdAt), desc(chatbotCommerceOrders.id))
        .limit(limit)
        .offset(offset),
    );
    return rows.map(toOrder);
  }

  async updateOrder(companyId: string, orderId: string, patch: OrderPatch): Promise<OrderRecord | null> {
    const scope = requireCompanyId(companyId);
    const values = { ...stripUndefined(patch), updatedAt: this.clock() };
    const scoped = and(eq(chatbotCommerceOrders.companyId, scope), eq(chatbotCommerceOrders.id, orderId));
    // M1: a move to refunded needs a refund record. An order already refunded keeps its status and passes.
    const guard =
      patch.status === "refunded"
        ? or(eq(chatbotCommerceOrders.status, "refunded"), refundRecordExists(scope, orderId))
        : undefined;
    const rows = await this.q(
      this.db
        .update(chatbotCommerceOrders)
        .set(values)
        .where(guard ? and(scoped, guard) : scoped)
        .returning(),
    );
    if (rows[0]) return toOrder(rows[0]);
    if (guard === undefined) return null;
    // No row changed. Either the order is missing, or the refund record is missing.
    const exists = await this.findOrder(scope, orderId);
    if (!exists) return null;
    throw new OrderError(REFUND_RECORD_REQUIRED);
  }

  async listOrderItems(companyId: string, orderId: string): Promise<OrderItemRecord[]> {
    const scope = requireCompanyId(companyId);
    const rows = await this.q(
      this.db
        .select()
        .from(chatbotCommerceOrderItems)
        .where(and(eq(chatbotCommerceOrderItems.companyId, scope), eq(chatbotCommerceOrderItems.orderId, orderId)))
        .orderBy(asc(chatbotCommerceOrderItems.createdAt), asc(chatbotCommerceOrderItems.id)),
    );
    return rows.map(toOrderItem);
  }

  async findOrderItem(companyId: string, orderItemId: string): Promise<OrderItemRecord | null> {
    const scope = requireCompanyId(companyId);
    const [row] = await this.q(
      this.db
        .select()
        .from(chatbotCommerceOrderItems)
        .where(and(eq(chatbotCommerceOrderItems.companyId, scope), eq(chatbotCommerceOrderItems.id, orderItemId)))
        .limit(1),
    );
    return row ? toOrderItem(row) : null;
  }

  async updateOrderItem(companyId: string, orderItemId: string, patch: { returnedQuantity: number }): Promise<OrderItemRecord | null> {
    const scope = requireCompanyId(companyId);
    const [row] = await this.q(
      this.db
        .update(chatbotCommerceOrderItems)
        .set({ returnedQuantity: patch.returnedQuantity, updatedAt: this.clock() })
        .where(and(eq(chatbotCommerceOrderItems.companyId, scope), eq(chatbotCommerceOrderItems.id, orderItemId)))
        .returning(),
    );
    return row ? toOrderItem(row) : null;
  }

  async createReturn(companyId: string, returnInsert: ReturnInsert, itemInserts: ReturnItemInsert[]): Promise<ReturnBundle> {
    const scope = requireCompanyId(companyId);
    const now = this.clock();
    const id = randomUUID();
    return this.db.transaction(async (tx) => {
      const [inserted] = await this.q(
        tx
          .insert(chatbotCommerceReturns)
          .values({ ...returnInsert, id, companyId: scope, createdAt: now, updatedAt: now })
          .returning(),
      );
      const itemRows =
        itemInserts.length > 0
          ? await this.q(
              tx
                .insert(chatbotCommerceReturnItems)
                .values(itemInserts.map((item) => ({ ...item, id: randomUUID(), companyId: scope, returnId: id, createdAt: now, updatedAt: now })))
                .returning(),
            )
          : [];
      return { returnRecord: toReturn(inserted), items: itemRows.map(toReturnItem) };
    });
  }

  async findReturn(companyId: string, returnId: string): Promise<ReturnRecord | null> {
    const scope = requireCompanyId(companyId);
    const [row] = await this.q(
      this.db
        .select()
        .from(chatbotCommerceReturns)
        .where(and(eq(chatbotCommerceReturns.companyId, scope), eq(chatbotCommerceReturns.id, returnId)))
        .limit(1),
    );
    return row ? toReturn(row) : null;
  }

  async listReturns(companyId: string, orderId: string): Promise<ReturnRecord[]> {
    const scope = requireCompanyId(companyId);
    const rows = await this.q(
      this.db
        .select()
        .from(chatbotCommerceReturns)
        .where(and(eq(chatbotCommerceReturns.companyId, scope), eq(chatbotCommerceReturns.orderId, orderId)))
        .orderBy(asc(chatbotCommerceReturns.createdAt), asc(chatbotCommerceReturns.id)),
    );
    return rows.map(toReturn);
  }

  async listReturnItems(companyId: string, returnId: string): Promise<ReturnItemRecord[]> {
    const scope = requireCompanyId(companyId);
    const rows = await this.q(
      this.db
        .select()
        .from(chatbotCommerceReturnItems)
        .where(and(eq(chatbotCommerceReturnItems.companyId, scope), eq(chatbotCommerceReturnItems.returnId, returnId)))
        .orderBy(asc(chatbotCommerceReturnItems.createdAt), asc(chatbotCommerceReturnItems.id)),
    );
    return rows.map(toReturnItem);
  }

  async updateReturn(companyId: string, returnId: string, patch: ReturnPatch): Promise<ReturnRecord | null> {
    const scope = requireCompanyId(companyId);
    const [row] = await this.q(
      this.db
        .update(chatbotCommerceReturns)
        .set({ ...stripUndefined(patch), updatedAt: this.clock() })
        .where(and(eq(chatbotCommerceReturns.companyId, scope), eq(chatbotCommerceReturns.id, returnId)))
        .returning(),
    );
    return row ? toReturn(row) : null;
  }

  // The event log is append-only. This class has no update or delete for events, and tests check that.
  async appendOrderEvent(companyId: string, event: OrderEventInsert): Promise<OrderEventRecord> {
    const scope = requireCompanyId(companyId);
    // Sequence is computed inside the INSERT, and the unique (company_id, sequence) index rejects a race.
    const nextSequence = sql`(select coalesce(max(${chatbotCommerceOrderEvents.sequence}), 0) + 1 from ${chatbotCommerceOrderEvents} where ${chatbotCommerceOrderEvents.companyId} = ${scope})`;
    const [row] = await this.q(
      this.db
        .insert(chatbotCommerceOrderEvents)
        .values({
          id: randomUUID(),
          companyId: scope,
          sequence: nextSequence,
          orderId: event.orderId,
          eventType: event.eventType,
          actorType: event.actorType,
          actorId: event.actorId,
          beforeState: event.beforeState,
          afterState: event.afterState,
          metadata: event.metadata,
          createdAt: this.clock(),
        })
        .returning(),
    );
    return toEvent(row);
  }

  async listOrderEvents(companyId: string, orderId: string): Promise<OrderEventRecord[]> {
    const scope = requireCompanyId(companyId);
    const rows = await this.q(
      this.db
        .select()
        .from(chatbotCommerceOrderEvents)
        .where(and(eq(chatbotCommerceOrderEvents.companyId, scope), eq(chatbotCommerceOrderEvents.orderId, orderId)))
        .orderBy(asc(chatbotCommerceOrderEvents.sequence)),
    );
    return rows.map(toEvent);
  }

  async createCoupon(companyId: string, coupon: CouponInsert): Promise<CouponRecord> {
    const scope = requireCompanyId(companyId);
    const now = this.clock();
    const [row] = await this.q(
      this.db
        .insert(chatbotCommerceCoupons)
        .values({ ...coupon, id: randomUUID(), companyId: scope, createdAt: now, updatedAt: now })
        .onConflictDoNothing({
          target: [chatbotCommerceCoupons.companyId, chatbotCommerceCoupons.chatbotId, chatbotCommerceCoupons.code],
        })
        .returning(),
    );
    if (!row) {
      throw new OrderError("A coupon with this code already exists for this chatbot.", 409);
    }
    return toCoupon(row);
  }

  async findCouponById(companyId: string, couponId: string): Promise<CouponRecord | null> {
    const scope = requireCompanyId(companyId);
    const [row] = await this.q(
      this.db
        .select()
        .from(chatbotCommerceCoupons)
        .where(and(eq(chatbotCommerceCoupons.companyId, scope), eq(chatbotCommerceCoupons.id, couponId)))
        .limit(1),
    );
    return row ? toCoupon(row) : null;
  }

  async findCouponByCode(companyId: string, chatbotId: string, code: string): Promise<CouponRecord | null> {
    const scope = requireCompanyId(companyId);
    const [row] = await this.q(
      this.db
        .select()
        .from(chatbotCommerceCoupons)
        .where(
          and(
            eq(chatbotCommerceCoupons.companyId, scope),
            eq(chatbotCommerceCoupons.chatbotId, chatbotId),
            eq(chatbotCommerceCoupons.code, code),
          ),
        )
        .limit(1),
    );
    return row ? toCoupon(row) : null;
  }

  async listCouponUsages(companyId: string, couponId: string): Promise<CouponUsageRecord[]> {
    const scope = requireCompanyId(companyId);
    const rows = await this.q(
      this.db
        .select()
        .from(chatbotCommerceCouponUsages)
        .where(and(eq(chatbotCommerceCouponUsages.companyId, scope), eq(chatbotCommerceCouponUsages.couponId, couponId))),
    );
    return rows.map(toCouponUsage);
  }

  async listCartCouponUsages(companyId: string, cartId: string): Promise<CouponUsageRecord[]> {
    const scope = requireCompanyId(companyId);
    const rows = await this.q(
      this.db
        .select()
        .from(chatbotCommerceCouponUsages)
        .where(and(eq(chatbotCommerceCouponUsages.companyId, scope), eq(chatbotCommerceCouponUsages.cartId, cartId))),
    );
    return rows.map(toCouponUsage);
  }

  async findCouponUsage(companyId: string, couponId: string, cartId: string): Promise<CouponUsageRecord | null> {
    const scope = requireCompanyId(companyId);
    const [row] = await this.q(
      this.db
        .select()
        .from(chatbotCommerceCouponUsages)
        .where(
          and(
            eq(chatbotCommerceCouponUsages.companyId, scope),
            eq(chatbotCommerceCouponUsages.couponId, couponId),
            eq(chatbotCommerceCouponUsages.cartId, cartId),
          ),
        )
        .limit(1),
    );
    return row ? toCouponUsage(row) : null;
  }

  async insertCouponUsage(companyId: string, usage: CouponUsageInsert): Promise<CouponUsageRecord> {
    const scope = requireCompanyId(companyId);
    const now = this.clock();
    const [row] = await this.q(
      this.db
        .insert(chatbotCommerceCouponUsages)
        .values({ ...usage, id: randomUUID(), companyId: scope, createdAt: now, updatedAt: now })
        .onConflictDoNothing({
          target: [chatbotCommerceCouponUsages.companyId, chatbotCommerceCouponUsages.couponId, chatbotCommerceCouponUsages.cartId],
        })
        .returning(),
    );
    if (!row) {
      throw new OrderError("A usage already exists for this coupon and cart.", 409);
    }
    return toCouponUsage(row);
  }

  async updateCouponUsage(companyId: string, usageId: string, patch: CouponUsagePatch): Promise<CouponUsageRecord | null> {
    const scope = requireCompanyId(companyId);
    const [row] = await this.q(
      this.db
        .update(chatbotCommerceCouponUsages)
        .set({ ...stripUndefined(patch), updatedAt: this.clock() })
        .where(and(eq(chatbotCommerceCouponUsages.companyId, scope), eq(chatbotCommerceCouponUsages.id, usageId)))
        .returning(),
    );
    return row ? toCouponUsage(row) : null;
  }

  async listReservedCouponUsages(companyId: string, limit: number): Promise<CouponUsageRecord[]> {
    const scope = requireCompanyId(companyId);
    const rows = await this.q(
      this.db
        .select()
        .from(chatbotCommerceCouponUsages)
        .where(
          and(
            eq(chatbotCommerceCouponUsages.companyId, scope),
            eq(chatbotCommerceCouponUsages.status, "reserved"),
            isNotNull(chatbotCommerceCouponUsages.expiresAt),
          ),
        )
        .orderBy(asc(chatbotCommerceCouponUsages.expiresAt))
        .limit(limit),
    );
    return rows.map(toCouponUsage);
  }
}

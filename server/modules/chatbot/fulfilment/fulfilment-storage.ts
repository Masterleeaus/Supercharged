/**
 * Storage contract for the fulfilment slice.
 *
 * Every method takes companyId as its first argument and only reads or writes rows that carry it.
 * Services call requireCompanyId() before any storage call, so a missing tenant fails closed.
 *
 * transaction() runs a callback with exclusive access to one company's rows. If the callback throws,
 * every write it made is rolled back. The Drizzle implementation maps this to a database transaction
 * with SELECT ... FOR UPDATE on the stock row. The in-memory implementation below snapshots the
 * company's rows and restores them on failure.
 *
 * Locking differs by implementation. createMemoryFulfilmentStorage() serialises per company in
 * process only. DrizzleFulfilmentStorage relies on row locks inside transaction(), so it holds
 * across processes. See DECISIONS.md, "Drizzle".
 */
import { and, asc, eq, inArray, isNull, lte } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { ChatbotError, requireCompanyId } from "../chatbot-scope.ts";
import {
  chatbotFulfilmentLocations,
  chatbotFulfilmentOrderLines,
  chatbotFulfilmentOrders,
  chatbotFulfilmentItems,
  chatbotFulfilments,
  chatbotInventoryAdjustments,
  chatbotInventoryReservations,
  chatbotInventoryStock,
} from "../db/fulfilment.ts";
import type {
  FulfilmentItemRecord,
  OrderLine,
  FulfilmentStatus,
  FulfilmentMethod,
} from "./types.ts";
import type {
  AdjustmentRecord,
  FulfilmentRecord,
  Id,
  LocationRecord,
  OrderRecord,
  ReservationRecord,
  StockRecord,
} from "./types.ts";

export interface FulfilmentStorage {
  /** Runs fn with exclusive access to this company's rows. Rolls back all writes if fn throws. */
  transaction<T>(companyId: Id, fn: (tx: FulfilmentStorage) => Promise<T>): Promise<T>;

  getLocation(companyId: Id, locationId: Id): Promise<LocationRecord | null>;
  saveLocation(companyId: Id, record: LocationRecord): Promise<void>;

  getStock(companyId: Id, variantId: Id, locationId: Id | null): Promise<StockRecord | null>;
  saveStock(companyId: Id, record: StockRecord): Promise<void>;

  getReservation(companyId: Id, reservationId: Id): Promise<ReservationRecord | null>;
  findReservationByKey(companyId: Id, idempotencyKey: string): Promise<ReservationRecord | null>;
  insertReservation(companyId: Id, record: ReservationRecord): Promise<void>;
  saveReservation(companyId: Id, record: ReservationRecord): Promise<void>;
  /** Active reservations for one stock row, across all holders. */
  listActiveReservations(companyId: Id, variantId: Id, locationId: Id | null): Promise<ReservationRecord[]>;
  /** Active reservations whose expiry is at or before `at`, oldest first. */
  listDueReservations(companyId: Id, at: Date, limit: number): Promise<ReservationRecord[]>;

  findAdjustmentByKey(companyId: Id, idempotencyKey: string): Promise<AdjustmentRecord | null>;
  insertAdjustment(companyId: Id, record: AdjustmentRecord): Promise<void>;

  getOrder(companyId: Id, orderId: Id): Promise<OrderRecord | null>;
  saveOrder(companyId: Id, record: OrderRecord): Promise<void>;

  getFulfilment(companyId: Id, fulfilmentId: Id): Promise<FulfilmentRecord | null>;
  findFulfilmentByKey(companyId: Id, idempotencyKey: string): Promise<FulfilmentRecord | null>;
  insertFulfilment(companyId: Id, record: FulfilmentRecord): Promise<void>;
  saveFulfilment(companyId: Id, record: FulfilmentRecord): Promise<void>;
  listFulfilmentsForOrder(companyId: Id, orderId: Id): Promise<FulfilmentRecord[]>;
}

interface CompanyRows {
  locations: Map<Id, LocationRecord>;
  stock: Map<string, StockRecord>;
  reservations: Map<Id, ReservationRecord>;
  adjustments: Map<Id, AdjustmentRecord>;
  orders: Map<Id, OrderRecord>;
  fulfilments: Map<Id, FulfilmentRecord>;
}

const emptyRows = (): CompanyRows => ({
  locations: new Map(),
  stock: new Map(),
  reservations: new Map(),
  adjustments: new Map(),
  orders: new Map(),
  fulfilments: new Map(),
});

const stockKey = (variantId: Id, locationId: Id | null): string => `${variantId}|${locationId ?? "*"}`;

const copy = <T>(value: T): T => structuredClone(value);

/** Test and development storage. Same contract as the Drizzle implementation, no database. */
export function createMemoryFulfilmentStorage(): FulfilmentStorage {
  // Outer key is companyId. Every lookup starts there, so rows are isolated by tenant.
  const buckets = new Map<Id, CompanyRows>();
  const locks = new Map<Id, Promise<void>>();

  const rows = (companyId: Id): CompanyRows => {
    let bucket = buckets.get(companyId);
    if (!bucket) {
      bucket = emptyRows();
      buckets.set(companyId, bucket);
    }
    return bucket;
  };

  const storage: FulfilmentStorage = {
    async transaction<T>(companyId: Id, fn: (tx: FulfilmentStorage) => Promise<T>): Promise<T> {
      const scope = requireCompanyId(companyId);
      const previous = locks.get(scope) ?? Promise.resolve();
      let release: () => void = () => undefined;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      locks.set(scope, previous.then(() => current));
      await previous;

      const snapshot = copy(rows(scope));
      try {
        return await fn(storage);
      } catch (error) {
        buckets.set(scope, snapshot);
        throw error;
      } finally {
        release();
      }
    },

    async getLocation(companyId, locationId) {
      const record = rows(requireCompanyId(companyId)).locations.get(locationId);
      return record ? copy(record) : null;
    },
    async saveLocation(companyId, record) {
      rows(requireCompanyId(companyId)).locations.set(record.id, copy({ ...record, companyId: requireCompanyId(companyId) }));
    },

    async getStock(companyId, variantId, locationId) {
      const record = rows(requireCompanyId(companyId)).stock.get(stockKey(variantId, locationId));
      return record ? copy(record) : null;
    },
    async saveStock(companyId, record) {
      const scope = requireCompanyId(companyId);
      rows(scope).stock.set(stockKey(record.variantId, record.locationId), copy({ ...record, companyId: scope }));
    },

    async getReservation(companyId, reservationId) {
      const record = rows(requireCompanyId(companyId)).reservations.get(reservationId);
      return record ? copy(record) : null;
    },
    async findReservationByKey(companyId, idempotencyKey) {
      const found = [...rows(requireCompanyId(companyId)).reservations.values()].find(
        (record) => record.idempotencyKey === idempotencyKey,
      );
      return found ? copy(found) : null;
    },
    async insertReservation(companyId, record) {
      const scope = requireCompanyId(companyId);
      rows(scope).reservations.set(record.id, copy({ ...record, companyId: scope }));
    },
    async saveReservation(companyId, record) {
      const scope = requireCompanyId(companyId);
      rows(scope).reservations.set(record.id, copy({ ...record, companyId: scope }));
    },
    async listActiveReservations(companyId, variantId, locationId) {
      return [...rows(requireCompanyId(companyId)).reservations.values()]
        .filter(
          (record) =>
            record.status === "active" && record.variantId === variantId && record.locationId === locationId,
        )
        .map(copy);
    },
    async listDueReservations(companyId, at, limit) {
      return [...rows(requireCompanyId(companyId)).reservations.values()]
        .filter((record) => record.status === "active" && record.expiresAt.getTime() <= at.getTime())
        .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
        .slice(0, limit)
        .map(copy);
    },

    async findAdjustmentByKey(companyId, idempotencyKey) {
      const found = [...rows(requireCompanyId(companyId)).adjustments.values()].find(
        (record) => record.idempotencyKey === idempotencyKey,
      );
      return found ? copy(found) : null;
    },
    async insertAdjustment(companyId, record) {
      const scope = requireCompanyId(companyId);
      rows(scope).adjustments.set(record.id, copy({ ...record, companyId: scope }));
    },

    async getOrder(companyId, orderId) {
      const record = rows(requireCompanyId(companyId)).orders.get(orderId);
      return record ? copy(record) : null;
    },
    async saveOrder(companyId, record) {
      const scope = requireCompanyId(companyId);
      rows(scope).orders.set(record.id, copy({ ...record, companyId: scope }));
    },

    async getFulfilment(companyId, fulfilmentId) {
      const record = rows(requireCompanyId(companyId)).fulfilments.get(fulfilmentId);
      return record ? copy(record) : null;
    },
    async findFulfilmentByKey(companyId, idempotencyKey) {
      const found = [...rows(requireCompanyId(companyId)).fulfilments.values()].find(
        (record) => record.idempotencyKey === idempotencyKey,
      );
      return found ? copy(found) : null;
    },
    async insertFulfilment(companyId, record) {
      const scope = requireCompanyId(companyId);
      rows(scope).fulfilments.set(record.id, copy({ ...record, companyId: scope }));
    },
    async saveFulfilment(companyId, record) {
      const scope = requireCompanyId(companyId);
      rows(scope).fulfilments.set(record.id, copy({ ...record, companyId: scope }));
    },
    async listFulfilmentsForOrder(companyId, orderId) {
      return [...rows(requireCompanyId(companyId)).fulfilments.values()]
        .filter((record) => record.orderId === orderId)
        .map(copy);
    },
  };

  return storage;
}

// ---------------------------------------------------------------------------
// Drizzle implementation
// ---------------------------------------------------------------------------

type Db = PgDatabase<any, any, any>;

/** Postgres SQLSTATE code, read from the wrapped driver error when Drizzle has wrapped it. */
export function pgErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const { code, cause } = error as { code?: unknown; cause?: { code?: unknown } };
  const value = cause?.code ?? code;
  return typeof value === "string" ? value : undefined;
}

/**
 * Maps database errors to ChatbotError. A unique violation (23505) is a conflict with an existing key.
 * A check violation (23514) means the database refused a stock or quantity rule. Both are 409.
 * Service errors pass through unchanged, so a rejected transaction reports the real reason.
 */
export function mapFulfilmentDatabaseError(error: unknown): unknown {
  if (error instanceof ChatbotError) return error;
  const code = pgErrorCode(error);
  if (code === "23505") return new ChatbotError("A record with this key already exists for this company.", 409);
  if (code === "23514") return new ChatbotError("The database refused a stock or quantity rule.", 409);
  return error;
}

// Query builders. Each one filters on company_id (or inserts it). They are exported so tests can
// render the exact SQL without connecting to a database.

const stockWhere = (companyId: Id, variantId: Id, locationId: Id | null) =>
  and(
    eq(chatbotInventoryStock.companyId, companyId),
    eq(chatbotInventoryStock.variantId, variantId),
    locationId === null ? isNull(chatbotInventoryStock.locationId) : eq(chatbotInventoryStock.locationId, locationId),
  );

const stockColumns = (record: StockRecord) => ({
  quantity: record.quantity,
  reserved: record.reserved,
  committed: record.committed,
  allocated: record.allocated,
  damaged: record.damaged,
  safetyStock: record.safetyStock,
  incoming: record.incoming,
  lowStockThreshold: record.lowStockThreshold,
  allowBackorder: record.allowBackorder,
  version: record.version,
  updatedAt: new Date(),
});

/** SELECT the stock row. With forUpdate it takes a row lock that lasts until the transaction ends. */
export function selectStockQuery(db: Db, companyId: Id, variantId: Id, locationId: Id | null, forUpdate: boolean) {
  const query = db.select().from(chatbotInventoryStock).where(stockWhere(companyId, variantId, locationId));
  return forUpdate ? query.for("update") : query;
}

export function updateStockQuery(db: Db, companyId: Id, record: StockRecord) {
  return db
    .update(chatbotInventoryStock)
    .set(stockColumns(record))
    .where(stockWhere(companyId, record.variantId, record.locationId))
    .returning({ variantId: chatbotInventoryStock.variantId });
}

export function insertStockQuery(db: Db, companyId: Id, record: StockRecord) {
  return db.insert(chatbotInventoryStock).values({ ...stockColumns(record), companyId, variantId: record.variantId, locationId: record.locationId });
}

export function selectLocationQuery(db: Db, companyId: Id, locationId: Id) {
  return db
    .select()
    .from(chatbotFulfilmentLocations)
    .where(and(eq(chatbotFulfilmentLocations.companyId, companyId), eq(chatbotFulfilmentLocations.id, locationId)));
}

export function upsertLocationQuery(db: Db, companyId: Id, record: LocationRecord) {
  const values = { companyId, id: record.id, code: record.code, name: record.name, active: record.active, priority: record.priority };
  return db
    .insert(chatbotFulfilmentLocations)
    .values(values)
    .onConflictDoUpdate({
      target: [chatbotFulfilmentLocations.companyId, chatbotFulfilmentLocations.id],
      set: { code: record.code, name: record.name, active: record.active, priority: record.priority, updatedAt: new Date() },
    });
}

export function selectReservationQuery(db: Db, companyId: Id, reservationId: Id) {
  return db
    .select()
    .from(chatbotInventoryReservations)
    .where(and(eq(chatbotInventoryReservations.companyId, companyId), eq(chatbotInventoryReservations.id, reservationId)));
}

export function selectReservationByKeyQuery(db: Db, companyId: Id, idempotencyKey: string) {
  return db
    .select()
    .from(chatbotInventoryReservations)
    .where(and(eq(chatbotInventoryReservations.companyId, companyId), eq(chatbotInventoryReservations.idempotencyKey, idempotencyKey)));
}

export function selectActiveReservationsQuery(db: Db, companyId: Id, variantId: Id, locationId: Id | null) {
  return db
    .select()
    .from(chatbotInventoryReservations)
    .where(
      and(
        eq(chatbotInventoryReservations.companyId, companyId),
        eq(chatbotInventoryReservations.variantId, variantId),
        locationId === null
          ? isNull(chatbotInventoryReservations.locationId)
          : eq(chatbotInventoryReservations.locationId, locationId),
        eq(chatbotInventoryReservations.status, "active"),
      ),
    );
}

export function selectDueReservationsQuery(db: Db, companyId: Id, at: Date, limit: number) {
  return db
    .select()
    .from(chatbotInventoryReservations)
    .where(
      and(
        eq(chatbotInventoryReservations.companyId, companyId),
        eq(chatbotInventoryReservations.status, "active"),
        lte(chatbotInventoryReservations.expiresAt, at),
      ),
    )
    .orderBy(asc(chatbotInventoryReservations.expiresAt))
    .limit(limit);
}

const reservationValues = (companyId: Id, record: ReservationRecord) => ({
  companyId,
  id: record.id,
  holderId: record.holderId,
  variantId: record.variantId,
  locationId: record.locationId,
  quantity: record.quantity,
  status: record.status,
  idempotencyKey: record.idempotencyKey,
  expiresAt: record.expiresAt,
  committedAt: record.committedAt,
  releasedAt: record.releasedAt,
  releaseReason: record.releaseReason,
  createdAt: record.createdAt,
});

export function insertReservationQuery(db: Db, companyId: Id, record: ReservationRecord) {
  return db.insert(chatbotInventoryReservations).values(reservationValues(companyId, record));
}

export function upsertReservationQuery(db: Db, companyId: Id, record: ReservationRecord) {
  const { companyId: _c, id: _i, createdAt: _t, ...changes } = reservationValues(companyId, record);
  return db
    .insert(chatbotInventoryReservations)
    .values(reservationValues(companyId, record))
    .onConflictDoUpdate({
      target: [chatbotInventoryReservations.companyId, chatbotInventoryReservations.id],
      set: changes,
    });
}

export function selectAdjustmentByKeyQuery(db: Db, companyId: Id, idempotencyKey: string) {
  return db
    .select()
    .from(chatbotInventoryAdjustments)
    .where(and(eq(chatbotInventoryAdjustments.companyId, companyId), eq(chatbotInventoryAdjustments.idempotencyKey, idempotencyKey)));
}

export function insertAdjustmentQuery(db: Db, companyId: Id, record: AdjustmentRecord) {
  return db.insert(chatbotInventoryAdjustments).values({
    companyId,
    id: record.id,
    variantId: record.variantId,
    locationId: record.locationId,
    delta: record.delta,
    reason: record.reason,
    balanceAfter: record.balanceAfter,
    version: record.version,
    actorId: record.actorId,
    idempotencyKey: record.idempotencyKey,
    createdAt: record.createdAt,
  });
}

export function selectOrderQuery(db: Db, companyId: Id, orderId: Id) {
  return db
    .select()
    .from(chatbotFulfilmentOrders)
    .where(and(eq(chatbotFulfilmentOrders.companyId, companyId), eq(chatbotFulfilmentOrders.id, orderId)));
}

export function upsertOrderQuery(db: Db, companyId: Id, record: OrderRecord) {
  return db
    .insert(chatbotFulfilmentOrders)
    .values({ companyId, id: record.id, reference: record.reference, createdAt: record.createdAt })
    .onConflictDoUpdate({
      target: [chatbotFulfilmentOrders.companyId, chatbotFulfilmentOrders.id],
      set: { reference: record.reference },
    });
}

export function selectOrderLinesQuery(db: Db, companyId: Id, orderId: Id) {
  return db
    .select()
    .from(chatbotFulfilmentOrderLines)
    .where(and(eq(chatbotFulfilmentOrderLines.companyId, companyId), eq(chatbotFulfilmentOrderLines.orderId, orderId)));
}

export function deleteOrderLinesQuery(db: Db, companyId: Id, orderId: Id) {
  return db
    .delete(chatbotFulfilmentOrderLines)
    .where(and(eq(chatbotFulfilmentOrderLines.companyId, companyId), eq(chatbotFulfilmentOrderLines.orderId, orderId)));
}

export function insertOrderLinesQuery(db: Db, companyId: Id, orderId: Id, lines: readonly OrderLine[]) {
  return db.insert(chatbotFulfilmentOrderLines).values(
    lines.map((line) => ({
      companyId,
      id: line.id,
      orderId,
      variantId: line.variantId,
      productId: line.productId,
      sku: line.sku,
      name: line.name,
      quantity: line.quantity,
    })),
  );
}

export function selectFulfilmentQuery(db: Db, companyId: Id, fulfilmentId: Id) {
  return db
    .select()
    .from(chatbotFulfilments)
    .where(and(eq(chatbotFulfilments.companyId, companyId), eq(chatbotFulfilments.id, fulfilmentId)));
}

export function selectFulfilmentByKeyQuery(db: Db, companyId: Id, idempotencyKey: string) {
  return db
    .select()
    .from(chatbotFulfilments)
    .where(and(eq(chatbotFulfilments.companyId, companyId), eq(chatbotFulfilments.idempotencyKey, idempotencyKey)));
}

export function selectFulfilmentsForOrderQuery(db: Db, companyId: Id, orderId: Id) {
  return db
    .select()
    .from(chatbotFulfilments)
    .where(and(eq(chatbotFulfilments.companyId, companyId), eq(chatbotFulfilments.orderId, orderId)));
}

const fulfilmentValues = (companyId: Id, record: FulfilmentRecord) => ({
  companyId,
  id: record.id,
  orderId: record.orderId,
  status: record.status,
  methodType: record.methodType,
  locationId: record.locationId,
  carrier: record.carrier,
  service: record.service,
  trackingNumber: record.trackingNumber,
  trackingUrl: record.trackingUrl,
  customerNote: record.customerNote,
  internalNote: record.internalNote,
  idempotencyKey: record.idempotencyKey,
  requestHash: record.requestHash,
  processingAt: record.processingAt,
  shippedAt: record.shippedAt,
  deliveredAt: record.deliveredAt,
  cancelledAt: record.cancelledAt,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

export function insertFulfilmentQuery(db: Db, companyId: Id, record: FulfilmentRecord) {
  return db.insert(chatbotFulfilments).values(fulfilmentValues(companyId, record));
}

export function upsertFulfilmentQuery(db: Db, companyId: Id, record: FulfilmentRecord) {
  const { companyId: _c, id: _i, createdAt: _t, idempotencyKey: _k, ...changes } = fulfilmentValues(companyId, record);
  return db
    .insert(chatbotFulfilments)
    .values(fulfilmentValues(companyId, record))
    .onConflictDoUpdate({
      target: [chatbotFulfilments.companyId, chatbotFulfilments.id],
      set: changes,
    });
}

export function selectItemsQuery(db: Db, companyId: Id, fulfilmentIds: readonly Id[]) {
  return db
    .select()
    .from(chatbotFulfilmentItems)
    .where(and(eq(chatbotFulfilmentItems.companyId, companyId), inArray(chatbotFulfilmentItems.fulfilmentId, [...fulfilmentIds])));
}

export function deleteItemsQuery(db: Db, companyId: Id, fulfilmentId: Id) {
  return db
    .delete(chatbotFulfilmentItems)
    .where(and(eq(chatbotFulfilmentItems.companyId, companyId), eq(chatbotFulfilmentItems.fulfilmentId, fulfilmentId)));
}

export function insertItemsQuery(db: Db, companyId: Id, fulfilmentId: Id, items: readonly FulfilmentItemRecord[]) {
  return db.insert(chatbotFulfilmentItems).values(
    items.map((item) => ({
      companyId,
      fulfilmentId,
      orderLineId: item.orderLineId,
      variantId: item.variantId,
      productId: item.productId,
      sku: item.sku,
      name: item.name,
      quantity: item.quantity,
    })),
  );
}

// Row to record mappers. Drizzle returns camelCase keys, so the mappers only pick the record fields.

type StockRow = typeof chatbotInventoryStock.$inferSelect;
type ReservationRow = typeof chatbotInventoryReservations.$inferSelect;
type FulfilmentRow = typeof chatbotFulfilments.$inferSelect;

const toStock = (row: StockRow): StockRecord => ({
  companyId: row.companyId,
  variantId: row.variantId,
  locationId: row.locationId,
  quantity: row.quantity,
  reserved: row.reserved,
  committed: row.committed,
  allocated: row.allocated,
  damaged: row.damaged,
  safetyStock: row.safetyStock,
  incoming: row.incoming,
  lowStockThreshold: row.lowStockThreshold,
  allowBackorder: row.allowBackorder,
  version: row.version,
});

const toReservation = (row: ReservationRow): ReservationRecord => ({
  id: row.id,
  companyId: row.companyId,
  holderId: row.holderId,
  variantId: row.variantId,
  locationId: row.locationId,
  quantity: row.quantity,
  status: row.status as ReservationRecord["status"],
  idempotencyKey: row.idempotencyKey,
  expiresAt: row.expiresAt,
  committedAt: row.committedAt,
  releasedAt: row.releasedAt,
  releaseReason: row.releaseReason,
  createdAt: row.createdAt,
});

const toFulfilment = (row: FulfilmentRow, items: FulfilmentItemRecord[]): FulfilmentRecord => ({
  id: row.id,
  companyId: row.companyId,
  orderId: row.orderId,
  status: row.status as FulfilmentStatus,
  methodType: row.methodType as FulfilmentMethod,
  locationId: row.locationId,
  carrier: row.carrier,
  service: row.service,
  trackingNumber: row.trackingNumber,
  trackingUrl: row.trackingUrl,
  customerNote: row.customerNote,
  internalNote: row.internalNote,
  idempotencyKey: row.idempotencyKey,
  requestHash: row.requestHash,
  items,
  processingAt: row.processingAt,
  shippedAt: row.shippedAt,
  deliveredAt: row.deliveredAt,
  cancelledAt: row.cancelledAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * Postgres implementation of FulfilmentStorage. Construct it with a Drizzle database. Inside
 * transaction() it passes a transaction-bound instance to the callback, and the stock row is read with
 * SELECT ... FOR UPDATE. Outside a transaction, reads take no lock.
 *
 * Stock cannot go negative: the table CHECK constraints refuse a write that would take reserved,
 * committed or allocated stock below zero, and the service checks availability under the row lock first.
 */
export class DrizzleFulfilmentStorage implements FulfilmentStorage {
  private readonly db: Db;
  private readonly inTransaction: boolean;

  constructor(db: Db, options: { inTransaction?: boolean } = {}) {
    this.db = db;
    this.inTransaction = options.inTransaction === true;
  }

  private async run<T>(query: PromiseLike<T>): Promise<T> {
    try {
      return await query;
    } catch (error) {
      throw mapFulfilmentDatabaseError(error);
    }
  }

  private async loadFulfilments(companyId: Id, rows: FulfilmentRow[]): Promise<FulfilmentRecord[]> {
    if (rows.length === 0) return [];
    const items = await this.run(selectItemsQuery(this.db, companyId, rows.map((row) => row.id)));
    return rows.map((row) =>
      toFulfilment(
        row,
        items
          .filter((item) => item.fulfilmentId === row.id)
          .map((item) => ({
            orderLineId: item.orderLineId,
            variantId: item.variantId,
            productId: item.productId,
            sku: item.sku,
            name: item.name,
            quantity: item.quantity,
          })),
      ),
    );
  }

  async transaction<T>(companyId: Id, fn: (tx: FulfilmentStorage) => Promise<T>): Promise<T> {
    requireCompanyId(companyId);
    try {
      return await this.db.transaction((tx) => fn(new DrizzleFulfilmentStorage(tx, { inTransaction: true })));
    } catch (error) {
      throw mapFulfilmentDatabaseError(error);
    }
  }

  async getLocation(companyId: Id, locationId: Id): Promise<LocationRecord | null> {
    const scope = requireCompanyId(companyId);
    const [row] = await this.run(selectLocationQuery(this.db, scope, locationId));
    if (!row) return null;
    return { id: row.id, companyId: row.companyId, code: row.code, name: row.name, active: row.active, priority: row.priority };
  }

  async saveLocation(companyId: Id, record: LocationRecord): Promise<void> {
    await this.run(upsertLocationQuery(this.db, requireCompanyId(companyId), record));
  }

  async getStock(companyId: Id, variantId: Id, locationId: Id | null): Promise<StockRecord | null> {
    const scope = requireCompanyId(companyId);
    const [row] = await this.run(selectStockQuery(this.db, scope, variantId, locationId, this.inTransaction));
    return row ? toStock(row) : null;
  }

  async saveStock(companyId: Id, record: StockRecord): Promise<void> {
    const scope = requireCompanyId(companyId);
    const updated = await this.run(updateStockQuery(this.db, scope, record));
    if (updated.length === 0) {
      await this.run(insertStockQuery(this.db, scope, record));
    }
  }

  async getReservation(companyId: Id, reservationId: Id): Promise<ReservationRecord | null> {
    const [row] = await this.run(selectReservationQuery(this.db, requireCompanyId(companyId), reservationId));
    return row ? toReservation(row) : null;
  }

  async findReservationByKey(companyId: Id, idempotencyKey: string): Promise<ReservationRecord | null> {
    const [row] = await this.run(selectReservationByKeyQuery(this.db, requireCompanyId(companyId), idempotencyKey));
    return row ? toReservation(row) : null;
  }

  async insertReservation(companyId: Id, record: ReservationRecord): Promise<void> {
    await this.run(insertReservationQuery(this.db, requireCompanyId(companyId), record));
  }

  async saveReservation(companyId: Id, record: ReservationRecord): Promise<void> {
    await this.run(upsertReservationQuery(this.db, requireCompanyId(companyId), record));
  }

  async listActiveReservations(companyId: Id, variantId: Id, locationId: Id | null): Promise<ReservationRecord[]> {
    const rows = await this.run(selectActiveReservationsQuery(this.db, requireCompanyId(companyId), variantId, locationId));
    return rows.map(toReservation);
  }

  async listDueReservations(companyId: Id, at: Date, limit: number): Promise<ReservationRecord[]> {
    const rows = await this.run(selectDueReservationsQuery(this.db, requireCompanyId(companyId), at, limit));
    return rows.map(toReservation);
  }

  async findAdjustmentByKey(companyId: Id, idempotencyKey: string): Promise<AdjustmentRecord | null> {
    const [row] = await this.run(selectAdjustmentByKeyQuery(this.db, requireCompanyId(companyId), idempotencyKey));
    if (!row) return null;
    return {
      id: row.id,
      companyId: row.companyId,
      variantId: row.variantId,
      locationId: row.locationId,
      delta: row.delta,
      reason: row.reason,
      balanceAfter: row.balanceAfter,
      version: row.version,
      actorId: row.actorId,
      idempotencyKey: row.idempotencyKey,
      createdAt: row.createdAt,
    };
  }

  async insertAdjustment(companyId: Id, record: AdjustmentRecord): Promise<void> {
    await this.run(insertAdjustmentQuery(this.db, requireCompanyId(companyId), record));
  }

  async getOrder(companyId: Id, orderId: Id): Promise<OrderRecord | null> {
    const scope = requireCompanyId(companyId);
    const [row] = await this.run(selectOrderQuery(this.db, scope, orderId));
    if (!row) return null;
    const lines = await this.run(selectOrderLinesQuery(this.db, scope, orderId));
    return {
      id: row.id,
      companyId: row.companyId,
      reference: row.reference,
      createdAt: row.createdAt,
      lines: lines.map((line) => ({
        id: line.id,
        variantId: line.variantId,
        productId: line.productId,
        sku: line.sku,
        name: line.name,
        quantity: line.quantity,
      })),
    };
  }

  async saveOrder(companyId: Id, record: OrderRecord): Promise<void> {
    const scope = requireCompanyId(companyId);
    await this.run(
      this.db.transaction(async (tx) => {
        await upsertOrderQuery(tx, scope, record);
        await deleteOrderLinesQuery(tx, scope, record.id);
        if (record.lines.length > 0) {
          await insertOrderLinesQuery(tx, scope, record.id, record.lines);
        }
      }),
    );
  }

  async getFulfilment(companyId: Id, fulfilmentId: Id): Promise<FulfilmentRecord | null> {
    const scope = requireCompanyId(companyId);
    const rows = await this.run(selectFulfilmentQuery(this.db, scope, fulfilmentId));
    const [record] = await this.loadFulfilments(scope, rows);
    return record ?? null;
  }

  async findFulfilmentByKey(companyId: Id, idempotencyKey: string): Promise<FulfilmentRecord | null> {
    const scope = requireCompanyId(companyId);
    const rows = await this.run(selectFulfilmentByKeyQuery(this.db, scope, idempotencyKey));
    const [record] = await this.loadFulfilments(scope, rows);
    return record ?? null;
  }

  async insertFulfilment(companyId: Id, record: FulfilmentRecord): Promise<void> {
    const scope = requireCompanyId(companyId);
    await this.run(
      this.db.transaction(async (tx) => {
        await insertFulfilmentQuery(tx, scope, record);
        if (record.items.length > 0) {
          await insertItemsQuery(tx, scope, record.id, record.items);
        }
      }),
    );
  }

  async saveFulfilment(companyId: Id, record: FulfilmentRecord): Promise<void> {
    const scope = requireCompanyId(companyId);
    await this.run(
      this.db.transaction(async (tx) => {
        await upsertFulfilmentQuery(tx, scope, record);
        await deleteItemsQuery(tx, scope, record.id);
        if (record.items.length > 0) {
          await insertItemsQuery(tx, scope, record.id, record.items);
        }
      }),
    );
  }

  async listFulfilmentsForOrder(companyId: Id, orderId: Id): Promise<FulfilmentRecord[]> {
    const scope = requireCompanyId(companyId);
    const rows = await this.run(selectFulfilmentsForOrderQuery(this.db, scope, orderId));
    return this.loadFulfilments(scope, rows);
  }
}

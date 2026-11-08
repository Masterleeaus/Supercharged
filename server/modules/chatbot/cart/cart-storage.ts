/**
 * Storage contract for the cart and checkout slice.
 *
 * Every method takes companyId as its first argument and only reads or writes rows that carry it.
 * requireCompanyId() runs in both the service and the storage, so a missing tenant fails closed.
 *
 * transaction() gives one callback exclusive access to the company's rows and rolls back on throw.
 * The Drizzle implementation maps it to a database transaction. Inside it, reads of the cart, checkout
 * and spend-limit rows use SELECT ... FOR UPDATE. The in-memory implementation serialises per company
 * in process only. See DECISIONS.md, "Drizzle".
 *
 * Two implementations exist: createMemoryCartStorage() and DrizzleCartStorage. Both keep the same
 * unique rules: one active cart per conversation, one open checkout per cart, one record per
 * idempotency key per owner, one spend limit per scope.
 */
import { and, asc, eq, or, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { ChatbotError, requireCompanyId } from "../chatbot-scope.ts";
import { CART_CONSTRAINTS, chatbotCartIdempotencyKeys, chatbotCartLines, chatbotCarts, chatbotCheckoutSessions, chatbotSpendLimits } from "../db/cart.ts";
import {
  CartError,
  type CartLine,
  type CartOperationRecord,
  type CartRecord,
  type CheckoutContact,
  type CheckoutOperationRecord,
  type CheckoutRecord,
  type OrderRequest,
  type SpendLimitRecord,
  type SpendScopeType,
} from "./cart-types.ts";

export interface SpendLimitTarget {
  readonly scopeType: SpendScopeType;
  readonly scopeId: string;
}

export interface CartStorage {
  /**
   * Runs fn with exclusive access to this company's rows and rolls back every write if fn throws.
   * Nested calls on the same in-memory storage would wait on themselves and must not be made.
   */
  transaction<T>(companyId: string, fn: (tx: CartStorage) => Promise<T>): Promise<T>;

  /** The one active cart for a conversation, or null. */
  findActiveCart(companyId: string, conversationId: string): Promise<CartRecord | null>;
  getCart(companyId: string, cartId: string): Promise<CartRecord | null>;
  /** Inserts or replaces a cart. Throws if a second active cart would exist for the conversation. */
  putCart(companyId: string, cart: CartRecord): Promise<void>;
  /**
   * Stores cart as the conversation's active cart, unless one already exists, and returns the active cart.
   * Drizzle: INSERT ... ON CONFLICT DO NOTHING on the active-cart index, then a company-scoped SELECT. Two
   * first requests for one conversation therefore both get the same cart.
   */
  insertActiveCartOrFind(companyId: string, cart: CartRecord): Promise<CartRecord>;

  findCartOperation(companyId: string, cartId: string, idempotencyKey: string): Promise<CartOperationRecord | null>;
  /** Throws if the (cart, key) pair already exists. */
  putCartOperation(companyId: string, operation: CartOperationRecord): Promise<void>;

  getCheckout(companyId: string, checkoutId: string): Promise<CheckoutRecord | null>;
  /** The open checkout for a cart, or null. */
  findOpenCheckoutForCart(companyId: string, cartId: string): Promise<CheckoutRecord | null>;
  /** Inserts or replaces a checkout. Throws if a second open checkout would exist for the cart. */
  putCheckout(companyId: string, checkout: CheckoutRecord): Promise<void>;

  findCheckoutOperation(companyId: string, checkoutId: string, idempotencyKey: string): Promise<CheckoutOperationRecord | null>;
  /** Throws if the (checkout, key) pair already exists. */
  putCheckoutOperation(companyId: string, operation: CheckoutOperationRecord): Promise<void>;

  /** Every spend limit matching one of the targets, enabled or not. The caller filters on enabled. */
  findSpendLimits(companyId: string, targets: readonly SpendLimitTarget[]): Promise<SpendLimitRecord[]>;
  /** Inserts or replaces a spend limit, keyed by (scopeType, scopeId). */
  putSpendLimit(companyId: string, limit: SpendLimitRecord): Promise<void>;
}

export function createMemoryCartStorage(): CartStorage {
  // companyId -> store. Each company has its own maps, so one tenant can never see another's rows.
  const carts = new Map<string, Map<string, CartRecord>>();
  const cartOps = new Map<string, Map<string, CartOperationRecord>>();
  const checkouts = new Map<string, Map<string, CheckoutRecord>>();
  const checkoutOps = new Map<string, Map<string, CheckoutOperationRecord>>();
  const spendLimits = new Map<string, Map<string, SpendLimitRecord>>();
  const allStores: Array<Map<string, Map<string, unknown>>> = [carts, cartOps, checkouts, checkoutOps, spendLimits];
  // Per-company queue for transaction(). Records are replaced, never mutated, so a shallow copy of
  // each company's map is a full snapshot for rollback.
  const locks = new Map<string, Promise<void>>();

  function bucket<T>(store: Map<string, Map<string, T>>, companyId: string): Map<string, T> {
    const tenant = requireCompanyId(companyId);
    let rows = store.get(tenant);
    if (!rows) {
      rows = new Map();
      store.set(tenant, rows);
    }
    return rows;
  }

  const storage: CartStorage = {
    async transaction<T>(companyId: string, fn: (tx: CartStorage) => Promise<T>): Promise<T> {
      const tenant = requireCompanyId(companyId);
      const previous = locks.get(tenant) ?? Promise.resolve();
      let release: () => void = () => undefined;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => current);
      locks.set(tenant, tail);
      await previous;

      const snapshot = allStores.map((store) => ({ store, rows: new Map(store.get(tenant) ?? []) }));
      try {
        return await fn(storage);
      } catch (error) {
        for (const { store, rows } of snapshot) store.set(tenant, rows);
        throw error;
      } finally {
        release();
        if (locks.get(tenant) === tail) locks.delete(tenant);
      }
    },

    async findActiveCart(companyId, conversationId) {
      for (const cart of bucket(carts, companyId).values()) {
        if (cart.conversationId === conversationId && cart.status === "active") {
          return cart;
        }
      }
      return null;
    },

    async getCart(companyId, cartId) {
      return bucket(carts, companyId).get(cartId) ?? null;
    },

    async putCart(companyId, cart) {
      const rows = bucket(carts, companyId);
      if (cart.status === "active") {
        for (const other of rows.values()) {
          if (other.id !== cart.id && other.status === "active" && other.conversationId === cart.conversationId) {
            throw new CartError("conflict", "An active cart already exists for this conversation.");
          }
        }
      }
      rows.set(cart.id, cart);
    },

    async insertActiveCartOrFind(companyId, cart) {
      const rows = bucket(carts, companyId);
      for (const other of rows.values()) {
        if (other.status === "active" && other.conversationId === cart.conversationId) return other;
      }
      rows.set(cart.id, cart);
      return cart;
    },

    async findCartOperation(companyId, cartId, idempotencyKey) {
      return bucket(cartOps, companyId).get(`${cartId}\u0000${idempotencyKey}`) ?? null;
    },

    async putCartOperation(companyId, operation) {
      const rows = bucket(cartOps, companyId);
      const key = `${operation.cartId}\u0000${operation.idempotencyKey}`;
      if (rows.has(key)) {
        throw new CartError("idempotency_conflict", "This idempotency key was already recorded for the cart.");
      }
      rows.set(key, operation);
    },

    async getCheckout(companyId, checkoutId) {
      return bucket(checkouts, companyId).get(checkoutId) ?? null;
    },

    async findOpenCheckoutForCart(companyId, cartId) {
      for (const checkout of bucket(checkouts, companyId).values()) {
        if (checkout.cartId === cartId && checkout.status === "open") {
          return checkout;
        }
      }
      return null;
    },

    async putCheckout(companyId, checkout) {
      const rows = bucket(checkouts, companyId);
      if (checkout.status === "open") {
        for (const other of rows.values()) {
          if (other.id !== checkout.id && other.status === "open" && other.cartId === checkout.cartId) {
            throw new CartError("conflict", "An open checkout already exists for this cart.");
          }
        }
      }
      rows.set(checkout.id, checkout);
    },

    async findCheckoutOperation(companyId, checkoutId, idempotencyKey) {
      return bucket(checkoutOps, companyId).get(`${checkoutId}\u0000${idempotencyKey}`) ?? null;
    },

    async putCheckoutOperation(companyId, operation) {
      const rows = bucket(checkoutOps, companyId);
      const key = `${operation.checkoutId}\u0000${operation.idempotencyKey}`;
      if (rows.has(key)) {
        throw new CartError("idempotency_conflict", "This idempotency key was already recorded for the checkout.");
      }
      rows.set(key, operation);
    },

    async findSpendLimits(companyId, targets) {
      const matches: SpendLimitRecord[] = [];
      for (const limit of bucket(spendLimits, companyId).values()) {
        if (targets.some((target) => target.scopeType === limit.scopeType && target.scopeId === limit.scopeId)) {
          matches.push(limit);
        }
      }
      return matches;
    },

    async putSpendLimit(companyId, limit) {
      bucket(spendLimits, companyId).set(`${limit.scopeType}\u0000${limit.scopeId}`, limit);
    },
  };

  return storage;
}

// ---------------------------------------------------------------------------
// Drizzle implementation
// ---------------------------------------------------------------------------

type Db = PgDatabase<any, any, any>;

function pgError(error: unknown): { code?: string; constraint?: string } | undefined {
  if (!error || typeof error !== "object") return undefined;
  const { code, constraint, cause } = error as { code?: unknown; constraint?: unknown; cause?: { code?: unknown; constraint?: unknown } };
  const value = cause?.code ?? code;
  const name = cause?.constraint ?? constraint;
  return {
    code: typeof value === "string" ? value : undefined,
    constraint: typeof name === "string" ? name : undefined,
  };
}

/**
 * Maps database errors to the slice's error types. A unique violation on the idempotency index is
 * idempotency_conflict. A unique violation on the active-cart, open-checkout or spend-limit index is a
 * conflict. A check violation is validation. Service errors pass through unchanged.
 */
export function mapCartDatabaseError(error: unknown): unknown {
  if (error instanceof ChatbotError) return error;
  const detail = pgError(error);
  if (detail?.code === "23505") {
    if (detail.constraint === CART_CONSTRAINTS.idempotencyKey) {
      return new CartError("idempotency_conflict", "This idempotency key was already recorded.");
    }
    return new CartError("conflict", "The write conflicts with an active cart, an open checkout or a spend limit.");
  }
  if (detail?.code === "23514") return new CartError("validation", "The database refused a cart or checkout value.");
  return error;
}

// Query builders. Each one filters on company_id (or inserts it). Exported so tests can render the SQL.

type CartRow = typeof chatbotCarts.$inferSelect;
type CartLineRow = typeof chatbotCartLines.$inferSelect;
type CheckoutRow = typeof chatbotCheckoutSessions.$inferSelect;
type SpendLimitRow = typeof chatbotSpendLimits.$inferSelect;

export function selectCartQuery(db: Db, companyId: string, cartId: string, forUpdate: boolean) {
  const query = db
    .select()
    .from(chatbotCarts)
    .where(and(eq(chatbotCarts.companyId, companyId), eq(chatbotCarts.id, cartId)));
  return forUpdate ? query.for("update") : query;
}

export function selectActiveCartQuery(db: Db, companyId: string, conversationId: string) {
  return db
    .select()
    .from(chatbotCarts)
    .where(
      and(
        eq(chatbotCarts.companyId, companyId),
        eq(chatbotCarts.conversationId, conversationId),
        eq(chatbotCarts.status, "active"),
      ),
    );
}

/**
 * INSERT ... ON CONFLICT DO NOTHING against the partial unique index on (company_id, conversation_id) WHERE
 * status = 'active'. The index predicate must match the conflict predicate, or Postgres cannot infer the index.
 */
export function insertActiveCartIfAbsentQuery(db: Db, companyId: string, cart: CartRecord) {
  return db
    .insert(chatbotCarts)
    .values({
      companyId,
      id: cart.id,
      chatbotId: cart.chatbotId,
      conversationId: cart.conversationId,
      customerId: cart.customerId,
      status: cart.status,
      currency: cart.currency,
      subtotalMinor: cart.subtotalMinor,
      discountMinor: cart.discountMinor,
      totalMinor: cart.totalMinor,
      version: cart.version,
      expiresAt: cart.expiresAt,
      createdAt: cart.createdAt,
      updatedAt: cart.updatedAt,
    })
    .onConflictDoNothing({
      target: [chatbotCarts.companyId, chatbotCarts.conversationId],
      where: sql`${chatbotCarts.status} = 'active'`,
    });
}

export function upsertCartQuery(db: Db, companyId: string, cart: CartRecord) {
  return db
    .insert(chatbotCarts)
    .values({
      companyId,
      id: cart.id,
      chatbotId: cart.chatbotId,
      conversationId: cart.conversationId,
      customerId: cart.customerId,
      status: cart.status,
      currency: cart.currency,
      subtotalMinor: cart.subtotalMinor,
      discountMinor: cart.discountMinor,
      totalMinor: cart.totalMinor,
      version: cart.version,
      expiresAt: cart.expiresAt,
      createdAt: cart.createdAt,
      updatedAt: cart.updatedAt,
    })
    .onConflictDoUpdate({
      target: [chatbotCarts.companyId, chatbotCarts.id],
      set: {
        chatbotId: cart.chatbotId,
        conversationId: cart.conversationId,
        customerId: cart.customerId,
        status: cart.status,
        currency: cart.currency,
        subtotalMinor: cart.subtotalMinor,
        discountMinor: cart.discountMinor,
        totalMinor: cart.totalMinor,
        version: cart.version,
        expiresAt: cart.expiresAt,
        updatedAt: cart.updatedAt,
      },
    });
}

export function selectCartLinesQuery(db: Db, companyId: string, cartId: string) {
  return db
    .select()
    .from(chatbotCartLines)
    .where(and(eq(chatbotCartLines.companyId, companyId), eq(chatbotCartLines.cartId, cartId)))
    .orderBy(asc(chatbotCartLines.position));
}

export function deleteCartLinesQuery(db: Db, companyId: string, cartId: string) {
  return db
    .delete(chatbotCartLines)
    .where(and(eq(chatbotCartLines.companyId, companyId), eq(chatbotCartLines.cartId, cartId)));
}

export function insertCartLinesQuery(db: Db, companyId: string, cartId: string, lines: readonly CartLine[], at: Date) {
  return db.insert(chatbotCartLines).values(
    lines.map((line, position) => ({
      companyId,
      cartId,
      lineKey: line.lineKey,
      position,
      variantId: line.variantId,
      productId: line.productId,
      sku: line.sku,
      name: line.name,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      lineTotalMinor: line.lineTotalMinor,
      currency: line.currency,
      customisation: { ...line.customisation },
      createdAt: at,
      updatedAt: at,
    })),
  );
}

export function selectOperationQuery(db: Db, companyId: string, ownerType: "cart" | "checkout", ownerId: string, idempotencyKey: string) {
  return db
    .select()
    .from(chatbotCartIdempotencyKeys)
    .where(
      and(
        eq(chatbotCartIdempotencyKeys.companyId, companyId),
        eq(chatbotCartIdempotencyKeys.ownerType, ownerType),
        eq(chatbotCartIdempotencyKeys.ownerId, ownerId),
        eq(chatbotCartIdempotencyKeys.idempotencyKey, idempotencyKey),
      ),
    );
}

export function insertOperationQuery(
  db: Db,
  companyId: string,
  ownerType: "cart" | "checkout",
  ownerId: string,
  operation: { idempotencyKey: string; requestHash: string; operation: string; createdAt: Date },
) {
  return db.insert(chatbotCartIdempotencyKeys).values({
    companyId,
    ownerType,
    ownerId,
    idempotencyKey: operation.idempotencyKey,
    requestHash: operation.requestHash,
    operation: operation.operation,
    createdAt: operation.createdAt,
  });
}

export function selectCheckoutQuery(db: Db, companyId: string, checkoutId: string, forUpdate: boolean) {
  const query = db
    .select()
    .from(chatbotCheckoutSessions)
    .where(and(eq(chatbotCheckoutSessions.companyId, companyId), eq(chatbotCheckoutSessions.id, checkoutId)));
  return forUpdate ? query.for("update") : query;
}

export function selectOpenCheckoutForCartQuery(db: Db, companyId: string, cartId: string) {
  return db
    .select()
    .from(chatbotCheckoutSessions)
    .where(
      and(
        eq(chatbotCheckoutSessions.companyId, companyId),
        eq(chatbotCheckoutSessions.cartId, cartId),
        eq(chatbotCheckoutSessions.status, "open"),
      ),
    );
}

export function upsertCheckoutQuery(db: Db, companyId: string, checkout: CheckoutRecord) {
  const values = {
    companyId,
    id: checkout.id,
    cartId: checkout.cartId,
    chatbotId: checkout.chatbotId,
    conversationId: checkout.conversationId,
    customerId: checkout.customerId,
    status: checkout.status,
    currency: checkout.currency,
    lines: [...checkout.lines],
    subtotalMinor: checkout.subtotalMinor,
    discountMinor: checkout.discountMinor,
    totalMinor: checkout.totalMinor,
    contactEmail: checkout.contact.email,
    contactPhone: checkout.contact.phone,
    contactName: checkout.contact.name,
    orderRequest: checkout.orderRequest ? { ...checkout.orderRequest } : null,
    version: checkout.version,
    expiresAt: checkout.expiresAt,
    submittedAt: checkout.submittedAt,
    cancelledAt: checkout.cancelledAt,
    createdAt: checkout.createdAt,
    updatedAt: checkout.updatedAt,
  };
  const { companyId: _c, id: _i, createdAt: _t, cartId: _k, ...changes } = values;
  return db
    .insert(chatbotCheckoutSessions)
    .values(values)
    .onConflictDoUpdate({ target: [chatbotCheckoutSessions.companyId, chatbotCheckoutSessions.id], set: changes });
}

export function selectSpendLimitsQuery(db: Db, companyId: string, targets: readonly SpendLimitTarget[], forUpdate: boolean) {
  const query = db
    .select()
    .from(chatbotSpendLimits)
    .where(
      and(
        eq(chatbotSpendLimits.companyId, companyId),
        or(
          ...targets.map((target) =>
            and(eq(chatbotSpendLimits.scopeType, target.scopeType), eq(chatbotSpendLimits.scopeId, target.scopeId)),
          ),
        ),
      ),
    )
    // A fixed order means two transactions that lock several limits always lock them in the same order.
    .orderBy(asc(chatbotSpendLimits.scopeType), asc(chatbotSpendLimits.scopeId));
  return forUpdate ? query.for("update") : query;
}

export function upsertSpendLimitQuery(db: Db, companyId: string, limit: SpendLimitRecord) {
  return db
    .insert(chatbotSpendLimits)
    .values({
      companyId,
      id: limit.id,
      scopeType: limit.scopeType,
      scopeId: limit.scopeId,
      currency: limit.currency,
      maxOrderMinor: limit.maxOrderMinor,
      dailyLimitMinor: limit.dailyLimitMinor,
      spentMinor: limit.spentMinor,
      periodDate: limit.periodDate,
      enabled: limit.enabled,
      createdAt: limit.createdAt,
      updatedAt: limit.updatedAt,
    })
    .onConflictDoUpdate({
      target: [chatbotSpendLimits.companyId, chatbotSpendLimits.scopeType, chatbotSpendLimits.scopeId],
      set: {
        currency: limit.currency,
        maxOrderMinor: limit.maxOrderMinor,
        dailyLimitMinor: limit.dailyLimitMinor,
        spentMinor: limit.spentMinor,
        periodDate: limit.periodDate,
        enabled: limit.enabled,
        updatedAt: limit.updatedAt,
      },
    });
}

// Row to record mappers.

const toCartLine = (row: CartLineRow): CartLine => ({
  lineKey: row.lineKey,
  variantId: row.variantId,
  productId: row.productId,
  sku: row.sku,
  name: row.name,
  quantity: row.quantity,
  unitPriceMinor: row.unitPriceMinor,
  lineTotalMinor: row.lineTotalMinor,
  currency: row.currency,
  customisation: row.customisation,
});

const toCart = (row: CartRow, lines: CartLineRow[]): CartRecord => ({
  id: row.id,
  companyId: row.companyId,
  chatbotId: row.chatbotId,
  conversationId: row.conversationId,
  customerId: row.customerId,
  status: row.status as CartRecord["status"],
  currency: row.currency,
  lines: lines.map(toCartLine),
  subtotalMinor: row.subtotalMinor,
  discountMinor: row.discountMinor,
  totalMinor: row.totalMinor,
  version: row.version,
  expiresAt: row.expiresAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toCheckout = (row: CheckoutRow): CheckoutRecord => {
  const contact: CheckoutContact = { email: row.contactEmail, phone: row.contactPhone, name: row.contactName };
  return {
    id: row.id,
    companyId: row.companyId,
    cartId: row.cartId,
    chatbotId: row.chatbotId,
    conversationId: row.conversationId,
    customerId: row.customerId,
    status: row.status as CheckoutRecord["status"],
    currency: row.currency,
    lines: row.lines as unknown as CartLine[],
    subtotalMinor: row.subtotalMinor,
    discountMinor: row.discountMinor,
    totalMinor: row.totalMinor,
    contact,
    orderRequest: (row.orderRequest as unknown as OrderRequest | null) ?? null,
    version: row.version,
    expiresAt: row.expiresAt,
    submittedAt: row.submittedAt,
    cancelledAt: row.cancelledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

const toSpendLimit = (row: SpendLimitRow): SpendLimitRecord => ({
  id: row.id,
  companyId: row.companyId,
  scopeType: row.scopeType as SpendScopeType,
  scopeId: row.scopeId,
  currency: row.currency,
  maxOrderMinor: row.maxOrderMinor,
  dailyLimitMinor: row.dailyLimitMinor,
  spentMinor: row.spentMinor,
  periodDate: row.periodDate,
  enabled: row.enabled,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * Postgres implementation of CartStorage. Inside transaction() it passes a transaction-bound instance
 * to the callback. There, reads of the cart, checkout and spend-limit rows use SELECT ... FOR UPDATE,
 * so a second transaction waits until the first commits. Outside a transaction, reads take no lock.
 *
 * The database guarantees hold without the lock as well: partial unique indexes stop a second active
 * cart or open checkout, and the idempotency unique index stops a repeated key. Those return
 * CartError codes through mapCartDatabaseError.
 */
export class DrizzleCartStorage implements CartStorage {
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
      throw mapCartDatabaseError(error);
    }
  }

  private async loadCart(companyId: string, row: CartRow): Promise<CartRecord> {
    const lines = await this.run(selectCartLinesQuery(this.db, companyId, row.id));
    return toCart(row, lines);
  }

  async transaction<T>(companyId: string, fn: (tx: CartStorage) => Promise<T>): Promise<T> {
    requireCompanyId(companyId);
    try {
      return await this.db.transaction((tx) => fn(new DrizzleCartStorage(tx, { inTransaction: true })));
    } catch (error) {
      throw mapCartDatabaseError(error);
    }
  }

  async findActiveCart(companyId: string, conversationId: string): Promise<CartRecord | null> {
    const scope = requireCompanyId(companyId);
    const [row] = await this.run(selectActiveCartQuery(this.db, scope, conversationId));
    return row ? this.loadCart(scope, row) : null;
  }

  async getCart(companyId: string, cartId: string): Promise<CartRecord | null> {
    const scope = requireCompanyId(companyId);
    const [row] = await this.run(selectCartQuery(this.db, scope, cartId, this.inTransaction));
    return row ? this.loadCart(scope, row) : null;
  }

  async putCart(companyId: string, cart: CartRecord): Promise<void> {
    const scope = requireCompanyId(companyId);
    const at = cart.updatedAt;
    await this.run(
      this.db.transaction(async (tx) => {
        await upsertCartQuery(tx, scope, cart);
        await deleteCartLinesQuery(tx, scope, cart.id);
        if (cart.lines.length > 0) {
          await insertCartLinesQuery(tx, scope, cart.id, cart.lines, at);
        }
      }),
    );
  }

  async insertActiveCartOrFind(companyId: string, cart: CartRecord): Promise<CartRecord> {
    const scope = requireCompanyId(companyId);
    // A cart is created with no lines, so the insert needs no line rows.
    await this.run(insertActiveCartIfAbsentQuery(this.db, scope, cart));
    const [row] = await this.run(selectActiveCartQuery(this.db, scope, cart.conversationId));
    if (!row) {
      throw new CartError("conflict", "The conversation's active cart could not be read back.");
    }
    return this.loadCart(scope, row);
  }

  async findCartOperation(companyId: string, cartId: string, idempotencyKey: string): Promise<CartOperationRecord | null> {
    const [row] = await this.run(selectOperationQuery(this.db, requireCompanyId(companyId), "cart", cartId, idempotencyKey));
    if (!row) return null;
    return { companyId: row.companyId, cartId: row.ownerId, idempotencyKey: row.idempotencyKey, requestHash: row.requestHash, operation: row.operation, createdAt: row.createdAt };
  }

  async putCartOperation(companyId: string, operation: CartOperationRecord): Promise<void> {
    const scope = requireCompanyId(companyId);
    await this.run(insertOperationQuery(this.db, scope, "cart", operation.cartId, operation));
  }

  async getCheckout(companyId: string, checkoutId: string): Promise<CheckoutRecord | null> {
    const scope = requireCompanyId(companyId);
    const [row] = await this.run(selectCheckoutQuery(this.db, scope, checkoutId, this.inTransaction));
    return row ? toCheckout(row) : null;
  }

  async findOpenCheckoutForCart(companyId: string, cartId: string): Promise<CheckoutRecord | null> {
    const [row] = await this.run(selectOpenCheckoutForCartQuery(this.db, requireCompanyId(companyId), cartId));
    return row ? toCheckout(row) : null;
  }

  async putCheckout(companyId: string, checkout: CheckoutRecord): Promise<void> {
    await this.run(upsertCheckoutQuery(this.db, requireCompanyId(companyId), checkout));
  }

  async findCheckoutOperation(companyId: string, checkoutId: string, idempotencyKey: string): Promise<CheckoutOperationRecord | null> {
    const [row] = await this.run(selectOperationQuery(this.db, requireCompanyId(companyId), "checkout", checkoutId, idempotencyKey));
    if (!row) return null;
    return { companyId: row.companyId, checkoutId: row.ownerId, idempotencyKey: row.idempotencyKey, requestHash: row.requestHash, operation: row.operation, createdAt: row.createdAt };
  }

  async putCheckoutOperation(companyId: string, operation: CheckoutOperationRecord): Promise<void> {
    const scope = requireCompanyId(companyId);
    await this.run(insertOperationQuery(this.db, scope, "checkout", operation.checkoutId, operation));
  }

  async findSpendLimits(companyId: string, targets: readonly SpendLimitTarget[]): Promise<SpendLimitRecord[]> {
    const scope = requireCompanyId(companyId);
    if (targets.length === 0) return [];
    const rows = await this.run(selectSpendLimitsQuery(this.db, scope, targets, this.inTransaction));
    return rows.map(toSpendLimit);
  }

  async putSpendLimit(companyId: string, limit: SpendLimitRecord): Promise<void> {
    await this.run(upsertSpendLimitQuery(this.db, requireCompanyId(companyId), limit));
  }
}

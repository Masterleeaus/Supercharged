/**
 * Storage port for the order-ops slice, with an in-memory reference implementation.
 *
 * Every method takes companyId first. A row whose companyId differs from the argument is invisible: get returns
 * null, find returns null, list leaves it out, and update returns null. Nothing is written with a companyId
 * that the caller did not pass.
 *
 * transaction() gives all-or-nothing writes. The in-memory version restores a snapshot when the work throws.
 * The Drizzle version (../../db/commerce-order-ops.ts) maps this to a database transaction.
 */
import { randomUUID } from "node:crypto";
import { requireCompanyId } from "../../chatbot-scope.ts";
import type {
  ImportRun,
  InventoryConflict,
  InventoryConflictEvent,
  InventoryMapping,
  InventoryPolicy,
  ListingSnapshot,
  MarketplaceOrder,
  MarketplaceOrderLine,
  OrderException,
  OrderExceptionEvent,
  OrderOpsOutboxRow,
  ScanRun,
  SettlementEntry,
  SettlementReconciliation,
  SyncCursor,
  UnifiedOrder,
  UnifiedSourceSnapshot,
  WorkbenchAction,
} from "./types.ts";

export interface TenantRow {
  id: string;
  companyId: string;
}

export interface Repo<T extends TenantRow> {
  insert(companyId: string, row: Omit<T, "id" | "companyId">): Promise<T>;
  get(companyId: string, id: string): Promise<T | null>;
  find(companyId: string, where: (row: T) => boolean): Promise<T | null>;
  list(companyId: string, where?: (row: T) => boolean): Promise<T[]>;
  update(companyId: string, id: string, patch: Partial<Omit<T, "id" | "companyId">>): Promise<T | null>;
}

export interface OrderOpsStore {
  transaction<R>(work: (store: OrderOpsStore) => Promise<R>): Promise<R>;
  policies: Repo<InventoryPolicy>;
  listings: Repo<ListingSnapshot>;
  mappings: Repo<InventoryMapping>;
  scanRuns: Repo<ScanRun>;
  conflicts: Repo<InventoryConflict>;
  conflictEvents: Repo<InventoryConflictEvent>;
  cursors: Repo<SyncCursor>;
  importRuns: Repo<ImportRun>;
  marketplaceOrders: Repo<MarketplaceOrder>;
  marketplaceLines: Repo<MarketplaceOrderLine>;
  unifiedOrders: Repo<UnifiedOrder>;
  unifiedSnapshots: Repo<UnifiedSourceSnapshot>;
  exceptions: Repo<OrderException>;
  exceptionEvents: Repo<OrderExceptionEvent>;
  actions: Repo<WorkbenchAction>;
  settlementEntries: Repo<SettlementEntry>;
  reconciliations: Repo<SettlementReconciliation>;
  outbox: Repo<OrderOpsOutboxRow>;
}

type Tables = Record<string, TenantRow[]>;

function createRepo<T extends TenantRow>(tables: Tables, name: string, newId: () => string): Repo<T> {
  const rows = (): T[] => (tables[name] ??= []) as T[];
  return {
    async insert(companyId, row) {
      const scope = requireCompanyId(companyId);
      const stored = { ...row, id: newId(), companyId: scope } as unknown as T;
      rows().push(stored);
      return structuredClone(stored);
    },
    async get(companyId, id) {
      const scope = requireCompanyId(companyId);
      const hit = rows().find((r) => r.companyId === scope && r.id === id);
      return hit ? structuredClone(hit) : null;
    },
    async find(companyId, where) {
      const scope = requireCompanyId(companyId);
      const hit = rows().find((r) => r.companyId === scope && where(structuredClone(r)));
      return hit ? structuredClone(hit) : null;
    },
    async list(companyId, where) {
      const scope = requireCompanyId(companyId);
      return rows()
        .filter((r) => r.companyId === scope && (where ? where(structuredClone(r)) : true))
        .map((r) => structuredClone(r));
    },
    async update(companyId, id, patch) {
      const scope = requireCompanyId(companyId);
      const hit = rows().find((r) => r.companyId === scope && r.id === id);
      if (!hit) return null;
      Object.assign(hit, patch);
      return structuredClone(hit);
    },
  };
}

/**
 * Outbox insert is idempotent by dedupeKey inside a company, as the database unique index is. A second insert with
 * the same key returns the first row and writes nothing. The Drizzle store does the same with ON CONFLICT DO NOTHING.
 */
export function dedupedOutbox(base: Repo<OrderOpsOutboxRow>): Repo<OrderOpsOutboxRow> {
  return {
    ...base,
    async insert(companyId, row) {
      const scope = requireCompanyId(companyId);
      const existing = await base.find(scope, (r) => r.dedupeKey === row.dedupeKey);
      if (existing) return existing;
      return base.insert(scope, row);
    },
  };
}

export function createMemoryOrderOpsStore(newId: () => string = () => randomUUID()): OrderOpsStore {
  const tables: Tables = {};
  const build = (): Omit<OrderOpsStore, "transaction"> => ({
    policies: createRepo(tables, "policies", newId),
    listings: createRepo(tables, "listings", newId),
    mappings: createRepo(tables, "mappings", newId),
    scanRuns: createRepo(tables, "scanRuns", newId),
    conflicts: createRepo(tables, "conflicts", newId),
    conflictEvents: createRepo(tables, "conflictEvents", newId),
    cursors: createRepo(tables, "cursors", newId),
    importRuns: createRepo(tables, "importRuns", newId),
    marketplaceOrders: createRepo(tables, "marketplaceOrders", newId),
    marketplaceLines: createRepo(tables, "marketplaceLines", newId),
    unifiedOrders: createRepo(tables, "unifiedOrders", newId),
    unifiedSnapshots: createRepo(tables, "unifiedSnapshots", newId),
    exceptions: createRepo(tables, "exceptions", newId),
    exceptionEvents: createRepo(tables, "exceptionEvents", newId),
    actions: createRepo(tables, "actions", newId),
    settlementEntries: createRepo(tables, "settlementEntries", newId),
    reconciliations: createRepo(tables, "reconciliations", newId),
    outbox: dedupedOutbox(createRepo<OrderOpsOutboxRow>(tables, "outbox", newId)),
  });

  const store: OrderOpsStore = {
    ...build(),
    async transaction(work) {
      const snapshot = structuredClone(tables);
      try {
        return await work(store);
      } catch (error) {
        for (const key of Object.keys(tables)) delete tables[key];
        Object.assign(tables, snapshot);
        throw error;
      }
    },
  };
  return store;
}

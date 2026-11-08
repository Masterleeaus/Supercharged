/**
 * Drizzle implementation of OrderOpsStore. It has the same interface and the same rules as the in-memory store in
 * storage.ts, so the services run unchanged on either one.
 *
 * Tenancy: every query puts company_id in its WHERE clause (or in the INSERT values), and every returned row is
 * checked against the company again in code. A row from another company is treated as absent.
 *
 * find() and list() take a JavaScript predicate, as the in-memory store does. SQL cannot run that predicate, so
 * these two read every row of the company and filter in memory. That is correct, but it is not an indexed query.
 * See DECISIONS.md. Hot paths can use the builders in drizzle-queries.ts.
 *
 * transaction() opens a database transaction. A nested call inside a transaction is a savepoint, so a failed
 * inner step rolls back only itself. The outbox row is written in the same transaction as the state change.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { requireCompanyId } from "../../chatbot-scope.ts";
import { chatbotEventOutbox } from "../../db/events.ts";
import {
  chatbotCommerceImportRuns,
  chatbotCommerceInventoryConflictEvents,
  chatbotCommerceInventoryConflicts,
  chatbotCommerceInventoryMappings,
  chatbotCommerceInventoryPolicies,
  chatbotCommerceInventoryScanRuns,
  chatbotCommerceListingSnapshots,
  chatbotCommerceMarketplaceOrderLines,
  chatbotCommerceMarketplaceOrders,
  chatbotCommerceOrderExceptionEvents,
  chatbotCommerceOrderExceptions,
  chatbotCommerceSettlementEntries,
  chatbotCommerceSettlementReconciliations,
  chatbotCommerceSyncCursors,
  chatbotCommerceUnifiedOrderSnapshots,
  chatbotCommerceUnifiedOrders,
  chatbotCommerceWorkbenchActions,
} from "../../db/commerce-order-ops.ts";
import type { OrderOpsStore, Repo, TenantRow } from "./storage.ts";
import type { OrderOpsOutboxRow } from "./types.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OrderOpsExecutor = PgDatabase<any, any, any>;

export interface DrizzleOrderOpsStoreOptions {
  /** Generates ids for inserted rows. Defaults to a random UUID. */
  newId?: () => string;
}

// Each order-ops table has companyId and id columns. The table types differ, so the repo helper takes the table loosely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTable = any;

function scopedRepo<T extends TenantRow>(exec: OrderOpsExecutor, table: AnyTable, newId: () => string): Repo<T> {
  const byId = async (scope: string, id: string): Promise<T | null> => {
    const rows = (await exec
      .select()
      .from(table)
      .where(and(eq(table.companyId, scope), eq(table.id, id)))
      .limit(1)) as T[];
    const hit = rows[0];
    return hit && hit.companyId === scope && hit.id === id ? hit : null;
  };
  const scopedRows = async (scope: string): Promise<T[]> => {
    const rows = (await exec.select().from(table).where(eq(table.companyId, scope))) as T[];
    return rows.filter((row) => row.companyId === scope);
  };

  return {
    async insert(companyId, row) {
      const scope = requireCompanyId(companyId);
      const values = { ...row, id: newId(), companyId: scope };
      const inserted = (await exec.insert(table).values(values).returning()) as T[];
      return inserted[0] as T;
    },
    async get(companyId, id) {
      return byId(requireCompanyId(companyId), id);
    },
    async find(companyId, where) {
      const scope = requireCompanyId(companyId);
      return (await scopedRows(scope)).find((row) => where(row)) ?? null;
    },
    async list(companyId, where) {
      const scope = requireCompanyId(companyId);
      const rows = await scopedRows(scope);
      return where ? rows.filter((row) => where(row)) : rows;
    },
    async update(companyId, id, patch) {
      const scope = requireCompanyId(companyId);
      // The id and the company can never be changed by a patch.
      const { id: _id, companyId: _company, ...changes } = patch as Record<string, unknown>;
      if (Object.keys(changes).length === 0) return byId(scope, id);
      const updated = (await exec
        .update(table)
        .set(changes)
        .where(and(eq(table.companyId, scope), eq(table.id, id)))
        .returning()) as T[];
      const row = updated[0];
      return row && row.companyId === scope && row.id === id ? row : null;
    },
  };
}

function outboxRepo(exec: OrderOpsExecutor, newId: () => string): Repo<OrderOpsOutboxRow> {
  const base = scopedRepo<OrderOpsOutboxRow>(exec, chatbotEventOutbox, newId);
  return {
    ...base,
    async insert(companyId, row) {
      const scope = requireCompanyId(companyId);
      const values = { ...row, id: newId(), companyId: scope };
      const inserted = (await exec
        .insert(chatbotEventOutbox)
        .values(values)
        .onConflictDoNothing({ target: [chatbotEventOutbox.companyId, chatbotEventOutbox.dedupeKey] })
        .returning()) as OrderOpsOutboxRow[];
      if (inserted[0]) return inserted[0];
      // The key already exists for this company. Return that row, as the in-memory store does.
      const existing = (await exec
        .select()
        .from(chatbotEventOutbox)
        .where(and(eq(chatbotEventOutbox.companyId, scope), eq(chatbotEventOutbox.dedupeKey, row.dedupeKey)))
        .limit(1)) as OrderOpsOutboxRow[];
      return existing[0] as OrderOpsOutboxRow;
    },
  };
}

function buildStore(exec: OrderOpsExecutor, newId: () => string): OrderOpsStore {
  return {
    transaction: <R>(work: (store: OrderOpsStore) => Promise<R>) => exec.transaction((tx) => work(buildStore(tx, newId))),
    policies: scopedRepo(exec, chatbotCommerceInventoryPolicies, newId),
    listings: scopedRepo(exec, chatbotCommerceListingSnapshots, newId),
    mappings: scopedRepo(exec, chatbotCommerceInventoryMappings, newId),
    scanRuns: scopedRepo(exec, chatbotCommerceInventoryScanRuns, newId),
    conflicts: scopedRepo(exec, chatbotCommerceInventoryConflicts, newId),
    conflictEvents: scopedRepo(exec, chatbotCommerceInventoryConflictEvents, newId),
    cursors: scopedRepo(exec, chatbotCommerceSyncCursors, newId),
    importRuns: scopedRepo(exec, chatbotCommerceImportRuns, newId),
    marketplaceOrders: scopedRepo(exec, chatbotCommerceMarketplaceOrders, newId),
    marketplaceLines: scopedRepo(exec, chatbotCommerceMarketplaceOrderLines, newId),
    unifiedOrders: scopedRepo(exec, chatbotCommerceUnifiedOrders, newId),
    unifiedSnapshots: scopedRepo(exec, chatbotCommerceUnifiedOrderSnapshots, newId),
    exceptions: scopedRepo(exec, chatbotCommerceOrderExceptions, newId),
    exceptionEvents: scopedRepo(exec, chatbotCommerceOrderExceptionEvents, newId),
    actions: scopedRepo(exec, chatbotCommerceWorkbenchActions, newId),
    settlementEntries: scopedRepo(exec, chatbotCommerceSettlementEntries, newId),
    reconciliations: scopedRepo(exec, chatbotCommerceSettlementReconciliations, newId),
    outbox: outboxRepo(exec, newId),
  };
}

/**
 * Builds the Drizzle store over a database handle or a transaction handle. Pass the handle the caller owns.
 * The tables are defined in db/commerce-order-ops.ts (and the outbox table in db/events.ts). No migration is applied here.
 */
export function createDrizzleOrderOpsStore(exec: OrderOpsExecutor, options: DrizzleOrderOpsStoreOptions = {}): OrderOpsStore {
  return buildStore(exec, options.newId ?? (() => randomUUID()));
}

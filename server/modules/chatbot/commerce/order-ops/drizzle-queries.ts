/**
 * Drizzle query builders for the hot paths of the order-ops slice. Each builder takes companyId and puts it in
 * the WHERE clause (or, for inserts, in the values). The builders never execute. A caller runs them through its
 * own database handle, and the tests render them with PgDialect to check the company predicate without a database.
 *
 * These cover the lookups the in-memory store does with a predicate. A full DrizzleOrderOpsStore that implements
 * OrderOpsStore is not written yet (see DECISIONS.md).
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  chatbotCommerceInventoryConflicts,
  chatbotCommerceMarketplaceOrders,
  chatbotCommerceOrderExceptions,
  chatbotCommerceSettlementEntries,
  chatbotCommerceUnifiedOrders,
} from "../../db/commerce-order-ops.ts";

type OrderOpsDb = Pick<NodePgDatabase<Record<string, never>>, "select" | "insert" | "update">;

export function unifiedOrderByKey(db: OrderOpsDb, companyId: string, chatbotId: string, sourceType: string, sourceScope: string, sourceOrderId: string) {
  const t = chatbotCommerceUnifiedOrders;
  return db
    .select()
    .from(t)
    .where(
      and(
        eq(t.companyId, companyId),
        eq(t.chatbotId, chatbotId),
        eq(t.sourceType, sourceType),
        eq(t.sourceScope, sourceScope),
        eq(t.sourceOrderId, sourceOrderId),
      ),
    )
    .limit(1);
}

export function unifiedOrdersForChatbot(db: OrderOpsDb, companyId: string, chatbotId: string, limit: number) {
  const t = chatbotCommerceUnifiedOrders;
  return db
    .select()
    .from(t)
    .where(and(eq(t.companyId, companyId), eq(t.chatbotId, chatbotId)))
    .orderBy(desc(t.placedAt), desc(t.id))
    .limit(limit);
}

export function marketplaceOrderByExternalId(db: OrderOpsDb, companyId: string, connectionId: string, externalOrderId: string) {
  const t = chatbotCommerceMarketplaceOrders;
  return db
    .select()
    .from(t)
    .where(and(eq(t.companyId, companyId), eq(t.connectionId, connectionId), eq(t.externalOrderId, externalOrderId)))
    .limit(1);
}

export function openConflictsForConnection(db: OrderOpsDb, companyId: string, chatbotId: string, connectionId: string) {
  const t = chatbotCommerceInventoryConflicts;
  return db
    .select()
    .from(t)
    .where(
      and(
        eq(t.companyId, companyId),
        eq(t.chatbotId, chatbotId),
        eq(t.connectionId, connectionId),
        inArray(t.status, ["open", "acknowledged"]),
      ),
    )
    .orderBy(asc(t.firstDetectedAt), asc(t.id));
}

export function conflictStatusUpdate(db: OrderOpsDb, companyId: string, conflictId: string, status: string) {
  const t = chatbotCommerceInventoryConflicts;
  return db
    .update(t)
    .set({ status })
    .where(and(eq(t.companyId, companyId), eq(t.id, conflictId)))
    .returning();
}

export function openExceptionsForOrder(db: OrderOpsDb, companyId: string, unifiedOrderId: string) {
  const t = chatbotCommerceOrderExceptions;
  return db
    .select()
    .from(t)
    .where(and(eq(t.companyId, companyId), eq(t.unifiedOrderId, unifiedOrderId), inArray(t.status, ["open", "acknowledged"])));
}

export function settlementEntryByKey(db: OrderOpsDb, companyId: string, chatbotId: string, provider: string, sourceScope: string, externalEntryId: string) {
  const t = chatbotCommerceSettlementEntries;
  return db
    .select()
    .from(t)
    .where(
      and(
        eq(t.companyId, companyId),
        eq(t.chatbotId, chatbotId),
        eq(t.provider, provider),
        eq(t.sourceScope, sourceScope),
        eq(t.externalEntryId, externalEntryId),
      ),
    )
    .limit(1);
}

export function insertSettlementEntry(db: OrderOpsDb, companyId: string, row: typeof chatbotCommerceSettlementEntries.$inferInsert) {
  return db
    .insert(chatbotCommerceSettlementEntries)
    .values({ ...row, companyId })
    .returning();
}

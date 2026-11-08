/**
 * Marketplace order import. Port of MarketplaceOrderImportRuntime.php.
 *
 * Idempotent by (connection, external order id). Importing the same order again updates the one stored row
 * and its lines. It never creates a second order. A payload that fails validation is counted as rejected and
 * the rest of the page still imports. The cursor only moves when the page is stored.
 */
import type { HttpClient } from "../../contracts/index.ts";
import { assertCurrency, assertNonNegativeMinor, hashOf, sha256Hex } from "./canonical.ts";
import { assertConnectionScope, connectionRef } from "./support.ts";
import type { MarketplaceRegistry } from "./ports.ts";
import type { OrderOpsStore } from "./storage.ts";
import { createOrderProjector } from "./projector.ts";
import { OrderOpsError, type ConnectionScope, type ImportRun } from "./types.ts";

export interface OrderImportDeps {
  store: OrderOpsStore;
  marketplaces: MarketplaceRegistry;
  http: HttpClient;
  now?: () => Date;
}

interface ParsedLine {
  externalLineId: string;
  sku: string | null;
  title: string;
  quantity: number;
  unitAmount: number;
  taxAmount: number;
  snapshot: Record<string, unknown>;
}

interface ParsedOrder {
  externalOrderId: string;
  status: string;
  fulfillmentStatus: string | null;
  currency: string;
  totalAmount: number;
  buyerDisplayName: string | null;
  sourceHash: string;
  placedAt: Date | null;
  providerUpdatedAt: Date | null;
  lines: ParsedLine[];
  payload: Record<string, unknown>;
}

export function createMarketplaceOrderImport(deps: OrderImportDeps) {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());

  async function importOrders(companyId: string, scope: ConnectionScope): Promise<ImportRun> {
    assertConnectionScope(companyId, scope);
    const cursor = (await store.cursors.find(companyId, (c) => c.connectionId === scope.connectionId && c.scope === "orders")) ??
      (await store.cursors.insert(companyId, { connectionId: scope.connectionId, scope: "orders", cursor: {}, lastSyncedAt: null }));

    const run = await store.importRuns.insert(companyId, {
      chatbotId: scope.chatbotId,
      connectionId: scope.connectionId,
      scope: "orders",
      status: "running",
      cursorBefore: cursor.cursor,
      cursorAfter: null,
      recordsRead: 0,
      recordsRejected: 0,
      recordsCreated: 0,
      recordsUpdated: 0,
      failureReason: null,
      startedAt: now(),
      completedAt: null,
    });

    let read = 0;
    let rejected = 0;
    let created = 0;
    let updated = 0;
    try {
      const provider = deps.marketplaces.get(scope.provider);
      const page = await provider.read.importOrders(connectionRef(scope), Object.keys(cursor.cursor).length > 0 ? cursor.cursor : null, deps.http);
      const nextCursor = page.nextCursor ?? {};
      for (const payload of page.orders) {
        read++;
        let parsed: ParsedOrder;
        try {
          parsed = parseOrder(payload);
        } catch {
          rejected++;
          continue;
        }
        const outcome = await store.transaction(async (tx) => {
          const timestamp = now();
          const projector = createOrderProjector({ store: tx, now });
          const existing = await tx.marketplaceOrders.find(companyId, (o) => o.connectionId === scope.connectionId && o.externalOrderId === parsed.externalOrderId);
          const fields = {
            chatbotId: scope.chatbotId,
            connectionId: scope.connectionId,
            provider: scope.provider,
            externalOrderId: parsed.externalOrderId,
            status: parsed.status,
            fulfillmentStatus: parsed.fulfillmentStatus,
            currency: parsed.currency,
            totalAmount: parsed.totalAmount,
            buyerDisplayName: parsed.buyerDisplayName,
            sourceHash: parsed.sourceHash,
            snapshot: parsed.payload,
            placedAt: parsed.placedAt,
            providerUpdatedAt: parsed.providerUpdatedAt,
            lastImportedAt: timestamp,
          };
          const order = existing
            ? ((await tx.marketplaceOrders.update(companyId, existing.id, fields)) as NonNullable<typeof existing>)
            : await tx.marketplaceOrders.insert(companyId, { ...fields, firstImportedAt: timestamp });
          for (const line of parsed.lines) {
            const row = { orderId: order.id, externalLineId: line.externalLineId, sku: line.sku, title: line.title, quantity: line.quantity, unitAmount: line.unitAmount, taxAmount: line.taxAmount, snapshot: line.snapshot };
            const existingLine = await tx.marketplaceLines.find(companyId, (l) => l.orderId === order.id && l.externalLineId === line.externalLineId);
            if (existingLine) await tx.marketplaceLines.update(companyId, existingLine.id, row);
            else await tx.marketplaceLines.insert(companyId, row);
          }
          const lines = await tx.marketplaceLines.list(companyId, (l) => l.orderId === order.id);
          await projector.projectMarketplace(companyId, { ...order, id: order.id }, lines);
          return existing ? "updated" : "created";
        });
        if (outcome === "created") created++;
        else updated++;
      }

      await store.cursors.update(companyId, cursor.id, { cursor: nextCursor, lastSyncedAt: now() });
      const done = await store.importRuns.update(companyId, run.id, {
        status: "completed",
        cursorAfter: nextCursor,
        recordsRead: read,
        recordsRejected: rejected,
        recordsCreated: created,
        recordsUpdated: updated,
        completedAt: now(),
      });
      return done as ImportRun;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = await store.importRuns.update(companyId, run.id, {
        status: "failed",
        recordsRead: read,
        recordsRejected: rejected,
        recordsCreated: created,
        recordsUpdated: updated,
        failureReason: `Marketplace order import failed: ${sha256Hex(message)}`,
        completedAt: now(),
      });
      return failed as ImportRun;
    }
  }

  return { importOrders };
}

function parseOrder(payload: Record<string, unknown>): ParsedOrder {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new OrderOpsError("Order payload must be an object.");
  const externalOrderId = typeof payload.external_order_id === "string" ? payload.external_order_id.trim() : "";
  if (externalOrderId === "") throw new OrderOpsError("external_order_id is required.");
  const status = typeof payload.status === "string" ? payload.status.trim() : "";
  if (status === "") throw new OrderOpsError("status is required.");
  const currency = assertCurrency(String(payload.currency ?? "").toUpperCase());
  const totalAmount = assertNonNegativeMinor(payload.total_amount, "total_amount");
  const buyer = payload.buyer as Record<string, unknown> | undefined;
  const lines: ParsedLine[] = [];
  for (const raw of Array.isArray(payload.lines) ? payload.lines : []) {
    if (raw === null || typeof raw !== "object") continue;
    const line = raw as Record<string, unknown>;
    const externalLineId = typeof line.external_line_id === "string" ? line.external_line_id.trim() : "";
    if (externalLineId === "") continue;
    lines.push({
      externalLineId,
      sku: typeof line.sku === "string" ? line.sku : null,
      title: typeof line.title === "string" ? line.title : "",
      quantity: assertNonNegativeMinor(line.quantity, "quantity"),
      unitAmount: assertNonNegativeMinor(line.unit_amount, "unit_amount"),
      taxAmount: assertNonNegativeMinor(line.tax_amount ?? 0, "tax_amount"),
      snapshot: line,
    });
  }
  return {
    externalOrderId,
    status,
    fulfillmentStatus: typeof payload.fulfillment_status === "string" ? payload.fulfillment_status : null,
    currency,
    totalAmount,
    buyerDisplayName: typeof buyer?.display_name === "string" ? buyer.display_name : null,
    sourceHash: typeof payload.source_hash === "string" && payload.source_hash !== "" ? payload.source_hash : hashOf(payload),
    placedAt: parseDate(payload.placed_at),
    providerUpdatedAt: parseDate(payload.updated_at),
    lines,
    payload,
  };
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Settlement import and reconciliation. Port of OrderSettlementRuntime.php.
 *
 * Entries are idempotent by (chatbot, provider, source scope, external entry id). Re-sending an entry with the
 * same data changes nothing. Re-using an id with different data is refused. Totals are integer minor units.
 * Each reconciliation stores a report whose expected lines sum to the expected net, and that sum is checked.
 */
import { assertMinor, hashOf } from "./canonical.ts";
import { buildSettlementReport, calculateSettlement } from "./settlement-math.ts";
import type { OrderOpsStore } from "./storage.ts";
import { OrderOpsError, type SettlementEntry, type SettlementReconciliation, type UnifiedOrder } from "./types.ts";

export interface SettlementDeps {
  store: OrderOpsStore;
  now?: () => Date;
}

export interface SettlementImportInput {
  provider: string;
  sourceScope?: string | null;
  sourceBatchId?: string | null;
  entries: Record<string, unknown>[];
}

const GROSS_TYPES = ["sale", "gross", "order"];

export function createOrderSettlement(deps: SettlementDeps) {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());

  async function requireOrder(companyId: string, chatbotId: string, orderId: string): Promise<UnifiedOrder> {
    const order = await store.unifiedOrders.get(companyId, orderId);
    if (!order || order.chatbotId !== chatbotId) throw new OrderOpsError("Order not found.", 404);
    return order;
  }

  async function importEntries(companyId: string, chatbotId: string, orderId: string, input: SettlementImportInput) {
    const order = await requireOrder(companyId, chatbotId, orderId);
    const provider = input.provider.trim().toLowerCase();
    const sourceScope = (input.sourceScope ?? "").trim() || order.sourceScope.trim() || provider;
    if (provider === "" || input.entries.length === 0) {
      throw new OrderOpsError("A provider and at least one settlement entry are required.");
    }

    let created = 0;
    let duplicates = 0;
    await store.transaction(async (tx) => {
      for (const [index, entry] of input.entries.entries()) {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
        const externalId = String(entry.external_entry_id ?? entry.id ?? "").trim();
        const type = String(entry.type ?? "adjustment").trim().toLowerCase();
        const currency = String(entry.currency ?? order.currency).trim().toUpperCase();
        if (externalId === "" || currency.length !== 3) {
          throw new OrderOpsError(`entries.${index}: every settlement entry requires an external_entry_id and a three-letter currency.`);
        }
        if (currency !== order.currency.toUpperCase()) {
          throw new OrderOpsError(`entries.${index}.currency: settlement currency must match the order currency.`);
        }
        const amount = assertMinor(entry.amount ?? 0, `entries.${index}.amount`);
        const sourceHash = hashOf(entry);
        const existing = await tx.settlementEntries.find(companyId, (e) => e.chatbotId === chatbotId && e.provider === provider && e.sourceScope === sourceScope && e.externalEntryId === externalId);
        if (existing) {
          if (existing.unifiedOrderId !== order.id || existing.sourceHash !== sourceHash) {
            throw new OrderOpsError(`entries.${index}: the settlement entry ID was already used with different immutable source data.`);
          }
          duplicates++;
          continue;
        }
        await tx.settlementEntries.insert(companyId, {
          chatbotId,
          unifiedOrderId: order.id,
          provider,
          sourceScope,
          externalEntryId: externalId,
          sourceBatchId: input.sourceBatchId ?? null,
          entryType: type,
          amount,
          currency,
          sourceHash,
          sourceSnapshot: entry,
          occurredAt: parseDate(entry.occurred_at),
          importedAt: now(),
        });
        created++;
      }
    });

    const reconciliation = await reconcile(companyId, chatbotId, orderId);
    return { created, duplicates, reconciliation: reconciliation.reconciliation };
  }

  async function reconcile(companyId: string, chatbotId: string, orderId: string): Promise<{ reconciliation: SettlementReconciliation; order: UnifiedOrder }> {
    const order = await requireOrder(companyId, chatbotId, orderId);
    const entries = await store.settlementEntries.list(companyId, (e) => e.unifiedOrderId === order.id);
    const normalized = entries.map((e) => ({ type: e.entryType, amount: e.amount }));
    if (!normalized.some((e) => GROSS_TYPES.includes(e.type))) {
      normalized.push({ type: "sale", amount: order.grossTotal });
    }
    const calculation = calculateSettlement(normalized);
    const report = buildSettlementReport(order.currency, normalized);
    const evidence = {
      entry_ids: entries.map((e) => e.id),
      entry_hashes: entries.map((e) => e.sourceHash),
      order_source_hash: order.sourceHash,
    };
    const calculationHash = hashOf([calculation, evidence]);

    return store.transaction(async (tx) => {
      const existing = await tx.reconciliations.find(companyId, (r) => r.unifiedOrderId === order.id && r.calculationHash === calculationHash);
      const row =
        existing ??
        (await tx.reconciliations.insert(companyId, {
          chatbotId,
          unifiedOrderId: order.id,
          calculationHash,
          calculation: { ...calculation },
          report,
          evidence,
          reconciledAt: now(),
        }));
      const updated = (await tx.unifiedOrders.update(companyId, order.id, {
        feeTotal: calculation.feeAmount,
        shippingCostTotal: calculation.shippingCostAmount,
        refundTotal: Math.max(order.refundTotal, calculation.refundAmount),
        chargebackTotal: calculation.chargebackAmount,
        expectedNetPayout: calculation.expectedNetAmount,
        reportedNetPayout: calculation.reportedNetAmount,
        settlementVariance: calculation.varianceAmount,
        reconciliationStatus: calculation.status,
      })) as UnifiedOrder;
      return { reconciliation: row as SettlementReconciliation, order: updated };
    });
  }

  async function listEntries(companyId: string, chatbotId: string, orderId: string): Promise<SettlementEntry[]> {
    await requireOrder(companyId, chatbotId, orderId);
    return store.settlementEntries.list(companyId, (e) => e.unifiedOrderId === orderId);
  }

  return { importEntries, reconcile, listEntries };
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}


/**
 * Unified order projection: one view of native orders and marketplace orders, keyed by
 * (company, chatbot, source type, source scope, source order id). Port of UnifiedOrderProjectorRuntime.php.
 *
 * Native orders come from the orders slice through NativeOrderSource (public OrderDetail type only).
 * Re-projecting an order refreshes its source fields. It never resets the settlement fields, which only the
 * settlement service writes.
 */
import type { OrderDetail } from "../../orders/index.ts";
import { assertCurrency, assertNonNegativeMinor, hashOf, isExternalSource, normalizeSource, requireText } from "./canonical.ts";
import type { NativeOrderSource } from "./ports.ts";
import type { OrderOpsStore } from "./storage.ts";
import { OrderOpsError, type MarketplaceOrder, type MarketplaceOrderLine, type UnifiedOrder } from "./types.ts";

export interface ProjectorDeps {
  store: OrderOpsStore;
  now?: () => Date;
}

const DISPUTED_RETURN_STATUSES = ["disputed", "rejected", "chargeback"];

type ProjectionKey = { chatbotId: string; sourceType: string; sourceScope: string; sourceOrderId: string };

export function createOrderProjector(deps: ProjectorDeps) {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());

  async function persist(companyId: string, key: ProjectionKey, snapshot: Record<string, unknown>, attributes: Record<string, unknown>): Promise<UnifiedOrder> {
    const sourceHash = hashOf(snapshot);
    const existing = await store.unifiedOrders.find(companyId, (o) => o.chatbotId === key.chatbotId && o.sourceType === key.sourceType && o.sourceScope === key.sourceScope && o.sourceOrderId === key.sourceOrderId);
    const timestamp = now();
    const common = { ...attributes, sourceSnapshot: snapshot, sourceHash, lastProjectedAt: timestamp };
    let order: UnifiedOrder;
    if (existing) {
      order = (await store.unifiedOrders.update(companyId, existing.id, common)) as UnifiedOrder;
    } else {
      order = await store.unifiedOrders.insert(companyId, {
        ...key,
        ...common,
        feeTotal: 0,
        shippingCostTotal: 0,
        expectedNetPayout: 0,
        reportedNetPayout: 0,
        settlementVariance: 0,
        reconciliationStatus: "unreconciled",
      } as Omit<UnifiedOrder, "id" | "companyId">);
    }
    const seen = await store.unifiedSnapshots.find(companyId, (s) => s.unifiedOrderId === order.id && s.sourceHash === sourceHash);
    if (!seen) {
      const all = await store.unifiedSnapshots.list(companyId, (s) => s.unifiedOrderId === order.id);
      const sequence = all.reduce((max, s) => Math.max(max, s.sequence), 0) + 1;
      await store.unifiedSnapshots.insert(companyId, { unifiedOrderId: order.id, sequence, sourceHash, snapshot, capturedAt: timestamp });
    }
    return order;
  }

  async function projectNative(companyId: string, detail: OrderDetail): Promise<UnifiedOrder> {
    const order = detail.order;
    if (order.companyId !== companyId) throw new OrderOpsError("Order not found.", 404);
    const payment = order.paymentSnapshot ?? {};
    const paymentStatus = typeof payment.status === "string" && payment.status !== "" ? payment.status : "unpaid";
    const returnDisputed = detail.returns.some((r) => DISPUTED_RETURN_STATUSES.includes(String(r.returnRecord.status)));
    const snapshot: Record<string, unknown> = {
      kind: "native_order",
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      fulfillmentStatus: order.fulfillmentStatus,
      currency: order.currency,
      subtotal: order.subtotal,
      discountTotal: order.discountTotal,
      taxTotal: order.taxTotal,
      shippingTotal: order.shippingTotal,
      total: order.total,
      refundedTotal: order.refundedTotal,
      customerSnapshot: order.customerSnapshot,
      shippingAddress: order.shippingAddress,
      paymentStatus,
      items: detail.items.map((i) => ({ id: i.id, sku: i.sku, name: i.name, quantity: i.quantity, unitPrice: i.unitPrice, lineTotal: i.lineTotal })),
      returns: detail.returns.map((r) => ({ id: r.returnRecord.id, status: r.returnRecord.status })),
      placedAt: order.placedAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
      return_disputed: returnDisputed,
    };
    const name = typeof order.customerSnapshot.name === "string" ? order.customerSnapshot.name : typeof order.customerSnapshot.email === "string" ? order.customerSnapshot.email : "";
    return persist(
      companyId,
      { chatbotId: order.chatbotId, sourceType: "native", sourceScope: "native", sourceOrderId: order.id },
      snapshot,
      {
        nativeOrderId: order.id,
        marketplaceOrderId: null,
        connectionId: null,
        externalAuthoritative: false,
        status: order.status,
        fulfillmentStatus: order.fulfillmentStatus,
        paymentStatus,
        currency: order.currency.toUpperCase(),
        grossTotal: order.total,
        discountTotal: order.discountTotal,
        taxTotal: order.taxTotal,
        shippingTotal: order.shippingTotal,
        refundTotal: order.refundedTotal,
        chargebackTotal: 0,
        buyerDisplayName: name,
        shippingAddress: order.shippingAddress,
        placedAt: order.placedAt,
        sourceUpdatedAt: order.updatedAt,
        metadata: { order_number: order.orderNumber, source: "native" },
      },
    );
  }

  async function projectMarketplace(companyId: string, order: MarketplaceOrder, lines: MarketplaceOrderLine[]): Promise<UnifiedOrder> {
    if (order.companyId !== companyId) throw new OrderOpsError("Order not found.", 404);
    const snapshot: Record<string, unknown> = {
      ...order.snapshot,
      lines: lines.map((l) => ({ external_line_id: l.externalLineId, sku: l.sku, title: l.title, quantity: l.quantity, unit_amount: l.unitAmount, tax_amount: l.taxAmount })),
    };
    const sourceType = normalizeSource(order.provider);
    const lineTax = lines.reduce((sum, l) => sum + l.taxAmount, 0);
    const paymentStatus = String(snapshot.payment_status ?? snapshot.financial_status ?? "unknown");
    return persist(
      companyId,
      { chatbotId: order.chatbotId, sourceType, sourceScope: `connection:${order.connectionId}`, sourceOrderId: order.externalOrderId },
      snapshot,
      {
        nativeOrderId: null,
        marketplaceOrderId: order.id,
        connectionId: order.connectionId,
        externalAuthoritative: isExternalSource(sourceType),
        status: order.status,
        fulfillmentStatus: order.fulfillmentStatus ?? "unknown",
        paymentStatus,
        currency: order.currency,
        grossTotal: order.totalAmount,
        discountTotal: numberOr(snapshot.discount_total, 0),
        taxTotal: numberOr(snapshot.tax_total, lineTax),
        shippingTotal: numberOr(snapshot.shipping_total, 0),
        refundTotal: numberOr(snapshot.refund_total, 0),
        chargebackTotal: numberOr(snapshot.chargeback_total, 0),
        buyerDisplayName: order.buyerDisplayName,
        shippingAddress: recordOr(snapshot.shipping_address ?? snapshot.delivery_address),
        placedAt: order.placedAt,
        sourceUpdatedAt: order.providerUpdatedAt,
        metadata: { external_order_id: order.externalOrderId, provider: sourceType, connection_id: order.connectionId },
      },
    );
  }

  /** Projects a source that is not on the marketplace table, such as a store platform the caller reads directly. */
  async function projectExternal(
    companyId: string,
    chatbotId: string,
    sourceType: string,
    sourceScope: string,
    sourceOrderId: string,
    snapshot: Record<string, unknown>,
    connection: { companyId: string; connectionId: string } | null = null,
  ): Promise<UnifiedOrder> {
    const source = normalizeSource(sourceType);
    if (!isExternalSource(source)) throw new OrderOpsError("External projection requires a marketplace or store source.");
    const orderId = requireText(sourceOrderId, "source_order_id");
    if (connection && connection.companyId !== companyId) throw new OrderOpsError("Marketplace connection not found.", 404);
    return persist(
      companyId,
      { chatbotId, sourceType: source, sourceScope: sourceScope.trim() !== "" ? sourceScope.trim() : source, sourceOrderId: orderId },
      snapshot,
      {
        nativeOrderId: null,
        marketplaceOrderId: null,
        connectionId: connection?.connectionId ?? null,
        externalAuthoritative: true,
        status: String(snapshot.status ?? "unknown"),
        fulfillmentStatus: String(snapshot.fulfillment_status ?? "unknown"),
        paymentStatus: String(snapshot.payment_status ?? snapshot.financial_status ?? "unknown"),
        currency: assertCurrency(String(snapshot.currency ?? "USD").toUpperCase()),
        grossTotal: assertNonNegativeMinor(numberOr(snapshot.total_amount ?? snapshot.total, 0), "total"),
        discountTotal: numberOr(snapshot.discount_total, 0),
        taxTotal: numberOr(snapshot.tax_total, 0),
        shippingTotal: numberOr(snapshot.shipping_total, 0),
        refundTotal: numberOr(snapshot.refund_total, 0),
        chargebackTotal: numberOr(snapshot.chargeback_total, 0),
        buyerDisplayName: String((snapshot.buyer as Record<string, unknown> | undefined)?.display_name ?? snapshot.buyer_display_name ?? ""),
        shippingAddress: recordOr(snapshot.shipping_address ?? snapshot.delivery_address),
        placedAt: snapshot.placed_at ? new Date(String(snapshot.placed_at)) : null,
        sourceUpdatedAt: snapshot.updated_at ? new Date(String(snapshot.updated_at)) : null,
        metadata: { source, source_scope: sourceScope },
      },
    );
  }

  /** Projects every native and marketplace order of one chatbot. Only rows of this company are read. */
  async function syncChatbot(companyId: string, chatbotId: string, native: NativeOrderSource): Promise<{ native_projected: number; external_projected: number; total_projected: number }> {
    let nativeCount = 0;
    for (const detail of await native.listForChatbot(companyId, chatbotId)) {
      if (detail.order.chatbotId !== chatbotId) continue;
      await projectNative(companyId, detail);
      nativeCount++;
    }
    let externalCount = 0;
    const orders = await store.marketplaceOrders.list(companyId, (o) => o.chatbotId === chatbotId);
    for (const order of orders) {
      const lines = await store.marketplaceLines.list(companyId, (l) => l.orderId === order.id);
      await projectMarketplace(companyId, order, lines);
      externalCount++;
    }
    return { native_projected: nativeCount, external_projected: externalCount, total_projected: nativeCount + externalCount };
  }

  return { projectNative, projectMarketplace, projectExternal, syncChatbot };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : fallback;
}

function recordOr(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

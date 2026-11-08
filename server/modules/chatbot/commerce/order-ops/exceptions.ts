/**
 * Order exceptions: detection, acknowledge, assign and resolve, with an audit event for every change.
 * Port of OrderExceptionRuntime.php.
 *
 * Exceptions are never deleted. Each change writes an OrderExceptionEvent holding the state before and after.
 * A scan opens, reopens or auto-resolves exceptions. A seller's manual resolve is kept until the scan
 * finds the condition again, and then the exception reopens (PHP behaviour; see DECISIONS.md).
 */
import { detectExceptions, EXCEPTION_TITLES, exceptionFingerprint } from "./exception-detector.ts";
import type { OrderOpsStore } from "./storage.ts";
import { OrderOpsError, type OrderException, type OrderExceptionEvent, type UnifiedOrder } from "./types.ts";

export interface ExceptionDeps {
  store: OrderOpsStore;
  now?: () => Date;
  /** Seconds an order may stay unfulfilled before it is flagged. PHP default is 172800 (two days). */
  fulfilmentDelaySeconds?: number;
}

export function createOrderExceptions(deps: ExceptionDeps) {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const delay = deps.fulfilmentDelaySeconds ?? 172_800;

  async function scanOrder(companyId: string, order: UnifiedOrder): Promise<{ opened: number; resolved: number; active: number }> {
    if (order.companyId !== companyId) throw new OrderOpsError("Order not found.", 404);
    let stockConflict = order.metadata.stock_conflict === true;
    if (!stockConflict && order.connectionId !== null) {
      const connectionId = order.connectionId;
      stockConflict = (await store.conflicts.find(companyId, (c) => c.chatbotId === order.chatbotId && c.connectionId === connectionId && (c.status === "open" || c.status === "acknowledged"))) !== null;
    }
    const detected = detectExceptions(
      {
        paymentStatus: order.paymentStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        placedAtMs: order.placedAt ? order.placedAt.getTime() : 0,
        shippingAddress: order.shippingAddress,
        stockConflict,
        returnDisputed: order.sourceSnapshot.return_disputed === true,
        reconciliationStatus: order.reconciliationStatus,
      },
      now().getTime(),
      delay,
    );

    return store.transaction(async (tx) => {
      const timestamp = now();
      const active: string[] = [];
      let opened = 0;
      let resolved = 0;
      for (const item of detected) {
        const fingerprint = exceptionFingerprint(order.id, item.type);
        active.push(fingerprint);
        const current = await tx.exceptions.find(companyId, (e) => e.unifiedOrderId === order.id && e.fingerprint === fingerprint);
        if (!current) {
          const created = await tx.exceptions.insert(companyId, {
            chatbotId: order.chatbotId,
            unifiedOrderId: order.id,
            exceptionType: item.type,
            fingerprint,
            severity: item.severity,
            status: "open",
            title: EXCEPTION_TITLES[item.type],
            summary: item.message,
            evidence: evidenceOf(order, item.type),
            firstDetectedAt: timestamp,
            lastDetectedAt: timestamp,
            assignedUserId: null,
            acknowledgedByUserId: null,
            acknowledgedAt: null,
            resolvedByUserId: null,
            resolvedAt: null,
            metadata: {},
          });
          opened++;
          await event(tx, companyId, created.id, "detected", null, null, {}, stateOf(created), timestamp);
          continue;
        }
        const wasResolved = current.status === "resolved";
        const updated = (await tx.exceptions.update(companyId, current.id, {
          severity: item.severity,
          status: wasResolved ? "open" : current.status,
          summary: item.message,
          evidence: evidenceOf(order, item.type),
          lastDetectedAt: timestamp,
          resolvedAt: wasResolved ? null : current.resolvedAt,
          resolvedByUserId: wasResolved ? null : current.resolvedByUserId,
        })) as OrderException;
        if (wasResolved) {
          opened++;
          await event(tx, companyId, current.id, "reopened", "system", null, {}, stateOf(updated), timestamp, stateOf(current));
        }
      }

      const stale = await tx.exceptions.list(companyId, (e) => e.unifiedOrderId === order.id && (e.status === "open" || e.status === "acknowledged") && !active.includes(e.fingerprint));
      for (const item of stale) {
        const updated = (await tx.exceptions.update(companyId, item.id, {
          status: "resolved",
          resolvedAt: timestamp,
          metadata: { ...item.metadata, auto_resolved: true },
        })) as OrderException;
        resolved++;
        await event(tx, companyId, item.id, "auto_resolved", "system", null, {}, stateOf(updated), timestamp, stateOf(item));
      }
      return { opened, resolved, active: active.length };
    });
  }

  async function scanChatbot(companyId: string, chatbotId: string): Promise<{ orders_scanned: number; exceptions_opened: number; exceptions_resolved: number }> {
    const orders = await store.unifiedOrders.list(companyId, (o) => o.chatbotId === chatbotId);
    let opened = 0;
    let resolved = 0;
    for (const order of orders) {
      const result = await scanOrder(companyId, order);
      opened += result.opened;
      resolved += result.resolved;
    }
    return { orders_scanned: orders.length, exceptions_opened: opened, exceptions_resolved: resolved };
  }

  async function listOpen(companyId: string, chatbotId: string, unifiedOrderId: string): Promise<OrderException[]> {
    return store.exceptions.list(companyId, (e) => e.chatbotId === chatbotId && e.unifiedOrderId === unifiedOrderId && (e.status === "open" || e.status === "acknowledged"));
  }

  async function acknowledge(companyId: string, chatbotId: string, exceptionId: string, userId: string): Promise<OrderException> {
    return store.transaction(async (tx) => {
      const current = await requireException(tx, companyId, chatbotId, exceptionId);
      const timestamp = now();
      const updated = (await tx.exceptions.update(companyId, current.id, { status: "acknowledged", acknowledgedByUserId: userId, acknowledgedAt: timestamp })) as OrderException;
      await event(tx, companyId, current.id, "acknowledged", "user", userId, {}, stateOf(updated), timestamp, stateOf(current));
      return updated;
    });
  }

  async function assign(companyId: string, chatbotId: string, exceptionId: string, assigneeUserId: string, actorUserId: string): Promise<OrderException> {
    return store.transaction(async (tx) => {
      const current = await requireException(tx, companyId, chatbotId, exceptionId);
      const timestamp = now();
      const updated = (await tx.exceptions.update(companyId, current.id, { assignedUserId: assigneeUserId })) as OrderException;
      await event(tx, companyId, current.id, "assigned", "user", actorUserId, { assignee_user_id: assigneeUserId }, stateOf(updated), timestamp, stateOf(current));
      return updated;
    });
  }

  async function resolve(companyId: string, chatbotId: string, exceptionId: string, userId: string, note: string | null = null): Promise<OrderException> {
    return store.transaction(async (tx) => {
      const current = await requireException(tx, companyId, chatbotId, exceptionId);
      const timestamp = now();
      const updated = (await tx.exceptions.update(companyId, current.id, {
        status: "resolved",
        resolvedByUserId: userId,
        resolvedAt: timestamp,
        metadata: { ...current.metadata, resolution_note: note },
      })) as OrderException;
      await event(tx, companyId, current.id, "resolved", "user", userId, { note }, stateOf(updated), timestamp, stateOf(current));
      return updated;
    });
  }

  async function auditTrail(companyId: string, chatbotId: string, exceptionId: string): Promise<OrderExceptionEvent[]> {
    await requireException(store, companyId, chatbotId, exceptionId);
    return store.exceptionEvents.list(companyId, (e) => e.exceptionId === exceptionId);
  }

  return { scanOrder, scanChatbot, listOpen, acknowledge, assign, resolve, auditTrail, withStore: (tx: OrderOpsStore) => createOrderExceptions({ ...deps, store: tx }) };
}

async function requireException(store: OrderOpsStore, companyId: string, chatbotId: string, exceptionId: string): Promise<OrderException> {
  const row = await store.exceptions.get(companyId, exceptionId);
  if (!row || row.chatbotId !== chatbotId) throw new OrderOpsError("Order exception not found.", 404);
  return row;
}

function evidenceOf(order: UnifiedOrder, type: string): Record<string, unknown> {
  return { type, source_hash: order.sourceHash, source_type: order.sourceType, source_order_id: order.sourceOrderId, reconciliation_status: order.reconciliationStatus };
}

function stateOf(row: OrderException | Partial<OrderException>): Record<string, unknown> {
  return {
    status: row.status,
    severity: row.severity,
    summary: row.summary,
    assignedUserId: row.assignedUserId ?? null,
    acknowledgedByUserId: row.acknowledgedByUserId ?? null,
    resolvedByUserId: row.resolvedByUserId ?? null,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  };
}

async function event(
  store: OrderOpsStore,
  companyId: string,
  exceptionId: string,
  eventType: string,
  actorType: "system" | "user" | null,
  actorUserId: string | null,
  metadata: Record<string, unknown>,
  after: Record<string, unknown>,
  at: Date,
  before: Record<string, unknown> = {},
): Promise<void> {
  await store.exceptionEvents.insert(companyId, { exceptionId, eventType, actorType, actorUserId, beforeState: before, afterState: after, metadata, occurredAt: at });
}

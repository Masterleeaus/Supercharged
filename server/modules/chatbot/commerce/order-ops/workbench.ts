/**
 * Unified order workbench and its tool outputs. Port of UnifiedOrderWorkbenchRuntime.php and
 * OrderWorkbenchToolRuntime.php.
 *
 * Safety rules kept from the PHP:
 *   - seller_order_workbench_sync needs explicit seller approval.
 *   - A refund is only proposed (awaiting_approval). Nothing here calls a payment provider.
 *   - A customer contact is only drafted (prepared). Nothing here sends a message.
 *   - Every write action has an idempotency key. The same key with the same request returns the stored
 *     action. The same key with a different request is refused.
 *   - Only the chatbot owner may run the tools.
 */
import { hashOf } from "./canonical.ts";
import { createOrderExceptions } from "./exceptions.ts";
import { createOrderProjector } from "./projector.ts";
import type { NativeOrderSource } from "./ports.ts";
import type { OrderOpsStore } from "./storage.ts";
import { createOrderSettlement } from "./settlement.ts";
import { OrderOpsError, type OrderException, type UnifiedOrder, type WorkbenchAction } from "./types.ts";

export interface WorkbenchDeps {
  store: OrderOpsStore;
  native: NativeOrderSource;
  now?: () => Date;
  proposalTtlMinutes?: number;
  fulfilmentDelaySeconds?: number;
}

export interface WorkbenchActor {
  userId: string | null;
  chatbotOwnerId: string;
}

export interface WorkbenchListFilters {
  source_type?: string;
  status?: string;
  fulfillment_status?: string;
  payment_status?: string;
  reconciliation_status?: string;
  unreconciled_only?: boolean;
  exceptions_only?: boolean;
  external_only?: boolean;
  search?: string;
}

export const WORKBENCH_TOOLS = [
  {
    name: "seller_order_workbench_list",
    description: "[inform] List unified native and external orders, including unfulfilled, unreconciled or exceptional orders.",
    parameters: {
      type: "object",
      properties: {
        source_type: { type: "string" }, status: { type: "string" }, fulfillment_status: { type: "string" },
        payment_status: { type: "string" }, unreconciled_only: { type: "boolean" }, exceptions_only: { type: "boolean" },
        search: { type: "string" }, limit: { type: "integer" },
      },
    },
  },
  {
    name: "seller_order_workbench_sync",
    description: "[prepare] Refresh the unified order projection and detect current exceptions.",
    parameters: { type: "object", properties: { seller_approved: { type: "boolean" } }, required: ["seller_approved"] },
  },
  {
    name: "seller_order_prepare_refund",
    description: "[prepare] Prepare a refund proposal. This never executes a native or external refund.",
    parameters: {
      type: "object",
      properties: { order_uuid: { type: "string" }, exception_uuid: { type: "string" }, amount: { type: "integer" }, reason: { type: "string" }, idempotency_key: { type: "string" } },
      required: ["order_uuid", "amount", "reason", "idempotency_key"],
    },
  },
  {
    name: "seller_order_prepare_customer_contact",
    description: "[prepare] Prepare a grounded customer-contact draft for an order exception. It is not sent.",
    parameters: {
      type: "object",
      properties: { order_uuid: { type: "string" }, exception_uuid: { type: "string" }, channel: { type: "string" }, idempotency_key: { type: "string" } },
      required: ["order_uuid", "idempotency_key"],
    },
  },
] as const;

export function createOrderWorkbench(deps: WorkbenchDeps) {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const ttl = deps.proposalTtlMinutes ?? 30;
  const projectorFor = (tx: OrderOpsStore) => createOrderProjector({ store: tx, now });
  const exceptionsFor = (tx: OrderOpsStore) => createOrderExceptions({ store: tx, now, fulfilmentDelaySeconds: deps.fulfilmentDelaySeconds });
  const settlements = createOrderSettlement({ store, now });
  const exceptions = exceptionsFor(store);

  function assertOwner(actor: WorkbenchActor): void {
    if (actor.userId === null || actor.userId !== actor.chatbotOwnerId) {
      throw new OrderOpsError("Only the authenticated chatbot owner can use order workbench tools.", 422);
    }
  }

  async function requireOrder(companyId: string, chatbotId: string, orderId: string): Promise<UnifiedOrder> {
    const order = await store.unifiedOrders.get(companyId, orderId);
    if (!order || order.chatbotId !== chatbotId) throw new OrderOpsError("Order not found.", 404);
    return order;
  }

  async function requireExceptionFor(companyId: string, chatbotId: string, order: UnifiedOrder, exceptionId: string): Promise<OrderException> {
    const row = await store.exceptions.get(companyId, exceptionId);
    if (!row || row.chatbotId !== chatbotId || row.unifiedOrderId !== order.id) throw new OrderOpsError("Order exception not found.", 404);
    return row;
  }

  async function list(companyId: string, chatbotId: string, filters: WorkbenchListFilters = {}, limit = 25) {
    const page = Math.min(100, Math.max(1, Math.trunc(limit)));
    const rawSearch = (filters.search ?? "").trim();
    const search = rawSearch.toLowerCase();
    const rows = await store.unifiedOrders.list(companyId, (o) => {
      if (o.chatbotId !== chatbotId) return false;
      if (filters.source_type?.trim() && o.sourceType !== filters.source_type.trim()) return false;
      if (filters.status?.trim() && o.status !== filters.status.trim()) return false;
      if (filters.fulfillment_status?.trim() && o.fulfillmentStatus !== filters.fulfillment_status.trim()) return false;
      if (filters.payment_status?.trim() && o.paymentStatus !== filters.payment_status.trim()) return false;
      if (filters.reconciliation_status?.trim() && o.reconciliationStatus !== filters.reconciliation_status.trim()) return false;
      if (filters.external_only === true && !o.externalAuthoritative) return false;
      if (filters.unreconciled_only === true && o.reconciliationStatus === "reconciled") return false;
      if (search !== "") {
        const hit = o.sourceOrderId.toLowerCase().includes(search) || (o.buyerDisplayName ?? "").toLowerCase().includes(search) || o.id === rawSearch;
        if (!hit) return false;
      }
      return true;
    });
    const withOpen = [];
    for (const order of rows) {
      const open = await exceptions.listOpen(companyId, chatbotId, order.id);
      if (filters.exceptions_only === true && open.length === 0) continue;
      withOpen.push({ order, open });
    }
    withOpen.sort((a, b) => placedMs(b.order) - placedMs(a.order) || (a.order.id < b.order.id ? 1 : -1));
    const items = withOpen.slice(0, page).map(({ order, open }) => ({
      uuid: order.id,
      source_type: order.sourceType,
      source_order_id: order.sourceOrderId,
      status: order.status,
      fulfillment_status: order.fulfillmentStatus,
      payment_status: order.paymentStatus,
      currency: order.currency,
      gross_total: order.grossTotal,
      reconciliation_status: order.reconciliationStatus,
      settlement_variance: order.settlementVariance,
      open_exceptions: open.map((e) => ({ uuid: e.id, type: e.exceptionType, severity: e.severity, summary: e.summary })),
    }));
    return { items, total: withOpen.length, limit: page };
  }

  async function sync(companyId: string, chatbotId: string, native: NativeOrderSource = deps.native) {
    const projection = await projectorFor(store).syncChatbot(companyId, chatbotId, native);
    const exceptionCounts = await exceptionsFor(store).scanChatbot(companyId, chatbotId);
    return { projection, exceptions: exceptionCounts };
  }

  async function reconcile(companyId: string, chatbotId: string, orderId: string): Promise<UnifiedOrder> {
    await settlements.reconcile(companyId, chatbotId, orderId);
    const fresh = await requireOrder(companyId, chatbotId, orderId);
    await exceptions.scanOrder(companyId, fresh);
    return requireOrder(companyId, chatbotId, orderId);
  }

  async function acknowledge(companyId: string, chatbotId: string, orderId: string, exceptionId: string, userId: string, key: string) {
    const order = await requireOrder(companyId, chatbotId, orderId);
    const exception = await requireExceptionFor(companyId, chatbotId, order, exceptionId);
    return lowRiskAction(companyId, chatbotId, order, exception, "acknowledge", key, userId, async (tx) => exceptionsFor(tx).acknowledge(companyId, chatbotId, exception.id, userId));
  }

  async function assign(companyId: string, chatbotId: string, orderId: string, exceptionId: string, assigneeUserId: string, actorUserId: string, key: string) {
    const order = await requireOrder(companyId, chatbotId, orderId);
    const exception = await requireExceptionFor(companyId, chatbotId, order, exceptionId);
    return lowRiskAction(companyId, chatbotId, order, exception, "assign", key, actorUserId, async (tx) => exceptionsFor(tx).assign(companyId, chatbotId, exception.id, assigneeUserId, actorUserId), { assignee_user_id: assigneeUserId }, assigneeUserId);
  }

  async function resolve(companyId: string, chatbotId: string, orderId: string, exceptionId: string, userId: string, key: string, note: string | null = null) {
    const order = await requireOrder(companyId, chatbotId, orderId);
    const exception = await requireExceptionFor(companyId, chatbotId, order, exceptionId);
    return lowRiskAction(companyId, chatbotId, order, exception, "resolve", key, userId, async (tx) => exceptionsFor(tx).resolve(companyId, chatbotId, exception.id, userId, note), { note });
  }

  /** Proposes a refund for seller approval. Records a proposal only. No payment provider is called. */
  async function prepareRefundProposal(
    companyId: string,
    chatbotId: string,
    orderId: string,
    exceptionId: string | null,
    amount: number,
    reason: string,
    key: string,
    userId: string,
  ): Promise<WorkbenchAction> {
    const idempotencyKey = requireKey(key);
    const order = await requireOrder(companyId, chatbotId, orderId);
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > Math.max(0, order.grossTotal - order.refundTotal)) {
      throw new OrderOpsError("Refund proposal amount exceeds the currently refundable order amount.");
    }
    const exception = exceptionId ? await requireExceptionFor(companyId, chatbotId, order, exceptionId) : null;
    const proposal = {
      amount,
      currency: order.currency,
      reason: reason.trim(),
      source_type: order.sourceType,
      external_authoritative: order.externalAuthoritative,
      required_next_step: order.externalAuthoritative
        ? "Execute refund in the authoritative external provider after seller approval."
        : "Use the native payment refund workflow after seller approval.",
    };
    return firstOrCreateAction(companyId, chatbotId, order, exception, "refund_proposal", idempotencyKey, proposal, userId, "awaiting_approval", amount, order.currency);
  }

  /** Drafts a customer message from the order facts. It is stored as a draft and not sent. */
  async function prepareCustomerContact(companyId: string, chatbotId: string, orderId: string, exceptionId: string | null, channel: string, key: string, userId: string): Promise<WorkbenchAction> {
    const idempotencyKey = requireKey(key);
    const order = await requireOrder(companyId, chatbotId, orderId);
    const exception = exceptionId ? await requireExceptionFor(companyId, chatbotId, order, exceptionId) : null;
    const summary = exception?.summary || "Order follow-up requested.";
    const greeting = order.buyerDisplayName ? ` ${order.buyerDisplayName}` : "";
    const draft = `Hello${greeting}, we are reviewing order ${order.sourceOrderId}. ${summary} We will confirm the next step through this channel.`;
    const proposal = {
      channel: channel.trim().toLowerCase() || "connected_inbox",
      draft,
      facts: { source_type: order.sourceType, order_id: order.sourceOrderId, status: order.status, fulfillment_status: order.fulfillmentStatus, payment_status: order.paymentStatus },
      transport_boundary: "Send through the existing chatbot-agent or channel extension. Order ops stores no channel credentials.",
    };
    return firstOrCreateAction(companyId, chatbotId, order, exception, "prepare_customer_contact", idempotencyKey, proposal, userId, "prepared");
  }

  /**
   * Runs one of the four tools for an actor. The actor must be the chatbot owner. Unknown tool names are refused.
   */
  async function execute(companyId: string, chatbotId: string, actor: WorkbenchActor, name: string, args: Record<string, unknown>) {
    assertOwner(actor);
    const userId = actor.userId as string;
    if (name === "seller_order_workbench_list") {
      const limit = typeof args.limit === "number" ? args.limit : 25;
      return { data: await list(companyId, chatbotId, filtersFrom(args), limit) };
    }
    if (name === "seller_order_workbench_sync") {
      if (args.seller_approved !== true) {
        throw new OrderOpsError("Explicit seller approval is required before refreshing external and native order projections.");
      }
      return { data: await sync(companyId, chatbotId) };
    }
    if (name === "seller_order_prepare_refund") {
      const exceptionId = typeof args.exception_uuid === "string" && args.exception_uuid !== "" ? args.exception_uuid : null;
      const action = await prepareRefundProposal(companyId, chatbotId, String(args.order_uuid ?? ""), exceptionId, Number(args.amount ?? 0), String(args.reason ?? ""), String(args.idempotency_key ?? ""), userId);
      return { data: action };
    }
    if (name === "seller_order_prepare_customer_contact") {
      const exceptionId = typeof args.exception_uuid === "string" && args.exception_uuid !== "" ? args.exception_uuid : null;
      const action = await prepareCustomerContact(companyId, chatbotId, String(args.order_uuid ?? ""), exceptionId, String(args.channel ?? "connected_inbox"), String(args.idempotency_key ?? ""), userId);
      return { data: action };
    }
    throw new OrderOpsError("Unsupported order workbench tool.");
  }

  async function lowRiskAction(
    companyId: string,
    chatbotId: string,
    order: UnifiedOrder,
    exception: OrderException | null,
    type: string,
    key: string,
    userId: string,
    operation: (tx: OrderOpsStore) => Promise<unknown>,
    proposal: Record<string, unknown> = {},
    assignee: string | null = null,
  ): Promise<WorkbenchAction> {
    const idempotencyKey = requireKey(key);
    const requestHash = actionHash(order, exception, type, proposal);
    const existing = await store.actions.find(companyId, (a) => a.chatbotId === chatbotId && a.idempotencyKey === idempotencyKey);
    if (existing) return assertSameRequest(existing, order, exception, type, requestHash);

    return store.transaction(async (tx) => {
      const action = await tx.actions.insert(companyId, {
        chatbotId,
        unifiedOrderId: order.id,
        exceptionId: exception?.id ?? null,
        actionType: type,
        status: "processing",
        idempotencyKey,
        requestHash,
        requestedByUserId: userId,
        assignedToUserId: assignee,
        amount: null,
        currency: null,
        sourceHash: order.sourceHash,
        proposal,
        result: null,
        expiresAt: null,
        executedAt: null,
        createdAt: now(),
      });
      const result = await operation(tx);
      const done = (await tx.actions.update(companyId, action.id, { status: "completed", result: toResult(result), executedAt: now() })) as WorkbenchAction;
      return done;
    });
  }

  async function firstOrCreateAction(
    companyId: string,
    chatbotId: string,
    order: UnifiedOrder,
    exception: OrderException | null,
    type: string,
    idempotencyKey: string,
    proposal: Record<string, unknown>,
    userId: string,
    status: WorkbenchAction["status"],
    amount: number | null = null,
    currency: string | null = null,
  ): Promise<WorkbenchAction> {
    const requestHash = actionHash(order, exception, type, proposal);
    const existing = await store.actions.find(companyId, (a) => a.chatbotId === chatbotId && a.idempotencyKey === idempotencyKey);
    if (existing) return assertSameRequest(existing, order, exception, type, requestHash);
    return store.actions.insert(companyId, {
      chatbotId,
      unifiedOrderId: order.id,
      exceptionId: exception?.id ?? null,
      actionType: type,
      status,
      idempotencyKey,
      requestHash,
      requestedByUserId: userId,
      assignedToUserId: null,
      amount,
      currency,
      sourceHash: order.sourceHash,
      proposal,
      result: null,
      expiresAt: status === "awaiting_approval" ? new Date(now().getTime() + ttl * 60_000) : null,
      executedAt: null,
      createdAt: now(),
    });
  }

  return { list, sync, reconcile, acknowledge, assign, resolve, prepareRefundProposal, prepareCustomerContact, execute, toolDefinitions: () => WORKBENCH_TOOLS };
}

function requireKey(key: string): string {
  const trimmed = (key ?? "").trim();
  if (trimmed === "" || trimmed.length > 191) {
    throw new OrderOpsError("A non-empty idempotency key of at most 191 characters is required.");
  }
  return trimmed;
}

function actionHash(order: UnifiedOrder, exception: OrderException | null, type: string, proposal: Record<string, unknown>): string {
  return hashOf({ unified_order_id: order.id, exception_id: exception?.id ?? null, action_type: type, proposal });
}

function assertSameRequest(existing: WorkbenchAction, order: UnifiedOrder, exception: OrderException | null, type: string, requestHash: string): WorkbenchAction {
  const same =
    existing.unifiedOrderId === order.id &&
    (existing.exceptionId ?? null) === (exception?.id ?? null) &&
    existing.actionType === type &&
    existing.requestHash === requestHash;
  if (!same) throw new OrderOpsError("Idempotency key was already used for a different order workbench request.");
  return existing;
}

function toResult(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value: value ?? null };
}

function placedMs(order: UnifiedOrder): number {
  return order.placedAt ? order.placedAt.getTime() : 0;
}

function filtersFrom(args: Record<string, unknown>): WorkbenchListFilters {
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    source_type: text(args.source_type),
    status: text(args.status),
    fulfillment_status: text(args.fulfillment_status),
    payment_status: text(args.payment_status),
    search: text(args.search),
    unreconciled_only: args.unreconciled_only === true,
    exceptions_only: args.exceptions_only === true,
  };
}


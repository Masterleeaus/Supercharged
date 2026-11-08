/**
 * Customer communications: inbound support messages, threads, policy, drafts, governed actions, and handoff.
 * Port of CustomerCommunicationRuntime.php and CustomerCommunicationContextRuntime.php.
 *
 * Rules enforced here:
 * - A draft is text only. Nothing is sent from this module, and canAutoSend is advice for the channel layer.
 * - Order, payment, fulfilment and return facts are shown only to a verified identity (the cart is the one exception,
 *   as in the PHP).
 * - A financial or fulfilment action is never executed by a model reply. It is proposed, then approved by a party
 *   with authority (see approval-gate.ts and authority.ts).
 * - Refunds also need the CHATBOT_PAYMENTS_ENABLED flag set to exactly "true".
 */
import { CONTRACT_FLAGS, readFlag, type FlagEnv } from "../../contracts/index.ts";
import { CommerceError } from "./errors.ts";
import { communicationReplyCard, escalationCard, type EscalationView, type ReplyDraftView } from "./cards.ts";
import {
  claimForExecution,
  completeAction,
  failAction,
  proposeAction,
  publicAction,
  type ApprovalActionStore,
  type ApprovalAction,
} from "./approval-gate.ts";
import {
  communicationAuthority,
  resolveCommerceRole,
  type ApproverActor,
  type AuthorityDecision,
  type AutomaticLimitKey,
  type AuthorityLevel,
} from "./authority.ts";

export const COMM_CHANNELS = ["web", "email", "sms", "whatsapp", "telegram", "messenger", "instagram", "marketplace_message", "internal_inbox"] as const;

export interface CommThread {
  id: string;
  companyId: string;
  chatbotId: string;
  channel: string;
  externalThreadId: string | null;
  customerId: number | null;
  sessionId: string | null;
  identityVerified: boolean;
  intent: string | null;
  confidence: number | null;
  priority: "normal" | "high" | "urgent";
  sentiment: "neutral" | "negative";
  status: "open" | "handoff" | "closed";
  lastMessageAt: Date | null;
}

export interface CommMessage {
  id: string;
  companyId: string;
  threadId: string;
  chatbotId: string;
  channel: string;
  externalMessageId: string | null;
  direction: "inbound" | "outbound";
  actorType: string;
  body: string;
  intent: string | null;
  confidence: number | null;
  receivedAt: Date;
}

export interface CommPolicy {
  companyId: string;
  chatbotId: string;
  autoReplyEnabled: boolean;
  /** 0 to 1. */
  autoReplyConfidence: number;
  limits: Record<AutomaticLimitKey, number>;
  currency: string;
  active: boolean;
}

export interface CommEscalation extends EscalationView {
  threadId: string;
  chatbotId: string;
  contextSnapshot: Record<string, unknown>;
}

export interface CommunicationStore {
  findMessageByExternalId(companyId: string, chatbotId: string, channel: string, externalId: string): Promise<CommMessage | null>;
  findThreadByExternalId(companyId: string, chatbotId: string, channel: string, externalThreadId: string): Promise<CommThread | null>;
  findThread(companyId: string, threadId: string): Promise<CommThread | null>;
  saveThread(thread: CommThread): Promise<void>;
  insertThread(thread: CommThread): Promise<void>;
  insertMessage(message: CommMessage): Promise<void>;
  findMessage(companyId: string, messageId: string): Promise<CommMessage | null>;
  latestInbound(companyId: string, threadId: string): Promise<CommMessage | null>;
  getPolicy(companyId: string, chatbotId: string): Promise<CommPolicy | null>;
  insertEscalation(escalation: CommEscalation): Promise<void>;
}

export interface OrderFact {
  id: string;
  companyId: string;
  orderNumber: string;
  status: string;
  fulfilmentStatus: string;
  sessionId: string | null;
  customerId: number | null;
  shippingAddress: Record<string, unknown>;
}

export interface CommerceFacts {
  activeCart: Record<string, unknown> | null;
  orders: { id: string; orderNumber: string; status: string }[];
  payments: { id: string; status: string; capturedMinor: number; refundedMinor: number; currency: string }[];
  fulfilments: { status: string; trackingNumber: string | null }[];
  returns: { rmaNumber: string; status: string }[];
}

export interface CommerceFactsPort {
  /** Loads the commerce records for a session or customer, company-scoped. */
  load(companyId: string, chatbotId: string, scope: { sessionId: string | null; customerId: number | null }): Promise<CommerceFacts>;
}

export interface CommOrdersPort {
  findScoped(companyId: string, chatbotId: string, orderId: string, scope: { sessionId: string | null; customerId: number | null }): Promise<OrderFact | null>;
  requestReturn(companyId: string, orderId: string, items: unknown[], resolution: string, reason: string | null, customerId: number | null): Promise<{ rmaNumber: string; status: string }>;
  cancel(companyId: string, orderId: string, idempotencyKey: string): Promise<{ status: string }>;
  correctAddress(companyId: string, orderId: string, address: Record<string, unknown>): Promise<{ status: string }>;
}

export interface RefundPort {
  refund(companyId: string, paymentId: string, amountMinor: number, currency: string, reason: string, idempotencyKey: string): Promise<{ refundedMinor: number; status: string }>;
}

export interface CommunicationDeps {
  store: CommunicationStore;
  approvals: ApprovalActionStore;
  facts: CommerceFactsPort;
  orders: CommOrdersPort;
  refunds: RefundPort;
  env: FlagEnv;
  now: () => Date;
  newId: () => string;
  actionTtlMinutes?: number;
}

export interface InboundMessage {
  actorType?: string;
  authenticated?: boolean;
  channel: string;
  externalMessageId?: string | null;
  externalThreadId?: string | null;
  body: string;
  intent?: string | null;
  confidence?: number | null;
  identityVerified?: boolean;
  customerId?: number | null;
  sessionId?: string | null;
}

const DEFAULT_CONFIDENCE_BY_INTENT = (intent: string): number => (intent === "product_question" ? 0.65 : 0.88);

const INTENT_PATTERNS: [string, string[]][] = [
  ["legal_threat", ["lawyer", "legal action", "sue ", "consumer affairs"]],
  ["fraud_suspected", ["fraud", "stolen card", "not my purchase"]],
  ["chargeback_dispute", ["chargeback", "bank dispute"]],
  ["delivery_delay", ["late", "delayed", "not arrived", "where is my order"]],
  ["tracking", ["tracking", "track my"]],
  ["return", ["return", "send it back"]],
  ["exchange", ["exchange", "different size", "swap"]],
  ["refund_status", ["refund status", "where is my refund"]],
  ["cancel_order", ["cancel my order", "cancel order"]],
  ["address_correction", ["wrong address", "change address", "correct address"]],
  ["payment_problem", ["payment failed", "charged twice", "payment problem"]],
  ["damaged_item", ["damaged", "broken", "defective"]],
  ["missing_item", ["missing item", "item missing"]],
  ["order_status", ["order status", "my order"]],
  ["checkout_problem", ["checkout", "coupon not working", "cannot buy"]],
  ["warranty", ["warranty", "guarantee"]],
  ["complaint", ["complaint", "unhappy", "terrible service"]],
];

/** Port of CustomerCommunicationRuntime::classifyIntent. First matching pattern wins. */
export function classifyIntent(body: string): string {
  const text = body.toLowerCase();
  for (const [intent, needles] of INTENT_PATTERNS) {
    if (needles.some((needle) => text.includes(needle))) return intent;
  }
  return "product_question";
}

function priorityFor(intent: string, body: string): CommThread["priority"] {
  if (["legal_threat", "fraud_suspected", "chargeback_dispute", "safety_incident"].includes(intent)) return "urgent";
  if (["delivery_delay", "damaged_item", "missing_item", "payment_problem"].includes(intent) || body.toLowerCase().includes("urgent")) return "high";
  return "normal";
}

function sentimentFor(body: string): CommThread["sentiment"] {
  const text = body.toLowerCase();
  return ["angry", "furious", "terrible", "disgusted", "unacceptable", "hate"].some((w) => text.includes(w)) ? "negative" : "neutral";
}

function authorityActionForIntent(intent: string): string {
  switch (intent) {
    case "order_status": return "get_order_status";
    case "tracking":
    case "delivery_delay": return "get_tracking";
    case "refund_status": return "get_refund_status";
    case "return_status": return "get_return_status";
    case "payment_problem": return "get_payment_status";
    case "legal_threat":
    case "fraud_suspected":
    case "chargeback_dispute":
    case "safety_incident": return intent;
    default: return "answer_product_question";
  }
}

const ZERO_LIMITS: Record<AutomaticLimitKey, number> = {
  automatic_refund_limit: 0,
  automatic_discount_limit: 0,
  automatic_store_credit_limit: 0,
  automatic_replacement_limit: 0,
  automatic_cancellation_limit: 0,
};

/** Safe default policy. Auto-reply is off and every automatic limit is zero, until the company changes them. */
export function defaultPolicy(companyId: string, chatbotId: string): CommPolicy {
  return { companyId, chatbotId, autoReplyEnabled: false, autoReplyConfidence: 0.9, limits: { ...ZERO_LIMITS }, currency: "USD", active: true };
}

function replyText(intent: string, facts: CommerceFacts, verified: boolean): string {
  if (["order_status", "tracking", "delivery_delay", "refund_status", "return_status", "payment_problem"].includes(intent) && !verified) {
    return "I can help with that, but I need to verify the customer before sharing private order or payment details.";
  }
  const latestOrder = facts.orders[0];
  const latestFulfilment = facts.fulfilments[0];
  const latestPayment = facts.payments[0];
  const latestReturn = facts.returns[0];
  switch (intent) {
    case "order_status":
      return latestOrder ? `Order ${latestOrder.orderNumber} is currently ${latestOrder.status}.` : "I could not find an order linked to this verified conversation.";
    case "tracking":
    case "delivery_delay":
      return latestFulfilment
        ? `The latest fulfilment is ${latestFulfilment.status}${latestFulfilment.trackingNumber ? ` with tracking number ${latestFulfilment.trackingNumber}` : ""}.`
        : "I could not find a shipment linked to this order yet.";
    case "refund_status":
    case "payment_problem":
      return latestPayment
        ? `The latest payment is ${latestPayment.status}. Captured: ${latestPayment.currency} ${(latestPayment.capturedMinor / 100).toFixed(2)}; refunded: ${latestPayment.currency} ${(latestPayment.refundedMinor / 100).toFixed(2)}.`
        : "I could not find a payment linked to this verified customer.";
    case "return_status":
    case "return":
    case "exchange":
      return latestReturn
        ? `Return ${latestReturn.rmaNumber} is currently ${latestReturn.status}.`
        : "I could not find an existing return. I can prepare a return request for approval.";
    case "cancel_order":
      return "I can prepare an order-cancellation request. It will be checked against the seller's approval policy before execution.";
    case "legal_threat":
    case "fraud_suspected":
    case "chargeback_dispute":
      return "I'm escalating this conversation to a person who can review it safely.";
    default:
      return "I can help with product questions, checkout, payment, delivery, returns, exchanges, refunds, and order support. I will verify the relevant commerce records before making factual claims.";
  }
}

function suggestedActions(intent: string, orderId: string | null): Record<string, unknown>[] {
  if (orderId === null) return [];
  switch (intent) {
    case "return":
    case "exchange": return [{ action_type: "prepare_return", order_id: orderId }];
    case "cancel_order": return [{ action_type: "cancel_order", order_id: orderId }];
    case "refund_status":
    case "payment_problem": return [{ action_type: "issue_refund", order_id: orderId, requires_amount: true }];
    case "address_correction": return [{ action_type: "correct_address", order_id: orderId }];
    default: return [];
  }
}

export function createCommunications(deps: CommunicationDeps) {
  const ttl = deps.actionTtlMinutes ?? 15;

  async function scopedThread(companyId: string, chatbotId: string, threadId: string): Promise<CommThread> {
    const thread = await deps.store.findThread(companyId, threadId);
    if (thread === null || thread.chatbotId !== chatbotId) throw new CommerceError("not_found", "The conversation was not found.");
    return thread;
  }

  async function factsFor(thread: CommThread): Promise<CommerceFacts> {
    const scope = { sessionId: thread.sessionId, customerId: thread.customerId };
    const loaded = await deps.facts.load(thread.companyId, thread.chatbotId, scope);
    if (!thread.identityVerified) {
      return { activeCart: loaded.activeCart, orders: [], payments: [], fulfilments: [], returns: [] };
    }
    return loaded;
  }

  async function escalate(thread: CommThread, message: CommMessage | null, reason: string, severity: string, summary: string, recommendedAction: string | null) {
    const snapshot = await factsFor(thread);
    const escalation: CommEscalation = {
      id: deps.newId(),
      companyId: thread.companyId,
      threadId: thread.id,
      chatbotId: thread.chatbotId,
      reason,
      severity,
      status: "open",
      summary,
      recommendedAction,
      contextSnapshot: { ...snapshot, message_id: message?.id ?? null },
    };
    await deps.store.insertEscalation(escalation);
    const priority: CommThread["priority"] = severity === "high" || severity === "critical" ? "urgent" : thread.priority;
    await deps.store.saveThread({ ...thread, status: "handoff", priority });
    return { escalation: { id: escalation.id, reason, severity, status: "open" }, ui: escalationCard(escalation, thread.companyId) };
  }

  return {
    /** Records an inbound message. Duplicate external ids return the stored message and do nothing else. */
    async ingest(companyId: string, chatbotId: string, input: InboundMessage) {
      const role = resolveCommerceRole({
        actorType: input.actorType ?? "customer",
        requestedRole: "customer_communications",
        authenticated: input.authenticated === true,
        channel: input.channel,
        intent: input.intent ?? "",
        inboundSupport: true,
      });
      if (role !== "customer_communications") throw new CommerceError("forbidden", "This message is not authorised for the customer communications role.");

      const channel = input.channel.trim().toLowerCase();
      if (!(COMM_CHANNELS as readonly string[]).includes(channel)) throw new CommerceError("validation", "The channel is not supported.", { channel: "unsupported" });
      const externalMessageId = input.externalMessageId?.trim() || null;
      if (externalMessageId !== null) {
        const existing = await deps.store.findMessageByExternalId(companyId, chatbotId, channel, externalMessageId);
        if (existing !== null) {
          const thread = await deps.store.findThread(companyId, existing.threadId);
          return { duplicate: true as const, message: existing, thread };
        }
      }

      const externalThreadId = input.externalThreadId?.trim() || null;
      let thread = externalThreadId !== null ? await deps.store.findThreadByExternalId(companyId, chatbotId, channel, externalThreadId) : null;
      if (thread === null) {
        thread = {
          id: deps.newId(),
          companyId,
          chatbotId,
          channel,
          externalThreadId,
          customerId: input.customerId ?? null,
          sessionId: input.sessionId ?? null,
          identityVerified: input.identityVerified === true,
          intent: null,
          confidence: null,
          priority: "normal",
          sentiment: "neutral",
          status: "open",
          lastMessageAt: null,
        };
        await deps.store.insertThread(thread);
      }

      const body = input.body.trim();
      const intent = input.intent?.trim() || classifyIntent(body);
      const confidence = Math.max(0, Math.min(1, input.confidence ?? DEFAULT_CONFIDENCE_BY_INTENT(intent)));
      const now = deps.now();
      const message: CommMessage = {
        id: deps.newId(),
        companyId,
        threadId: thread.id,
        chatbotId,
        channel,
        externalMessageId,
        direction: "inbound",
        actorType: input.actorType ?? "customer",
        body,
        intent,
        confidence,
        receivedAt: now,
      };
      await deps.store.insertMessage(message);
      const updated: CommThread = {
        ...thread,
        intent,
        confidence,
        priority: priorityFor(intent, body),
        sentiment: sentimentFor(body),
        lastMessageAt: now,
        status: thread.status === "closed" ? "open" : thread.status,
      };
      await deps.store.saveThread(updated);

      const policy = (await deps.store.getPolicy(companyId, chatbotId)) ?? defaultPolicy(companyId, chatbotId);
      const authority = communicationAuthority(authorityActionForIntent(intent), { confidence, identityVerified: updated.identityVerified, limits: policy.limits });
      let handoff: Awaited<ReturnType<typeof escalate>> | undefined;
      if (authority.escalate) {
        handoff = await escalate(updated, message, intent, "high", "The customer message triggered a human-only commerce support rule.", "Review the conversation and respond through the connected channel inbox.");
      }
      return { duplicate: false as const, thread: await deps.store.findThread(companyId, thread.id), message, authority, handoff };
    },

    /** Facts for a thread, identity-gated. */
    async threadContext(companyId: string, chatbotId: string, threadId: string) {
      const thread = await scopedThread(companyId, chatbotId, threadId);
      return { thread: { id: thread.id, channel: thread.channel, status: thread.status, intent: thread.intent, identityVerified: thread.identityVerified }, facts: await factsFor(thread) };
    },

    /** Text only. Never sends. canAutoSend is advice for the channel layer. */
    async draftReply(companyId: string, chatbotId: string, threadId: string, messageId: string | null = null) {
      const thread = await scopedThread(companyId, chatbotId, threadId);
      const message = messageId !== null
        ? await deps.store.findMessage(companyId, messageId)
        : await deps.store.latestInbound(companyId, thread.id);
      const intent = message?.intent ?? thread.intent ?? "general_support";
      const confidence = message?.confidence ?? thread.confidence ?? 0.5;
      const facts = await factsFor(thread);
      const policy = (await deps.store.getPolicy(companyId, chatbotId)) ?? defaultPolicy(companyId, chatbotId);
      const authority: AuthorityDecision = communicationAuthority(authorityActionForIntent(intent), { confidence, identityVerified: thread.identityVerified, limits: policy.limits });
      const orderId = facts.orders[0]?.id ?? null;
      const text = replyText(intent, facts, thread.identityVerified);
      const draft = {
        text,
        intent,
        confidence,
        authority,
        canAutoSend: policy.autoReplyEnabled && authority.level === "answer_automatically" && authority.allowed && confidence >= policy.autoReplyConfidence,
        facts,
        actions: suggestedActions(intent, orderId),
        constraints: {
          do_not_claim_an_action_completed_without_a_persisted_result: true,
          do_not_reveal_private_order_data_without_verified_identity: true,
          do_not_invent_tracking_payment_or_refund_state: true,
        },
      };
      const view: ReplyDraftView = { threadId: thread.id, channel: thread.channel, intent, authorityLevel: authority.level, text, actions: draft.actions };
      return { draft, ui: communicationReplyCard(view) };
    },

    /**
     * Proposes a governed action. Returns a token only when staff or the customer must confirm. Human-only and
     * connected-system actions become handoffs.
     */
    async prepareAction(companyId: string, chatbotId: string, threadId: string, input: { actionType: string; payload: Record<string, unknown>; idempotencyKey: string; messageId?: string | null }) {
      const thread = await scopedThread(companyId, chatbotId, threadId);
      if (input.idempotencyKey.trim() === "") throw new CommerceError("validation", "An idempotency key is required.", { idempotency_key: "required" });
      const existing = await deps.approvals.findByIdempotencyKey(companyId, chatbotId, "communication", input.idempotencyKey);
      if (existing !== null) return { action: publicAction(existing), approvalToken: null, replay: true, authority: null, escalation: null };

      const message = input.messageId ? await deps.store.findMessage(companyId, input.messageId) : await deps.store.latestInbound(companyId, thread.id);
      const policy = (await deps.store.getPolicy(companyId, chatbotId)) ?? defaultPolicy(companyId, chatbotId);
      const amountMinor = Math.max(0, Math.trunc(Number(input.payload.amount_minor ?? 0)));
      const authority = communicationAuthority(input.actionType, {
        confidence: message?.confidence ?? thread.confidence ?? 0,
        identityVerified: thread.identityVerified,
        amountMinor,
        limits: policy.limits,
      });

      if (authority.level === "human_only") {
        const escalation = await escalate(thread, message, authority.reason, "high", authority.reason, "A human should review the requested action.");
        return { action: null, approvalToken: null, replay: false, authority, escalation };
      }
      if (["offer_discount", "replace_item", "issue_store_credit"].includes(input.actionType)) {
        const escalation = await escalate(thread, message, "connected_system_required", "normal",
          "The requested support action requires a connected discount, replacement, or credit provider that is not owned by this extension.",
          "Review and execute the proposed action in the connected seller system.");
        return { action: null, approvalToken: null, replay: false, authority, escalation };
      }

      const proposed = await proposeAction(
        deps.approvals,
        deps.now(),
        {
          companyId,
          chatbotId,
          scope: "communication",
          subjectId: thread.id,
          actionType: input.actionType,
          authorityLevel: authority.level as AuthorityLevel,
          payload: input.payload,
          idempotencyKey: input.idempotencyKey,
          amountMinor: amountMinor > 0 ? amountMinor : null,
          currency: typeof input.payload.currency === "string" ? input.payload.currency : policy.currency,
          ttlMinutes: ttl,
        },
        deps.newId,
      );
      return { action: proposed.action, approvalToken: proposed.approvalToken, replay: proposed.replay, authority, escalation: null };
    },

    /**
     * Runs an action after its claim. Refunds are also gated by CHATBOT_PAYMENTS_ENABLED. Order lookups use the
     * thread's own scope, so an action cannot reach another customer's order.
     */
    async executeApproved(companyId: string, chatbotId: string, threadId: string, actionId: string, c: { approvalToken: string | null; approver: ApproverActor; approverId: string }) {
      const thread = await scopedThread(companyId, chatbotId, threadId);
      const before = await deps.approvals.findById(companyId, actionId);
      if (before === null || before.subjectId !== thread.id || before.scope !== "communication" || before.chatbotId !== chatbotId) {
        throw new CommerceError("not_found", "The action was not found.");
      }
      const claim = await claimForExecution(deps.approvals, deps.now(), companyId, actionId, c.approvalToken, c.approver, c.approverId);
      if (claim.state === "replay") return { action: publicAction(claim.action), result: claim.action.result, replay: true };

      const action: ApprovalAction = claim.action;
      const scope = { sessionId: thread.sessionId, customerId: thread.customerId };
      try {
        const result = await runCommunicationAction(action, companyId, chatbotId, scope, c.approverId);
        await completeAction(deps.approvals, deps.now(), companyId, action.id, c.approverId, result);
        return { action: publicAction({ ...action, status: "executed", result }), result, replay: false };
      } catch (error) {
        const reason = error instanceof CommerceError ? error.message : "The customer-service action could not be completed.";
        await failAction(deps.approvals, deps.now(), companyId, action.id, reason);
        throw error instanceof CommerceError ? error : new CommerceError("validation", reason);
      }
    },

    escalate,
  };

  async function runCommunicationAction(
    action: ApprovalAction,
    companyId: string,
    chatbotId: string,
    scope: { sessionId: string | null; customerId: number | null },
    approverId: string,
  ): Promise<Record<string, unknown>> {
    const payload = action.payload;
    const orderId = typeof payload.order_id === "string" ? payload.order_id : null;
    const requireOrder = async () => {
      if (orderId === null) throw new CommerceError("validation", "A scoped order is required.", { order_id: "required" });
      const order = await deps.orders.findScoped(companyId, chatbotId, orderId, scope);
      if (order === null) throw new CommerceError("not_found", "The order was not found.");
      return order;
    };
    switch (action.actionType) {
      case "request_return":
      case "prepare_return": {
        const order = await requireOrder();
        const ret = await deps.orders.requestReturn(companyId, order.id, Array.isArray(payload.items) ? payload.items : [], String(payload.resolution ?? "refund"), payload.reason ? String(payload.reason) : null, scope.customerId);
        return { type: "return_requested", return: ret };
      }
      case "cancel_order": {
        const order = await requireOrder();
        const cancelled = await deps.orders.cancel(companyId, order.id, `communication:${action.id}`);
        return { type: "order_cancelled", status: cancelled.status };
      }
      case "issue_refund": {
        if (!readFlag(CONTRACT_FLAGS.PAYMENTS_ENABLED, deps.env)) throw new CommerceError("flag_disabled", "Payments are not enabled for this workspace.");
        const amount = Math.trunc(Number(payload.amount_minor ?? 0));
        if (amount <= 0) throw new CommerceError("validation", "A refund amount is required.", { amount_minor: "required" });
        const paymentId = typeof payload.payment_id === "string" ? payload.payment_id : null;
        if (paymentId === null) throw new CommerceError("validation", "The scoped order has no refundable payment.", { payment_id: "required" });
        await requireOrder();
        const refund = await deps.refunds.refund(companyId, paymentId, amount, String(payload.currency ?? "USD"), String(payload.reason ?? "Customer communications refund"), `communication:${action.id}`);
        return { type: "payment_refunded", refund };
      }
      case "correct_address": {
        const order = await requireOrder();
        if (order.fulfilmentStatus === "fulfilled" || order.fulfilmentStatus === "delivered") {
          throw new CommerceError("validation", "The delivery address cannot be changed after fulfilment.", { order_id: "fulfilled" });
        }
        const address = (payload.shipping_address ?? {}) as Record<string, unknown>;
        const corrected = await deps.orders.correctAddress(companyId, order.id, address);
        return { type: "address_corrected", status: corrected.status, approved_by: approverId };
      }
      default:
        throw new CommerceError("validation", "The prepared customer-service action is not executable by this extension.", { action_type: "unsupported" });
    }
  }
}

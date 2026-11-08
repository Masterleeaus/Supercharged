/**
 * Runtime ports: conversations, messages, drafts, streaming, workflows, structured actions, outbound webhooks,
 * outbox, notifications, participants, presence, attachments and analytics.
 *
 * These mirror the core PHP runtime interfaces in extensions/chatbot/System/Contracts/*.php, with three changes:
 * every method takes companyId first, return types are explicit records instead of arrays, and realtime delivery
 * goes through the existing EventPublisher (server/modules/chatbot/inbox/event-publisher.ts). No transport is named here.
 */
import type { EventPublisher, InboxEvent, InboxEventType } from "../inbox/event-publisher.ts";
import type { Handler, InboxParticipant, InboxPresence, PresenceState } from "../inbox/types.ts";
import type { ChannelKind } from "./channels.ts";
import type { ModelMessage, ModelStreamEvent, ModelUsage } from "./ai.ts";
import type { SealedSecret } from "./secrets.ts";

/** Realtime delivery is the existing inbox EventPublisher. Re-exported so runtime builders import one place. */
export type RealtimePublisher = EventPublisher;
export type RealtimeEvent = InboxEvent;

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export const CONVERSATION_STATUSES = ["open", "archived", "merged"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export interface ConversationRecord {
  id: string;
  companyId: string;
  chatbotId: string;
  channel: ChannelKind;
  externalThreadId: string | null;
  customerId: string | null;
  status: ConversationStatus;
  handler: Handler;
  summary: string | null;
  summaryUpdatedAt: Date | null;
  mergedIntoId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewConversation {
  chatbotId: string;
  channel: ChannelKind;
  externalThreadId: string | null;
  customerId: string | null;
}

export interface ConversationSearchFilters {
  chatbotId?: string;
  channel?: ChannelKind;
  status?: ConversationStatus;
  customerId?: string;
  /** Free text, matched against message text. */
  query?: string;
  updatedAfter?: Date;
  limit: number;
  cursor: string | null;
}

export interface ConversationSearchPage {
  rows: ConversationRecord[];
  nextCursor: string | null;
}

export interface ConversationRuntime {
  create(companyId: string, input: NewConversation): Promise<ConversationRecord>;
  archive(companyId: string, conversationId: string): Promise<ConversationRecord | null>;
  /**
   * Moves every message of source into target, then marks source merged. Both must belong to companyId.
   * Not implemented yet: the storage layer needs a change request first (runtime slice, merge).
   */
  merge(companyId: string, targetId: string, sourceId: string): Promise<ConversationRecord | null>;
  /** Returns the stored summary. force re-summarises even when the summary is still fresh. */
  summarize(companyId: string, conversationId: string, options: { force: boolean; timeoutMs: number }): Promise<string>;
  search(companyId: string, filters: ConversationSearchFilters): Promise<ConversationSearchPage>;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Delivery status of an outbound message. Allowed moves: queued to sent, sent to delivered, delivered to read.
 * failed can follow any state before read. retry moves failed back to queued. Nothing moves backwards.
 */
export const MESSAGE_STATUSES = ["queued", "sent", "delivered", "read", "failed"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export type MessageRole = "customer" | "assistant" | "staff" | "system";

export interface MessageRecord {
  id: string;
  companyId: string;
  conversationId: string;
  role: MessageRole;
  staffId: string | null;
  channel: ChannelKind;
  contentKind: "text" | "image" | "audio" | "video" | "file" | "template" | "interactive";
  text: string | null;
  status: MessageStatus;
  /** Channel's own id for the message. Set once the provider accepts it. */
  externalMessageId: string | null;
  failureReason: string | null;
  isInternalNote: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewMessage {
  role: MessageRole;
  staffId: string | null;
  contentKind: MessageRecord["contentKind"];
  text: string | null;
  attachmentIds: string[];
  isInternalNote: boolean;
  /** Same key on a second create returns the first message instead of writing a duplicate. */
  idempotencyKey: string | null;
}

export interface MessageRuntime {
  create(companyId: string, conversationId: string, input: NewMessage): Promise<MessageRecord>;
  retry(companyId: string, messageId: string): Promise<MessageRecord | null>;
  markSent(companyId: string, messageId: string, externalMessageId: string | null): Promise<MessageRecord | null>;
  markDelivered(companyId: string, messageId: string, externalMessageId: string | null): Promise<MessageRecord | null>;
  markRead(companyId: string, messageId: string): Promise<MessageRecord | null>;
  markFailed(companyId: string, messageId: string, reason: string): Promise<MessageRecord | null>;
}

// ---------------------------------------------------------------------------
// Drafts (staff-assist and AI assist)
// ---------------------------------------------------------------------------

export interface DraftContext {
  conversationId: string;
  chatbotId: string;
  /** Most recent messages, oldest first. The runtime does not fetch them, the caller does. */
  recentMessages: ModelMessage[];
  /** Knowledge chunks already retrieved for this turn, if any. */
  knowledgeText: string | null;
  locale: string | null;
  instructions: string | null;
  timeoutMs: number;
}

export interface DraftResult {
  text: string;
  /** Model-reported confidence is not trusted. Null when the model did not give one. */
  confidence: number | null;
  usage: ModelUsage;
  model: string;
}

export interface DraftRuntime {
  draft(companyId: string, context: DraftContext): Promise<DraftResult>;
  translate(companyId: string, text: string, targetLocale: string, timeoutMs: number): Promise<string>;
}

// ---------------------------------------------------------------------------
// Streaming (token deltas to the widget or inbox while a reply is generated)
// ---------------------------------------------------------------------------

export interface StreamSummary {
  messageId: string;
  deltasSent: number;
  finishReason: "stop" | "length" | "tool_call" | "content_filter" | "error";
  usage: ModelUsage;
}

/**
 * Consumes model stream events for one reply. Persistence happens once, at the end, in the message runtime.
 * Deltas are delivered through the realtime path (see OutboxEvent). Failover is not allowed after the first delta.
 */
export interface StreamingRuntime {
  streamReply(
    companyId: string,
    conversationId: string,
    events: AsyncIterable<ModelStreamEvent>,
  ): Promise<StreamSummary>;
  typing(companyId: string, conversationId: string, participantKey: string, active: boolean): Promise<void>;
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

export const WORKFLOW_RUN_STATUSES = ["queued", "running", "waiting", "completed", "failed", "cancelled"] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export interface WorkflowRun {
  id: string;
  companyId: string;
  workflow: string;
  status: WorkflowRunStatus;
  attempt: number;
  context: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: string | null;
  nextRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Attempts allowed before the run fails for good. Optional. Added by change request C1 (events slice). */
  maxAttempts?: number;
  /** Same key returns the existing run. Optional. Added by change request C1 (events slice). */
  idempotencyKey?: string | null;
}

export interface WorkflowDispatchOptions {
  delaySeconds?: number;
  /** Same key returns the existing run. */
  idempotencyKey?: string;
  /** Conversation the run belongs to, when there is one. Added by change request C1 (events slice). */
  conversationId?: string;
  /** Attempts allowed for this run. Added by change request C1 (events slice). */
  maxAttempts?: number;
}

export interface WorkflowRuntime {
  dispatch(
    companyId: string,
    workflow: string,
    context: Record<string, unknown>,
    options?: WorkflowDispatchOptions,
  ): Promise<WorkflowRun>;
  get(companyId: string, runId: string): Promise<WorkflowRun | null>;
  resume(companyId: string, runId: string, input: Record<string, unknown>): Promise<WorkflowRun | null>;
  complete(companyId: string, runId: string, output: Record<string, unknown>): Promise<WorkflowRun | null>;
  fail(companyId: string, runId: string, error: string, output?: Record<string, unknown>): Promise<WorkflowRun | null>;
  retry(companyId: string, runId: string, delaySeconds?: number): Promise<WorkflowRun | null>;
  cancel(companyId: string, runId: string): Promise<WorkflowRun | null>;
}

// ---------------------------------------------------------------------------
// Structured actions (what the model proposes, and what staff or policy approves)
// ---------------------------------------------------------------------------

export const STRUCTURED_ACTION_KINDS = [
  "create_booking",
  "reschedule_booking",
  "cancel_booking",
  "add_to_cart",
  "quote_checkout",
  "lookup_order",
  "request_refund",
  "handoff_to_human",
  "send_reminder",
] as const;
export type StructuredActionKind = (typeof STRUCTURED_ACTION_KINDS)[number];

export const STRUCTURED_ACTION_STATUSES = ["proposed", "approved", "rejected", "executed", "failed", "expired"] as const;
export type StructuredActionStatus = (typeof STRUCTURED_ACTION_STATUSES)[number];

/**
 * An action the model asked for. Stored before it runs. Actions in REQUIRES_APPROVAL never execute from a
 * model reply alone: they stay proposed until a staff member approves them.
 */
export interface StructuredAction {
  id: string;
  companyId: string;
  conversationId: string;
  kind: StructuredActionKind;
  /** Validated against the kind's schema before storage. Unknown keys are rejected. */
  args: Record<string, unknown>;
  status: StructuredActionStatus;
  requiresApproval: boolean;
  approvedBy: string | null;
  resultRef: string | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** After this time a proposed action cannot be approved. Optional. Added by change request C2 (events slice). */
  expiresAt?: Date | null;
  /** How staff should show the action. Optional. Added by change request C2 (events slice). */
  presentation?: Record<string, unknown> | null;
  /** Stable key so a retried proposal is not stored twice. Optional. Added by change request C2 (events slice). */
  idempotencyKey?: string | null;
}

export const REQUIRES_APPROVAL: readonly StructuredActionKind[] = ["request_refund", "cancel_booking"];

// ---------------------------------------------------------------------------
// Outbox and outbound webhooks
// ---------------------------------------------------------------------------

export const OUTBOX_STATUSES = ["pending", "published", "failed"] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

/**
 * Written in the same transaction as the state change it describes. A relay later publishes it to the
 * EventPublisher and to outbound webhooks. A publish failure never rolls back the state change.
 */
export interface OutboxEvent {
  id: string;
  companyId: string;
  topic: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  /** Stable key so a retried write does not produce two events. */
  dedupeKey: string;
  status: OutboxStatus;
  attempts: number;
  availableAt: Date;
  publishedAt: Date | null;
  createdAt: Date;
}

/**
 * Outbox topics routed to realtime. The rule is the identity mapping: a topic goes to the EventPublisher only when
 * its name is one of INBOX_EVENT_TYPES. Other topics go to outbound webhooks only. Named by change request C4
 * (events slice).
 */
export type OutboxRealtimeTopic = InboxEventType;

/** Lease a worker takes on claimed outbox rows. Added by change request C3 (events slice). */
export interface OutboxLease {
  workerId: string;
  leaseSeconds: number;
}

/** Failure detail for a retry or dead letter. Added by change request C3 (events slice). */
export interface OutboxFailureDetail {
  /** Attempts made so far, including the one that just failed. */
  attempts: number;
  /** Short, non-secret text. Never a raw error message that can echo a URL or body. */
  lastError: string;
}

export interface OutboxStorage {
  /** Inserts inside the caller's transaction. Use the tx handle from the storage layer, never a second connection. */
  append(companyId: string, event: Omit<OutboxEvent, "id" | "status" | "attempts" | "publishedAt" | "createdAt">): Promise<OutboxEvent>;
  /** lease is optional. When given, claimed rows are held by that worker for leaseSeconds (change request C3). */
  claimBatch(companyId: string, limit: number, now: Date, lease?: OutboxLease): Promise<OutboxEvent[]>;
  markPublished(companyId: string, eventId: string, at: Date): Promise<void>;
  /** detail is optional. When given, the attempt count and last error are recorded (change request C3). */
  markFailed(companyId: string, eventId: string, nextAvailableAt: Date, detail?: OutboxFailureDetail): Promise<void>;
  /** Optional. Stops retrying an event for good. Added by change request C3 (events slice). */
  markDeadLetter?(companyId: string, eventId: string, detail: OutboxFailureDetail): Promise<void>;
}

export interface WebhookSubscription {
  id: string;
  companyId: string;
  url: string;
  topics: string[];
  active: boolean;
  /**
   * Sealed with SecretBox. The plaintext signing secret is never stored or returned.
   * Written as the versioned string (secrets/sealed-form.ts). The contract object is still accepted on read.
   */
  signingSecret: string | SealedSecret;
}

export interface WebhookDelivery {
  subscriptionId: string;
  eventId: string;
  httpStatus: number | null;
  ok: boolean;
  attempt: number;
  errorMessage: string | null;
  deliveredAt: Date;
}

export interface WebhookDispatcher {
  /** Sends one event to every matching subscription. Signs with HMAC over the exact body bytes. */
  dispatch(companyId: string, event: OutboxEvent): Promise<WebhookDelivery[]>;
}

// ---------------------------------------------------------------------------
// Notifications and participants
// ---------------------------------------------------------------------------

export interface NotificationRecipient {
  kind: "staff" | "customer";
  id: string;
}

export interface NotificationRuntime {
  notify(
    companyId: string,
    topic: string,
    recipients: NotificationRecipient[],
    payload: Record<string, unknown>,
  ): Promise<void>;
}

export interface ParticipantRuntime {
  list(companyId: string, conversationId: string): Promise<InboxParticipant[]>;
  save(companyId: string, conversationId: string, participant: InboxParticipant): Promise<void>;
  remove(companyId: string, conversationId: string, participantId: string): Promise<boolean>;
}

export interface PresenceRuntime {
  touch(companyId: string, conversationId: string, participantKey: string, state: PresenceState): Promise<InboxPresence>;
  list(companyId: string, conversationId: string, sinceSeconds: number): Promise<InboxPresence[]>;
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export interface AttachmentRecord {
  id: string;
  companyId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  /** SHA-256 hex of the stored bytes. */
  sha256: string;
  /** Opaque key in the object store. Never shown to a customer. */
  storageKey: string;
  createdAt: Date;
}

export interface AttachmentStore {
  put(
    companyId: string,
    input: { filename: string; contentType: string; bytes: Uint8Array },
  ): Promise<AttachmentRecord>;
  get(companyId: string, attachmentId: string): Promise<AttachmentRecord | null>;
  /** Short-lived read URL. ttlSeconds is capped by the implementation. */
  readUrl(companyId: string, attachmentId: string, ttlSeconds: number): Promise<string | null>;
  delete(companyId: string, attachmentId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export const ANALYTICS_METRICS = [
  "conversations",
  "messages",
  "handoffs",
  "resolved_by_ai",
  "avg_first_response_seconds",
  "bookings_created",
  "orders_placed",
] as const;
export type AnalyticsMetric = (typeof ANALYTICS_METRICS)[number];

export interface AnalyticsQuery {
  metrics: AnalyticsMetric[];
  /** Inclusive start of the range. */
  from: Date;
  /** Exclusive end of the range: an event at exactly `to` is outside it. Documented by change request (ops slice). */
  to: Date;
  groupBy: "day" | "week" | "channel" | "chatbot" | null;
  chatbotId?: string;
}

export interface AnalyticsRow {
  bucket: string | null;
  values: Partial<Record<AnalyticsMetric, number>>;
}

export interface AnalyticsQueryPort {
  run(companyId: string, query: AnalyticsQuery): Promise<AnalyticsRow[]>;
}

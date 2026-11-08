/**
 * Shared types and storage ports for the events slice: workflows, structured actions, outbound webhooks,
 * the transactional outbox and notifications.
 *
 * Contract types come from ../contracts/index.ts and are not redefined here. The records below extend them
 * with columns the contract does not name (lease tokens, idempotency keys, expiry). Every store method takes
 * companyId first and filters on it; a row from another company is reported as absent.
 */
import type {
  OutboxEvent,
  StructuredAction,
  WebhookDelivery,
  WebhookSubscription,
  WorkflowRun,
} from "../contracts/index.ts";

export type EventsErrorCode = "VALIDATION" | "INVALID_STATE" | "SECRET_UNAVAILABLE" | "NOTIFICATION_FAILED";

/**
 * Thrown for bad input and for transitions the state does not allow. The message is safe to show staff:
 * it never contains payloads, secrets or customer data.
 */
export class EventsError extends Error {
  code: EventsErrorCode;
  constructor(code: EventsErrorCode, message: string) {
    super(message);
    this.name = "EventsError";
    this.code = code;
  }
}

/** Injected clock and id source. Tests pass fixed values. */
export interface EventsDeps {
  now: () => Date;
  newId: () => string;
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

export interface WorkflowRunRecord extends WorkflowRun {
  conversationId: string | null;
  idempotencyKey: string | null;
  maxAttempts: number;
  lockedAt: Date | null;
  lockToken: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export type StepClaim =
  | { state: "claimed" }
  | { state: "done"; output: Record<string, unknown> }
  | { state: "busy" };

export interface WorkflowStore {
  findRunByIdempotencyKey(companyId: string, workflow: string, key: string): Promise<WorkflowRunRecord | null>;
  /** Returns null when the idempotency key is already taken for this workflow. */
  insertRun(companyId: string, run: WorkflowRunRecord): Promise<WorkflowRunRecord | null>;
  getRun(companyId: string, runId: string): Promise<WorkflowRunRecord | null>;
  /**
   * Runs mutate under the row lock. mutate returns a patch, or null for no change, or throws to refuse.
   * A throw leaves the row untouched.
   */
  mutateRun(
    companyId: string,
    runId: string,
    mutate: (run: WorkflowRunRecord) => Partial<WorkflowRunRecord> | null,
  ): Promise<WorkflowRunRecord | null>;
  /** Takes the next queued run whose time has come, or a running run whose lock went stale. */
  claimRun(companyId: string, now: Date, staleAfterSeconds: number, lockToken: string): Promise<WorkflowRunRecord | null>;
  claimStep(
    companyId: string,
    runId: string,
    stepKey: string,
    lockToken: string,
    now: Date,
    staleAfterSeconds: number,
  ): Promise<StepClaim>;
  completeStep(
    companyId: string,
    runId: string,
    stepKey: string,
    lockToken: string,
    output: Record<string, unknown>,
    now: Date,
  ): Promise<boolean>;
  releaseStep(companyId: string, runId: string, stepKey: string, lockToken: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Structured actions
// ---------------------------------------------------------------------------

export interface ActionButton {
  id: string;
  label: string;
}

export type ActionFormFieldType = "text" | "number" | "boolean" | "choice" | "datetime";

export interface ActionFormField {
  name: string;
  label: string;
  type: ActionFormFieldType;
  required: boolean;
  maxLength?: number;
  options?: string[];
}

/** What the bot shows the customer or staff: buttons, a form, or both. Validated before storage. */
export interface ActionPresentation {
  buttons?: ActionButton[];
  form?: { fields: ActionFormField[] };
}

export interface ActionRecord extends StructuredAction {
  expiresAt: Date | null;
  idempotencyKey: string | null;
  presentation: ActionPresentation | null;
  executionToken: string | null;
  executionStartedAt: Date | null;
}

export interface ActionStore {
  conversationExists(companyId: string, conversationId: string): Promise<boolean>;
  findByIdempotencyKey(companyId: string, conversationId: string, key: string): Promise<ActionRecord | null>;
  /** Returns null when the idempotency key is already taken in this conversation. */
  insertAction(companyId: string, action: ActionRecord): Promise<ActionRecord | null>;
  getAction(companyId: string, actionId: string): Promise<ActionRecord | null>;
  listActions(companyId: string, conversationId: string, status?: ActionRecord["status"]): Promise<ActionRecord[]>;
  /** Same locking rule as WorkflowStore.mutateRun. */
  mutateAction(
    companyId: string,
    actionId: string,
    mutate: (action: ActionRecord) => Partial<ActionRecord> | null,
  ): Promise<ActionRecord | null>;
  /**
   * Sets status "expired" on this company's "proposed" actions created before cutoff. Returns the count.
   * Only "proposed" rows are touched, so approved, rejected and executed actions are never changed.
   */
  expireProposedBefore(companyId: string, cutoff: Date, now: Date): Promise<number>;
}

// ---------------------------------------------------------------------------
// Outbox and webhooks
// ---------------------------------------------------------------------------

export interface OutboxRecord extends OutboxEvent {
  lockedAt: Date | null;
  /** The lease owner for this claim: the worker id plus a per-claim token. Writes are fenced on it. */
  lockedBy: string | null;
  /** Set once the realtime publish succeeded, so a retry never publishes the same event twice. */
  realtimePublishedAt: Date | null;
  lastError: string | null;
  failedAt: Date | null;
}

export interface WebhookSubscriptionView {
  id: string;
  companyId: string;
  url: string;
  topics: string[];
  active: boolean;
}

export interface WebhookDeliveryRecord extends WebhookDelivery {
  companyId: string;
  eventId: string;
}

export interface OutboxStore {
  /** Upserts on (companyId, dedupeKey). A second write with the same key returns the first row. */
  appendEvent(companyId: string, event: OutboxRecord): Promise<OutboxRecord>;
  /** Leases up to limit due events. A lease that has not expired keeps other workers off the row. */
  claimBatch(
    companyId: string,
    limit: number,
    now: Date,
    lease: { workerId: string; leaseSeconds: number },
  ): Promise<OutboxRecord[]>;
  /**
   * Write fencing. When leaseOwner is given, the write applies only while the row is still leased to that
   * owner. A worker whose lease expired and was taken over gets false and must stop; its write is ignored.
   */
  markRealtimePublished(companyId: string, eventId: string, at: Date, leaseOwner?: string): Promise<boolean>;
  markPublished(companyId: string, eventId: string, at: Date, leaseOwner?: string): Promise<boolean>;
  /** attempts is optional. When absent the store adds one to the stored count. */
  markFailed(
    companyId: string,
    eventId: string,
    update: { attempts?: number; nextAvailableAt: Date; lastError: string; leaseOwner?: string },
  ): Promise<boolean>;
  markDeadLetter(
    companyId: string,
    eventId: string,
    update: { attempts?: number; failedAt: Date; lastError: string; leaseOwner?: string },
  ): Promise<boolean>;
  /** Dead-lettered events for one company, newest failure first. Limit is already clamped by the caller. */
  listDeadLetters(companyId: string, limit: number): Promise<OutboxRecord[]>;
  insertSubscription(companyId: string, subscription: WebhookSubscription): Promise<void>;
  listSubscriptions(companyId: string): Promise<WebhookSubscription[]>;
  listDeliveries(companyId: string, eventId: string): Promise<WebhookDeliveryRecord[]>;
  recordDelivery(companyId: string, delivery: WebhookDeliveryRecord): Promise<void>;
}

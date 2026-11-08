/**
 * Transactional outbox. A state change and its event are written in the same transaction (the caller passes
 * a transaction-bound store). A processor later relays each event once to the realtime EventPublisher and to
 * outbound webhooks.
 *
 * Port of EventOutbox.php and EventOutboxProcessor.php. Defaults match config/chatbot.php in the PHP app:
 * 8 attempts, 15 second base backoff doubling to a 3600 second cap, 300 second lease, 10 second webhook timeout.
 *
 * At-most-once publish: the realtime publish is recorded before webhooks run, so a retry never publishes
 * the same event to the EventPublisher twice. Webhooks are at-least-once per subscription; the Idempotency-Key
 * header carries the event id so receivers can dedupe.
 */
import type { EventPublisher, InboxEvent, InboxEventType } from "../inbox/event-publisher.ts";
import { INBOX_EVENT_TYPES } from "../inbox/event-publisher.ts";
import type { OutboxEvent, OutboxStorage, WebhookDispatcher } from "../contracts/index.ts";
import { EventsError, type EventsDeps, type OutboxRecord, type OutboxStore } from "./types.ts";

export const OUTBOX_DEFAULTS = {
  maxAttempts: 8,
  baseBackoffSeconds: 15,
  maxBackoffSeconds: 3600,
  leaseSeconds: 300,
  batchLimit: 100,
  maxPayloadBytes: 64 * 1024,
} as const;

const MAX_TOPIC_LENGTH = 191;

const MAX_WORKER_ID_LENGTH = 100;

/** Lease owner for one claim: the worker id plus a per-claim token. Fits the locked_by column (191). */
export function leaseOwnerFor(workerId: string, claimToken: string): string {
  if (!workerId || workerId.length > MAX_WORKER_ID_LENGTH || workerId.includes("/")) {
    throw new EventsError("VALIDATION", "Outbox worker id is not valid.");
  }
  return `${workerId}/${claimToken.slice(0, 64)}`;
}

/** Backoff after the given attempt number: base * 2^(attempt-1), capped. */
export function outboxBackoffSeconds(attempt: number, base: number, cap: number): number {
  return Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
}

/** The contract's OutboxStorage, backed by the store. Used inside the caller's transaction. */
export function createOutboxStorage(store: OutboxStore, deps: EventsDeps): OutboxStorage {
  return {
    async append(companyId, event) {
      if (!event.topic || event.topic.length > MAX_TOPIC_LENGTH) throw new EventsError("VALIDATION", "Outbox topic is not valid.");
      if (!event.dedupeKey || event.dedupeKey.length > MAX_TOPIC_LENGTH) throw new EventsError("VALIDATION", "Outbox dedupe key is not valid.");
      if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
        throw new EventsError("VALIDATION", "Outbox payload must be an object.");
      }
      if (Buffer.byteLength(JSON.stringify(event.payload), "utf8") > OUTBOX_DEFAULTS.maxPayloadBytes) {
        throw new EventsError("VALIDATION", "Outbox payload is too large.");
      }
      const now = deps.now();
      const row: OutboxRecord = {
        ...event,
        companyId,
        id: deps.newId(),
        status: "pending",
        attempts: 0,
        publishedAt: null,
        createdAt: now,
        lockedAt: null,
        lockedBy: null,
        realtimePublishedAt: null,
        lastError: null,
        failedAt: null,
      };
      return stripLease(await store.appendEvent(companyId, row));
    },

    async claimBatch(companyId, limit, now) {
      const rows = await store.claimBatch(companyId, Math.max(1, Math.min(limit, 500)), now, {
        workerId: "contract-claim",
        leaseSeconds: OUTBOX_DEFAULTS.leaseSeconds,
      });
      return rows.map(stripLease);
    },

    async markPublished(companyId, eventId, at) {
      await store.markPublished(companyId, eventId, at);
    },

    async markFailed(companyId, eventId, nextAvailableAt) {
      // The contract carries no attempt count here, so the store adds one to the stored count.
      await store.markFailed(companyId, eventId, { nextAvailableAt, lastError: "Relay failed." });
    },
  };
}

function stripLease(row: OutboxRecord): OutboxEvent {
  return {
    id: row.id,
    companyId: row.companyId,
    topic: row.topic,
    aggregateId: row.aggregateId,
    payload: row.payload,
    dedupeKey: row.dedupeKey,
    status: row.status,
    attempts: row.attempts,
    availableAt: row.availableAt,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
  };
}

export interface OutboxProcessOptions {
  limit?: number;
  workerId: string;
  leaseSeconds?: number;
  maxAttempts?: number;
  baseBackoffSeconds?: number;
  maxBackoffSeconds?: number;
}

export interface OutboxProcessResult {
  claimed: number;
  published: number;
  retried: number;
  deadLettered: number;
}

export interface OutboxProcessorDeps {
  store: OutboxStore;
  webhooks: WebhookDispatcher;
  publisher: EventPublisher;
  events: EventsDeps;
}

export interface OutboxProcessor {
  process(companyId: string, options: OutboxProcessOptions): Promise<OutboxProcessResult>;
}

function isInboxTopic(topic: string): topic is InboxEventType {
  return (INBOX_EVENT_TYPES as readonly string[]).includes(topic);
}

/** Maps an outbox row to the inbox event shape. The payload carries conversationId and data. */
export function toInboxEvent(row: OutboxRecord): InboxEvent {
  const payload = row.payload as { conversationId?: unknown; data?: unknown };
  const data = (typeof payload.data === "object" && payload.data !== null ? payload.data : {}) as InboxEvent["data"];
  return {
    type: row.topic as InboxEventType,
    companyId: row.companyId,
    conversationId: typeof payload.conversationId === "string" ? payload.conversationId : row.aggregateId,
    occurredAt: row.createdAt,
    data: { ...data, actorId: typeof data.actorId === "string" ? data.actorId : "system" },
  };
}

export function createOutboxProcessor(deps: OutboxProcessorDeps): OutboxProcessor {
  return {
    async process(companyId, options) {
      const now = deps.events.now();
      const maxAttempts = options.maxAttempts ?? OUTBOX_DEFAULTS.maxAttempts;
      const base = options.baseBackoffSeconds ?? OUTBOX_DEFAULTS.baseBackoffSeconds;
      const cap = options.maxBackoffSeconds ?? OUTBOX_DEFAULTS.maxBackoffSeconds;
      // Each claim gets its own lease owner, so a worker whose lease expired cannot write over a later claim.
      const leaseOwner = leaseOwnerFor(options.workerId, deps.events.newId());
      const rows = await deps.store.claimBatch(companyId, Math.max(1, Math.min(options.limit ?? OUTBOX_DEFAULTS.batchLimit, 500)), now, {
        workerId: leaseOwner,
        leaseSeconds: options.leaseSeconds ?? OUTBOX_DEFAULTS.leaseSeconds,
      });

      const result: OutboxProcessResult = { claimed: rows.length, published: 0, retried: 0, deadLettered: 0 };

      for (const row of rows) {
        const attempts = row.attempts + 1;
        try {
          if (!row.realtimePublishedAt && isInboxTopic(row.topic)) {
            await deps.publisher.publish(toInboxEvent(row));
          }
          if (!row.realtimePublishedAt) {
            const held = await deps.store.markRealtimePublished(companyId, row.id, deps.events.now(), leaseOwner);
            // Lease lost: stop here, so a stale worker never reaches the webhooks for this row.
            if (!held) throw new EventsError("INVALID_STATE", "Lease lost before webhook dispatch.");
          }

          const deliveries = await deps.webhooks.dispatch(companyId, stripLease(row));
          const failed = deliveries.filter((d) => !d.ok).length;
          if (failed > 0) {
            // The message names the count only. Response bodies and URLs are not stored.
            throw new EventsError("INVALID_STATE", `${failed} webhook deliver${failed === 1 ? "y" : "ies"} failed.`);
          }

          if (await deps.store.markPublished(companyId, row.id, deps.events.now(), leaseOwner)) result.published++;
        } catch (error) {
          const reason = error instanceof EventsError ? error.message : "Relay failed.";
          if (attempts >= maxAttempts) {
            if (await deps.store.markDeadLetter(companyId, row.id, { attempts, failedAt: deps.events.now(), lastError: reason, leaseOwner })) {
              result.deadLettered++;
            }
          } else {
            const delay = outboxBackoffSeconds(attempts, base, cap);
            if (
              await deps.store.markFailed(companyId, row.id, {
                attempts,
                nextAvailableAt: new Date(deps.events.now().getTime() + delay * 1000),
                lastError: reason,
                leaseOwner,
              })
            ) {
              result.retried++;
            }
          }
        }
      }
      return result;
    },
  };
}

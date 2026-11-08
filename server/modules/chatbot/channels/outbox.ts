/**
 * Channel outbox. Every outbound channel message is first written as a row, in the same transaction as the staff or
 * AI reply it belongs to (enqueue). A worker then drains due rows through the channel framework (drain).
 *
 * Rules:
 * - Idempotent enqueue: a second row with the same (company, idempotency key) is not written. The existing row is returned.
 * - Claim before send: a row is moved to "sending" with a lease before the provider call. Two workers never claim the same row.
 * - Sent once: a row that reached "sent" or "failed" is never claimed again. A lease that expires while "sending" is
 *   marked "failed" (lease_expired), not resent, because the provider may already have accepted the message.
 * - Bounded retry: a retryable failure goes back to "pending" with exponential backoff, until maxAttempts. Then it is "failed".
 * - Tenant scope: every store method takes companyId and filters on it.
 *
 * This file holds the row model, the service and an in-memory store. The Drizzle store is in outbox-drizzle.ts.
 */
import { randomUUID } from "node:crypto";
import { requireCompanyId } from "../chatbot-scope.ts";
import type { ChannelKind, OutboundMessage } from "../contracts/index.ts";
import { isChannelKind, sendOutbound, type OutboundPipelineDeps } from "./framework.ts";

export const OUTBOX_STATUSES = ["pending", "sending", "sent", "failed"] as const;
export type ChannelOutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const OUTBOX_DEFAULTS = {
  maxAttempts: 5,
  leaseMs: 120_000,
  baseBackoffMs: 30_000,
  maxBackoffMs: 30 * 60_000,
  batchSize: 20,
} as const;

const CONTENT_KINDS: readonly OutboundMessage["contentKind"][] = ["text", "image", "audio", "video", "file", "template"];
const MAX_IDEMPOTENCY_KEY = 256;
const MAX_RECIPIENT = 256;

export interface ChannelOutboxRow {
  id: string;
  companyId: string;
  channel: ChannelKind;
  accountId: string;
  recipient: string;
  contentKind: OutboundMessage["contentKind"];
  text: string | null;
  attachmentUrl: string | null;
  templateName: string | null;
  templateParams: Record<string, string> | null;
  replyToExternalMessageId: string | null;
  idempotencyKey: string;
  status: ChannelOutboxStatus;
  attempts: number;
  nextAttemptAt: Date;
  leaseUntil: Date | null;
  externalMessageId: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: Date;
  sentAt: Date | null;
}

/** An opaque transaction handle. The Drizzle store passes it to insert inside the caller's transaction; the memory store ignores it. */
export type OutboxTx = unknown;

export interface ChannelOutboxStore {
  /** Inserts the row, or returns the existing row for the same (company, idempotency key). */
  enqueue(tx: OutboxTx, row: ChannelOutboxRow): Promise<ChannelOutboxRow>;
  /** Moves "sending" rows whose lease has passed to "failed". Returns how many. */
  expireStaleLeases(companyId: string, now: Date): Promise<number>;
  /** Moves up to limit due "pending" rows to "sending", bumps attempts, sets the lease. */
  claimDue(companyId: string, now: Date, limit: number, leaseUntil: Date): Promise<ChannelOutboxRow[]>;
  markSent(companyId: string, id: string, at: Date, externalMessageId: string | null): Promise<boolean>;
  markRetry(companyId: string, id: string, nextAttemptAt: Date, errorCode: string, errorMessage: string): Promise<boolean>;
  markFailed(companyId: string, id: string, at: Date, errorCode: string, errorMessage: string): Promise<boolean>;
  findByKey(companyId: string, idempotencyKey: string): Promise<ChannelOutboxRow | null>;
}

export interface ChannelOutboxOptions {
  store: ChannelOutboxStore;
  clock?: () => Date;
  maxAttempts?: number;
  leaseMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface DrainSummary {
  expired: number;
  claimed: number;
  sent: number;
  retryScheduled: number;
  failed: number;
}

export interface ChannelOutbox {
  /** Writes one outbound row. Pass the transaction the reply is written in. */
  enqueue(tx: OutboxTx, companyId: string, message: OutboundMessage): Promise<ChannelOutboxRow>;
  /** One worker pass for one company. Safe to call again at any time: sent rows are never sent again. */
  drain(companyId: string, deps: OutboundPipelineDeps, batchSize?: number): Promise<DrainSummary>;
}

/** Exponential backoff: base, 2x, 4x, and so on, capped. attempt is the attempt that just failed (1 based). */
export function backoffMs(attempt: number, baseMs: number, maxMs: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(maxMs, baseMs * 2 ** exponent);
}

/** Maps a stored row back to the contract's OutboundMessage. The idempotency key is the row's key. */
export function toOutboundMessage(row: ChannelOutboxRow): OutboundMessage {
  return {
    channel: row.channel,
    accountId: row.accountId,
    recipient: row.recipient,
    contentKind: row.contentKind,
    text: row.text,
    attachmentUrl: row.attachmentUrl,
    templateName: row.templateName,
    templateParams: row.templateParams,
    replyToExternalMessageId: row.replyToExternalMessageId,
    idempotencyKey: row.idempotencyKey,
  };
}

/** Checks a message before it is written. Throws on bad shape. Provider limits are checked at send time. */
export function validateOutboundForEnqueue(companyId: string, message: OutboundMessage): void {
  requireCompanyId(companyId);
  if (!isChannelKind(message?.channel)) throw new Error("outbox: unknown channel");
  if (typeof message.accountId !== "string" || message.accountId.length === 0) throw new Error("outbox: account is required");
  if (typeof message.recipient !== "string" || message.recipient.length === 0 || message.recipient.length > MAX_RECIPIENT) {
    throw new Error("outbox: recipient is required");
  }
  if (!CONTENT_KINDS.includes(message.contentKind)) throw new Error("outbox: unknown content kind");
  if (typeof message.idempotencyKey !== "string" || message.idempotencyKey.length === 0 || message.idempotencyKey.length > MAX_IDEMPOTENCY_KEY) {
    throw new Error("outbox: idempotency key is required");
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

export function createChannelOutbox(options: ChannelOutboxOptions): ChannelOutbox {
  const { store } = options;
  const clock = options.clock ?? (() => new Date());
  const maxAttempts = options.maxAttempts ?? OUTBOX_DEFAULTS.maxAttempts;
  const leaseMs = options.leaseMs ?? OUTBOX_DEFAULTS.leaseMs;
  const baseBackoffMs = options.baseBackoffMs ?? OUTBOX_DEFAULTS.baseBackoffMs;
  const maxBackoffMs = options.maxBackoffMs ?? OUTBOX_DEFAULTS.maxBackoffMs;

  return {
    async enqueue(tx, companyId, message) {
      validateOutboundForEnqueue(companyId, message);
      const now = clock();
      return store.enqueue(tx, {
        id: randomUUID(),
        companyId,
        channel: message.channel,
        accountId: message.accountId,
        recipient: message.recipient,
        contentKind: message.contentKind,
        text: message.text,
        attachmentUrl: message.attachmentUrl,
        templateName: message.templateName,
        templateParams: message.templateParams ? { ...message.templateParams } : null,
        replyToExternalMessageId: message.replyToExternalMessageId,
        idempotencyKey: message.idempotencyKey,
        status: "pending",
        attempts: 0,
        nextAttemptAt: now,
        leaseUntil: null,
        externalMessageId: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        createdAt: now,
        sentAt: null,
      });
    },

    async drain(companyId, deps, batchSize = OUTBOX_DEFAULTS.batchSize) {
      requireCompanyId(companyId);
      const start = clock();
      const summary: DrainSummary = { expired: 0, claimed: 0, sent: 0, retryScheduled: 0, failed: 0 };

      summary.expired = await store.expireStaleLeases(companyId, start);
      const rows = await store.claimDue(companyId, start, batchSize, new Date(start.getTime() + leaseMs));
      summary.claimed = rows.length;

      for (const row of rows) {
        const result = await sendOutbound(deps, companyId, toOutboundMessage(row));
        const at = clock();

        if (result.status === "sent") {
          await store.markSent(companyId, row.id, at, result.externalMessageId);
          summary.sent += 1;
        } else if (result.status === "queued") {
          // The provider already holds the message (its own ledger shows it pending). Never resend it.
          await store.markSent(companyId, row.id, at, null);
          summary.sent += 1;
        } else if (result.retryable && row.attempts < maxAttempts) {
          const wait = backoffMs(row.attempts, baseBackoffMs, maxBackoffMs);
          await store.markRetry(companyId, row.id, new Date(at.getTime() + wait), result.errorCode, truncate(result.message, 300));
          summary.retryScheduled += 1;
        } else {
          await store.markFailed(companyId, row.id, at, result.errorCode, truncate(result.message, 300));
          summary.failed += 1;
        }
      }
      return summary;
    },
  };
}

/** In-memory store with the same rules as the Drizzle store. For tests and local wiring only. */
export function createMemoryChannelOutboxStore(): ChannelOutboxStore & { rowsFor(companyId: string): ChannelOutboxRow[] } {
  const rows: ChannelOutboxRow[] = [];
  const copy = (row: ChannelOutboxRow): ChannelOutboxRow => ({ ...row, templateParams: row.templateParams ? { ...row.templateParams } : null });
  const find = (companyId: string, id: string) => rows.find((row) => row.companyId === companyId && row.id === id);

  return {
    async enqueue(_tx, row) {
      const existing = rows.find((item) => item.companyId === row.companyId && item.idempotencyKey === row.idempotencyKey);
      if (existing) return copy(existing);
      rows.push(copy(row));
      return copy(row);
    },

    async expireStaleLeases(companyId, now) {
      let count = 0;
      for (const row of rows) {
        if (row.companyId === companyId && row.status === "sending" && row.leaseUntil !== null && row.leaseUntil <= now) {
          row.status = "failed";
          row.leaseUntil = null;
          row.lastErrorCode = "lease_expired";
          row.lastErrorMessage = "Send lease expired before the outcome was recorded. Not resent.";
          count += 1;
        }
      }
      return count;
    },

    async claimDue(companyId, now, limit, leaseUntil) {
      const due = rows
        .filter((row) => row.companyId === companyId && row.status === "pending" && row.nextAttemptAt <= now)
        .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
        .slice(0, limit);
      for (const row of due) {
        row.status = "sending";
        row.attempts += 1;
        row.leaseUntil = leaseUntil;
      }
      return due.map(copy);
    },

    async markSent(companyId, id, at, externalMessageId) {
      const row = find(companyId, id);
      if (!row || row.status !== "sending") return false;
      Object.assign(row, { status: "sent", sentAt: at, externalMessageId, leaseUntil: null, lastErrorCode: null, lastErrorMessage: null });
      return true;
    },

    async markRetry(companyId, id, nextAttemptAt, errorCode, errorMessage) {
      const row = find(companyId, id);
      if (!row || row.status !== "sending") return false;
      Object.assign(row, { status: "pending", nextAttemptAt, leaseUntil: null, lastErrorCode: errorCode, lastErrorMessage: errorMessage });
      return true;
    },

    async markFailed(companyId, id, _at, errorCode, errorMessage) {
      const row = find(companyId, id);
      if (!row || row.status !== "sending") return false;
      Object.assign(row, { status: "failed", leaseUntil: null, lastErrorCode: errorCode, lastErrorMessage: errorMessage });
      return true;
    },

    async findByKey(companyId, idempotencyKey) {
      const row = rows.find((item) => item.companyId === companyId && item.idempotencyKey === idempotencyKey);
      return row ? copy(row) : null;
    },

    rowsFor(companyId) {
      return rows.filter((row) => row.companyId === companyId).map(copy);
    },
  };
}

// Async-safe audit sink for comms modules.
//
// The comms modules (contact-merge, contact-import, suppression) call their audit callback
// synchronously and expect it to return at once. logAuditEvent is async, so this adapter takes
// each entry into an in-order queue synchronously and writes the queue through the injected
// writer one entry at a time. A failed write keeps its entry at the head of the queue and is
// retried after a delay, so no entry is dropped and the order is kept.
//
// Type imports from the server modules, plus the no-import comms-audit-events builder. This file loads no
// database pool and no network.
import { randomUUID } from 'node:crypto';
import type { AuditAction, AuditLogEntry } from '../../services/audit-log';
import type { MergeAudit } from './contact-merge';
import type { ExportAuditEntry } from './contact-import';
import type { SuppressionAuditEntry } from './suppression';
import { buildCommsAuditEvent, type CommsEventType } from './comms-audit-events.ts';

/** The comms event actions (see comms-audit-events.ts). Each one maps to the same-named AuditAction. */
export type CommsEventAction =
  | 'comms.draft_created'
  | 'comms.draft_edited'
  | 'comms.approval_recorded'
  | 'comms.message_sent'
  | 'comms.assignment_changed'
  | 'comms.campaign_changed'
  | 'comms.provider_event'
  | 'comms.human_override';

/**
 * One comms event, already built and allowlisted by buildCommsAuditEvent. The detail is copied
 * as given, so only the fields the builder kept reach the log.
 */
export interface CommsEventAuditEntry {
  action: CommsEventAction;
  companyId: string;
  actorId: string;
  /** ISO 8601 time from the caller's clock. */
  at: string;
  target: { type: string; id: string };
  detail: Readonly<Record<string, string | null>>;
}

export type CommsAuditEntry = MergeAudit | ExportAuditEntry | SuppressionAuditEntry | CommsEventAuditEntry;

/** The comms actions this sink accepts. Each must also be a member of AuditAction. */
export const COMMS_AUDIT_ACTIONS: readonly AuditAction[] = [
  'contacts_merged',
  'comms.audience_export',
  'comms.suppression_changed',
  'comms.draft_created',
  'comms.draft_edited',
  'comms.approval_recorded',
  'comms.message_sent',
  'comms.assignment_changed',
  'comms.campaign_changed',
  'comms.provider_event',
  'comms.human_override',
];

export type AuditWriter = (entry: AuditLogEntry) => Promise<void>;

export type AuditSinkRefusedReason =
  | 'write_missing'
  | 'invalid_company'
  | 'unknown_action'
  | 'company_mismatch';

export class AuditSinkRefused extends Error {
  readonly reason: AuditSinkRefusedReason;

  constructor(reason: AuditSinkRefusedReason) {
    super(reason);
    this.name = 'AuditSinkRefused';
    this.reason = reason;
  }
}

export interface CommsAuditSinkOptions {
  /** Pass logAuditEvent from services/audit-log. Required. */
  write: AuditWriter;
  /** Delay before retrying a failed write. Defaults to 1000 ms. */
  retryDelayMs?: number;
}

export interface CommsAuditSink {
  /**
   * Synchronous audit callback for entries that name their own company (suppression entries).
   * The entry's companyId must be a UUID, or the entry is refused.
   */
  audit(entry: CommsAuditEntry): void;
  /**
   * Returns the synchronous audit callback for one company. Entries that carry a companyId
   * must match it. The company comes from the verified session, never from the entry.
   */
  forCompany(companyId: string): (entry: CommsAuditEntry) => void;
  /**
   * Like forCompany, but the returned function writes through the writer and resolves only after
   * the writer resolves. It rejects when the writer rejects. Send audit events need this path:
   * the queued path above returns before any write, so it cannot block a send.
   * Entries written here are not ordered against entries still in the queue.
   */
  forCompanyDurable(companyId: string): (entry: CommsAuditEntry) => Promise<void>;
  /** Number of entries still queued, including one being retried. */
  pending(): number;
  /** Waits until the queue is empty or timeoutMs passes. Resolves with the count still queued. */
  flush(timeoutMs?: number): Promise<number>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_RETRY_DELAY_MS = 1000;
const FLUSH_POLL_MS = 10;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retry delay: unref'd, like the flush timer in audit-log.ts, so a retry loop does not keep the process alive.
function retryWait(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    if (timer.unref) timer.unref();
  });
}

/** Maps a comms audit entry to the shape logAuditEvent takes. Only named fields are copied. */
function toAuditLogEntry(entry: CommsAuditEntry, companyId: string): AuditLogEntry {
  switch (entry.action) {
    case 'contacts_merged':
      return {
        action: entry.action,
        userId: entry.actorId,
        resourceType: 'contact',
        resourceId: entry.primaryId,
        metadata: { companyId, duplicateId: entry.duplicateId, at: entry.at },
      };
    case 'comms.audience_export':
      return {
        action: entry.action,
        userId: entry.actorId,
        resourceType: 'contact_export',
        metadata: { companyId, rowCount: entry.rowCount, at: entry.at },
      };
    case 'comms.suppression_changed':
      // Only the hash of the address is written, never the address itself.
      return {
        action: entry.action,
        userId: entry.actorId,
        resourceType: 'suppression',
        metadata: {
          companyId,
          change: entry.change,
          channel: entry.channel,
          addressHash: entry.addressHash,
          reason: entry.reason,
          at: entry.at,
        },
      };
    case 'comms.draft_created':
    case 'comms.draft_edited':
    case 'comms.approval_recorded':
    case 'comms.message_sent':
    case 'comms.assignment_changed':
    case 'comms.campaign_changed':
    case 'comms.provider_event':
    case 'comms.human_override':
      // Detail is already allowlisted by the event builder. The company and time are added here.
      return {
        action: entry.action,
        userId: entry.actorId,
        resourceType: entry.target.type,
        resourceId: entry.target.id,
        metadata: { ...entry.detail, companyId, at: entry.at },
      };
    default:
      throw new AuditSinkRefused('unknown_action');
  }
}

export function createCommsAuditSink(options: CommsAuditSinkOptions): CommsAuditSink {
  if (typeof options?.write !== 'function') {
    throw new AuditSinkRefused('write_missing');
  }
  const write = options.write;
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const allowed = new Set<string>(COMMS_AUDIT_ACTIONS);

  const queue: AuditLogEntry[] = [];
  let running: Promise<void> | null = null;

  // Single drainer. Entries are written strictly in the order they were queued.
  async function drain(): Promise<void> {
    while (queue.length > 0) {
      try {
        await write(queue[0]);
        queue.shift();
      } catch {
        // Keep the head entry and retry it, so nothing is skipped or reordered.
        await retryWait(retryDelayMs);
      }
    }
    running = null;
  }

  function enqueue(entry: AuditLogEntry): void {
    queue.push(entry);
    if (running === null) {
      running = drain();
    }
  }

  function prepare(entry: CommsAuditEntry, companyId: string): AuditLogEntry {
    if (!entry || typeof entry !== 'object' || !allowed.has(entry.action)) {
      throw new AuditSinkRefused('unknown_action');
    }
    return toAuditLogEntry(entry, companyId);
  }

  function accept(entry: CommsAuditEntry, companyId: string): void {
    enqueue(prepare(entry, companyId));
  }

  return {
    audit(entry: CommsAuditEntry): void {
      const companyId = (entry as { companyId?: unknown } | null)?.companyId;
      if (typeof companyId !== 'string' || !UUID.test(companyId)) {
        throw new AuditSinkRefused('invalid_company');
      }
      accept(entry, companyId);
    },

    forCompany(companyId: string) {
      if (typeof companyId !== 'string' || !UUID.test(companyId)) {
        throw new AuditSinkRefused('invalid_company');
      }
      return (entry: CommsAuditEntry): void => {
        const entryCompany = (entry as { companyId?: unknown } | null)?.companyId;
        if (entryCompany !== undefined && entryCompany !== companyId) {
          throw new AuditSinkRefused('company_mismatch');
        }
        accept(entry, companyId);
      };
    },

    forCompanyDurable(companyId: string) {
      if (typeof companyId !== 'string' || !UUID.test(companyId)) {
        throw new AuditSinkRefused('invalid_company');
      }
      return async (entry: CommsAuditEntry): Promise<void> => {
        const entryCompany = (entry as { companyId?: unknown } | null)?.companyId;
        if (entryCompany !== undefined && entryCompany !== companyId) {
          throw new AuditSinkRefused('company_mismatch');
        }
        await write(prepare(entry, companyId));
      };
    },

    pending(): number {
      return queue.length;
    },

    async flush(timeoutMs = 5000): Promise<number> {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      while (queue.length > 0 && Date.now() < deadline) {
        await sleep(FLUSH_POLL_MS);
      }
      return queue.length;
    },
  };
}

/**
 * Receives one built comms event. Pass forCompanyDurable(companyId) from the sink, or a test fake.
 * A send audit awaits the returned promise, so a rejection counts as a failed write.
 */
export type CommsEventSink = (entry: CommsEventAuditEntry) => void | Promise<void>;

/** Converts a Date, epoch milliseconds or ISO string to an ISO 8601 UTC string. Null when unreadable. */
export function toCommsIsoTime(value: unknown): string | null {
  let ms: number;
  if (value instanceof Date) {
    ms = value.getTime();
  } else if (typeof value === 'number') {
    ms = value;
  } else if (typeof value === 'string') {
    ms = Date.parse(value);
  } else {
    return null;
  }
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export interface RecordCommsEventInput {
  companyId: string;
  /** Required. Without a human or system actor id, nothing is recorded. */
  actorId?: string | null;
  /** The caller's clock reading for the event. */
  now: unknown;
  target: { type: string; id: string };
  detail?: Readonly<Record<string, unknown>>;
}

/**
 * Builds one comms event with buildCommsAuditEvent and hands it to the injected sink.
 * Records nothing, and returns false, when no sink is passed, the actor is missing, or the event
 * is refused. Returns true only when the sink accepted the event. Never throws, so the caller's
 * action (for example a send that already went out) is never turned into a failure by audit.
 */
export function recordCommsEvent(
  sink: CommsEventSink | null | undefined,
  type: CommsEventType,
  input: RecordCommsEventInput,
): boolean {
  if (typeof sink !== 'function') return false;
  if (typeof input.actorId !== 'string' || input.actorId.trim() === '') return false;
  const at = toCommsIsoTime(input.now);
  if (at === null) return false;
  try {
    const event = buildCommsAuditEvent(type, {
      companyId: input.companyId,
      actorId: input.actorId,
      at,
      target: input.target,
      detail: input.detail,
    });
    const written: unknown = sink({
      action: event.type,
      companyId: event.companyId,
      actorId: event.actorId,
      at: event.at,
      target: event.target,
      detail: event.detail,
    });
    // A rejected write here has no caller to report to. Swallow it so it is not an unhandled rejection.
    if (written instanceof Promise) written.then(undefined, () => {});
    return true;
  } catch {
    return false;
  }
}

// ---------- Send audit (fail closed) ----------
//
// A send writes a 'pending' comms.message_sent event before the provider is called. If that write
// fails, the send is refused and the provider is never called. After the provider answers, a second
// event with status 'sent' or 'provider_error' is written. If that second write fails, the send
// result is still returned, with auditRecorded false and auditError 'post_send_write_failed'.
// Both events share one correlation id as their target id.

export type CommsSendChannel = 'sms' | 'telegram' | 'whatsapp' | 'email' | 'messenger';

export interface CommsSendAuditOutcome {
  /** True only when the pending event and the outcome event were both written. */
  auditRecorded: boolean;
  /** Set when the pending event was written but the outcome event was not. */
  auditError?: 'post_send_write_failed';
}

/** Result for a send that never had an audit sink injected. Nothing was recorded. */
export const NO_SEND_AUDIT: CommsSendAuditOutcome = Object.freeze({ auditRecorded: false });

export type CommsAuditWriteReason = 'invalid_event' | 'write_failed';

export class CommsAuditWriteError extends Error {
  readonly reason: CommsAuditWriteReason;

  constructor(reason: CommsAuditWriteReason) {
    super(reason);
    this.name = 'CommsAuditWriteError';
    this.reason = reason;
  }
}

export interface CommsSendAuditContext {
  companyId: string;
  /** Required. Without a valid actor the pending event cannot be built, so the send is refused. */
  actorId: unknown;
  channel: CommsSendChannel;
  /** Clock reading for each event. Called once per event. */
  now: () => unknown;
}

export interface CommsSendAudit {
  /** Target id shared by the pending and outcome events. */
  readonly correlationId: string;
  /** Writes the outcome event. Never throws. */
  finish(status: 'sent' | 'provider_error'): Promise<CommsSendAuditOutcome>;
}

async function writeSendEvent(
  sink: CommsEventSink,
  ctx: CommsSendAuditContext,
  correlationId: string,
  status: 'pending' | 'sent' | 'provider_error',
): Promise<void> {
  const at = toCommsIsoTime(ctx.now());
  let event: ReturnType<typeof buildCommsAuditEvent>;
  try {
    event = buildCommsAuditEvent('comms.message_sent', {
      companyId: ctx.companyId,
      actorId: typeof ctx.actorId === 'string' ? ctx.actorId : '',
      at: at ?? '',
      target: { type: 'message', id: correlationId },
      detail: { channel: ctx.channel, status },
    });
  } catch {
    throw new CommsAuditWriteError('invalid_event');
  }
  try {
    await sink({
      action: event.type,
      companyId: event.companyId,
      actorId: event.actorId,
      at: event.at,
      target: event.target,
      detail: event.detail,
    });
  } catch {
    throw new CommsAuditWriteError('write_failed');
  }
}

/**
 * Writes the pending event and returns a handle for the outcome. Returns null when no sink is
 * injected, and records nothing. Throws CommsAuditWriteError when the pending event cannot be
 * written: the caller must then refuse the send and must not call the provider.
 */
export async function openSendAudit(
  sink: CommsEventSink | null | undefined,
  ctx: CommsSendAuditContext,
): Promise<CommsSendAudit | null> {
  if (typeof sink !== 'function') return null;
  const correlationId = randomUUID();
  await writeSendEvent(sink, ctx, correlationId, 'pending');
  return {
    correlationId,
    async finish(status) {
      try {
        await writeSendEvent(sink, ctx, correlationId, status);
        return { auditRecorded: true };
      } catch {
        return { auditRecorded: false, auditError: 'post_send_write_failed' };
      }
    },
  };
}

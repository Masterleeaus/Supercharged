// Comms audit event vocabulary and builder. Append-only: this module exports create-style
// builders only. There is no update, delete or remove path, and no function here mutates an event.
//
// Every event carries a company id (a UUID, required), an actor, an ISO 8601 time and a target.
// A missing or invalid company, actor, time or target is refused. Detail fields are copied only
// from a per-type allowlist, so message bodies, addresses and provider payloads cannot be written
// through this path.
//
// No imports: this file loads no database pool, no network and no server services.

export const COMMS_EVENT_TYPES = [
  'comms.draft_created',
  'comms.draft_edited',
  'comms.approval_recorded',
  'comms.message_sent',
  'comms.assignment_changed',
  'comms.campaign_changed',
  'comms.provider_event',
  'comms.human_override',
] as const;

export type CommsEventType = (typeof COMMS_EVENT_TYPES)[number];

/** Detail fields each type may carry. Any other key in the input is dropped. */
const DETAIL_FIELDS: Readonly<Record<CommsEventType, readonly string[]>> = {
  'comms.draft_created': ['channel'],
  'comms.draft_edited': ['channel'],
  'comms.approval_recorded': ['decision'],
  'comms.message_sent': ['channel', 'status'],
  'comms.assignment_changed': ['assigneeId'],
  'comms.campaign_changed': ['change'],
  'comms.provider_event': ['provider', 'providerEvent'],
  'comms.human_override': ['overridden', 'reason'],
};

/** Fields that may be null. Only an assignment can be cleared (unassigned). */
const NULLABLE_DETAIL_FIELDS: readonly string[] = ['assigneeId'];

const ENUM_DETAILS: Readonly<Record<string, readonly string[]>> = {
  decision: ['approved', 'rejected'],
  change: ['created', 'started', 'paused', 'resumed', 'edited'],
  status: ['pending', 'sent', 'provider_error'],
};

export type CommsEventDetail = Readonly<Record<string, string | null>>;

export interface CommsAuditEvent {
  readonly type: CommsEventType;
  readonly companyId: string;
  readonly actorId: string;
  /** ISO 8601 time, as supplied by the caller's clock. */
  readonly at: string;
  readonly target: { readonly type: string; readonly id: string };
  readonly detail: CommsEventDetail;
}

export interface CommsAuditEventInput {
  companyId: string;
  actorId: string;
  at: string;
  target: { type: string; id: string };
  detail?: Readonly<Record<string, unknown>>;
}

export type CommsAuditEventRefusedReason =
  | 'unknown_type'
  | 'invalid_company'
  | 'invalid_actor'
  | 'invalid_time'
  | 'invalid_target'
  | 'invalid_detail';

export class CommsAuditEventRefused extends Error {
  readonly reason: CommsAuditEventRefusedReason;

  constructor(reason: CommsAuditEventRefusedReason) {
    super(reason);
    this.name = 'CommsAuditEventRefused';
    this.reason = reason;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function pickDetail(type: CommsEventType, detail: Readonly<Record<string, unknown>> | undefined): CommsEventDetail {
  const out: Record<string, string | null> = {};
  if (!detail || typeof detail !== 'object') return out;
  for (const field of DETAIL_FIELDS[type]) {
    if (!(field in detail)) continue;
    const value = detail[field];
    if (value === null && NULLABLE_DETAIL_FIELDS.includes(field)) {
      out[field] = null;
      continue;
    }
    if (!isNonBlank(value)) throw new CommsAuditEventRefused('invalid_detail');
    const allowed = ENUM_DETAILS[field];
    if (allowed && !allowed.includes(value)) throw new CommsAuditEventRefused('invalid_detail');
    out[field] = value;
  }
  return Object.freeze(out);
}

/**
 * Builds one well-formed, frozen comms audit event. Refuses (throws CommsAuditEventRefused)
 * when the type is unknown, or the company, actor, time or target is missing or invalid.
 * The company must come from the verified session, never from a request body.
 */
export function buildCommsAuditEvent(type: CommsEventType, input: CommsAuditEventInput): CommsAuditEvent {
  if (!(COMMS_EVENT_TYPES as readonly string[]).includes(type)) {
    throw new CommsAuditEventRefused('unknown_type');
  }
  if (!input || typeof input !== 'object') {
    throw new CommsAuditEventRefused('invalid_company');
  }
  if (typeof input.companyId !== 'string' || !UUID.test(input.companyId)) {
    throw new CommsAuditEventRefused('invalid_company');
  }
  if (!isNonBlank(input.actorId)) {
    throw new CommsAuditEventRefused('invalid_actor');
  }
  if (typeof input.at !== 'string' || !ISO_TIME.test(input.at) || Number.isNaN(Date.parse(input.at))) {
    throw new CommsAuditEventRefused('invalid_time');
  }
  const target = input.target;
  if (!target || !isNonBlank(target.type) || !isNonBlank(target.id)) {
    throw new CommsAuditEventRefused('invalid_target');
  }

  return Object.freeze({
    type,
    companyId: input.companyId,
    actorId: input.actorId,
    at: input.at,
    target: Object.freeze({ type: target.type, id: target.id }),
    detail: pickDetail(type, input.detail),
  });
}

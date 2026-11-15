/**
 * Verification and idempotent handling for Central's signed outbox events (issue #196).
 * Mirrors Central's contract (docs/EVENTS.md): HMAC-SHA256 over the canonical JSON of every
 * envelope field except `signature`, keyed by the route secret. Delivery is at least once.
 *
 * Order of checks: shape, signature (any key valid now), tenant binding, event type, freshness.
 * Nothing in the envelope is used before the signature verifies.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const MIN_SECRET_LENGTH = 32;
export const MAX_PAYLOAD_BYTES = 4096;
export const DEFAULT_MAX_EVENT_AGE_MS = 15 * 60_000;
const FUTURE_SKEW_MS = 60_000;
const SIGNATURE = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const STRING_FIELDS = ['eventId', 'organisationId', 'sourceProduct', 'eventType', 'correlationId', 'idempotencyKey', 'occurredAt', 'signature'] as const;

export type EventEnvelope = Readonly<{
  eventId: string;
  organisationId: string;
  sourceProduct: string;
  eventType: string;
  schemaVersion: number;
  correlationId: string;
  idempotencyKey: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  signature: string;
}>;

export type RouteKeyMs = Readonly<{ id: string; secret: string; notBeforeMs: number; notAfterMs: number }>;

export type EventRoute = Readonly<{
  consumer: string;
  organisationId: string;
  eventTypes: readonly string[];
  keys: readonly RouteKeyMs[];
}>;

export type EventRejectionCode =
  | 'invalid_envelope'
  | 'no_active_key'
  | 'bad_signature'
  | 'tenant_mismatch'
  | 'unknown_event_type'
  | 'stale_event';

export class EventRejectedError extends Error {
  readonly code: EventRejectionCode;
  constructor(code: EventRejectionCode) {
    super(`signed event rejected: ${code}`);
    this.name = 'EventRejectedError';
    this.code = code;
  }
}

/** Same canonical form as Central: keys sorted at every depth, JSON otherwise. */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 32) throw new EventRejectedError('invalid_envelope');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new EventRejectedError('invalid_envelope');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const parts = Object.keys(record).sort().map((key) => {
      const item = record[key];
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
        throw new EventRejectedError('invalid_envelope');
      }
      return `${JSON.stringify(key)}:${canonicalJson(item, depth + 1)}`;
    });
    return `{${parts.join(',')}}`;
  }
  throw new EventRejectedError('invalid_envelope');
}

export function signEnvelope(unsigned: Record<string, unknown>, secret: string): string {
  return createHmac('sha256', secret).update(canonicalJson(unsigned), 'utf8').digest('hex');
}

function shapeOk(e: Record<string, unknown>): boolean {
  for (const field of STRING_FIELDS) {
    if (typeof e[field] !== 'string' || (e[field] as string).length === 0) return false;
  }
  if (!Number.isSafeInteger(e.schemaVersion) || (e.schemaVersion as number) < 1) return false;
  if (e.payload === null || typeof e.payload !== 'object' || Array.isArray(e.payload)) return false;
  return UUID.test(e.organisationId as string) && (e.eventId as string).length <= 128;
}

/** Verifies one raw envelope against a route. Returns the typed envelope or throws EventRejectedError. */
export function verifyInboundEvent(input: {
  raw: unknown;
  route: EventRoute;
  nowMs: number;
  maxAgeMs?: number;
}): EventEnvelope {
  const { raw, route, nowMs } = input;
  const maxAgeMs = input.maxAgeMs ?? DEFAULT_MAX_EVENT_AGE_MS;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new EventRejectedError('invalid_envelope');
  const envelope = raw as Record<string, unknown>;
  if (!shapeOk(envelope)) throw new EventRejectedError('invalid_envelope');

  const { signature, ...unsigned } = envelope;
  if (typeof signature !== 'string' || !SIGNATURE.test(signature)) throw new EventRejectedError('bad_signature');
  const active = route.keys.filter((k) => k.notBeforeMs <= nowMs && nowMs < k.notAfterMs);
  if (active.length === 0) throw new EventRejectedError('no_active_key');
  const given = Buffer.from(signature, 'hex');
  let verified = false;
  for (const key of active) {
    const expected = createHmac('sha256', key.secret).update(canonicalJson(unsigned), 'utf8').digest();
    if (expected.length === given.length && timingSafeEqual(expected, given)) verified = true;
  }
  if (!verified) throw new EventRejectedError('bad_signature');

  if ((envelope.organisationId as string).toLowerCase() !== route.organisationId.toLowerCase()) {
    throw new EventRejectedError('tenant_mismatch');
  }
  if (!EVENT_TYPE.test(envelope.eventType as string) || !route.eventTypes.includes(envelope.eventType as string)) {
    throw new EventRejectedError('unknown_event_type');
  }
  const occurredMs = Date.parse(envelope.occurredAt as string);
  if (!Number.isFinite(occurredMs) || nowMs - occurredMs > maxAgeMs || occurredMs - nowMs > FUTURE_SKEW_MS) {
    throw new EventRejectedError('stale_event');
  }
  return Object.freeze({ ...(envelope as unknown as EventEnvelope) });
}

export type ProcessedStore = {
  /** Records the event id. Returns false when it was already recorded. */
  claim(consumer: string, eventId: string): Promise<boolean>;
  /** Removes a claim after a failed effect, so a later delivery can retry. */
  release(consumer: string, eventId: string): Promise<void>;
};

/** Runs the effect once per (consumer, eventId). Production must back the store with the same transaction. */
export function createIdempotentConsumer(input: {
  consumer: string;
  store: ProcessedStore;
  handle: (envelope: EventEnvelope) => Promise<void>;
}): (envelope: EventEnvelope) => Promise<'processed' | 'duplicate'> {
  return async (envelope) => {
    const first = await input.store.claim(input.consumer, envelope.eventId);
    if (!first) return 'duplicate';
    try {
      await input.handle(envelope);
    } catch (error) {
      await input.store.release(input.consumer, envelope.eventId);
      throw error;
    }
    return 'processed';
  };
}

/** In-memory store for tests and single-process use only. It is not durable. */
export function createMemoryProcessedStore(): ProcessedStore & { size(): number } {
  const seen = new Set<string>();
  return {
    async claim(consumer, eventId) {
      const id = `${consumer}\u0000${eventId}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    },
    async release(consumer, eventId) {
      seen.delete(`${consumer}\u0000${eventId}`);
    },
    size() {
      return seen.size;
    },
  };
}

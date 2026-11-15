/**
 * Consumer for Scheduled booking events (Sc3). Scheduled owns bookings; this module only keeps a
 * read-only mirror of the booking state those events announce.
 *
 * Event names on the wire follow Central docs/EVENTS.md: eventType is a slug (letters, digits and
 * underscore), so `booking.created` travels as `booking_created` at schemaVersion 1.
 *
 * Order of checks: flag, body size, JSON parse, signature (via verifyInboundEvent), source product,
 * event type, payload shape, then one database transaction that claims the idempotency key and
 * moves the mirror forward. Nothing in the envelope is used before the signature verifies.
 */
import {
  canonicalJson,
  EventRejectedError,
  verifyInboundEvent,
  type EventEnvelope,
  type EventRoute,
  type RouteKeyMs,
} from '../central-oidc/signed-events.ts';

export const SCHEDULED_SOURCE_PRODUCT = 'scheduled';
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_PAYLOAD_BYTES = 4096;
const BOOKING_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export const BOOKING_EVENT_TYPES = Object.freeze(['booking_created', 'booking_cancelled', 'booking_rescheduled'] as const);
export type BookingEventType = (typeof BOOKING_EVENT_TYPES)[number];

export type BookingEvent = Readonly<{
  companyId: string;
  idempotencyKey: string;
  eventId: string;
  eventType: BookingEventType;
  bookingId: string;
  status: 'booked' | 'cancelled';
  startsAt: string | null;
  endsAt: string | null;
  occurredAt: string;
}>;

export type ApplyOutcome = 'applied' | 'duplicate' | 'stale';

/** Store contract. Implementations must make `apply` atomic: claim the key and move the mirror together. */
export interface ScheduledBookingStore {
  apply(event: BookingEvent): Promise<ApplyOutcome>;
}

export type BookingConsumeResult = 'applied' | 'duplicate' | 'stale' | 'disabled';

export class ScheduledBookingConsumerError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`scheduled booking event rejected: ${code}`);
    this.name = 'ScheduledBookingConsumerError';
    this.code = code;
  }
}

/** Maps an eventType on the wire to the mirror status it sets. Payload status is never trusted. */
const STATUS_FOR: Readonly<Record<BookingEventType, 'booked' | 'cancelled'>> = Object.freeze({
  booking_created: 'booked',
  booking_rescheduled: 'booked',
  booking_cancelled: 'cancelled',
});

function isoOrNull(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new ScheduledBookingConsumerError(`invalid_payload:${field}`);
  }
  return new Date(Date.parse(value)).toISOString();
}

/** Keeps only the fields the mirror needs. Unknown payload fields are dropped, not stored. */
export function normaliseBookingPayload(eventType: BookingEventType, payload: Record<string, unknown>) {
  if (canonicalJson(payload).length > MAX_PAYLOAD_BYTES) throw new ScheduledBookingConsumerError('payload_too_large');
  const bookingId = payload.bookingId;
  if (typeof bookingId !== 'string' || !BOOKING_ID.test(bookingId)) {
    throw new ScheduledBookingConsumerError('invalid_payload:bookingId');
  }
  const startsAt = isoOrNull(payload.startsAt, 'startsAt');
  const endsAt = isoOrNull(payload.endsAt, 'endsAt');
  if (eventType !== 'booking_cancelled' && startsAt === null) {
    throw new ScheduledBookingConsumerError('invalid_payload:startsAt');
  }
  return { bookingId, startsAt, endsAt };
}

/** Parses and verifies one raw body. Pure: no clock or database access beyond `nowMs`. */
export function parseScheduledBookingEvent(input: {
  rawBody: string;
  route: EventRoute;
  nowMs: number;
  maxAgeMs?: number;
}): BookingEvent {
  if (Buffer.byteLength(input.rawBody, 'utf8') > MAX_BODY_BYTES) {
    throw new ScheduledBookingConsumerError('body_too_large');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(input.rawBody);
  } catch {
    throw new ScheduledBookingConsumerError('invalid_envelope');
  }
  let envelope: EventEnvelope;
  try {
    envelope = verifyInboundEvent({ raw, route: input.route, nowMs: input.nowMs, maxAgeMs: input.maxAgeMs });
  } catch (error) {
    if (error instanceof EventRejectedError) throw new ScheduledBookingConsumerError(error.code);
    throw error;
  }
  if (envelope.sourceProduct !== SCHEDULED_SOURCE_PRODUCT) {
    throw new ScheduledBookingConsumerError('wrong_source');
  }
  const eventType = envelope.eventType as BookingEventType;
  if (!(BOOKING_EVENT_TYPES as readonly string[]).includes(eventType) || envelope.schemaVersion !== 1) {
    throw new ScheduledBookingConsumerError('unsupported_event');
  }
  const { bookingId, startsAt, endsAt } = normaliseBookingPayload(eventType, envelope.payload);
  return Object.freeze({
    companyId: envelope.organisationId.toLowerCase(),
    idempotencyKey: envelope.idempotencyKey,
    eventId: envelope.eventId,
    eventType,
    bookingId,
    status: STATUS_FOR[eventType],
    startsAt,
    endsAt,
    occurredAt: new Date(Date.parse(envelope.occurredAt)).toISOString(),
  });
}

/**
 * Builds the consumer. `enabled` comes from the flag reader; when false, every call returns
 * 'disabled' without reading the body or touching the store.
 */
export function createScheduledBookingConsumer(input: {
  enabled: boolean;
  route: EventRoute;
  store: ScheduledBookingStore;
  clock?: () => number;
  maxAgeMs?: number;
}) {
  const clock = input.clock ?? (() => Date.now());
  return async function consume(rawBody: string): Promise<BookingConsumeResult> {
    if (!input.enabled) return 'disabled';
    const event = parseScheduledBookingEvent({
      rawBody,
      route: input.route,
      nowMs: clock(),
      maxAgeMs: input.maxAgeMs,
    });
    return input.store.apply(event);
  };
}

export type { EventRoute, RouteKeyMs };

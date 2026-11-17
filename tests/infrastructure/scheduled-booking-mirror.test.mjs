// Sc3: Scheduled booking events consumer and read-only mirror. Fixed secrets, fixed clock, fake store.
// No database and no network. The PostgreSQL SQL is checked against a fake pool, not a real server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { signEnvelope } from '../../server/infrastructure/central-oidc/signed-events.ts';
import {
  createScheduledBookingConsumer, parseScheduledBookingEvent, ScheduledBookingConsumerError, MAX_BODY_BYTES,
} from '../../server/infrastructure/scheduled-booking-mirror/consumer.ts';
import { readMirrorRoute, isMirrorEnabled, ScheduledBookingConfigError, MIRROR_FLAG_ENV } from '../../server/infrastructure/scheduled-booking-mirror/config.ts';
import { createPgScheduledBookingStore } from '../../server/infrastructure/scheduled-booking-mirror/pg-store.ts';

const NOW = Date.parse('2026-11-15T10:00:00Z');
const COMPANY = '00000000-0000-4000-8000-00000000000a';
const OTHER = '00000000-0000-4000-8000-00000000000b';
const SECRET = 's'.repeat(48);
const WRONG = 'w'.repeat(48);
const ENV = { [MIRROR_FLAG_ENV]: 'true', SCHEDULED_BOOKING_EVENTS_SECRET: SECRET, SCHEDULED_BOOKING_ORGANISATION_ID: COMPANY };
const route = readMirrorRoute(ENV);

function raw(overrides = {}, secret = SECRET) {
  const unsigned = {
    eventId: '22222222-2222-4222-8222-222222222222',
    organisationId: COMPANY,
    sourceProduct: 'scheduled',
    eventType: 'booking_created',
    schemaVersion: 1,
    correlationId: 'corr-1',
    idempotencyKey: 'scheduled:booking:B-100:created',
    occurredAt: '2026-11-15T09:59:00Z',
    payload: { bookingId: 'B-100', startsAt: '2026-11-20T09:00:00Z', endsAt: '2026-11-20T10:00:00Z', status: 'x', client: 'private' },
    ...overrides,
  };
  return JSON.stringify({ ...unsigned, signature: signEnvelope(unsigned, secret) });
}

/** In-memory store with the same rules as the SQL: key claim first, then forward-only mirror. */
function memoryStore() {
  const keys = new Set();
  const mirror = new Map();
  const calls = [];
  return {
    calls, keys, mirror,
    async apply(event) {
      calls.push(event.idempotencyKey);
      const k = `${event.companyId}|${event.idempotencyKey}`;
      if (keys.has(k)) return 'duplicate';
      keys.add(k);
      const m = `${event.companyId}|${event.bookingId}`;
      const prev = mirror.get(m);
      if (prev && Date.parse(prev.lastOccurredAt) > Date.parse(event.occurredAt)) return 'stale';
      mirror.set(m, { status: event.status, startsAt: event.startsAt, endsAt: event.endsAt, lastOccurredAt: event.occurredAt });
      return 'applied';
    },
  };
}

test('a valid booking_created event is verified, typed and applied to the mirror', async () => {
  const store = memoryStore();
  const consume = createScheduledBookingConsumer({ enabled: true, route, store, clock: () => NOW });
  assert.equal(await consume(raw()), 'applied');
  const row = store.mirror.get(`${COMPANY}|B-100`);
  assert.equal(row.status, 'booked');
  assert.equal(row.startsAt, '2026-11-20T09:00:00.000Z');
  assert.equal(row.endsAt, '2026-11-20T10:00:00.000Z');
});

test('the parsed event keeps only mirror fields; payload status and client data are dropped', () => {
  const event = parseScheduledBookingEvent({ rawBody: raw(), route, nowMs: NOW });
  assert.deepEqual(Object.keys(event).sort(), ['bookingId', 'companyId', 'endsAt', 'eventId', 'eventType', 'idempotencyKey', 'occurredAt', 'startsAt', 'status']);
  assert.equal(event.status, 'booked');
});

test('a bad signature is refused before the store is touched', async () => {
  const store = memoryStore();
  const consume = createScheduledBookingConsumer({ enabled: true, route, store, clock: () => NOW });
  await assert.rejects(consume(raw({}, WRONG)), (e) => e instanceof ScheduledBookingConsumerError && e.code === 'bad_signature');
  const tampered = JSON.parse(raw());
  tampered.payload.startsAt = '2026-12-01T09:00:00Z';
  await assert.rejects(consume(JSON.stringify(tampered)), { code: 'bad_signature' });
  assert.equal(store.calls.length, 0);
});

test('a duplicate event (same idempotency key) is a no-op and leaves the mirror unchanged', async () => {
  const store = memoryStore();
  const consume = createScheduledBookingConsumer({ enabled: true, route, store, clock: () => NOW });
  const body = raw();
  assert.equal(await consume(body), 'applied');
  const before = JSON.stringify([...store.mirror.entries()]);
  assert.equal(await consume(body), 'duplicate');
  assert.equal(JSON.stringify([...store.mirror.entries()]), before);
});

test('a later cancellation moves the mirror to cancelled, and a late older event does not undo it', async () => {
  const store = memoryStore();
  const consume = createScheduledBookingConsumer({ enabled: true, route, store, clock: () => NOW });
  assert.equal(await consume(raw({ occurredAt: '2026-11-15T09:50:00Z' })), 'applied');
  const cancel = raw({ eventType: 'booking_cancelled', idempotencyKey: 'scheduled:booking:B-100:cancelled', occurredAt: '2026-11-15T09:55:00Z', eventId: '33333333-3333-4333-8333-333333333333', payload: { bookingId: 'B-100' } });
  assert.equal(await consume(cancel), 'applied');
  assert.equal(store.mirror.get(`${COMPANY}|B-100`).status, 'cancelled');
  assert.equal(await consume(raw({ occurredAt: '2026-11-15T09:47:00Z', idempotencyKey: 'scheduled:booking:B-100:late' })), 'stale');
  assert.equal(store.mirror.get(`${COMPANY}|B-100`).status, 'cancelled');
});

test('the flag is off by default and nothing is read or stored when it is off', async () => {
  assert.equal(isMirrorEnabled({}), false);
  assert.equal(isMirrorEnabled({ [MIRROR_FLAG_ENV]: '1' }), false);
  assert.equal(readMirrorRoute({}), null);
  const store = memoryStore();
  const consume = createScheduledBookingConsumer({ enabled: false, route: null ?? route, store, clock: () => NOW });
  assert.equal(await consume('not json at all'), 'disabled');
  assert.equal(store.calls.length, 0);
});

test('enabling the flag without a valid secret or organisation id fails with the variable name only', () => {
  assert.throws(() => readMirrorRoute({ [MIRROR_FLAG_ENV]: 'true', SCHEDULED_BOOKING_ORGANISATION_ID: COMPANY }), (e) => e instanceof ScheduledBookingConfigError && /SCHEDULED_BOOKING_EVENTS_SECRET/.test(e.message) && !e.message.includes(COMPANY));
  assert.throws(() => readMirrorRoute({ ...ENV, SCHEDULED_BOOKING_ORGANISATION_ID: 'not-a-uuid' }), /SCHEDULED_BOOKING_ORGANISATION_ID/);
});

test('wrong source, dotted or unknown event names, other schema versions and other tenants are refused', async () => {
  const store = memoryStore();
  const consume = createScheduledBookingConsumer({ enabled: true, route, store, clock: () => NOW });
  await assert.rejects(consume(raw({ sourceProduct: 'sorted' })), { code: 'wrong_source' });
  await assert.rejects(consume(raw({ eventType: 'booking.created' })), { code: 'unknown_event_type' });
  await assert.rejects(consume(raw({ eventType: 'invoice_paid' })), { code: 'unknown_event_type' });
  await assert.rejects(consume(raw({ schemaVersion: 2 })), { code: 'unsupported_event' });
  await assert.rejects(consume(raw({ organisationId: OTHER })), { code: 'tenant_mismatch' });
  assert.equal(store.calls.length, 0);
});

test('payload rules: bookingId required, startsAt required for create, oversize body and payload refused', () => {
  assert.throws(() => parseScheduledBookingEvent({ rawBody: raw({ payload: { startsAt: '2026-11-20T09:00:00Z' } }), route, nowMs: NOW }), { code: 'invalid_payload:bookingId' });
  assert.throws(() => parseScheduledBookingEvent({ rawBody: raw({ payload: { bookingId: 'B-1' } }), route, nowMs: NOW }), { code: 'invalid_payload:startsAt' });
  assert.throws(() => parseScheduledBookingEvent({ rawBody: raw({ payload: { bookingId: 'B-1', startsAt: '2026-11-20T09:00:00Z', note: 'x'.repeat(4200) } }), route, nowMs: NOW }), { code: 'payload_too_large' });
  assert.throws(() => parseScheduledBookingEvent({ rawBody: 'x'.repeat(MAX_BODY_BYTES + 1), route, nowMs: NOW }), { code: 'body_too_large' });
});

test('the PostgreSQL store claims the key in a transaction and reports duplicate, stale or applied', async () => {
  // Answers by statement: the claim and mirror rowCounts are set per scenario, BEGIN/COMMIT are not counted.
  const sql = [];
  let claimRows = 1;
  let mirrorRows = 1;
  const client = {
    async query(text) {
      const head = text.trim().split(/\s+/).slice(0, 3).join(' ');
      sql.push(head);
      if (head.startsWith('INSERT INTO scheduled_booking_events')) return { rowCount: claimRows };
      if (head.startsWith('INSERT INTO scheduled_booking_mirror')) return { rowCount: mirrorRows };
      return { rowCount: 0 };
    },
    release() { sql.push('RELEASE'); },
  };
  const store = createPgScheduledBookingStore({ connect: async () => client });
  const event = parseScheduledBookingEvent({ rawBody: raw(), route, nowMs: NOW });
  assert.equal(await store.apply(event), 'applied');
  claimRows = 0;
  assert.equal(await store.apply(event), 'duplicate');
  claimRows = 1; mirrorRows = 0;
  assert.equal(await store.apply(event), 'stale');
  assert.deepEqual(sql.slice(0, 5), ['BEGIN', 'INSERT INTO scheduled_booking_events', 'INSERT INTO scheduled_booking_mirror', 'COMMIT', 'RELEASE']);
  assert.deepEqual(sql.slice(5, 8), ['BEGIN', 'INSERT INTO scheduled_booking_events', 'COMMIT']);
});

test('migration 0020 is additive and registered in the runner and the journal', () => {
  const sql = readFileSync(new URL('../../migrations/0020_scheduled_booking_mirror.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS scheduled_booking_events/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS scheduled_booking_mirror/);
  const body = sql.split('\n').filter((l) => !l.startsWith('--')).join('\n');
  assert.doesNotMatch(body, /\b(DROP|ALTER|RENAME|TRUNCATE|DELETE)\b/i);
  const runner = readFileSync(new URL('../../scripts/run-safe-migration.mjs', import.meta.url), 'utf8');
  assert.match(runner, /\{ file: '0020_scheduled_booking_mirror\.sql', required: true \}/);
  const journal = JSON.parse(readFileSync(new URL('../../migrations/meta/_journal.json', import.meta.url), 'utf8'));
  // Later migrations (e.g. 0023 Marketing) may follow the booking mirror.
  // Assert it exists in order, not that it must be the final journal entry.
  const mirrorPosition = journal.entries.findIndex((e) => e.tag === '0020_scheduled_booking_mirror');
  const membershipPosition = journal.entries.findIndex((e) => e.tag === '0017_user_company_memberships');
  assert.ok(mirrorPosition > membershipPosition, 'booking mirror follows tenant membership');
  assert.equal(journal.entries.filter((e) => e.tag === '0020_scheduled_booking_mirror').length, 1);
});

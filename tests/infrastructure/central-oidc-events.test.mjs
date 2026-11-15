// Issue #196: signed outbox events. Verify before use, reject stale or unsigned events,
// and run each effect once per event id. Uses fixed secrets and a fixed clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyInboundEvent, signEnvelope, canonicalJson, createIdempotentConsumer, createMemoryProcessedStore,
  EventRejectedError,
} from '../../server/infrastructure/central-oidc/signed-events.ts';

const NOW = Date.parse('2026-11-15T10:00:00Z');
const TENANT = '00000000-0000-4000-8000-00000000000a';
const OTHER = '00000000-0000-4000-8000-00000000000b';
const SECRET = 'e'.repeat(48);
const OLD = 'o'.repeat(48);
const window = (from, to) => ({ notBeforeMs: from, notAfterMs: to });
const route = {
  consumer: 'supercharged-desk',
  organisationId: TENANT,
  eventTypes: ['invoice_paid'],
  keys: [{ id: 'current', secret: SECRET, ...window(NOW - 3600_000, NOW + 3600_000) }],
};

function event(overrides = {}, secret = SECRET) {
  const unsigned = {
    eventId: '11111111-1111-4111-8111-111111111111',
    organisationId: TENANT,
    sourceProduct: 'sorted',
    eventType: 'invoice_paid',
    schemaVersion: 1,
    correlationId: 'corr-1',
    idempotencyKey: 'invoice-7-paid',
    occurredAt: new Date(NOW - 1000).toISOString(),
    payload: { invoiceId: 'inv-7', amountMinor: 12500, currency: 'USD' },
    ...overrides,
  };
  return { ...unsigned, signature: signEnvelope(unsigned, secret) };
}

const verify = (raw, extra = {}) => verifyInboundEvent({ raw, route, nowMs: NOW, ...extra });
const codeOf = (fn) => { try { fn(); return null; } catch (e) { assert.ok(e instanceof EventRejectedError, String(e)); return e.code; } };

test('a correctly signed event verifies and is returned typed', () => {
  const e = verify(event());
  assert.equal(e.eventId, '11111111-1111-4111-8111-111111111111');
  assert.equal(e.payload.amountMinor, 12500);
});

test('canonical JSON is key-order independent, so the signature holds for reordered fields', () => {
  const a = canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 'x' } });
  const b = canonicalJson({ a: { c: 'x', d: [2, { y: 2, z: 1 }] }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}');
});

test('a tampered payload fails the signature', () => {
  const raw = event();
  raw.payload = { ...raw.payload, amountMinor: 1 };
  assert.equal(codeOf(() => verify(raw)), 'bad_signature');
});

test('unsigned and malformed signatures are refused', () => {
  const { signature: _s, ...unsigned } = event();
  assert.equal(codeOf(() => verify(unsigned)), 'invalid_envelope');
  assert.equal(codeOf(() => verify({ ...event(), signature: 'ab' })), 'bad_signature');
  assert.equal(codeOf(() => verify({ ...event(), signature: 'f'.repeat(64) })), 'bad_signature');
});

test('an event signed for another tenant fails the tenant binding even with a valid signature', () => {
  assert.equal(codeOf(() => verify(event({ organisationId: OTHER }))), 'tenant_mismatch');
});

test('an event type the consumer does not accept is refused after the signature', () => {
  assert.equal(codeOf(() => verify(event({ eventType: 'quote_sent' }))), 'unknown_event_type');
});

test('stale and far-future events are refused', () => {
  assert.equal(codeOf(() => verify(event({ occurredAt: new Date(NOW - 16 * 60_000).toISOString() }))), 'stale_event');
  assert.equal(codeOf(() => verify(event({ occurredAt: new Date(NOW + 5 * 60_000).toISOString() }))), 'stale_event');
  assert.equal(codeOf(() => verify(event({ occurredAt: new Date(NOW - 16 * 60_000).toISOString() }), { maxAgeMs: 20 * 60_000 })), null);
});

test('malformed envelopes are refused before any signature work', () => {
  for (const bad of [null, [], 'x', { ...event(), payload: [] }, { ...event(), schemaVersion: 0 }, { ...event(), organisationId: 'nope' }]) {
    assert.equal(codeOf(() => verify(bad)), 'invalid_envelope', JSON.stringify(bad)?.slice(0, 60));
  }
});

test('events signed with an expired key are refused, and a rotation window accepts both keys', () => {
  const expiredSigned = event({}, OLD);
  const onlyExpired = { ...route, keys: [{ id: 'old', secret: OLD, ...window(NOW - 7200_000, NOW - 3600_000) }] };
  assert.equal(codeOf(() => verifyInboundEvent({ raw: expiredSigned, route: onlyExpired, nowMs: NOW })), 'no_active_key');

  const overlap = {
    ...route,
    keys: [
      { id: 'old', secret: OLD, ...window(NOW - 7200_000, NOW + 600_000) },
      { id: 'new', secret: SECRET, ...window(NOW - 60_000, NOW + 7200_000) },
    ],
  };
  assert.equal(verifyInboundEvent({ raw: expiredSigned, route: overlap, nowMs: NOW }).eventType, 'invoice_paid');
  assert.equal(verifyInboundEvent({ raw: event({}, SECRET), route: overlap, nowMs: NOW }).eventType, 'invoice_paid');
  assert.equal(codeOf(() => verifyInboundEvent({ raw: expiredSigned, route: overlap, nowMs: NOW + 1200_000 })), 'bad_signature');
});

test('an idempotent consumer runs the effect once per event id', async () => {
  const store = createMemoryProcessedStore();
  const seen = [];
  const consume = createIdempotentConsumer({ consumer: 'supercharged-desk', store, handle: async (e) => { seen.push(e.eventId); } });
  const e = verify(event());
  assert.equal(await consume(e), 'processed');
  assert.equal(await consume(e), 'duplicate');
  assert.deepEqual(seen, [e.eventId]);
});

test('a failed effect releases its claim so a later delivery can retry', async () => {
  const store = createMemoryProcessedStore();
  let attempts = 0;
  const consume = createIdempotentConsumer({
    consumer: 'supercharged-desk', store,
    handle: async () => { attempts += 1; if (attempts === 1) throw new Error('db down'); },
  });
  const e = verify(event());
  await assert.rejects(consume(e), /db down/);
  assert.equal(store.size(), 0);
  assert.equal(await consume(e), 'processed');
  assert.equal(attempts, 2);
});

test('one event id stays scoped to its consumer', async () => {
  const store = createMemoryProcessedStore();
  const a = createIdempotentConsumer({ consumer: 'a', store, handle: async () => {} });
  const b = createIdempotentConsumer({ consumer: 'b', store, handle: async () => {} });
  const e = verify(event());
  assert.equal(await a(e), 'processed');
  assert.equal(await b(e), 'processed');
});

// Sandbox tests: Stripe webhook replay guard (server/middleware/webhook-replay.ts).
// Covers duplicate delivery, invalid signature, retry after forget(), and a full store
// refusing rather than accepting. Fakes only: fake secrets, fake constructEvent, injected clock.
// No network, no database, no timers.
// Run: node --test --experimental-transform-types tests/sandbox/stripe-replay.sandbox.test.mjs

// Test files must not write to stdout (it breaks the runner's IPC).
for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = () => {};

import test from 'node:test';
import assert from 'node:assert/strict';

const { createReplayGuard } = await import(
  new URL('../../server/middleware/webhook-replay.ts', import.meta.url).href
);
const { verifyStripeWebhookEvent } = await import(
  new URL('../../server/engines/payment/gateways/stripe/webhook-verify.ts', import.meta.url).href
);

const WINDOW_MS = 5 * 60 * 1000;
const FAKE_SECRET = 'whsec_fake_sandbox_only';
const START_MS = 1_767_225_600_000;

function makeClock(start = START_MS) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// Fake Stripe: accepts only the one signature the sandbox considers valid.
function makeFakeStripe(validSignature = 't=1767225600,v1=valid_fake') {
  const calls = [];
  return {
    calls,
    webhooks: {
      constructEvent(payload, header, secret) {
        calls.push({ header, secret });
        if (header !== validSignature) throw new Error('No signatures found matching the expected signature');
        return JSON.parse(String(payload));
      },
    },
  };
}

// Mirrors the Stripe route order: verify signature, then replay check with the signed timestamp.
// Maps refusals the same way the route does: capacity -> 503 with a generic body, others -> 409.
function receive(stripe, guard, rawBody, signature, now) {
  let event;
  try {
    event = verifyStripeWebhookEvent(stripe, rawBody, signature, FAKE_SECRET);
  } catch {
    return { status: 400 };
  }
  const signedAtSeconds = Number(signature.match(/(?:^|,)\s*t=(\d+)/)?.[1]);
  const result = guard.check({
    provider: 'stripe',
    eventId: event.id,
    timestampMs: Number.isFinite(signedAtSeconds) ? signedAtSeconds * 1000 : null,
  });
  if (result.accepted) return { status: 200, event };
  if (result.reason === 'capacity') {
    return { status: 503, body: { error: 'Webhook temporarily unavailable' } };
  }
  return { status: 409, reason: result.reason };
}

const VALID_SIG = 't=1767225600,v1=valid_fake';
const BODY = JSON.stringify({ id: 'evt_fake_0001', type: 'checkout.session.completed' });

test('Stripe duplicate delivery: the second delivery of the same event is refused as replay', () => {
  const clock = makeClock();
  const guard = createReplayGuard({ now: clock.now, windowMs: WINDOW_MS, maxEntries: 100 });
  const stripe = makeFakeStripe(VALID_SIG);

  assert.equal(receive(stripe, guard, BODY, VALID_SIG, clock.now).status, 200);
  clock.advance(1000);
  const second = receive(stripe, guard, BODY, VALID_SIG, clock.now);
  assert.equal(second.status, 409);
  assert.equal(second.reason, 'replay');
});

test('Stripe invalid signature: refused before the replay guard is consulted and nothing is recorded', () => {
  const clock = makeClock();
  const guard = createReplayGuard({ now: clock.now, windowMs: WINDOW_MS, maxEntries: 100 });
  const stripe = makeFakeStripe(VALID_SIG);

  const bad = receive(stripe, guard, BODY, 't=1767225600,v1=forged_fake', clock.now);
  assert.equal(bad.status, 400);
  assert.equal(guard.size(), 0, 'a rejected signature must not occupy a replay slot');

  // The genuine delivery of the same event is still accepted afterwards.
  assert.equal(receive(stripe, guard, BODY, VALID_SIG, clock.now).status, 200);
});

test('Stripe failed processing: after forget(), the provider retry of the same event is accepted', () => {
  const clock = makeClock();
  const guard = createReplayGuard({ now: clock.now, windowMs: WINDOW_MS, maxEntries: 100 });
  const stripe = makeFakeStripe(VALID_SIG);

  const first = receive(stripe, guard, BODY, VALID_SIG, clock.now);
  assert.equal(first.status, 200);

  // Handler threw, so the route calls forget() and lets Stripe's retry through.
  guard.forget({ provider: 'stripe', eventId: first.event.id });

  clock.advance(30_000);
  const retry = receive(stripe, guard, BODY, VALID_SIG, clock.now);
  assert.equal(retry.status, 200, 'retry after forget() must be accepted');

  // Once the retry has been accepted again, a further duplicate is refused.
  assert.equal(receive(stripe, guard, BODY, VALID_SIG, clock.now).reason, 'replay');
});

test('Stripe full store: with onFull refuse, a new event is refused with capacity and not stored', () => {
  const clock = makeClock();
  const guard = createReplayGuard({ now: clock.now, windowMs: WINDOW_MS, maxEntries: 2, onFull: 'refuse' });

  assert.deepEqual(guard.check({ provider: 'stripe', eventId: 'evt_a', timestampMs: clock.now() }), { accepted: true });
  assert.deepEqual(guard.check({ provider: 'stripe', eventId: 'evt_b', timestampMs: clock.now() }), { accepted: true });

  const refused = guard.check({ provider: 'stripe', eventId: 'evt_c', timestampMs: clock.now() });
  assert.deepEqual(refused, { accepted: false, reason: 'capacity' });
  assert.equal(guard.size(), 2, 'a refused event must not be stored or evict an existing entry');

  // Still full, so the same new event stays refused on retry.
  assert.equal(guard.check({ provider: 'stripe', eventId: 'evt_c', timestampMs: clock.now() }).reason, 'capacity');
  // Existing keys remain protected against replay while the store is full.
  assert.equal(guard.check({ provider: 'stripe', eventId: 'evt_a', timestampMs: clock.now() }).reason, 'replay');
});

test('Stripe full store: a valid signed event is answered 503 with a generic body, and is not recorded', () => {
  const clock = makeClock();
  const guard = createReplayGuard({ now: clock.now, windowMs: WINDOW_MS, maxEntries: 1, onFull: 'refuse' });
  const stripe = makeFakeStripe(VALID_SIG);
  const otherBody = JSON.stringify({ id: 'evt_fake_0002', type: 'checkout.session.completed' });

  assert.equal(receive(stripe, guard, BODY, VALID_SIG, clock.now).status, 200);

  const refused = receive(stripe, guard, otherBody, VALID_SIG, clock.now);
  assert.equal(refused.status, 503, 'a full guard must ask Stripe to retry with 503');
  assert.deepEqual(refused.body, { error: 'Webhook temporarily unavailable' });
  assert.equal(guard.size(), 1, 'the refused event must not occupy a slot');
});

test('Stripe full store: once entries expire and are swept, the refused event is accepted', () => {
  const clock = makeClock();
  const guard = createReplayGuard({ now: clock.now, windowMs: WINDOW_MS, maxEntries: 1, onFull: 'refuse' });

  assert.equal(guard.check({ provider: 'stripe', eventId: 'evt_a', timestampMs: clock.now() }).accepted, true);
  assert.equal(guard.check({ provider: 'stripe', eventId: 'evt_b', timestampMs: clock.now() }).reason, 'capacity');

  clock.advance(WINDOW_MS + 1);
  assert.equal(guard.check({ provider: 'stripe', eventId: 'evt_b', timestampMs: clock.now() }).accepted, true);
  assert.equal(guard.size(), 1);
});

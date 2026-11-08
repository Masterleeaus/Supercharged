// Sandbox tests: Stripe and Plivo signature paths and the replay guard.
// Fakes only. The Plivo middleware imports db, drizzle-orm and the schema; a resolve hook swaps
// them for in-memory stubs. The Stripe verifier takes a fake constructEvent. No network.
// Run: node --test --experimental-transform-types tests/sandbox/signature-replay.sandbox.test.mjs

// Test files must not write to stdout (it breaks the runner's IPC).
for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = () => {};

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createHmac } from 'node:crypto';

const HOOK = `
const DATA = (src) => 'data:text/javascript,' + encodeURIComponent(src);
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@shared/schema') {
    return { url: DATA('export const plivoCredentials = { authToken: "authToken", isPrimary: "isPrimary", isActive: "isActive" };'), shortCircuit: true };
  }
  if (specifier === 'drizzle-orm') {
    return { url: DATA('export const eq = (a, b) => ({ a, b });'), shortCircuit: true };
  }
  if (/(^|\\/)db$/.test(specifier)) {
    return { url: DATA('export const db = { select: () => ({ from: () => ({ where: () => globalThis.__sbx.credentialLookup() }) }) };'), shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(HOOK), import.meta.url);

const { requirePlivoV2Signature, verifyPlivoV2Signature, buildPlivoV2SigningBase } = await import(
  new URL('../../server/engines/plivo/plivo-signature.ts', import.meta.url).href
);
const { createReplayGuard } = await import(
  new URL('../../server/middleware/webhook-replay.ts', import.meta.url).href
);
const { verifyStripeWebhookEvent, StripeWebhookSecretMissingError } = await import(
  new URL('../../server/engines/payment/gateways/stripe/webhook-verify.ts', import.meta.url).href
);

const BASE = 'https://app.example.test';
const TOKEN = 'fake_plivo_auth_token';
const NONCE = 'nonce-0001';
const ROUTE = '/api/plivo/incoming';
const FORM = { CallUUID: 'call-1', From: '+61400000001', To: '+61400000002' };

// Independent signer used only to build test signatures (does not call the code under test).
function sign(url, nonce, body, token) {
  let base = url + nonce;
  for (const key of Object.keys(body).sort()) base += key + String(body[key]);
  return createHmac('sha256', token).update(base, 'utf8').digest('base64');
}

function fakeRes() {
  return {
    code: null, sent: false, body: null,
    status(c) { this.code = c; return this; },
    send(b) { this.sent = true; this.body = b; return this; },
  };
}

beforeEach(() => {
  globalThis.__sbx = {
    lookups: 0,
    credentialLookup: async () => {
      globalThis.__sbx.lookups += 1;
      return [{ authToken: TOKEN, isPrimary: true }];
    },
  };
});

afterEach(() => {
  delete globalThis.__sbx;
});

// Runs the Plivo middleware with a request. Resolves with what happened.
async function runPlivo({ headers, body, originalUrl = ROUTE, baseUrl = BASE }) {
  const mw = requirePlivoV2Signature(baseUrl);
  const res = fakeRes();
  let nextCalled = false;
  const req = { headers, body, originalUrl };
  await mw(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

const goodHeaders = (overrides = {}) => ({
  'x-plivo-signature-v2': sign(BASE + ROUTE, NONCE, FORM, TOKEN),
  'x-plivo-signature-v2-nonce': NONCE,
  ...overrides,
});

// ---- Stripe ------------------------------------------------------------------

function fakeStripe(impl) {
  const calls = [];
  return {
    calls,
    webhooks: {
      constructEvent(payload, header, secret) {
        calls.push({ payload, header, secret });
        return impl(payload, header, secret);
      },
    },
  };
}

test('Stripe valid: the raw body is passed to constructEvent unchanged and the event is returned', () => {
  const raw = '{"id":"evt_1","type":"invoice.paid","created":1767225600}';
  const stripe = fakeStripe(() => ({ id: 'evt_1', type: 'invoice.paid' }));
  const event = verifyStripeWebhookEvent(stripe, raw, 't=1,v1=abc', 'whsec_fake');

  assert.equal(event.id, 'evt_1');
  assert.equal(stripe.calls[0].payload, raw, 'body is not re-serialised before verification');
  assert.equal(stripe.calls[0].secret, 'whsec_fake');
});

test('Stripe invalid signature: a failing constructEvent error propagates and no event is returned', () => {
  const stripe = fakeStripe(() => { throw new Error('No signatures found matching the expected signature'); });
  assert.throws(
    () => verifyStripeWebhookEvent(stripe, '{}', 't=1,v1=bad', 'whsec_fake'),
    /No signatures found/,
  );
});

test('Stripe missing signature header: refused before constructEvent runs', () => {
  const stripe = fakeStripe(() => ({ id: 'evt_x' }));
  assert.throws(() => verifyStripeWebhookEvent(stripe, '{}', '', 'whsec_fake'), /Missing Stripe-Signature/);
  assert.equal(stripe.calls.length, 0);
});

test('Stripe outage analogue: missing or blank secret fails closed with the 503 error type', () => {
  const stripe = fakeStripe(() => ({ id: 'evt_x' }));
  for (const secret of [undefined, null, '', '   ']) {
    assert.throws(
      () => verifyStripeWebhookEvent(stripe, '{}', 't=1,v1=x', secret),
      StripeWebhookSecretMissingError,
    );
  }
  assert.equal(stripe.calls.length, 0, 'body is never trusted without a secret');
});

test('Stripe duplicate: the same event id is refused on the second delivery by the replay guard', () => {
  const guard = createReplayGuard({ now: () => 1_767_225_600_000, windowMs: 300_000, maxEntries: 100 });
  const event = { id: 'evt_dup', created: 1_767_225_600 };
  const check = () => guard.check({ provider: 'stripe', eventId: event.id, timestampMs: event.created * 1000 });

  assert.deepEqual(check(), { accepted: true });
  assert.deepEqual(check(), { accepted: false, reason: 'replay' });
});

test('Stripe timeout analogue: a stale event is refused as outside the 5 minute window', () => {
  const now = 1_767_225_600_000;
  const guard = createReplayGuard({ now: () => now, windowMs: 300_000, maxEntries: 100 });
  const stale = guard.check({ provider: 'stripe', eventId: 'evt_old', timestampMs: now - 600_000 });
  assert.deepEqual(stale, { accepted: false, reason: 'timestamp_out_of_window' });
});

// ---- Plivo V2 signature ------------------------------------------------------

test('Plivo valid: a correctly signed form post passes and next() runs once', async () => {
  const { res, nextCalled } = await runPlivo({ headers: goodHeaders(), body: { ...FORM } });
  assert.equal(nextCalled, true);
  assert.equal(res.sent, false);
});

test('Plivo invalid signature: a signature from the wrong token gets 403 and the handler does not run', async () => {
  const headers = goodHeaders({ 'x-plivo-signature-v2': sign(BASE + ROUTE, NONCE, FORM, 'other_token') });
  const { res, nextCalled } = await runPlivo({ headers, body: { ...FORM } });
  assert.equal(nextCalled, false);
  assert.equal(res.code, 403);
  assert.equal(res.body, 'Forbidden');
});

test('Plivo invalid signature: a body changed after signing gets 403', async () => {
  const { res, nextCalled } = await runPlivo({ headers: goodHeaders(), body: { ...FORM, To: '+61499999999' } });
  assert.equal(nextCalled, false);
  assert.equal(res.code, 403);
});

test('Plivo invalid signature: a signature made for another host does not verify (URL is bound)', async () => {
  const { res, nextCalled } = await runPlivo({
    headers: goodHeaders(), body: { ...FORM }, baseUrl: 'https://evil.example.test',
  });
  assert.equal(nextCalled, false);
  assert.equal(res.code, 403);
});

test('Plivo invalid signature: a signature of the wrong length is refused without throwing', () => {
  assert.equal(
    verifyPlivoV2Signature(BASE + ROUTE, NONCE, 'short', { ...FORM }, TOKEN),
    false,
  );
});

test('Plivo missing headers: no nonce means 403 and the credential table is never read', async () => {
  const headers = { 'x-plivo-signature-v2': sign(BASE + ROUTE, NONCE, FORM, TOKEN) };
  const { res, nextCalled } = await runPlivo({ headers, body: { ...FORM } });
  assert.equal(nextCalled, false);
  assert.equal(res.code, 403);
  assert.equal(globalThis.__sbx.lookups, 0);
});

test('Plivo no active credentials: fails closed with 403', async () => {
  globalThis.__sbx.credentialLookup = async () => [];
  const { res, nextCalled } = await runPlivo({ headers: goodHeaders(), body: { ...FORM } });
  assert.equal(nextCalled, false);
  assert.equal(res.code, 403);
});

test('Plivo outage: a database error during credential lookup gets a generic 403 with no detail', async () => {
  globalThis.__sbx.credentialLookup = async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432 user=svc'); };
  const { res, nextCalled } = await runPlivo({ headers: goodHeaders(), body: { ...FORM } });
  assert.equal(nextCalled, false);
  assert.equal(res.code, 403);
  assert.equal(res.body, 'Forbidden');
  assert.ok(!String(res.body).includes('ECONNREFUSED'));
});

test('Plivo timeout: a hung credential lookup is answered within 1 second', async () => {
  globalThis.__sbx.credentialLookup = () => new Promise(() => {}); // never settles
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve('hung'), 1000); });
  const outcome = await Promise.race([
    runPlivo({ headers: goodHeaders(), body: { ...FORM } }).then(() => 'answered'),
    deadline,
  ]);
  clearTimeout(timer);
  assert.equal(outcome, 'answered', 'middleware should answer (fail closed) when the lookup never returns');
});

test('Plivo rotation: a second active token still verifies, so a rotated credential does not lock out', async () => {
  globalThis.__sbx.credentialLookup = async () => [
    { authToken: 'old_token', isPrimary: false },
    { authToken: TOKEN, isPrimary: true },
  ];
  const { nextCalled } = await runPlivo({ headers: goodHeaders(), body: { ...FORM } });
  assert.equal(nextCalled, true);
});

test('Plivo signing base: repeated keys contribute every value in sorted order', () => {
  const base = buildPlivoV2SigningBase(BASE + ROUTE, NONCE, { To: ['b', 'a'], From: '+1' });
  assert.equal(base, BASE + ROUTE + NONCE + 'From+1' + 'To' + 'a' + 'To' + 'b');
});

// ---- Plivo replay (nonce as event id, as wired in plivo-webhooks.ts) ----------

test('Plivo duplicate: the same nonce inside the window is refused the second time', () => {
  let now = 1_767_225_600_000;
  const guard = createReplayGuard({ now: () => now, windowMs: 5 * 60_000, maxEntries: 10_000 });
  const check = () => guard.check({ provider: 'plivo', eventId: NONCE, timestampMs: now });

  assert.deepEqual(check(), { accepted: true });
  now += 30_000;
  assert.deepEqual(check(), { accepted: false, reason: 'replay' });
});

test('Plivo replay after 6 minutes: a captured, correctly signed request is refused', () => {
  // Plivo V2 signatures carry no timestamp, so they stay valid. The guard must still refuse the nonce
  // after the 5 minute sweep. This test fails if the sweep forgets the nonce while the signature still verifies.
  let now = 1_767_225_600_000;
  const guard = createReplayGuard({ now: () => now, windowMs: 5 * 60_000, maxEntries: 10_000 });
  guard.check({ provider: 'plivo', eventId: NONCE, timestampMs: now });

  now += 6 * 60_000;
  const replayed = guard.check({ provider: 'plivo', eventId: NONCE, timestampMs: now });
  assert.deepEqual(replayed, { accepted: false, reason: 'replay' });
});

// ---- Generic replay guard rules ----------------------------------------------

test('replay guard: missing provider, event id or timestamp are each refused with their own reason', () => {
  const guard = createReplayGuard({ now: () => 1000, windowMs: 1000, maxEntries: 10 });
  assert.equal(guard.check({ provider: '', eventId: 'e', timestampMs: 1000 }).reason, 'missing_provider');
  assert.equal(guard.check({ provider: 'p', eventId: '', timestampMs: 1000 }).reason, 'missing_event_id');
  assert.equal(guard.check({ provider: 'p', eventId: null, timestampMs: 1000 }).reason, 'missing_event_id');
  assert.equal(guard.check({ provider: 'p', eventId: 'e', timestampMs: NaN }).reason, 'missing_timestamp');
  assert.equal(guard.check({ provider: 'p', eventId: 'e', timestampMs: undefined }).reason, 'missing_timestamp');
  assert.equal(guard.size(), 0, 'refused events are not stored');
});

test('replay guard: the window edge is accepted and one millisecond beyond is refused, in both directions', () => {
  const guard = createReplayGuard({ now: () => 100_000, windowMs: 1000, maxEntries: 10 });
  assert.equal(guard.check({ provider: 'p', eventId: 'edge_past', timestampMs: 99_000 }).accepted, true);
  assert.equal(guard.check({ provider: 'p', eventId: 'edge_future', timestampMs: 101_000 }).accepted, true);
  assert.deepEqual(
    guard.check({ provider: 'p', eventId: 'too_old', timestampMs: 98_999 }),
    { accepted: false, reason: 'timestamp_out_of_window' },
  );
});

test('replay guard: the same event id under two providers is not a duplicate', () => {
  const guard = createReplayGuard({ now: () => 1000, windowMs: 1000, maxEntries: 10 });
  assert.equal(guard.check({ provider: 'stripe', eventId: 'x', timestampMs: 1000 }).accepted, true);
  assert.equal(guard.check({ provider: 'plivo', eventId: 'x', timestampMs: 1000 }).accepted, true);
});

test('replay guard: forget() after a failed handler lets the provider retry through', () => {
  const guard = createReplayGuard({ now: () => 1000, windowMs: 1000, maxEntries: 10 });
  assert.equal(guard.check({ provider: 'p', eventId: 'e', timestampMs: 1000 }).accepted, true);
  guard.forget({ provider: 'p', eventId: 'e' });
  assert.equal(guard.check({ provider: 'p', eventId: 'e', timestampMs: 1000 }).accepted, true);
  guard.forget({ provider: 'p', eventId: 'never_seen' }); // no-op, must not throw
});

test('replay guard: entries older than the window are swept, and size stays within maxEntries', () => {
  let now = 0;
  const guard = createReplayGuard({ now: () => now, windowMs: 1000, maxEntries: 5 });
  for (let i = 0; i < 20; i++) guard.check({ provider: 'p', eventId: `e${i}`, timestampMs: now });
  assert.equal(guard.size(), 5);

  now = 10_000;
  guard.check({ provider: 'p', eventId: 'fresh', timestampMs: now });
  assert.equal(guard.size(), 1, 'expired entries are dropped on the next check');
});

test('replay guard: bad construction options throw immediately', () => {
  assert.throws(() => createReplayGuard({ now: 1, windowMs: 1, maxEntries: 1 }), TypeError);
  assert.throws(() => createReplayGuard({ now: () => 0, windowMs: 0, maxEntries: 1 }), RangeError);
  assert.throws(() => createReplayGuard({ now: () => 0, windowMs: 1, maxEntries: 0 }), RangeError);
  assert.throws(() => createReplayGuard({ now: () => 0, windowMs: 1, maxEntries: 1.5 }), RangeError);
});

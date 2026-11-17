import test from 'node:test';
import assert from 'node:assert/strict';

const signing = await import('../../server/connectors/bridge/signing.ts');
const outbound = await import('../../server/connectors/bridge/outbound.ts');

const CO = '11111111-1111-4111-8111-111111111111';
const OTHER_CO = '22222222-2222-4222-8222-222222222222';
const SECRET = 'bridge-secret-value-at-least-32-chars-long';
const NOW = 1_800_000_000;
const URL_OK = 'https://hooks.example.com/zap/abc';

const sub = (over = {}) => ({
  bridgeId: 'zap-1',
  companyId: CO,
  url: URL_OK,
  secret: SECRET,
  events: ['booking.created'],
  active: true,
  ...over,
});

const event = (over = {}) => ({
  id: 'evt-1',
  event: 'booking.created',
  companyId: CO,
  occurredAt: '2026-11-18T00:00:00Z',
  data: { bookingId: 'b-1' },
  ...over,
});

function setup({ subs = [sub()], responses = [{ ok: true, status: 200 }], maxAttempts, maxPerMinute } = {}) {
  const calls = [];
  const queue = [...responses];
  const store = {
    async subscribersFor(companyId, ev) {
      return subs.filter((s) => s.companyId === companyId && s.events.includes(ev));
    },
  };
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return new Response('{"secret":"do-not-log"}', { status: next.status, headers: {} });
  };
  const sleeps = [];
  const dispatcher = outbound.createOutboundDispatcher({
    store,
    fetch,
    nowSeconds: () => NOW,
    sleep: async (ms) => { sleeps.push(ms); },
    maxAttempts,
    maxPerMinute,
  });
  return { dispatcher, calls, sleeps };
}

test('a delivery is signed so the receiver can verify it with the bridge secret', async () => {
  const { dispatcher, calls } = setup();
  const [outcome] = await dispatcher.dispatch(event());
  assert.equal(outcome.status, 'delivered');
  const { init } = calls[0];
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers['x-titan-event'], 'booking.created');
  assert.equal(init.headers['x-titan-delivery-id'], 'evt-1');
  const verified = signing.verifyDelivery({
    secret: SECRET,
    rawBody: init.body,
    timestampHeader: init.headers['x-titan-timestamp'],
    signatureHeader: init.headers['x-titan-signature'],
    nowSeconds: NOW,
  });
  assert.deepEqual(verified, { ok: true });
});

test('the payload carries the company, event and data, and nothing else', async () => {
  const { dispatcher, calls } = setup();
  await dispatcher.dispatch(event());
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), ['companyId', 'data', 'event', 'id', 'occurredAt']);
  assert.equal(body.companyId, CO);
});

test('events outside the catalogue are refused before any delivery', async () => {
  const { dispatcher, calls } = setup();
  await assert.rejects(() => dispatcher.dispatch(event({ event: 'invoice.refunded' })), RangeError);
  assert.equal(calls.length, 0);
});

test('another company never receives the event, even when it subscribed to the same event', async () => {
  const { dispatcher, calls } = setup({ subs: [sub({ companyId: OTHER_CO, bridgeId: 'other' })] });
  const outcomes = await dispatcher.dispatch(event());
  assert.deepEqual(outcomes, []);
  assert.equal(calls.length, 0);
});

test('inactive subscriptions and subscriptions to other events are skipped', async () => {
  const { dispatcher, calls } = setup({
    subs: [sub({ active: false, bridgeId: 'off' }), sub({ bridgeId: 'wrong', events: ['job.completed'] })],
  });
  // the store filters by event; the dispatcher must still refuse an inactive row it is handed
  const outcomes = await dispatcher.dispatch(event());
  assert.deepEqual(outcomes, []);
  assert.equal(calls.length, 0);
});

test('retries a 503 and succeeds on a later attempt, with growing backoff', async () => {
  const { dispatcher, calls, sleeps } = setup({
    responses: [{ status: 503 }, { status: 503 }, { ok: true, status: 200 }],
  });
  const [outcome] = await dispatcher.dispatch(event());
  assert.equal(outcome.status, 'delivered');
  assert.equal(outcome.attempts, 3);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [500, 1000]);
});

test('a 4xx other than 429 is not retried', async () => {
  const { dispatcher, calls } = setup({ responses: [{ status: 400 }] });
  const [outcome] = await dispatcher.dispatch(event());
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.httpStatus, 400);
  assert.equal(outcome.reason, 'http_400');
  assert.equal(calls.length, 1);
});

test('a network error is retried, and the failure reason never includes a response body', async () => {
  const { dispatcher } = setup({ responses: [new Error('socket hang up')], maxAttempts: 2 });
  const [outcome] = await dispatcher.dispatch(event());
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.reason, 'network_error');
  assert.ok(!JSON.stringify(outcome).includes('do-not-log'));
});

test('the per-bridge rate limit skips deliveries over the limit inside one minute', async () => {
  const { dispatcher, calls } = setup({ maxPerMinute: 1 });
  const first = await dispatcher.dispatch(event({ id: 'a' }));
  const second = await dispatcher.dispatch(event({ id: 'b' }));
  assert.equal(first[0].status, 'delivered');
  assert.deepEqual(second, [{ bridgeId: 'zap-1', status: 'rate_limited' }]);
  assert.equal(calls.length, 1);
});

test('a subscription pointing at plain http, with credentials, or with a short secret is refused', async () => {
  const bad = [
    sub({ bridgeId: 'http', url: 'http://hooks.example.com/x' }),
    sub({ bridgeId: 'creds', url: 'https://user:pw@hooks.example.com/x' }),
    sub({ bridgeId: 'short', secret: 'short' }),
  ];
  const { dispatcher, calls } = setup({ subs: bad });
  const outcomes = await dispatcher.dispatch(event());
  assert.deepEqual(outcomes.map((o) => o.status), ['invalid_subscription', 'invalid_subscription', 'invalid_subscription']);
  assert.equal(calls.length, 0);
});

test('validateSubscription reports unknown events and an empty event list', () => {
  assert.deepEqual(outbound.validateSubscription(sub()), []);
  const problems = outbound.validateSubscription(sub({ events: ['nope'] }));
  assert.ok(problems.some((p) => p.includes('unknown event')));
  assert.ok(outbound.validateSubscription(sub({ events: [] })).length > 0);
});

test('an oversized payload is refused before delivery', async () => {
  const { dispatcher, calls } = setup();
  await assert.rejects(() => dispatcher.dispatch(event({ data: { blob: 'x'.repeat(70_000) } })), RangeError);
  assert.equal(calls.length, 0);
});

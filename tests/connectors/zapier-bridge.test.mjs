import test from 'node:test';
import assert from 'node:assert/strict';

const signing = await import('../../server/connectors/bridge/signing.ts');
const inbound = await import('../../server/connectors/bridge/inbound.ts');
const events = await import('../../server/connectors/bridge/events.ts');
const { createFakeProvider, FAKE_API_KEY } = await import('./fixtures/fake-provider.ts');

const CO = '11111111-1111-4111-8111-111111111111';
const SECRET = 'bridge-secret-value-at-least-32-chars-long';
const NOW = 1_800_000_000;
const CREDS = { type: 'api_key', apiKey: FAKE_API_KEY };

const bridge = {
  bridgeId: 'zap-1',
  companyId: CO,
  connectorId: 'fake-crm',
  allowedActions: ['getContact', 'createBooking'],
  secret: SECRET,
};

function setup({ enabled = true, maxPerMinute = 60, bridges = [bridge] } = {}) {
  const provider = createFakeProvider();
  const audits = [];
  const registry = {
    async forCompany(companyId, id) {
      if (!enabled || companyId !== CO || id !== 'fake-crm') throw new Error('not enabled');
      return { manifest: {}, definition: provider };
    },
  };
  const handler = inbound.createBridgeHandler({
    loadBridge: async (id) => bridges.find((b) => b.bridgeId === id) ?? null,
    registry,
    resolveCredentials: async () => CREDS,
    audit: async (r) => { audits.push(r); },
    nowSeconds: () => NOW,
    maxPerMinute,
    timeoutMs: 1000,
  });
  return { handler, provider, audits };
}

function signed(bodyObj, { secret = SECRET, ts = NOW, bridgeId = 'zap-1' } = {}) {
  const rawBody = JSON.stringify(bodyObj);
  return {
    bridgeId,
    rawBody,
    timestampHeader: String(ts),
    signatureHeader: signing.signatureFor(secret, ts, rawBody),
  };
}

test('signing round-trips and rejects a wrong secret, a stale timestamp and a malformed digest', () => {
  const body = '{"a":1}';
  const sig = signing.signatureFor(SECRET, NOW, body);
  const base = { secret: SECRET, rawBody: body, timestampHeader: String(NOW), signatureHeader: sig, nowSeconds: NOW };
  assert.deepEqual(signing.verifyDelivery(base), { ok: true });
  assert.deepEqual(signing.verifyDelivery({ ...base, secret: 'x'.repeat(40) }), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(signing.verifyDelivery({ ...base, nowSeconds: NOW + 301 }), { ok: false, reason: 'stale_timestamp' });
  assert.deepEqual(signing.verifyDelivery({ ...base, signatureHeader: 'abc' }), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(signing.verifyDelivery({ ...base, timestampHeader: 'now' }), { ok: false, reason: 'bad_timestamp' });
  assert.throws(() => signing.signatureFor('short', NOW, body), RangeError);
});

test('a signed read from the allowlist runs once and returns the record', async () => {
  const { handler, provider, audits } = setup();
  const res = await handler.handle(signed({ action: 'getContact', input: { id: 'c1' } }));
  assert.equal(res.status, 200);
  assert.equal(res.body.result.id, 'c1');
  assert.equal(provider.calls, 1);
  assert.equal(audits.length, 1);
  assert.equal(JSON.stringify(audits[0]).includes(SECRET), false);
});

test('an unknown bridge and a bad signature get the same 401 and never reach the connector', async () => {
  const { handler, provider } = setup();
  const bad = await handler.handle(signed({ action: 'getContact', input: { id: 'c1' } }, { secret: 'y'.repeat(40) }));
  const unknown = await handler.handle(signed({ action: 'getContact', input: { id: 'c1' } }, { bridgeId: 'nope' }));
  assert.deepEqual([bad.status, bad.body], [401, { ok: false, error: 'unauthorized' }]);
  assert.deepEqual(unknown, bad);
  assert.equal(provider.calls, 0);
});

test('a replayed delivery is refused', async () => {
  const { handler, provider } = setup();
  const req = signed({ action: 'getContact', input: { id: 'c1' } });
  assert.equal((await handler.handle(req)).status, 200);
  assert.equal((await handler.handle(req)).status, 401);
  assert.equal(provider.calls, 1);
});

test('actions outside the bridge allowlist are refused before the connector is called', async () => {
  const { handler, provider } = setup({ bridges: [{ ...bridge, allowedActions: ['getContact'] }] });
  const res = await handler.handle(signed({ action: 'createBooking', input: {}, requestId: 'r1' }));
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'action_not_allowed');
  assert.equal(provider.calls, 0);
});

test('a body that names a company is refused: scope comes from the bridge only', async () => {
  const { handler, provider } = setup();
  const res = await handler.handle(signed({ action: 'getContact', input: { id: 'c1' }, companyId: '22222222-2222-4222-8222-222222222222' }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'company_scope_not_allowed');
  assert.equal(provider.calls, 0);
});

test('writes need a requestId, and a repeated requestId creates the booking once', async () => {
  const { handler, provider } = setup();
  const noId = await handler.handle(signed({ action: 'createBooking', input: {} }, { ts: NOW }));
  assert.equal(noId.status, 400);
  assert.equal(noId.body.error, 'request_id_required');

  const first = await handler.handle(signed({ action: 'createBooking', input: {}, requestId: 'lead-42' }, { ts: NOW + 1 }));
  const again = await handler.handle(signed({ action: 'createBooking', input: {}, requestId: 'lead-42' }, { ts: NOW + 2 }));
  assert.equal(first.status, 200);
  assert.equal(again.status, 200);
  assert.equal(provider.bookingsCreated, 1);
  assert.equal(provider.seenKeys[0], provider.seenKeys[1]);
});

test('a disabled connector is refused for the bridge company (fails closed)', async () => {
  const { handler, provider } = setup({ enabled: false });
  const res = await handler.handle(signed({ action: 'getContact', input: { id: 'c1' } }));
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'connector_unavailable');
  assert.equal(provider.calls, 0);
});

test('the per-bridge rate limit returns 429 once the window is full', async () => {
  const { handler } = setup({ maxPerMinute: 2 });
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await handler.handle(signed({ action: 'getContact', input: { id: 'c1' } }, { ts: NOW + i }))).status);
  assert.deepEqual(statuses, [200, 200, 429]);
});

test('vendor errors map to HTTP statuses without leaking detail', async () => {
  const { handler } = setup();
  const res = await handler.handle(signed({ action: 'getContact', input: { id: 'missing' } }));
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});

test('the outbound event catalogue lists the five events and nothing else', () => {
  assert.deepEqual([...events.BRIDGE_EVENTS], ['booking.created', 'job.completed', 'quote.accepted', 'invoice.paid', 'message.received']);
  assert.equal(events.isBridgeEvent('booking.created'), true);
  assert.equal(events.isBridgeEvent('user.deleted'), false);
});

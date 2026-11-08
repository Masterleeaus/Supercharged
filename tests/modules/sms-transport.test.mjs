// SMS transport (node:test). The provider is a fake; no network and no real SMS are sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canAdvanceDeliveryStatus,
  createSmsTransport,
  mapSmsDeliveryStatus,
  SMS_MAX_BODY_LENGTH,
} from '../../server/modules/comms/sms-transport.ts';

const CO = '11111111-1111-4111-8111-111111111111';
const TO = '+61412345678';

function fakeProvider(impl) {
  const calls = [];
  return {
    calls,
    provider: {
      async send(req) {
        calls.push(req);
        return impl ? impl(req) : { externalId: 'SM-test-1' };
      },
    },
  };
}

test('valid send calls the provider once and returns the external id', async () => {
  const { provider, calls } = fakeProvider();
  const t = createSmsTransport({ provider, now: () => 0 });
  const r = await t.send({ companyId: CO, to: '+61 412 345 678', body: 'Hello' });
  assert.deepEqual(r, { ok: true, externalId: 'SM-test-1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, TO);
  assert.equal(calls[0].body, 'Hello');
  assert.equal(typeof calls[0].idempotencyKey, 'string');
});

test('repeat send with the same inputs gives the same idempotencyKey', async () => {
  const { provider, calls } = fakeProvider();
  const t = createSmsTransport({ provider });
  await t.send({ companyId: CO, to: TO, body: 'Same body' });
  await t.send({ companyId: CO, to: TO, body: 'Same body' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].idempotencyKey, calls[1].idempotencyKey);
});

test('idempotencyKey differs when the body or company differs', async () => {
  const { provider, calls } = fakeProvider();
  const t = createSmsTransport({ provider });
  await t.send({ companyId: CO, to: TO, body: 'one' });
  await t.send({ companyId: CO, to: TO, body: 'two' });
  await t.send({ companyId: '22222222-2222-4222-8222-222222222222', to: TO, body: 'one' });
  assert.notEqual(calls[0].idempotencyKey, calls[1].idempotencyKey);
  assert.notEqual(calls[0].idempotencyKey, calls[2].idempotencyKey);
});

test('invalid company id is refused without calling the provider', async () => {
  const { provider, calls } = fakeProvider();
  const t = createSmsTransport({ provider });
  assert.deepEqual(await t.send({ companyId: 'not-a-uuid', to: TO, body: 'x' }), {
    ok: false,
    reason: 'invalid_company',
  });
  assert.equal(calls.length, 0);
});

test('body over the limit is refused, and the limit itself is allowed', async () => {
  const { provider, calls } = fakeProvider();
  const t = createSmsTransport({ provider });
  const over = 'a'.repeat(SMS_MAX_BODY_LENGTH + 1);
  assert.deepEqual(await t.send({ companyId: CO, to: TO, body: over }), {
    ok: false,
    reason: 'body_too_long',
  });
  assert.equal(calls.length, 0);
  const atLimit = await t.send({ companyId: CO, to: TO, body: 'a'.repeat(SMS_MAX_BODY_LENGTH) });
  assert.equal(atLimit.ok, true);
  assert.equal(calls.length, 1);
});

test('invalid E.164 number is refused without calling the provider', async () => {
  const { provider, calls } = fakeProvider();
  const t = createSmsTransport({ provider });
  for (const to of ['0412345678', '12345', '+0412345678', 'call me', '', null]) {
    assert.deepEqual(await t.send({ companyId: CO, to, body: 'x' }), {
      ok: false,
      reason: 'invalid_number',
    });
  }
  assert.equal(calls.length, 0);
});

test('provider exception becomes provider_error and the text holds no number', async () => {
  const { provider, calls } = fakeProvider(async () => {
    throw new Error(`rejected destination ${TO} by carrier`);
  });
  const t = createSmsTransport({ provider });
  const r = await t.send({ companyId: CO, to: TO, body: 'x' });
  assert.deepEqual(r, { ok: false, reason: 'provider_error' });
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(r).includes('412345678'), false);
});

test('provider returning no external id is a provider_error', async () => {
  const { provider } = fakeProvider(async () => ({}));
  const t = createSmsTransport({ provider });
  assert.deepEqual(await t.send({ companyId: CO, to: TO, body: 'x' }), {
    ok: false,
    reason: 'provider_error',
  });
});

test('mapStatus maps known provider statuses and returns unknown for anything else', () => {
  const t = createSmsTransport({ provider: fakeProvider().provider });
  assert.equal(t.mapStatus('queued'), 'queued');
  assert.equal(t.mapStatus('sent'), 'sent');
  assert.equal(t.mapStatus('delivered'), 'delivered');
  assert.equal(t.mapStatus('failed'), 'failed');
  assert.equal(t.mapStatus('undelivered'), 'undelivered');
  assert.equal(t.mapStatus(' Delivered '), 'delivered');
  assert.equal(t.mapStatus('sending'), 'unknown');
  assert.equal(t.mapStatus('rejected'), 'unknown');
  assert.equal(t.mapStatus(''), 'unknown');
  assert.equal(t.mapStatus(undefined), 'unknown');
  assert.equal(t.mapStatus(42), 'unknown');
});

test('inbound parses a complete payload into an sms message', () => {
  const t = createSmsTransport({ provider: fakeProvider().provider });
  const r = t.inbound({ from: TO, to: '+61400000000', body: 'Yes', providerMessageId: 'SM-in-1' });
  assert.deepEqual(r, {
    ok: true,
    message: { channel: 'sms', from: TO, to: '+61400000000', body: 'Yes', externalId: 'SM-in-1' },
  });
});

test('inbound refuses missing or malformed fields', () => {
  const t = createSmsTransport({ provider: fakeProvider().provider });
  const base = { from: TO, to: '+61400000000', body: 'Yes', providerMessageId: 'SM-in-1' };
  const bad = [
    { ...base, from: undefined },
    { ...base, to: '' },
    { ...base, body: undefined },
    { ...base, providerMessageId: null },
    { from: TO },
    null,
    'not an object',
  ];
  for (const payload of bad) {
    assert.deepEqual(t.inbound(payload), { ok: false, reason: 'invalid_inbound' });
  }
});

test('mapSmsDeliveryStatus maps the five Plivo outbound statuses and nothing else', () => {
  assert.equal(mapSmsDeliveryStatus('queued'), 'queued');
  assert.equal(mapSmsDeliveryStatus('SENT'), 'sent');
  assert.equal(mapSmsDeliveryStatus(' delivered '), 'delivered');
  assert.equal(mapSmsDeliveryStatus('undelivered'), 'undelivered');
  assert.equal(mapSmsDeliveryStatus('failed'), 'failed');
  assert.equal(mapSmsDeliveryStatus('rejected'), 'unknown');
  assert.equal(mapSmsDeliveryStatus(undefined), 'unknown');
  assert.equal(mapSmsDeliveryStatus(7), 'unknown');
});

test('canAdvanceDeliveryStatus moves forward and never back from a final status', () => {
  assert.equal(canAdvanceDeliveryStatus(undefined, 'failed'), true);
  assert.equal(canAdvanceDeliveryStatus('queued', 'sent'), true);
  assert.equal(canAdvanceDeliveryStatus('sent', 'delivered'), true);
  assert.equal(canAdvanceDeliveryStatus('sent', 'queued'), false);
  assert.equal(canAdvanceDeliveryStatus('delivered', 'delivered'), true);
  assert.equal(canAdvanceDeliveryStatus('delivered', 'failed'), false);
  assert.equal(canAdvanceDeliveryStatus('delivered', 'sent'), false);
  assert.equal(canAdvanceDeliveryStatus('undelivered', 'delivered'), false);
});

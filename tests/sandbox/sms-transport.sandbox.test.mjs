// Sandbox tests: SMS transport failure reasons, duplicate sends and receipts, provider outage and
// timeout (server/modules/comms/sms-transport.ts). The provider is a fake object. No network.
// Run: node --test --experimental-transform-types tests/sandbox/sms-transport.sandbox.test.mjs

// Test files must not write to stdout (it breaks the runner's IPC).
for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = () => {};

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const {
  createSmsTransport,
  canAdvanceDeliveryStatus,
  mapSmsDeliveryStatus,
  SMS_MAX_BODY_LENGTH,
} = await import(new URL('../../server/modules/comms/sms-transport.ts', import.meta.url).href);

const COMPANY = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const TO = '+61400000001';
const BODY = 'Your booking is confirmed.';

// Fake provider that records each call and replays a scripted outcome.
function fakeProvider(behaviour) {
  const calls = [];
  return {
    calls,
    async send(request) {
      calls.push(request);
      return behaviour(calls.length);
    },
  };
}

const ok = (externalId = 'SM_fake_0001') => () => ({ externalId });

// ---- duplicates --------------------------------------------------------------

test('duplicate send: the same company, number and body produce the same idempotency key', async () => {
  const provider = fakeProvider(ok());
  const transport = createSmsTransport({ provider });

  await transport.send({ companyId: COMPANY, to: TO, body: BODY });
  await transport.send({ companyId: COMPANY, to: TO, body: BODY });

  assert.equal(provider.calls.length, 2);
  assert.equal(provider.calls[0].idempotencyKey, provider.calls[1].idempotencyKey);
  const digest = createHash('sha256').update(BODY, 'utf8').digest('hex');
  assert.equal(provider.calls[0].idempotencyKey, `sms:${COMPANY}:${TO}:${digest}`);
});

test('duplicate send: a different body gets a different idempotency key', async () => {
  const provider = fakeProvider(ok());
  const transport = createSmsTransport({ provider });
  await transport.send({ companyId: COMPANY, to: TO, body: BODY });
  await transport.send({ companyId: COMPANY, to: TO, body: `${BODY} Thanks` });
  assert.notEqual(provider.calls[0].idempotencyKey, provider.calls[1].idempotencyKey);
});

test('duplicate receipts: a repeated status is accepted, a later non-advance is refused', () => {
  assert.equal(canAdvanceDeliveryStatus('delivered', 'delivered'), true, 'repeat of the same status');
  assert.equal(canAdvanceDeliveryStatus('delivered', 'failed'), false, 'first final status wins');
  assert.equal(canAdvanceDeliveryStatus('failed', 'delivered'), false, 'late success does not revive a failure');
  assert.equal(canAdvanceDeliveryStatus('sent', 'queued'), false, 'out-of-order queued is refused');
  assert.equal(canAdvanceDeliveryStatus('queued', 'sent'), true);
  assert.equal(canAdvanceDeliveryStatus('sent', 'delivered'), true);
  assert.equal(canAdvanceDeliveryStatus(null, 'queued'), true, 'no current status accepts anything');
});

// ---- timeout -----------------------------------------------------------------

test('timeout: a provider that never answers is cut off with provider_error within the deadline', async () => {
  const provider = { send: () => new Promise(() => {}) }; // never settles
  const transport = createSmsTransport({ provider, timeoutMs: 50 });

  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve('hung'), 1000); });
  const outcome = await Promise.race([
    transport.send({ companyId: COMPANY, to: TO, body: BODY }),
    deadline,
  ]);
  clearTimeout(timer);

  assert.notEqual(outcome, 'hung', 'send() should settle when the provider stalls');
  assert.deepEqual(outcome, { ok: false, reason: 'provider_error' });
});

// ---- provider outage ---------------------------------------------------------

test('outage: a provider error becomes provider_error and the error text (which may hold the number) is dropped', async () => {
  const provider = fakeProvider(() => { throw new Error(`Unable to reach carrier for ${TO}`); });
  const transport = createSmsTransport({ provider });

  const result = await transport.send({ companyId: COMPANY, to: TO, body: BODY });
  assert.deepEqual(result, { ok: false, reason: 'provider_error' });
  assert.ok(!JSON.stringify(result).includes(TO));
});

test('outage: a provider reply with no usable externalId is provider_error, not a success', async () => {
  for (const reply of [undefined, null, {}, { externalId: '' }, { externalId: '   ' }, { externalId: 42 }]) {
    const transport = createSmsTransport({ provider: fakeProvider(() => reply) });
    const result = await transport.send({ companyId: COMPANY, to: TO, body: BODY });
    assert.deepEqual(result, { ok: false, reason: 'provider_error' }, `reply ${JSON.stringify(reply)}`);
  }
});

test('outage: a successful reply returns the provider externalId', async () => {
  const transport = createSmsTransport({ provider: fakeProvider(ok('SM_abc')) });
  assert.deepEqual(
    await transport.send({ companyId: COMPANY, to: TO, body: BODY }),
    { ok: true, externalId: 'SM_abc' },
  );
});

// ---- failure reasons ---------------------------------------------------------

test('failure reasons: invalid company, body and number are each refused before the provider is called', async () => {
  const provider = fakeProvider(ok());
  const transport = createSmsTransport({ provider });

  assert.deepEqual(await transport.send({ companyId: 'not-a-uuid', to: TO, body: BODY }),
    { ok: false, reason: 'invalid_company' });
  assert.deepEqual(await transport.send({ companyId: undefined, to: TO, body: BODY }),
    { ok: false, reason: 'invalid_company' });
  assert.deepEqual(await transport.send({ companyId: COMPANY, to: TO, body: '' }),
    { ok: false, reason: 'invalid_body' });
  assert.deepEqual(await transport.send({ companyId: COMPANY, to: TO, body: 42 }),
    { ok: false, reason: 'invalid_body' });
  assert.deepEqual(await transport.send({ companyId: COMPANY, to: '12345', body: BODY }),
    { ok: false, reason: 'invalid_number' });
  assert.deepEqual(await transport.send({ companyId: COMPANY, to: 'call me', body: BODY }),
    { ok: false, reason: 'invalid_number' });

  assert.equal(provider.calls.length, 0);
});

test('failure reasons: the body limit is inclusive at 1600 and refused at 1601', async () => {
  const provider = fakeProvider(ok());
  const transport = createSmsTransport({ provider });

  assert.equal(SMS_MAX_BODY_LENGTH, 1600);
  assert.deepEqual(
    await transport.send({ companyId: COMPANY, to: TO, body: 'a'.repeat(1600) }),
    { ok: true, externalId: 'SM_fake_0001' },
  );
  assert.deepEqual(
    await transport.send({ companyId: COMPANY, to: TO, body: 'a'.repeat(1601) }),
    { ok: false, reason: 'body_too_long' },
  );
});

test('failure reasons: a national number with a leading 0 is refused without a default country code', async () => {
  const transport = createSmsTransport({ provider: fakeProvider(ok()) });
  assert.deepEqual(
    await transport.send({ companyId: COMPANY, to: '0400000001', body: BODY }),
    { ok: false, reason: 'invalid_number' },
  );
});

test('send never throws: a null input object returns invalid_company', async () => {
  const transport = createSmsTransport({ provider: fakeProvider(ok()) });
  assert.deepEqual(await transport.send(null), { ok: false, reason: 'invalid_company' });
});

// ---- inbound (malformed or spoofed payloads) ---------------------------------

test('inbound invalid: a payload missing the provider message id is refused', () => {
  const transport = createSmsTransport({ provider: fakeProvider(ok()) });
  assert.deepEqual(
    transport.inbound({ from: TO, to: '+61400000002', body: 'hi', providerMessageId: '' }),
    { ok: false, reason: 'invalid_inbound' },
  );
  assert.deepEqual(
    transport.inbound({ from: TO, to: '+61400000002', body: 42, providerMessageId: 'SM_1' }),
    { ok: false, reason: 'invalid_inbound' },
  );
});

test('inbound invalid: non-object payloads are refused', () => {
  const transport = createSmsTransport({ provider: fakeProvider(ok()) });
  assert.deepEqual(transport.inbound(null), { ok: false, reason: 'invalid_inbound' });
  assert.deepEqual(transport.inbound('SMS'), { ok: false, reason: 'invalid_inbound' });
});

test('inbound valid: a complete payload maps to an sms message keyed by the provider id', () => {
  const transport = createSmsTransport({ provider: fakeProvider(ok()) });
  assert.deepEqual(
    transport.inbound({ from: TO, to: '+61400000002', body: 'yes', providerMessageId: 'SM_in_1' }),
    { ok: true, message: { channel: 'sms', from: TO, to: '+61400000002', body: 'yes', externalId: 'SM_in_1' } },
  );
});

// ---- status mapping ----------------------------------------------------------

test('status mapping: exact provider strings map, case and spaces are tolerated, anything else is unknown', () => {
  assert.equal(mapSmsDeliveryStatus('Delivered '), 'delivered');
  assert.equal(mapSmsDeliveryStatus('undelivered'), 'undelivered');
  assert.equal(mapSmsDeliveryStatus('accepted'), 'unknown');
  assert.equal(mapSmsDeliveryStatus('constructor'), 'unknown', 'prototype keys are not statuses');
  assert.equal(mapSmsDeliveryStatus({ status: 'sent' }), 'unknown');
  assert.equal(mapSmsDeliveryStatus(undefined), 'unknown');
});

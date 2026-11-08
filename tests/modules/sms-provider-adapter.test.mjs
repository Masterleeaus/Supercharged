// SMS provider adapter tests (node:test). The HTTP client is a stub: no network, no real fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSmsProviderAdapter, handlePlivoDeliveryReceipt } from '../../server/modules/comms/sms-provider-adapter.ts';

const COMPANY = '11111111-2222-4333-8444-555555555555';
const PHONE = '+61400000000';
const ACCOUNT = 'AC0123456789abcdef';
const TOKEN = 'super-secret-token-value';
const NOON_UTC = '2026-11-03T12:00:00Z';
const TWO_AM_UTC = '2026-11-03T02:00:00Z';

const optedInContact = (overrides = {}) => ({
  handles: { phone: PHONE },
  consents: [{ channel: 'sms', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }],
  // Quiet hours are read in the recipient's timezone. UTC keeps the clock hours in these tests.
  timezone: 'UTC',
  ...overrides,
});

function stubHttp(respond) {
  const calls = [];
  const http = async (url, init) => {
    calls.push({ url, init });
    return respond ? respond(url, init) : okResponse({ message_uuid: ['SM123'] });
  };
  return { http, calls };
}

function okResponse(payload) {
  return { ok: true, status: 201, json: async () => payload };
}

function build(overrides = {}) {
  const stub = overrides.stub ?? stubHttp();
  const adapter = createSmsProviderAdapter({
    accountId: ACCOUNT,
    authToken: TOKEN,
    fromNumber: '+61499999999',
    http: stub.http,
    resolveCompany: async () => ({ quietHours: { startHour: 21, endHour: 7 }, timezone: 'UTC' }),
    resolveContact: async () => optedInContact(),
    now: () => Date.parse(NOON_UTC),
    ...overrides.options,
  });
  return { adapter, calls: stub.calls };
}

const send = (adapter, overrides = {}) =>
  adapter.send({ companyId: COMPANY, to: PHONE, body: 'Hello from Clean Smart', ...overrides });

test('sends through the injected client and returns the first Plivo message_uuid as externalId', async () => {
  const { adapter, calls } = build();
  const result = await send(adapter);
  assert.deepEqual(result, { ok: true, externalId: 'SM123', auditRecorded: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].url, 'https://api.plivo.com/v1/Account/AC0123456789abcdef/Message/');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(sent, { src: '61499999999', dst: '61400000000', text: 'Hello from Clean Smart' });
});

test('credential travels only in the Authorization header', async () => {
  const { adapter, calls } = build();
  await send(adapter);
  const expected = `Basic ${Buffer.from(`${ACCOUNT}:${TOKEN}`).toString('base64')}`;
  assert.equal(calls[0].init.headers.Authorization, expected);
  assert.equal(calls[0].url.includes(TOKEN), false);
  assert.equal(calls[0].init.body.includes(TOKEN), false);
});

test('refuses an opted-out contact and never calls the client', async () => {
  const contact = optedInContact({
    consents: [
      { channel: 'sms', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' },
      { channel: 'sms', action: 'opt_out', at: '2026-02-01T00:00:00Z', source: 'contact' },
    ],
  });
  const { adapter, calls } = build({ options: { resolveContact: async () => contact } });
  assert.deepEqual(await send(adapter), { ok: false, reason: 'opted_out' });
  assert.equal(calls.length, 0);
});

test('refuses a contact with no sms consent and never calls the client', async () => {
  const contact = optedInContact({
    consents: [{ channel: 'email', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }],
  });
  const { adapter, calls } = build({ options: { resolveContact: async () => contact } });
  assert.deepEqual(await send(adapter), { ok: false, reason: 'channel_not_consented' });
  assert.equal(calls.length, 0);
});

test('refuses when no contact owns the number', async () => {
  const { adapter, calls } = build({ options: { resolveContact: async () => null } });
  assert.deepEqual(await send(adapter), { ok: false, reason: 'invalid_contact' });
  assert.equal(calls.length, 0);
});

test('refuses when the resolved contact owns a different number', async () => {
  const { adapter, calls } = build({
    options: { resolveContact: async () => optedInContact({ handles: { phone: '+61411111111' } }) },
  });
  assert.deepEqual(await send(adapter), { ok: false, reason: 'invalid_contact' });
  assert.equal(calls.length, 0);
});

test('refuses inside company quiet hours and never calls the client', async () => {
  const { adapter, calls } = build({ options: { now: () => Date.parse(TWO_AM_UTC) } });
  assert.deepEqual(await send(adapter), { ok: false, reason: 'quiet_hours' });
  assert.equal(calls.length, 0);
});

test('sends outside quiet hours when no window is set', async () => {
  const { adapter, calls } = build({
    options: {
      now: () => Date.parse(TWO_AM_UTC),
      resolveCompany: async () => ({ quietHours: null, timezone: 'UTC' }),
    },
  });
  assert.deepEqual(await send(adapter), { ok: true, externalId: 'SM123', auditRecorded: false });
  assert.equal(calls.length, 1);
});

test('refuses an unknown company', async () => {
  const { adapter, calls } = build({ options: { resolveCompany: async () => null } });
  assert.deepEqual(await send(adapter), { ok: false, reason: 'invalid_company' });
  assert.equal(calls.length, 0);
});

test('rejects bad input before any lookup or request', async () => {
  let lookups = 0;
  const { adapter, calls } = build({
    options: {
      resolveCompany: async () => {
        lookups += 1;
        return { quietHours: null, timezone: 'UTC' };
      },
    },
  });
  assert.deepEqual(await send(adapter, { companyId: 'not-a-uuid' }), { ok: false, reason: 'invalid_company' });
  assert.deepEqual(await send(adapter, { body: '' }), { ok: false, reason: 'invalid_body' });
  assert.deepEqual(await send(adapter, { body: 'x'.repeat(1601) }), { ok: false, reason: 'body_too_long' });
  assert.deepEqual(await send(adapter, { to: 'not a phone' }), { ok: false, reason: 'invalid_number' });
  assert.equal(lookups, 0);
  assert.equal(calls.length, 0);
});

test('maps a provider HTTP error to provider_error without leaking the token or the number', async () => {
  const stub = stubHttp(() => ({
    ok: false,
    status: 401,
    json: async () => ({ message: `Authentication failed for ${TOKEN} to ${PHONE}` }),
  }));
  const { adapter } = build({ stub });
  const result = await send(adapter);
  assert.deepEqual(result, { ok: false, reason: 'provider_error', auditRecorded: false });
  const text = JSON.stringify(result);
  assert.equal(text.includes(TOKEN), false);
  assert.equal(text.includes(PHONE), false);
});

test('maps a thrown transport error to provider_error without echoing its message', async () => {
  const stub = stubHttp(async () => {
    throw new Error(`socket hang up for ${ACCOUNT}:${TOKEN}`);
  });
  const { adapter } = build({ stub });
  const result = await send(adapter);
  assert.deepEqual(result, { ok: false, reason: 'provider_error', auditRecorded: false });
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('maps an unreadable or sid-less success body to provider_error', async () => {
  const bad = stubHttp(() => ({ ok: true, status: 201, json: async () => { throw new SyntaxError('bad json'); } }));
  assert.deepEqual(await send(build({ stub: bad }).adapter), { ok: false, reason: 'provider_error', auditRecorded: false });

  const noSid = stubHttp(() => okResponse({ status: 'queued' }));
  assert.deepEqual(await send(build({ stub: noSid }).adapter), { ok: false, reason: 'provider_error', auditRecorded: false });
});

test('mapStatus and inbound keep the transport behaviour', () => {
  const { adapter } = build();
  assert.equal(adapter.mapStatus('delivered'), 'delivered');
  assert.equal(adapter.mapStatus('accepted'), 'unknown');
  const inbound = adapter.inbound({ from: PHONE, to: '+61499999999', body: 'hi', providerMessageId: 'SM9' });
  assert.deepEqual(inbound, {
    ok: true,
    message: { channel: 'sms', from: PHONE, to: '+61499999999', body: 'hi', externalId: 'SM9' },
  });
});

test('constructor rejects an invalid sender number', () => {
  assert.throws(
    () =>
      createSmsProviderAdapter({
        accountId: ACCOUNT,
        authToken: TOKEN,
        fromNumber: 'nope',
        http: async () => okResponse({}),
        resolveCompany: async () => null,
        resolveContact: async () => null,
      }),
    RangeError,
  );
});


const UUID_A = '99999999-8888-4777-8666-555555555555';

test('delivery receipt maps each Plivo status with the company and message id', () => {
  for (const [status, expected] of [
    ['queued', 'queued'],
    ['sent', 'sent'],
    ['delivered', 'delivered'],
    ['undelivered', 'undelivered'],
    ['failed', 'failed'],
  ]) {
    const r = handlePlivoDeliveryReceipt({
      companyId: COMPANY,
      payload: { MessageUUID: 'SM123', Status: status },
    });
    assert.deepEqual(r, { ok: true, companyId: COMPANY, externalId: 'SM123', status: expected });
  }
});

test('delivery receipt keeps a numeric ErrorCode and drops anything else', () => {
  const kept = handlePlivoDeliveryReceipt({
    companyId: COMPANY,
    payload: { MessageUUID: 'SM1', Status: 'failed', ErrorCode: '40002' },
  });
  assert.equal(kept.ok, true);
  assert.equal(kept.errorCode, '40002');

  const dropped = handlePlivoDeliveryReceipt({
    companyId: COMPANY,
    payload: { MessageUUID: 'SM1', Status: 'failed', ErrorCode: 'Bearer abc123 +61400000000' },
  });
  assert.equal(dropped.ok, true);
  assert.equal('errorCode' in dropped, false);
});

test('delivery receipt takes the company from the input and ignores any companyId in the payload', () => {
  const r = handlePlivoDeliveryReceipt({
    companyId: COMPANY,
    payload: { MessageUUID: 'SM1', Status: 'delivered', companyId: UUID_A },
  });
  assert.equal(r.ok, true);
  assert.equal(r.companyId, COMPANY);
});

test('delivery receipt refuses an unknown status, a missing id, a bad company and a non-object payload', () => {
  assert.deepEqual(
    handlePlivoDeliveryReceipt({ companyId: COMPANY, payload: { MessageUUID: 'SM1', Status: 'rejected' } }),
    { ok: false, reason: 'unknown_status' },
  );
  assert.deepEqual(
    handlePlivoDeliveryReceipt({ companyId: COMPANY, payload: { Status: 'sent' } }),
    { ok: false, reason: 'invalid_receipt' },
  );
  assert.deepEqual(
    handlePlivoDeliveryReceipt({ companyId: 'not-a-uuid', payload: { MessageUUID: 'SM1', Status: 'sent' } }),
    { ok: false, reason: 'invalid_company' },
  );
  assert.deepEqual(handlePlivoDeliveryReceipt({ companyId: COMPANY, payload: 'SM1' }), {
    ok: false,
    reason: 'invalid_receipt',
  });
  assert.deepEqual(handlePlivoDeliveryReceipt({ companyId: undefined, payload: {} }), {
    ok: false,
    reason: 'invalid_company',
  });
});

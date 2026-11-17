import test from 'node:test';
import assert from 'node:assert/strict';

const manifestMod = await import('../../server/plugins/manifest.ts');
const contract = await import('../../server/connectors/sdk/contract.ts');
const twilio = await import('../../server/connectors/twilio/index.ts');
const gatedMod = await import('../../server/connectors/twilio/gated-sms.ts');
const presend = await import('../../server/modules/comms/presend-gate.ts');
const suppressionMod = await import('../../server/modules/comms/suppression.ts');
const fs = await import('node:fs');

const CO = '11111111-1111-4111-8111-111111111111';
const SID = 'AC' + 'a'.repeat(32);
const TOKEN = 'token-value-not-real';
const CREDS = { type: 'api_key', apiKey: `${SID}:${TOKEN}` };
const TO = '+61412345678';
const NOW = new Date('2026-11-18T03:00:00Z');

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift() ?? { status: 201, body: { sid: 'SM' + 'b'.repeat(32), status: 'queued' } };
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: next.headers ?? {},
    });
  };
  return { fn, calls };
}

function definition(fetchImpl) {
  return twilio.createTwilioConnector({ fetchImpl, baseUrl: 'https://vendor.test' });
}

const contactWith = (events) => ({ handles: { phone: TO }, consents: events, timezone: 'Australia/Melbourne' });
const OPTED_IN = [{ channel: 'sms', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }];

function gateWith({ contact, suppressed = false, throws = false } = {}) {
  const blocked = [];
  const suppression = suppressionMod.createSuppressionList();
  if (suppressed) suppression.suppress(CO, { address: TO, channel: 'sms', reason: 'complaint', actorId: 'system' });
  const gate = presend.createPreSendGate({
    suppression,
    async loadContact() {
      if (throws) throw new Error('db down');
      return contact;
    },
    async loadQuietHours() { return null; },
    now: () => NOW,
    async recordBlocked(record) { blocked.push(record); },
  });
  return { gate, blocked };
}

const auditRecords = [];
const audit = async (r) => { auditRecords.push(r); };

test('manifest validates and the implementation passes the contract check', () => {
  const raw = JSON.parse(fs.readFileSync(new URL('../../server/connectors/twilio/connector.json', import.meta.url), 'utf8'));
  const m = manifestMod.validateConnectorManifest(raw);
  assert.equal(m.ok, true);
  assert.equal(m.manifest.id, 'twilio');
  assert.deepEqual(contract.checkConnectorDefinition(definition(fakeFetch([]).fn)), []);
});

test('sendSms posts a form body with basic auth, keeps the token out of the URL, and returns only the SID', async () => {
  const { fn, calls } = fakeFetch([]);
  const res = await definition(fn).execute(
    { action: 'sendSms', input: { to: TO, body: 'hi', from: '+61400000000' }, timeoutMs: 1000 },
    CREDS,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://vendor.test/2010-04-01/Accounts/${SID}/Messages.json`);
  assert.ok(!calls[0].url.includes(TOKEN));
  assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`);
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(body.get('To'), TO);
  assert.equal(body.get('From'), '+61400000000');
  assert.deepEqual(Object.keys(res).sort(), ['externalId', 'status']);
});

test('invalid input and malformed credentials are refused before any network call', async () => {
  const { fn, calls } = fakeFetch([]);
  const def = definition(fn);
  const cases = [
    [{ to: '0412345678', body: 'x', from: '+61400000000' }, CREDS],
    [{ to: TO, body: '', from: '+61400000000' }, CREDS],
    [{ to: TO, body: 'x' }, CREDS],
    [{ to: TO, body: 'x', from: '+61400000000', messagingServiceSid: 'MG' + 'c'.repeat(32) }, CREDS],
    [{ to: TO, body: 'x', from: '+61400000000' }, { type: 'api_key', apiKey: 'nocolon' }],
    [{ to: TO, body: 'x', from: '+61400000000' }, { type: 'oauth2', accessToken: 'x' }],
  ];
  for (const [input, creds] of cases) {
    await assert.rejects(def.execute({ action: 'sendSms', input, timeoutMs: 1000 }, creds), (e) => e instanceof contract.ConnectorError);
  }
  assert.equal(calls.length, 0);
});

test('vendor failures map to the taxonomy and only the codes marked retryable are retryable', async () => {
  const cases = [
    [{ status: 401 }, 'auth', false],
    [{ status: 429, headers: { 'retry-after': '2' } }, 'rate_limited', true],
    [{ status: 500 }, 'upstream', true],
    [{ status: 400 }, 'validation', false],
  ];
  for (const [resp, code, retryable] of cases) {
    const { fn } = fakeFetch([resp]);
    await assert.rejects(
      definition(fn).execute({ action: 'sendSms', input: { to: TO, body: 'x', from: '+61400000000' }, timeoutMs: 1000 }, CREDS),
      (e) => e.code === code && e.retryable === retryable,
    );
  }
  const { fn } = fakeFetch([{ status: 429, headers: { 'retry-after': '2' } }]);
  await assert.rejects(
    definition(fn).execute({ action: 'sendSms', input: { to: TO, body: 'x', from: '+61400000000' }, timeoutMs: 1000 }, CREDS),
    (e) => e.retryAfterMs === 2000,
  );
});

test('an opted-out recipient is blocked: no vault read, no connector call, block recorded', async () => {
  const { fn, calls } = fakeFetch([]);
  const { gate, blocked } = gateWith({ contact: contactWith([...OPTED_IN, { channel: 'sms', action: 'opt_out', at: '2026-02-01T00:00:00Z', source: 'contact' }]) });
  let routeReads = 0;
  const sender = gatedMod.createGatedSmsSender({
    gate, definition: definition(fn), audit,
    async resolveRoute() { routeReads += 1; return { credentials: CREDS, from: '+61400000000' }; },
  });
  const res = await sender.send({ companyId: CO, actorId: 'system', surface: 'marketing', to: TO, body: 'x' });
  assert.deepEqual(res, { status: 'blocked', reason: 'opted_out' });
  assert.equal(calls.length, 0);
  assert.equal(routeReads, 0);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].reason, 'opted_out');
});

test('a suppressed address and a gate that throws both block the send', async () => {
  const { fn, calls } = fakeFetch([]);
  const suppressedGate = gateWith({ contact: contactWith(OPTED_IN), suppressed: true });
  const s1 = gatedMod.createGatedSmsSender({ gate: suppressedGate.gate, definition: definition(fn), audit, resolveRoute: async () => ({ credentials: CREDS, from: '+61400000000' }) });
  assert.equal((await s1.send({ companyId: CO, actorId: 'system', surface: 'inbox', to: TO, body: 'x' })).reason, 'suppressed');

  const throwing = gateWith({ contact: contactWith(OPTED_IN), throws: true });
  const s2 = gatedMod.createGatedSmsSender({ gate: throwing.gate, definition: definition(fn), audit, resolveRoute: async () => ({ credentials: CREDS, from: '+61400000000' }) });
  const res = await s2.send({ companyId: CO, actorId: 'system', surface: 'inbox', to: TO, body: 'x' });
  assert.equal(res.reason, 'gate_error');
  assert.equal(calls.length, 0);
});

test('an allowed send reaches the connector once, even when the vendor fails (no duplicate SMS)', async () => {
  const { fn, calls } = fakeFetch([{ status: 500 }, { status: 201, body: { sid: 'SMx', status: 'queued' } }]);
  const { gate } = gateWith({ contact: contactWith(OPTED_IN) });
  const sender = gatedMod.createGatedSmsSender({
    gate, definition: definition(fn), audit,
    resolveRoute: async () => ({ credentials: CREDS, from: '+61400000000' }),
  });
  await assert.rejects(sender.send({ companyId: CO, actorId: 'system', surface: 'marketing', to: TO, body: 'x', stableId: 'job-1' }), (e) => e.code === 'upstream');
  assert.equal(calls.length, 1);
});

test('the campaign transport routes through the gate and throws when blocked', async () => {
  const { fn, calls } = fakeFetch([]);
  const { gate } = gateWith({ contact: contactWith([{ channel: 'sms', action: 'opt_out', at: '2026-02-01T00:00:00Z', source: 'contact' }]) });
  const sender = gatedMod.createGatedSmsSender({ gate, definition: definition(fn), audit, resolveRoute: async () => ({ credentials: CREDS, from: '+61400000000' }) });
  const transport = gatedMod.createGatedSmsTransport(sender);
  await assert.rejects(transport.send(CO, { id: 'j1', address: TO }, { subject: null, body: 'x' }), (e) => e.code === 'forbidden');
  assert.equal(calls.length, 0);

  const ok = gateWith({ contact: contactWith(OPTED_IN) });
  const sender2 = gatedMod.createGatedSmsSender({ gate: ok.gate, definition: definition(fakeFetch([]).fn), audit, resolveRoute: async () => ({ credentials: CREDS, from: '+61400000000' }) });
  const out = await gatedMod.createGatedSmsTransport(sender2).send(CO, { id: 'j2', address: TO }, { subject: null, body: 'x' });
  assert.equal(typeof out.externalId, 'string');
});

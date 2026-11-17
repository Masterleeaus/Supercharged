import test from 'node:test';
import assert from 'node:assert/strict';

const manifestMod = await import('../../server/plugins/manifest.ts');
const contract = await import('../../server/connectors/sdk/contract.ts');
const telegram = await import('../../server/connectors/telegram/index.ts');
const gatedMod = await import('../../server/connectors/telegram/gated-telegram.ts');
const presend = await import('../../server/modules/comms/presend-gate.ts');
const suppressionMod = await import('../../server/modules/comms/suppression.ts');
const fs = await import('node:fs');

const CO = '11111111-1111-4111-8111-111111111111';
const TOKEN = '123456789:AAFake-test-token-value_xyz';
const CREDS = { type: 'api_key', apiKey: TOKEN };
const CHAT = '987654321';
const NOW = new Date('2026-11-18T03:00:00Z');

/** Fake POST port. Each entry is a canned response, or a function returning a promise (to simulate a hang). */
function fakeHttp(responses) {
  const calls = [];
  const post = async (url, body) => {
    calls.push({ url, body });
    const next = responses.shift() ?? { ok: true, result: { message_id: 42 } };
    return typeof next === 'function' ? next() : next;
  };
  return { http: { post }, calls };
}

const definition = (http) => telegram.createTelegramConnector({ http });

const contactWith = (events) => ({ handles: { telegram: CHAT }, consents: events, timezone: 'Australia/Melbourne' });
const OPTED_IN = [{ channel: 'telegram', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }];

function gateWith({ contact, suppressed = false, throws = false } = {}) {
  const blocked = [];
  const suppression = suppressionMod.createSuppressionList();
  if (suppressed) suppression.suppress(CO, { address: CHAT, channel: 'telegram', reason: 'complaint', actorId: 'system' });
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

const audit = async () => {};

test('manifest validates and the implementation passes the contract check', () => {
  const raw = JSON.parse(fs.readFileSync(new URL('../../server/connectors/telegram/connector.json', import.meta.url), 'utf8'));
  const m = manifestMod.validateConnectorManifest(raw);
  assert.equal(m.ok, true);
  assert.equal(m.manifest.id, 'telegram');
  assert.deepEqual(contract.checkConnectorDefinition(definition(fakeHttp([]).http)), []);
});

test('sendMessage posts the chat and text, and returns only the message id', async () => {
  const { http, calls } = fakeHttp([]);
  const out = await definition(http).execute({ action: 'sendMessage', input: { chatId: CHAT, text: 'hello' }, timeoutMs: 1000 }, CREDS);
  assert.deepEqual(out, { externalId: '42' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.deepEqual(calls[0].body, { chat_id: CHAT, text: 'hello' });
  assert.equal(JSON.stringify(out).includes(TOKEN), false);
});

test('invalid input and malformed credentials are refused before any network call', async () => {
  const { http, calls } = fakeHttp([]);
  const def = definition(http);
  const badInputs = [
    { chatId: '', text: 'x' },
    { chatId: CHAT, text: '   ' },
    { chatId: CHAT, text: 'x'.repeat(4097) },
    { chatId: CHAT, text: 'x', replyToMessageId: -1 },
    null,
  ];
  for (const input of badInputs) {
    await assert.rejects(def.execute({ action: 'sendMessage', input, timeoutMs: 1000 }, CREDS), (e) => e.code === 'validation');
  }
  await assert.rejects(
    def.execute({ action: 'sendMessage', input: { chatId: CHAT, text: 'x' }, timeoutMs: 1000 }, { type: 'api_key', apiKey: 'not-a-token' }),
    (e) => e.code === 'auth' && !String(e.message).includes('not-a-token'),
  );
  await assert.rejects(
    def.execute({ action: 'sendMessage', input: { chatId: CHAT, text: 'x' }, timeoutMs: 1000 }, { type: 'oauth2', accessToken: 'x' }),
    (e) => e.code === 'auth',
  );
  assert.equal(calls.length, 0);
});

test('provider rejection maps to a retryable upstream error; an unknown outcome is never retryable', async () => {
  const { http: rejectHttp } = fakeHttp([{ ok: false, description: 'Bad Request' }]);
  await assert.rejects(
    definition(rejectHttp).execute({ action: 'sendMessage', input: { chatId: CHAT, text: 'x' }, timeoutMs: 1000 }, CREDS),
    (e) => e.code === 'upstream' && e.retryable === true,
  );

  const hang = () => new Promise(() => {});
  const { http: hangHttp, calls } = fakeHttp([hang]);
  await assert.rejects(
    definition(hangHttp).execute({ action: 'sendMessage', input: { chatId: CHAT, text: 'x' }, timeoutMs: 20 }, CREDS),
    (e) => e.code === 'unknown' && e.retryable === false,
  );
  assert.equal(calls.length, 1);
});

test('an opted-out recipient is blocked: no vault read, no connector call, block recorded', async () => {
  const { http, calls } = fakeHttp([]);
  const { gate, blocked } = gateWith({
    contact: contactWith([...OPTED_IN, { channel: 'telegram', action: 'opt_out', at: '2026-02-01T00:00:00Z', source: 'contact' }]),
  });
  let routeReads = 0;
  const sender = gatedMod.createGatedTelegramSender({
    gate, definition: definition(http), audit,
    async resolveRoute() { routeReads += 1; return { credentials: CREDS }; },
  });
  const res = await sender.send({ companyId: CO, actorId: 'system', surface: 'marketing', chatId: CHAT, text: 'x' });
  assert.deepEqual(res, { status: 'blocked', reason: 'opted_out' });
  assert.equal(calls.length, 0);
  assert.equal(routeReads, 0);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].channel, 'telegram');
});

test('a suppressed chat and a gate that throws both block the send', async () => {
  const { http, calls } = fakeHttp([]);
  const s1 = gatedMod.createGatedTelegramSender({
    gate: gateWith({ contact: contactWith(OPTED_IN), suppressed: true }).gate,
    definition: definition(http), audit, resolveRoute: async () => ({ credentials: CREDS }),
  });
  assert.equal((await s1.send({ companyId: CO, actorId: 'system', surface: 'inbox', chatId: CHAT, text: 'x' })).reason, 'suppressed');

  const s2 = gatedMod.createGatedTelegramSender({
    gate: gateWith({ contact: contactWith(OPTED_IN), throws: true }).gate,
    definition: definition(http), audit, resolveRoute: async () => ({ credentials: CREDS }),
  });
  assert.equal((await s2.send({ companyId: CO, actorId: 'system', surface: 'inbox', chatId: CHAT, text: 'x' })).reason, 'gate_error');
  assert.equal(calls.length, 0);
});

test('an allowed send reaches the connector once, even when the vendor fails (no duplicate message)', async () => {
  const { http, calls } = fakeHttp([{ ok: false }, { ok: true, result: { message_id: 7 } }]);
  const sender = gatedMod.createGatedTelegramSender({
    gate: gateWith({ contact: contactWith(OPTED_IN) }).gate,
    definition: definition(http), audit, resolveRoute: async () => ({ credentials: CREDS }),
  });
  await assert.rejects(
    sender.send({ companyId: CO, actorId: 'system', surface: 'inbox', chatId: CHAT, text: 'x', stableId: 'msg-1' }),
    (e) => e.code === 'upstream',
  );
  assert.equal(calls.length, 1);

  const ok = gatedMod.createGatedTelegramSender({
    gate: gateWith({ contact: contactWith(OPTED_IN) }).gate,
    definition: definition(fakeHttp([]).http), audit, resolveRoute: async () => ({ credentials: CREDS }),
  });
  assert.deepEqual(
    await ok.send({ companyId: CO, actorId: 'system', surface: 'inbox', chatId: CHAT, text: 'x' }),
    { status: 'sent', externalId: '42' },
  );
});

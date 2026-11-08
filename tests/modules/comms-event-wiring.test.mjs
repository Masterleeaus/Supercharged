// Comms audit event wiring for the send call sites (node:test). Fake sink and stub HTTP only:
// no database, no network, no provider calls. Console is silenced because the modules are server code.
const noop = () => {};
console.log = noop;
console.info = noop;
console.warn = noop;
console.error = noop;

import test from 'node:test';
import assert from 'node:assert/strict';
import { recordCommsEvent, toCommsIsoTime } from '../../server/modules/comms/audit-sink.ts';
import { createTelegramProviderAdapter, TelegramAdapterRefusedError } from '../../server/modules/comms/telegram-provider-adapter.ts';
import { createWhatsAppProviderAdapter } from '../../server/modules/comms/whatsapp-provider-adapter.ts';
import { createSmsProviderAdapter } from '../../server/modules/comms/sms-provider-adapter.ts';
import { createEmailProviderAdapter } from '../../server/modules/comms/email-provider-adapter.ts';
import { createSuppressionList } from '../../server/modules/comms/suppression.ts';
import { sendMessengerReply } from '../../server/modules/comms/messenger-provider-adapter.ts';

const CO = '11111111-1111-4111-8111-111111111111';
const ACTOR = 'user_42';
const TG_NOW = '2026-11-03T10:00:00Z';
const HOUR = 60 * 60 * 1000;
const NOW_MS = Date.parse('2026-11-03T12:00:00Z');

/** Fake sink: records every entry it is handed. */
function fakeSink() {
  const entries = [];
  return { entries, sink: (entry) => entries.push(entry) };
}

// ---------- helper ----------

test('no sink injected: recordCommsEvent records nothing and returns false', () => {
  const ok = recordCommsEvent(undefined, 'comms.message_sent', {
    companyId: CO,
    actorId: ACTOR,
    now: NOW_MS,
    target: { type: 'message', id: 'm1' },
    detail: { channel: 'sms' },
  });
  assert.equal(ok, false);
});

test('missing actor: nothing is recorded even when a sink is injected', () => {
  const fake = fakeSink();
  const ok = recordCommsEvent(fake.sink, 'comms.message_sent', {
    companyId: CO,
    actorId: '  ',
    now: NOW_MS,
    target: { type: 'message', id: 'm1' },
    detail: { channel: 'sms' },
  });
  assert.equal(ok, false);
  assert.equal(fake.entries.length, 0);
});

test('invalid company is refused by the builder and nothing is recorded', () => {
  const fake = fakeSink();
  const ok = recordCommsEvent(fake.sink, 'comms.message_sent', {
    companyId: 'not-a-uuid',
    actorId: ACTOR,
    now: NOW_MS,
    target: { type: 'message', id: 'm1' },
    detail: { channel: 'sms' },
  });
  assert.equal(ok, false);
  assert.equal(fake.entries.length, 0);
});

test('a valid event reaches the sink with an allowlisted detail only', () => {
  const fake = fakeSink();
  const ok = recordCommsEvent(fake.sink, 'comms.message_sent', {
    companyId: CO,
    actorId: ACTOR,
    now: NOW_MS,
    target: { type: 'message', id: 'm1' },
    // 'body' is not on the allowlist for message_sent, so it must be dropped.
    detail: { channel: 'sms', body: 'a private message body' },
  });
  assert.equal(ok, true);
  assert.equal(fake.entries.length, 1);
  const [entry] = fake.entries;
  assert.equal(entry.action, 'comms.message_sent');
  assert.equal(entry.companyId, CO);
  assert.equal(entry.actorId, ACTOR);
  assert.equal(entry.at, '2026-11-03T12:00:00.000Z');
  assert.deepEqual(entry.target, { type: 'message', id: 'm1' });
  assert.deepEqual(entry.detail, { channel: 'sms' });
  assert.equal(JSON.stringify(entry).includes('private message body'), false);
});

test('a sink that throws does not make recordCommsEvent throw', () => {
  const ok = recordCommsEvent(
    () => {
      throw new Error('sink down');
    },
    'comms.message_sent',
    { companyId: CO, actorId: ACTOR, now: NOW_MS, target: { type: 'message', id: 'm1' }, detail: { channel: 'sms' } },
  );
  assert.equal(ok, false);
});

test('toCommsIsoTime reads Date, epoch milliseconds and ISO strings, and refuses junk', () => {
  assert.equal(toCommsIsoTime(new Date(NOW_MS)), '2026-11-03T12:00:00.000Z');
  assert.equal(toCommsIsoTime(NOW_MS), '2026-11-03T12:00:00.000Z');
  assert.equal(toCommsIsoTime('2026-11-03T12:00:00Z'), '2026-11-03T12:00:00.000Z');
  assert.equal(toCommsIsoTime('yesterday-ish'), null);
  assert.equal(toCommsIsoTime(undefined), null);
});

// ---------- Telegram ----------

const tgConsented = {
  handles: { telegram: '98765' },
  consents: [{ channel: 'telegram', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }],
};

function tgAdapter({ auditSink, reply } = {}) {
  const posts = [];
  return {
    posts,
    adapter: createTelegramProviderAdapter({
      token: '123456:FAKE-TOKEN-VALUE',
      auditSink,
      http: {
        async post(url, body) {
          posts.push({ url, body });
          return reply ?? { ok: true, result: { message_id: 42 } };
        },
      },
    }),
  };
}

const tgInput = (overrides = {}) => ({
  companyId: CO,
  actorId: ACTOR,
  contact: tgConsented,
  chatId: '98765',
  text: 'See you Tuesday',
  now: TG_NOW,
  ...overrides,
});

/**
 * The pending event is written before the provider call and the outcome event after it. Both
 * carry one correlation id as their target id, so the provider message id is not in the target.
 */
function assertPendingAndOutcome(entries, channel, outcome = 'sent') {
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.action), ['comms.message_sent', 'comms.message_sent']);
  assert.equal(entries[0].target.type, 'message');
  assert.deepEqual(entries[0].target, entries[1].target);
  assert.deepEqual(entries[0].detail, { channel, status: 'pending' });
  assert.deepEqual(entries[1].detail, { channel, status: outcome });
}

test('telegram: a successful send with a sink writes a pending and an outcome event', async () => {
  const fake = fakeSink();
  const { adapter, posts } = tgAdapter({ auditSink: fake.sink });
  const result = await adapter.send(tgInput());
  assert.deepEqual(result, { ok: true, messageId: 42, auditRecorded: true });
  assert.equal(posts.length, 1);
  assertPendingAndOutcome(fake.entries, 'telegram');
});

test('telegram: no sink injected, the send still succeeds and records nothing', async () => {
  const { adapter } = tgAdapter();
  const result = await adapter.send(tgInput());
  assert.deepEqual(result, { ok: true, messageId: 42, auditRecorded: false });
});

test('telegram: no actor with a sink is refused before the provider is called', async () => {
  const fake = fakeSink();
  const { adapter, posts } = tgAdapter({ auditSink: fake.sink });
  await assert.rejects(adapter.send(tgInput({ actorId: undefined })), TelegramAdapterRefusedError);
  assert.equal(posts.length, 0);
  assert.equal(fake.entries.length, 0);
});

test('telegram: a provider failure writes a pending and a provider_error outcome event', async () => {
  const fake = fakeSink();
  const { adapter } = tgAdapter({ auditSink: fake.sink, reply: { ok: false } });
  const result = await adapter.send(tgInput());
  assert.deepEqual(result, { ok: false, reason: 'provider_error', auditRecorded: true });
  assertPendingAndOutcome(fake.entries, 'telegram', 'provider_error');
});

test('telegram: a consent refusal throws and records nothing', async () => {
  const fake = fakeSink();
  const optedOut = {
    handles: { telegram: '98765' },
    consents: [
      { channel: 'telegram', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' },
      { channel: 'telegram', action: 'opt_out', at: '2026-02-01T00:00:00Z', source: 'contact' },
    ],
  };
  const { adapter, posts } = tgAdapter({ auditSink: fake.sink });
  await assert.rejects(adapter.send(tgInput({ contact: optedOut })), TelegramAdapterRefusedError);
  assert.equal(posts.length, 0);
  assert.equal(fake.entries.length, 0);
});

// ---------- WhatsApp ----------

const WA_TO = '+61400000000';
const waContact = {
  handles: { phone: WA_TO },
  consents: [{ channel: 'whatsapp', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }],
};

function waAdapter({ auditSink, companyId = CO } = {}) {
  return createWhatsAppProviderAdapter({
    phoneNumberId: '555000111',
    accessToken: 'EAAG-FAKE-TOKEN',
    company: 'Clean Smart',
    companyId,
    auditSink,
    http: async () => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.T1' }] }) }),
  });
}

const waMessage = (overrides = {}) => ({
  to: WA_TO,
  contact: waContact,
  now: NOW_MS,
  lastInboundAt: NOW_MS - 2 * HOUR,
  text: 'See you Tuesday',
  actorId: ACTOR,
  ...overrides,
});

test('whatsapp: a successful free-form send with a sink writes a pending and an outcome event', async () => {
  const fake = fakeSink();
  const r = await waAdapter({ auditSink: fake.sink }).send(waMessage());
  assert.deepEqual(r, { ok: true, externalId: 'wamid.T1', auditRecorded: true });
  assertPendingAndOutcome(fake.entries, 'whatsapp');
});

test('whatsapp: no sink injected, the send still succeeds', async () => {
  const r = await waAdapter().send(waMessage());
  assert.deepEqual(r, { ok: true, externalId: 'wamid.T1', auditRecorded: false });
});

test('whatsapp: a refused send (window closed) records nothing', async () => {
  const fake = fakeSink();
  const r = await waAdapter({ auditSink: fake.sink }).send(waMessage({ lastInboundAt: NOW_MS - 30 * HOUR }));
  assert.equal(r.ok, false);
  assert.equal(fake.entries.length, 0);
});

// ---------- SMS ----------

const SMS_PHONE = '+61400000000';

test('sms: a successful send records one message_sent event with the Plivo id', async () => {
  const fake = fakeSink();
  const adapter = createSmsProviderAdapter({
    accountId: 'AC0123456789abcdef',
    authToken: 'FAKE-AUTH-TOKEN',
    fromNumber: '+61499999999',
    http: async () => ({ ok: true, status: 201, json: async () => ({ message_uuid: ['SM123'] }) }),
    resolveCompany: async () => ({ quietHours: null }),
    resolveContact: async () => ({
      handles: { phone: SMS_PHONE },
      consents: [{ channel: 'sms', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }],
      timezone: 'UTC',
    }),
    now: () => NOW_MS,
    auditSink: fake.sink,
  });
  const r = await adapter.send({ companyId: CO, actorId: ACTOR, to: SMS_PHONE, body: 'Hello' });
  assert.deepEqual(r, { ok: true, externalId: 'SM123', auditRecorded: true });
  assertPendingAndOutcome(fake.entries, 'sms');
});

test('sms: no actor with a sink is refused before the provider is called', async () => {
  const fake = fakeSink();
  let providerCalls = 0;
  const adapter = createSmsProviderAdapter({
    accountId: 'AC0123456789abcdef',
    authToken: 'FAKE-AUTH-TOKEN',
    fromNumber: '+61499999999',
    http: async () => {
      providerCalls += 1;
      return { ok: true, status: 201, json: async () => ({ message_uuid: ['SM124'] }) };
    },
    resolveCompany: async () => ({ quietHours: null }),
    resolveContact: async () => ({
      handles: { phone: SMS_PHONE },
      consents: [{ channel: 'sms', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }],
      timezone: 'UTC',
    }),
    now: () => NOW_MS,
    auditSink: fake.sink,
  });
  const r = await adapter.send({ companyId: CO, to: SMS_PHONE, body: 'Hello' });
  assert.deepEqual(r, { ok: false, reason: 'audit_unavailable', auditRecorded: false });
  assert.equal(providerCalls, 0);
  assert.equal(fake.entries.length, 0);
});

// ---------- Email ----------

const EMAIL_ADDRESS = 'jane.doe@example.com';
const EMAIL_CONSENTED = {
  handles: { email: EMAIL_ADDRESS },
  consents: [{ channel: 'email', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }],
};

test('email: a successful send records one message_sent event with the provider message id', async () => {
  const fake = fakeSink();
  const sender = createEmailProviderAdapter({
    companyId: CO,
    suppression: createSuppressionList(),
    loadContact: async () => EMAIL_CONSENTED,
    buildUnsubscribeUrl: () => 'https://app.example.com/unsubscribe/token-abc',
    base: async () => ({ success: true, messageId: 'em_1' }),
    now: () => new Date(NOW_MS),
    auditSink: fake.sink,
    actorId: ACTOR,
  });
  const r = await sender({ to: EMAIL_ADDRESS, subject: 'Hi', text: 'Hello', html: '<p>Hello</p>' });
  assert.deepEqual(r, { success: true, messageId: 'em_1', auditRecorded: true });
  assertPendingAndOutcome(fake.entries, 'email');
});

test('email: a failed base send writes a pending and a provider_error outcome event', async () => {
  const fake = fakeSink();
  const sender = createEmailProviderAdapter({
    companyId: CO,
    suppression: createSuppressionList(),
    loadContact: async () => EMAIL_CONSENTED,
    buildUnsubscribeUrl: () => 'https://app.example.com/unsubscribe/token-abc',
    base: async () => ({ success: false, error: 'sender_error' }),
    now: () => new Date(NOW_MS),
    auditSink: fake.sink,
    actorId: ACTOR,
  });
  const r = await sender({ to: EMAIL_ADDRESS, subject: 'Hi', text: 'Hello' });
  assert.deepEqual(r, { success: false, error: 'sender_error', auditRecorded: true });
  assertPendingAndOutcome(fake.entries, 'email', 'provider_error');
});

// ---------- Messenger ----------

const RID = '1234567890';

test('messenger: a successful reply with company and actor writes a pending and an outcome event', async () => {
  const fake = fakeSink();
  const r = await sendMessengerReply({
    accessToken: 'EAAG-FAKE-TOKEN',
    recipientId: RID,
    text: 'Hello',
    contact: { handles: { messenger: RID }, consents: [] },
    lastInboundAt: NOW_MS - HOUR,
    now: NOW_MS,
    http: { async post() { return { message_id: 'm_1' }; } },
    companyId: CO,
    actorId: ACTOR,
    auditSink: fake.sink,
  });
  assert.deepEqual(r, { ok: true, messageId: 'm_1', auditRecorded: true });
  assertPendingAndOutcome(fake.entries, 'messenger');
});

test('messenger: without a company the send is refused before the provider is called', async () => {
  const fake = fakeSink();
  let posts = 0;
  const r = await sendMessengerReply({
    accessToken: 'EAAG-FAKE-TOKEN',
    recipientId: RID,
    text: 'Hello',
    contact: { handles: { messenger: RID }, consents: [] },
    lastInboundAt: NOW_MS - HOUR,
    now: NOW_MS,
    http: { async post() { posts += 1; return { message_id: 'm_2' }; } },
    actorId: ACTOR,
    auditSink: fake.sink,
  });
  assert.deepEqual(r, { ok: false, reason: 'audit_unavailable', auditRecorded: false });
  assert.equal(posts, 0);
  assert.equal(fake.entries.length, 0);
});

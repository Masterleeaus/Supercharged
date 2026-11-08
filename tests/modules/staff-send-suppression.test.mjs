// Suppression on staff sends (SMS, Telegram, WhatsApp). Node test runner, fakes only: no network,
// no database, no real provider. A suppressed recipient is refused before any HTTP call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSmsProviderAdapter } from '../../server/modules/comms/sms-provider-adapter.ts';
import {
  createTelegramProviderAdapter,
  TelegramAdapterRefusedError,
} from '../../server/modules/comms/telegram-provider-adapter.ts';
import { createWhatsAppProviderAdapter } from '../../server/modules/comms/whatsapp-provider-adapter.ts';
import { createSuppressionList } from '../../server/modules/comms/suppression.ts';

// Keep test output off stdout so the test runner's IPC stays clean.
for (const method of ['log', 'info', 'warn']) console[method] = () => {};

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-11-03T12:00:00Z');
const HOUR = 60 * 60 * 1000;

const SMS_PHONE = '+61400000000';
const TG_CHAT = '98765';
const WA_PHONE = '61412345678';

function fakeHttp(response) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return response(url, init);
  };
  return { calls, fn };
}

const okPlivo = () => ({ ok: true, status: 202, json: async () => ({ message_uuid: ['SM-1'] }) });

function suppressed(address, channel, companyId = CO_A) {
  const list = createSuppressionList();
  const res = list.suppress(companyId, { address, channel, reason: 'unsubscribed' });
  assert.equal(res.ok && res.suppressed, true);
  return list;
}

// ---------- SMS ----------

function smsAdapter({ suppression, http }) {
  return createSmsProviderAdapter({
    accountId: 'AC0123456789abcdef',
    authToken: 'sms-secret-token',
    fromNumber: '+61499999999',
    http,
    resolveCompany: async () => ({ quietHours: null }),
    resolveContact: async () => ({
      handles: { phone: SMS_PHONE },
      consents: [{ channel: 'sms', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }],
      timezone: 'UTC',
    }),
    now: () => NOW,
    ...(suppression ? { suppression } : {}),
  });
}

test('sms: a suppressed number is refused with reason suppressed and the client is never called', async () => {
  const http = fakeHttp(okPlivo);
  const adapter = smsAdapter({ suppression: suppressed(SMS_PHONE, 'sms'), http: http.fn });
  const result = await adapter.send({ companyId: CO_A, to: SMS_PHONE, body: 'Hello' });
  assert.deepEqual(result, { ok: false, reason: 'suppressed' });
  assert.equal(http.calls.length, 0);
});

test('sms: a number suppressed for another company does not block this company', async () => {
  const http = fakeHttp(okPlivo);
  const adapter = smsAdapter({ suppression: suppressed(SMS_PHONE, 'sms', CO_B), http: http.fn });
  const result = await adapter.send({ companyId: CO_A, to: SMS_PHONE, body: 'Hello' });
  assert.deepEqual(result, { ok: true, externalId: 'SM-1', auditRecorded: false });
  assert.equal(http.calls.length, 1);
});

// ---------- Telegram ----------

const telegramContact = {
  handles: { telegram: TG_CHAT },
  consents: [{ channel: 'telegram', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }],
};

function telegramHttpOk() {
  const calls = [];
  return {
    calls,
    async post(url, body) {
      calls.push({ url, body });
      return { ok: true, result: { message_id: 7 } };
    },
  };
}

test('telegram: a suppressed chat is refused with reason suppressed and nothing is posted', async () => {
  const http = telegramHttpOk();
  const adapter = createTelegramProviderAdapter({
    token: '123456:TG-SECRET',
    http,
    suppression: suppressed(TG_CHAT, 'telegram'),
  });
  await assert.rejects(
    adapter.send({ companyId: CO_A, contact: telegramContact, chatId: TG_CHAT, text: 'Hi', now: NOW }),
    (error) => error instanceof TelegramAdapterRefusedError && error.reason === 'suppressed',
  );
  assert.equal(http.calls.length, 0);
});

test('telegram: a send with no companyId is refused when a suppression list is wired (fails closed)', async () => {
  const http = telegramHttpOk();
  const adapter = createTelegramProviderAdapter({ token: '123456:TG-SECRET', http, suppression: createSuppressionList() });
  await assert.rejects(
    adapter.send({ contact: telegramContact, chatId: TG_CHAT, text: 'Hi', now: NOW }),
    (error) => error instanceof TelegramAdapterRefusedError && error.reason === 'suppressed',
  );
  assert.equal(http.calls.length, 0);
});

test('telegram: an unsuppressed chat with a companyId is sent', async () => {
  const http = telegramHttpOk();
  const adapter = createTelegramProviderAdapter({ token: '123456:TG-SECRET', http, suppression: createSuppressionList() });
  const result = await adapter.send({ companyId: CO_A, contact: telegramContact, chatId: TG_CHAT, text: 'Hi', now: NOW });
  assert.deepEqual(result, { ok: true, messageId: 7, auditRecorded: false });
  assert.equal(http.calls.length, 1);
});

// ---------- WhatsApp ----------

const waContact = {
  handles: { phone: WA_PHONE },
  consents: [{ channel: 'whatsapp', action: 'opt_in', at: NOW - 48 * HOUR, source: 'contact' }],
};

function waAdapter({ suppression, companyId, http }) {
  return createWhatsAppProviderAdapter({
    phoneNumberId: '109876543210987',
    accessToken: 'EAAG-WA-SECRET',
    http: http.fn,
    company: 'Clean Smart',
    ...(companyId !== undefined ? { companyId } : {}),
    ...(suppression ? { suppression } : {}),
  });
}

const waFreeForm = (overrides = {}) => ({
  to: WA_PHONE,
  contact: waContact,
  now: NOW,
  lastInboundAt: NOW - 2 * HOUR,
  text: 'See you Tuesday',
  ...overrides,
});

function waHttpOk() {
  return fakeHttp(async () => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.1' }] }) }));
}

test('whatsapp: a suppressed recipient is refused with reason suppressed and nothing is sent', async () => {
  const http = waHttpOk();
  const adapter = waAdapter({ suppression: suppressed(WA_PHONE, 'whatsapp'), companyId: CO_A, http });
  assert.deepEqual(await adapter.send(waFreeForm()), { ok: false, reason: 'suppressed' });
  assert.equal(http.calls.length, 0);
});

test('whatsapp: a suppressed recipient is refused even when the window is closed', async () => {
  const http = waHttpOk();
  const adapter = waAdapter({ suppression: suppressed(WA_PHONE, 'whatsapp'), companyId: CO_A, http });
  const result = await adapter.send(waFreeForm({ lastInboundAt: null }));
  assert.deepEqual(result, { ok: false, reason: 'suppressed' });
  assert.equal(http.calls.length, 0);
});

test('whatsapp: a send with no companyId is refused when a suppression list is wired (fails closed)', async () => {
  const http = waHttpOk();
  const adapter = waAdapter({ suppression: createSuppressionList(), http });
  assert.deepEqual(await adapter.send(waFreeForm()), { ok: false, reason: 'invalid_company' });
  assert.equal(http.calls.length, 0);
});

test('whatsapp: an unsuppressed recipient inside the window is sent', async () => {
  const http = waHttpOk();
  const adapter = waAdapter({ suppression: createSuppressionList(), companyId: CO_A, http });
  assert.deepEqual(await adapter.send(waFreeForm()), { ok: true, externalId: 'wamid.1', auditRecorded: false });
  assert.equal(http.calls.length, 1);
});

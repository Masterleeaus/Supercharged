// Timed-out send idempotency for Telegram, WhatsApp and Meta (node:test). Every HTTP call is a fake; no network.
// Console output is silenced because these modules are imported directly.
const noop = () => {};
console.log = noop;
console.info = noop;
console.warn = noop;

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTelegramSendRequest,
  sendTelegram,
} from '../../server/modules/comms/telegram-send.ts';
import {
  buildWhatsAppRequest,
  sendWhatsApp,
} from '../../server/modules/comms/whatsapp-send.ts';
import {
  buildMetaMessageRequest,
  sendMeta,
} from '../../server/modules/comms/meta-send.ts';

const TOKEN = 'SECRET-TOKEN-FAKE-000';
const KEY = 'booking-42:reminder-1';
const SHORT_TIMEOUT = 5;

// A provider that never answers. The send must time out and report 'uncertain'.
const hangingTelegramHttp = () => ({ post: () => new Promise(() => {}) });
const okTelegramHttp = (calls) => ({
  post: (url, body) => {
    calls.push({ url, body });
    return { ok: true, result: { message_id: 555 } };
  },
});

const WA_PHONE = '109876543210987';
const WA_TO = '61412345678';
const waRequest = (extra = {}) =>
  buildWhatsAppRequest({
    phoneNumberId: WA_PHONE,
    to: WA_TO,
    decision: { send: 'free_form' },
    text: 'Hello',
    ...extra,
  });
const hangingWaHttp = (calls) => async (url, init) => {
  calls.push({ url, init });
  return new Promise(() => {});
};

const RID = '1234567890';
const metaRequest = (extra = {}) =>
  buildMetaMessageRequest({ channel: 'messenger', recipientId: RID, text: 'Hi', ...extra }).request;
const hangingMetaHttp = (calls) => ({
  post: (url, body, headers) => {
    calls.push({ url, body, headers });
    return new Promise(() => {});
  },
});

// ---------- Telegram ----------

test('telegram: unkeyed timed-out send is uncertain with no key, and never plain provider_error', async () => {
  const calls = [];
  const req = buildTelegramSendRequest({ chatId: 1, text: 'hi' });
  const result = await sendTelegram({ token: TOKEN, request: req, http: hangingTelegramHttp(), timeoutMs: SHORT_TIMEOUT });
  assert.deepEqual(result, { ok: false, reason: 'uncertain' });
  assert.equal('idempotencyKey' in result, false);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(calls.length, 0);
});

test('telegram: an unkeyed uncertain request is not sent a second time', async () => {
  const calls = [];
  const http = { post: (url, body) => { calls.push(body); return new Promise(() => {}); } };
  const req = buildTelegramSendRequest({ chatId: 1, text: 'hi' });
  const first = await sendTelegram({ token: TOKEN, request: req, http, timeoutMs: SHORT_TIMEOUT });
  const second = await sendTelegram({ token: TOKEN, request: req, http: okTelegramHttp(calls), timeoutMs: SHORT_TIMEOUT });
  assert.deepEqual(first, { ok: false, reason: 'uncertain' });
  assert.deepEqual(second, { ok: false, reason: 'uncertain' });
  assert.equal(calls.length, 1, 'the second attempt must not reach the provider');
});

test('telegram: keyed timed-out send returns the same key and may be retried with it', async () => {
  const calls = [];
  const req = buildTelegramSendRequest({ chatId: 1, text: 'hi', idempotencyKey: KEY });
  const first = await sendTelegram({ token: TOKEN, request: req, http: hangingTelegramHttp(), timeoutMs: SHORT_TIMEOUT });
  assert.deepEqual(first, { ok: false, reason: 'uncertain', idempotencyKey: KEY });

  const retry = await sendTelegram({ token: TOKEN, request: req, http: okTelegramHttp(calls), timeoutMs: SHORT_TIMEOUT });
  assert.deepEqual(retry, { ok: true, messageId: 555, idempotencyKey: KEY });
  assert.equal(calls.length, 1);
});

test('telegram: keyed success returns the key; the key is not in the provider body', async () => {
  const calls = [];
  const req = buildTelegramSendRequest({ chatId: 98765, text: 'Hello', idempotencyKey: KEY });
  const result = await sendTelegram({ token: TOKEN, request: req, http: okTelegramHttp(calls) });
  assert.deepEqual(result, { ok: true, messageId: 555, idempotencyKey: KEY });
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(calls[0].body).includes(KEY), false);
});

test('telegram: builder rejects a malformed key and omits the key field when none is given', () => {
  assert.throws(
    () => buildTelegramSendRequest({ chatId: 1, text: 'hi', idempotencyKey: 'has spaces' }),
    (error) => error.reason === 'invalid_idempotency_key',
  );
  assert.throws(
    () => buildTelegramSendRequest({ chatId: 1, text: 'hi', idempotencyKey: 'x'.repeat(129) }),
    (error) => error.reason === 'invalid_idempotency_key',
  );
  assert.equal('idempotencyKey' in buildTelegramSendRequest({ chatId: 1, text: 'hi' }), false);
});

// ---------- WhatsApp ----------

test('whatsapp: unkeyed timed-out send is uncertain and a repeat makes no HTTP call', async () => {
  const calls = [];
  const req = waRequest();
  const first = await sendWhatsApp({ accessToken: TOKEN, request: req, http: hangingWaHttp(calls), timeoutMs: SHORT_TIMEOUT });
  const second = await sendWhatsApp({ accessToken: TOKEN, request: req, http: hangingWaHttp(calls), timeoutMs: SHORT_TIMEOUT });
  assert.deepEqual(first, { ok: false, reason: 'uncertain' });
  assert.deepEqual(second, { ok: false, reason: 'uncertain' });
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(first).includes(TOKEN), false);
});

test('whatsapp: keyed timed-out send returns its key', async () => {
  const calls = [];
  const req = waRequest({ idempotencyKey: KEY });
  assert.equal(req.idempotencyKey, KEY);
  const result = await sendWhatsApp({ accessToken: TOKEN, request: req, http: hangingWaHttp(calls), timeoutMs: SHORT_TIMEOUT });
  assert.deepEqual(result, { ok: false, reason: 'uncertain', idempotencyKey: KEY });
});

test('whatsapp: keyed success returns the key and the key stays out of the body', async () => {
  const req = waRequest({ idempotencyKey: KEY });
  const http = async () => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.K1' }] }) });
  const result = await sendWhatsApp({ accessToken: TOKEN, request: req, http });
  assert.deepEqual(result, { ok: true, externalId: 'wamid.K1', idempotencyKey: KEY });
  assert.equal(JSON.stringify(req.body).includes(KEY), false);
});

test('whatsapp: builder rejects a malformed key', () => {
  assert.deepEqual(waRequest({ idempotencyKey: 'bad/key' }), { ok: false, reason: 'invalid_idempotency_key' });
});

// ---------- Meta ----------

test('meta: unkeyed timed-out send is uncertain and a repeat makes no HTTP call', async () => {
  const calls = [];
  const req = metaRequest();
  const first = await sendMeta({ accessToken: TOKEN, request: req, http: hangingMetaHttp(calls), timeoutMs: SHORT_TIMEOUT });
  const second = await sendMeta({ accessToken: TOKEN, request: req, http: hangingMetaHttp(calls), timeoutMs: SHORT_TIMEOUT });
  assert.deepEqual(first, { ok: false, reason: 'uncertain' });
  assert.deepEqual(second, { ok: false, reason: 'uncertain' });
  assert.equal(calls.length, 1);
});

test('meta: keyed timed-out send returns its key and the key stays out of the body', async () => {
  const calls = [];
  const req = metaRequest({ idempotencyKey: KEY });
  const result = await sendMeta({ accessToken: TOKEN, request: req, http: hangingMetaHttp(calls), timeoutMs: SHORT_TIMEOUT });
  assert.deepEqual(result, { ok: false, reason: 'uncertain', idempotencyKey: KEY });
  assert.equal(JSON.stringify(calls[0].body).includes(KEY), false);
});

test('meta: keyed success returns the key; builder rejects a malformed key', async () => {
  const req = metaRequest({ idempotencyKey: KEY });
  const http = { post: async () => ({ message_id: 'mid.K1' }) };
  assert.deepEqual(await sendMeta({ accessToken: TOKEN, request: req, http }), {
    ok: true,
    messageId: 'mid.K1',
    idempotencyKey: KEY,
  });
  assert.deepEqual(
    buildMetaMessageRequest({ channel: 'messenger', recipientId: RID, text: 'Hi', idempotencyKey: 'a b' }),
    { ok: false, reason: 'invalid_idempotency_key' },
  );
});

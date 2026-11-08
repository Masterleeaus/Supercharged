// Sandbox tests: provider timeout, provider 5xx outage, duplicate send with the same idempotency key,
// and invalid inbound signature, for the SMS transport, Telegram, WhatsApp and Messenger send paths.
// Every provider and HTTP client is a fake. No network, no database, no real keys.
// Run: node --test --experimental-transform-types tests/sandbox/comms-outage.sandbox.test.mjs

// Test files must not write to stdout (it breaks the runner's IPC).
for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = () => {};

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const { createSmsTransport } = await import(
  new URL('../../server/modules/comms/sms-transport.ts', import.meta.url).href
);
const { buildTelegramSendRequest, sendTelegram } = await import(
  new URL('../../server/modules/comms/telegram-send.ts', import.meta.url).href
);
const { verifySecretToken, TELEGRAM_SECRET_HEADER } = await import(
  new URL('../../server/modules/comms/telegram-update.ts', import.meta.url).href
);
const { buildWhatsAppRequest, sendWhatsApp } = await import(
  new URL('../../server/modules/comms/whatsapp-send.ts', import.meta.url).href
);
const { buildMetaMessageRequest, sendMeta } = await import(
  new URL('../../server/modules/comms/meta-send.ts', import.meta.url).href
);
const { verifySignature } = await import(
  new URL('../../server/modules/comms/meta-webhook.ts', import.meta.url).href
);

const COMPANY = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const SMS_TO = '+61400000001';
const SMS_BODY = 'Your booking is confirmed.';
const TG_TOKEN = 'fake-telegram-bot-token-0001';
const TG_SECRET = 'fake-telegram-secret-token-0001';
const WA_TOKEN = 'fake-whatsapp-access-token-0001';
const META_TOKEN = 'fake-meta-page-token-0001';
const META_APP_SECRET = 'fake-meta-app-secret-0001';

const GUARD_MS = 1500; // Outer limit for a test. If a send is still pending after this, the test fails.

// Resolves with the send outcome, or the string 'HUNG' if the send did not settle within GUARD_MS.
async function settleWithin(promise) {
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve('HUNG'), GUARD_MS);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}

// A promise that never settles: the provider or HTTP client that has stopped answering.
const never = () => new Promise(() => {});

// ---- SMS transport (sms-transport.ts) ---------------------------------------

test('sms: provider timeout returns provider_error and no externalId', async () => {
  const transport = createSmsTransport({ provider: { send: never }, timeoutMs: 50 });
  const outcome = await settleWithin(transport.send({ companyId: COMPANY, to: SMS_TO, body: SMS_BODY }));
  assert.notEqual(outcome, 'HUNG');
  assert.deepEqual(outcome, { ok: false, reason: 'provider_error' });
  assert.equal('externalId' in outcome, false);
});

test('sms: provider 5xx outage returns provider_error, no success, and drops the provider text', async () => {
  const provider = {
    send: async () => {
      throw new Error(`HTTP 503 Service Unavailable for number ${SMS_TO}`);
    },
  };
  const transport = createSmsTransport({ provider });
  const outcome = await transport.send({ companyId: COMPANY, to: SMS_TO, body: SMS_BODY });
  assert.deepEqual(outcome, { ok: false, reason: 'provider_error' });
  assert.equal(JSON.stringify(outcome).includes(SMS_TO), false, 'provider text is not echoed');
});

test('sms: duplicate send with the same idempotency key is accepted once by a key-honouring provider', async () => {
  const seen = new Map();
  const provider = {
    send: async ({ idempotencyKey }) => {
      if (seen.has(idempotencyKey)) return { externalId: seen.get(idempotencyKey) };
      const externalId = `SM_fake_${seen.size + 1}`;
      seen.set(idempotencyKey, externalId);
      return { externalId };
    },
  };
  const calls = [];
  const recordingProvider = {
    send: async (request) => {
      calls.push(request.idempotencyKey);
      return provider.send(request);
    },
  };
  const transport = createSmsTransport({ provider: recordingProvider });
  const first = await transport.send({ companyId: COMPANY, to: SMS_TO, body: SMS_BODY });
  const second = await transport.send({ companyId: COMPANY, to: SMS_TO, body: SMS_BODY });
  assert.equal(first.ok && second.ok, true);
  assert.equal(calls[0], calls[1], 'same key on the retry');
  assert.equal(seen.size, 1, 'the provider created one message for two sends');
  assert.equal(first.externalId, second.externalId);
});

// Invalid signature: sms-transport.ts's inbound() does not check a signature. The Plivo
// X-Plivo-Signature-V2 check is in server/engines/plivo/plivo-signature.ts, which loads the database
// module at import time, so it is not exercised here. Not covered in this file.

// ---- Telegram (telegram-send.ts, telegram-update.ts) ------------------------

const tgRequest = () => buildTelegramSendRequest({ chatId: -1001234567890, text: 'Booking confirmed.' });

test('telegram: provider timeout returns uncertain and no messageId', async () => {
  const outcome = await settleWithin(
    sendTelegram({ token: TG_TOKEN, request: tgRequest(), http: { post: never }, timeoutMs: 50 }),
  );
  assert.notEqual(outcome, 'HUNG');
  assert.deepEqual(outcome, { ok: false, reason: 'uncertain' });
});

test('telegram: provider 5xx outage returns provider_error and drops the URL that holds the token', async () => {
  const http = {
    post: async (url) => {
      throw new Error(`Request failed with status code 500 for ${url}`);
    },
  };
  const outcome = await sendTelegram({ token: TG_TOKEN, request: tgRequest(), http });
  assert.deepEqual(outcome, { ok: false, reason: 'provider_error' });
  assert.equal(JSON.stringify(outcome).includes(TG_TOKEN), false);
});

test('telegram: a 5xx response body without ok:true is not recorded as a success', async () => {
  const http = { post: async () => ({ ok: false, error_code: 500, description: 'Internal Server Error' }) };
  const outcome = await sendTelegram({ token: TG_TOKEN, request: tgRequest(), http });
  assert.deepEqual(outcome, { ok: false, reason: 'provider_error' });
});

// Duplicate send: the Telegram Bot API sendMessage call takes no idempotency key, and this module
// does not add one. Not covered: a repeated send makes a second provider call.

test('telegram: invalid webhook secret header is refused, a missing one too', () => {
  assert.deepEqual(verifySecretToken({ header: 'wrong-secret', expected: TG_SECRET }), {
    ok: false,
    reason: 'verification_failed',
  });
  assert.deepEqual(verifySecretToken({ header: undefined, expected: TG_SECRET }), {
    ok: false,
    reason: 'verification_failed',
  });
  assert.deepEqual(verifySecretToken({ header: TG_SECRET, expected: '' }), { ok: false, reason: 'not_configured' });
  assert.equal(TELEGRAM_SECRET_HEADER, 'x-telegram-bot-api-secret-token');
});

// ---- WhatsApp (whatsapp-send.ts, meta-webhook.ts) ---------------------------

const waBuilt = () => {
  const built = buildWhatsAppRequest({
    phoneNumberId: '100200300400500',
    to: '+61400000001',
    decision: { send: 'free_form' },
    text: 'Booking confirmed.',
  });
  assert.equal(built.ok, true);
  return built;
};

test('whatsapp: provider timeout returns uncertain and no externalId', async () => {
  const built = waBuilt();
  const outcome = await settleWithin(
    sendWhatsApp({
      accessToken: WA_TOKEN,
      request: { url: built.url, body: built.body },
      http: never,
      timeoutMs: 50,
    }),
  );
  assert.notEqual(outcome, 'HUNG');
  assert.deepEqual(outcome, { ok: false, reason: 'uncertain' });
});

test('whatsapp: provider 5xx outage returns provider_error, no success recorded', async () => {
  const built = waBuilt();
  const http = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: { message: 'An unknown error occurred' } }),
  });
  const outcome = await sendWhatsApp({
    accessToken: WA_TOKEN,
    request: { url: built.url, body: built.body },
    http,
  });
  assert.deepEqual(outcome, { ok: false, reason: 'provider_error' });
});

test('whatsapp: a 200 response without a message id is not recorded as a success', async () => {
  const built = waBuilt();
  const http = async () => ({ ok: true, status: 200, json: async () => ({ messages: [] }) });
  const outcome = await sendWhatsApp({
    accessToken: WA_TOKEN,
    request: { url: built.url, body: built.body },
    http,
  });
  assert.deepEqual(outcome, { ok: false, reason: 'provider_error' });
});

// Duplicate send: the WhatsApp Cloud API send takes no idempotency key, and this module does not
// add one. Not covered: a repeated send makes a second provider call.

test('whatsapp: invalid inbound signature (X-Hub-Signature-256) is refused', () => {
  const body = Buffer.from('{"object":"whatsapp_business_account"}', 'utf8');
  const wrong = `sha256=${'0'.repeat(64)}`;
  assert.deepEqual(verifySignature({ rawBody: body, signatureHeader: wrong, appSecret: META_APP_SECRET }), {
    ok: false,
    reason: 'signature_mismatch',
  });
  assert.deepEqual(verifySignature({ rawBody: body, signatureHeader: undefined, appSecret: META_APP_SECRET }), {
    ok: false,
    reason: 'missing_signature',
  });
  assert.deepEqual(verifySignature({ rawBody: body, signatureHeader: 'sha1=abc', appSecret: META_APP_SECRET }), {
    ok: false,
    reason: 'malformed_signature',
  });
});

// ---- Messenger (meta-send.ts, meta-webhook.ts) ------------------------------

const metaRequest = () => {
  const built = buildMetaMessageRequest({
    channel: 'messenger',
    recipientId: '1234567890123456',
    text: 'Booking confirmed.',
    purpose: 'transactional',
  });
  assert.equal(built.ok, true);
  return built.request;
};

test('messenger: provider timeout returns uncertain and no messageId', async () => {
  const outcome = await settleWithin(
    sendMeta({ accessToken: META_TOKEN, request: metaRequest(), http: { post: never }, timeoutMs: 50 }),
  );
  assert.notEqual(outcome, 'HUNG');
  assert.deepEqual(outcome, { ok: false, reason: 'uncertain' });
});

test('messenger: provider 5xx outage returns provider_error, no success recorded', async () => {
  const http = {
    post: async () => {
      const error = new Error('Request failed with status code 500');
      error.status = 500;
      throw error;
    },
  };
  const outcome = await sendMeta({ accessToken: META_TOKEN, request: metaRequest(), http });
  assert.deepEqual(outcome, { ok: false, reason: 'provider_error' });
  assert.equal(JSON.stringify(outcome).includes(META_TOKEN), false);
});

test('messenger: an error body without message_id is not recorded as a success', async () => {
  const http = { post: async () => ({ error: { code: 2, message: 'An unknown error occurred' } }) };
  const outcome = await sendMeta({ accessToken: META_TOKEN, request: metaRequest(), http });
  assert.deepEqual(outcome, { ok: false, reason: 'provider_error' });
});

// Duplicate send: the Messenger Send API call takes no idempotency key, and this module does not
// add one. Not covered: a repeated send makes a second provider call.

test('messenger: invalid inbound signature is refused, a wrong secret too', () => {
  const body = Buffer.from('{"object":"page"}', 'utf8');
  const forged = `sha256=${createHmac('sha256', 'attacker-secret').update(body).digest('hex')}`;
  assert.deepEqual(verifySignature({ rawBody: body, signatureHeader: forged, appSecret: META_APP_SECRET }), {
    ok: false,
    reason: 'signature_mismatch',
  });
  assert.deepEqual(verifySignature({ rawBody: body, signatureHeader: forged, appSecret: '' }), {
    ok: false,
    reason: 'not_configured',
  });
});

// Channel webhook signatures are checked over the exact received bytes (req.rawBody / raw.rawBody), never over the
// parsed body. Each test sends a body whose parsed object is identical to the signed body but whose bytes differ
// (extra whitespace), and checks what the verifier does with it.
// Run: NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types tests/modules/chatbot-channels-raw-bytes.test.mjs
// No network and no database. The HTTP test listens on 127.0.0.1 only (ephemeral port).
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import {
  createChannelRegistry,
  createWhatsappProvider,
  createTelegramProvider,
  createMessengerProvider,
  createInstagramProvider,
  createMessengerWebhookRouter,
  createInstagramWebhookRouter,
  computeTwilioSignature,
  computeSignatureHeader,
} from '../../server/modules/chatbot/channels/index.ts';
import { verifyTelegramSecretToken, TELEGRAM_CREDENTIAL_KEYS } from '../../server/modules/chatbot/channels/telegram/index.ts';
import { verifyMessengerSignature, MESSENGER_SIGNATURE_HEADER } from '../../server/modules/chatbot/channels/messenger/index.ts';
import { verifySignedPost } from '../../server/modules/chatbot/channels/instagram/webhook.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const RECEIVED = new Date('2026-11-09T00:00:00Z');

// Fake secrets. Not provider keys.
const PAGE = '1029384756';
const MSG_APP_SECRET = 'msg-raw-app-secret-value-1';
const MSG_VERIFY = 'msg-raw-verify-token-value';
const IG_ID = '17841400000000001';
const IG_APP_SECRET = 'ig-raw-app-secret-value-1';
const WA_ACCOUNT = '+61400000000';
const WA_CUSTOMER = '+61411111111';
const WA_TOKEN = 'wa-raw-auth-token-value-123';
const WA_URL = `https://desk.example.test/api/chatbot/channels/${CO_A}/whatsapp/webhook`;
const TG_BOT = 'bot-raw-1';
const TG_SECRET = 'tg-raw-secret-value-xyz';

const CREDENTIALS = {
  [`${CO_A}|messenger|${PAGE}`]: { access_token: 'EAAFakeRawPageToken1', app_secret: MSG_APP_SECRET, verify_token: MSG_VERIFY },
  [`${CO_A}|instagram|${IG_ID}`]: { instagram_id: IG_ID, access_token: 'IGQVFakeRawToken1', app_secret: IG_APP_SECRET, verify_token: 'ig-raw-verify' },
  [`${CO_A}|whatsapp|${WA_ACCOUNT}`]: { whatsapp_token: WA_TOKEN, webhook_url: WA_URL },
  [`${CO_A}|telegram|${TG_BOT}`]: { telegram_token: '987654:AAFakeRawTelegramToken', webhook_secret: TG_SECRET },
};

const credentialSource = {
  async load(companyId, kind, accountId) {
    return CREDENTIALS[`${companyId}|${kind}|${accountId}`] ?? null;
  },
};

const memoryLedger = () => {
  const keys = new Map();
  return {
    async claim(companyId, accountId, key) {
      const k = `${companyId}|${accountId}|${key}`;
      if (keys.has(k)) return { kind: 'duplicate', done: keys.get(k).done, externalMessageId: null };
      keys.set(k, { done: false });
      return { kind: 'claimed' };
    },
    async complete(companyId, accountId, key) {
      keys.set(`${companyId}|${accountId}|${key}`, { done: true });
    },
    async release(companyId, accountId, key) {
      keys.delete(`${companyId}|${accountId}|${key}`);
    },
  };
};

const MSG_EVENT = JSON.stringify({
  object: 'page',
  entry: [{ id: PAGE, time: 1788825600000, messaging: [{ sender: { id: 'psid-raw-1' }, recipient: { id: PAGE }, timestamp: 1788825600000, message: { mid: 'm_raw_1', text: 'Hi' } }] }],
});

const IG_EVENT = JSON.stringify({
  object: 'instagram',
  entry: [{ id: IG_ID, time: 1, messaging: [{ sender: { id: 'igsid-raw-1' }, recipient: { id: IG_ID }, timestamp: 1, message: { mid: 'ig_raw_1', text: 'Hi' } }] }],
});

/** Same JSON value, different bytes: pretty-printed with indentation and line breaks. */
function prettyVariant(json) {
  return JSON.stringify(JSON.parse(json), null, 2);
}

/** A header value in the form Meta sends: sha256= followed by the hex HMAC of the exact bytes. */
const metaSig = (secret, bytes) => `sha256=${computeSignatureHeader(secret, bytes).slice('sha256='.length)}`;

function raw(bytes, headers = {}) {
  return { headers, rawBody: bytes, receivedAt: RECEIVED };
}

// ---------- pure verifiers: same parsed object, different bytes ----------

test('messenger: the signature covers the exact bytes, so a whitespace-only change fails with the same parsed object', async () => {
  const signed = MSG_EVENT;
  const variant = prettyVariant(signed);
  assert.deepEqual(JSON.parse(variant), JSON.parse(signed), 'precondition: parsed objects are identical');
  assert.notEqual(variant, signed, 'precondition: the bytes differ');

  const header = { [MESSENGER_SIGNATURE_HEADER]: metaSig(MSG_APP_SECRET, signed) };
  const creds = { app_secret: MSG_APP_SECRET };
  assert.deepEqual(verifyMessengerSignature(raw(signed, header), creds), { ok: true });
  assert.deepEqual(verifyMessengerSignature(raw(variant, header), creds), { ok: false, reason: 'signature_invalid' });

  // Through the provider, which is the path the framework calls.
  const provider = createMessengerProvider({ ledger: memoryLedger() });
  const result = await provider.verifyWebhook(CO_A, PAGE, raw(variant, header), CREDENTIALS[`${CO_A}|messenger|${PAGE}`]);
  assert.deepEqual(result, { ok: false, reason: 'signature_invalid' });
});

test('instagram: the signature covers the exact bytes, so a whitespace-only change fails with the same parsed object', async () => {
  const signed = IG_EVENT;
  const variant = prettyVariant(signed);
  assert.deepEqual(JSON.parse(variant), JSON.parse(signed), 'precondition: parsed objects are identical');

  const header = { 'x-hub-signature-256': metaSig(IG_APP_SECRET, signed) };
  assert.deepEqual(verifySignedPost(raw(signed, header), IG_APP_SECRET), { ok: true });
  assert.deepEqual(verifySignedPost(raw(variant, header), IG_APP_SECRET), { ok: false, reason: 'signature_invalid' });

  const provider = createInstagramProvider();
  const creds = CREDENTIALS[`${CO_A}|instagram|${IG_ID}`];
  assert.deepEqual(await provider.verifyWebhook(CO_A, IG_ID, raw(signed, header), creds), { ok: true });
  assert.deepEqual(await provider.verifyWebhook(CO_A, IG_ID, raw(variant, header), creds), { ok: false, reason: 'signature_invalid' });
});

test('whatsapp (Twilio): the signature is over decoded parameter values, so an encoding-only change passes and a changed value fails', async () => {
  const params = {
    MessageSid: 'SM0000000000000000000000000000r01',
    SmsSid: 'SM0000000000000000000000000000r01',
    AccountSid: 'AC00000000000000000000000000000000',
    From: `whatsapp:${WA_CUSTOMER}`,
    To: `whatsapp:${WA_ACCOUNT}`,
    WaId: WA_CUSTOMER.slice(1),
    ProfileName: 'Dana',
    MessageType: 'text',
    Body: 'Are you open Saturday?',
    NumMedia: '0',
  };
  const signed = new URLSearchParams(params).toString();
  // Same decoded values, encoded differently: space as %20 instead of +.
  const encodingVariant = signed.replace('Are+you+open+Saturday%3F', 'Are%20you%20open%20Saturday%3F');
  // Different decoded value: a trailing space added to the message body.
  const valueVariant = new URLSearchParams({ ...params, Body: 'Are you open Saturday? ' }).toString();

  assert.notEqual(encodingVariant, signed, 'precondition: the bytes differ');
  assert.deepEqual(
    [...new URLSearchParams(encodingVariant).entries()],
    [...new URLSearchParams(signed).entries()],
    'precondition: parsed entries are identical',
  );

  const signature = computeTwilioSignature(WA_TOKEN, WA_URL, [...new URLSearchParams(signed).entries()]);
  const header = { 'x-twilio-signature': signature };
  const provider = createWhatsappProvider();
  const creds = CREDENTIALS[`${CO_A}|whatsapp|${WA_ACCOUNT}`];

  assert.deepEqual(await provider.verifyWebhook(CO_A, WA_ACCOUNT, raw(signed, header), creds), { ok: true });
  assert.deepEqual(await provider.verifyWebhook(CO_A, WA_ACCOUNT, raw(encodingVariant, header), creds), { ok: true });
  assert.deepEqual(await provider.verifyWebhook(CO_A, WA_ACCOUNT, raw(valueVariant, header), creds), { ok: false, reason: 'signature_invalid' });
});

test('telegram: the secret-token check reads only the header, so body bytes do not change the result (no body signature exists)', async () => {
  const update = JSON.stringify({ update_id: 1, message: { message_id: 5, date: 1, chat: { id: 4242, type: 'private' }, text: 'Hi' } });
  const variant = prettyVariant(update);
  const headers = { 'x-telegram-bot-api-secret-token': TG_SECRET };

  assert.deepEqual(verifyTelegramSecretToken(raw(update, headers), { [TELEGRAM_CREDENTIAL_KEYS.webhookSecret]: TG_SECRET }), { ok: true });
  assert.deepEqual(verifyTelegramSecretToken(raw(variant, headers), { [TELEGRAM_CREDENTIAL_KEYS.webhookSecret]: TG_SECRET }), { ok: true });

  // A wrong header still fails whatever the bytes are.
  const bad = { 'x-telegram-bot-api-secret-token': 'not-the-secret' };
  assert.deepEqual(verifyTelegramSecretToken(raw(variant, bad), { [TELEGRAM_CREDENTIAL_KEYS.webhookSecret]: TG_SECRET }), { ok: false, reason: 'signature_invalid' });
});

// ---------- HTTP: a global JSON parser ahead of the routers sets req.body to an object ----------

const received = [];
const registry = createChannelRegistry();
registry.register(createMessengerProvider({ ledger: memoryLedger() }));
registry.register(createInstagramProvider());
const deps = {
  registry,
  credentials: credentialSource,
  onReceipt: async (companyId, receipt) => {
    received.push({ companyId, receipt });
  },
};

/** Builds an app with a global JSON parser. captureRaw decides whether that parser keeps the bytes on req.rawBody. */
function buildApp({ captureRaw }) {
  const app = express();
  app.use(
    express.json({
      verify: captureRaw
        ? (req, _res, buf) => {
            req.rawBody = buf;
          }
        : undefined,
    }),
  );
  app.use('/api/chatbot/channels/:companyId/messenger', createMessengerWebhookRouter(deps));
  app.use('/api/chatbot/channels/:companyId/instagram', createInstagramWebhookRouter(deps));
  return app;
}

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function post(base, path, bytes, headers) {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: bytes });
  return res.status;
}

const messengerPath = (co = CO_A) => `/api/chatbot/channels/${co}/messenger/webhook/${PAGE}`;
const instagramPath = (co = CO_A) => `/api/chatbot/channels/${co}/instagram/webhook/${IG_ID}`;

test('http: with a global JSON parser that keeps the bytes, a signed body is accepted and its whitespace variant is refused', async () => {
  received.length = 0;
  await withServer(buildApp({ captureRaw: true }), async (base) => {
    const msgVariant = prettyVariant(MSG_EVENT);
    assert.equal(await post(base, messengerPath(), MSG_EVENT, { 'x-hub-signature-256': metaSig(MSG_APP_SECRET, MSG_EVENT) }), 200);
    assert.equal(await post(base, messengerPath(), msgVariant, { 'x-hub-signature-256': metaSig(MSG_APP_SECRET, MSG_EVENT) }), 403);

    const igVariant = prettyVariant(IG_EVENT);
    assert.equal(await post(base, instagramPath(), IG_EVENT, { 'x-hub-signature-256': metaSig(IG_APP_SECRET, IG_EVENT) }), 200);
    assert.equal(await post(base, instagramPath(), igVariant, { 'x-hub-signature-256': metaSig(IG_APP_SECRET, IG_EVENT) }), 403);
  });
  // Only the two correctly signed bodies reached storage.
  assert.equal(received.length, 2);
});

test('http: a JSON parser that drops the bytes fails closed, even for a correctly signed body', async () => {
  received.length = 0;
  await withServer(buildApp({ captureRaw: false }), async (base) => {
    assert.equal(await post(base, messengerPath(), MSG_EVENT, { 'x-hub-signature-256': metaSig(MSG_APP_SECRET, MSG_EVENT) }), 403);
    assert.equal(await post(base, instagramPath(), IG_EVENT, { 'x-hub-signature-256': metaSig(IG_APP_SECRET, IG_EVENT) }), 403);
  });
  assert.equal(received.length, 0);
});

test('http: a correctly signed body posted to the wrong company is refused, and nothing is stored', async () => {
  received.length = 0;
  await withServer(buildApp({ captureRaw: true }), async (base) => {
    assert.equal(await post(base, messengerPath(CO_B), MSG_EVENT, { 'x-hub-signature-256': metaSig(MSG_APP_SECRET, MSG_EVENT) }), 403);
  });
  assert.equal(received.length, 0);
});

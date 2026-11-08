// Channel inbound routes, challenge hooks, and the outbox (enqueue, drain, retry, idempotency).
// Run: NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types tests/modules/chatbot-channels.test.mjs
// No network. The routes listen on 127.0.0.1 only (ephemeral port) and the providers get a fake HttpClient.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import express from 'express';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  createChannelRegistry,
  createWhatsappProvider,
  createTelegramProvider,
  createMessengerProvider,
  createInstagramProvider,
  createWhatsappWebhookRouter,
  createTelegramWebhookRouter,
  createMessengerWebhookRouter,
  createInstagramWebhookRouter,
  computeTwilioSignature,
  computeSignatureHeader,
  createChannelOutbox,
  createMemoryChannelOutboxStore,
  createDrizzleChannelOutboxStore,
  answerChallenge,
  OUTBOX_DEFAULTS,
  backoffMs,
  TELEGRAM_ACCOUNT_HEADER,
} from '../../server/modules/chatbot/channels/index.ts';

import {
  buildClaimPickQuery,
  buildEnqueueQuery,
  buildExpireQuery,
} from '../../server/modules/chatbot/channels/outbox-drizzle.ts';
import { chatbotChannelOutbox, chatbotChannelAccounts } from '../../server/modules/chatbot/db/channels-core.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-09T00:00:00Z');
const dialect = new PgDialect();

// Fake credentials. Not provider keys.
const WA_ACCOUNT = '+61400000000';
const WA_CUSTOMER = '+61411111111';
const WA_TOKEN = 'wa-auth-token-value-123';
const WA_URL = `https://desk.example.test/api/chatbot/channels/${CO_A}/whatsapp/webhook`;
const TG_BOT = 'bot-1';
const TG_TOKEN = '987654:AAFakeTelegramBotToken_abc';
const TG_SECRET = 'tg-secret-value-xyz';
const PAGE = '1029384756';
const MSG_APP_SECRET = 'msg-app-secret-value-1';
const MSG_VERIFY = 'msg-verify-token-value';
const MSG_TOKEN = 'EAAFakeMessengerPageToken1';
const IG_ID = '17841400000000001';
const IG_APP_SECRET = 'ig-app-secret-value-1';
const IG_VERIFY = 'ig-verify-token-value';

const CREDENTIALS = {
  [`${CO_A}|whatsapp|${WA_ACCOUNT}`]: {
    whatsapp_sid: 'AC00000000000000000000000000000000',
    whatsapp_token: WA_TOKEN,
    whatsapp_phone: WA_ACCOUNT,
    whatsapp_environment: 'production',
    webhook_url: WA_URL,
  },
  [`${CO_A}|telegram|${TG_BOT}`]: { telegram_token: TG_TOKEN, webhook_secret: TG_SECRET },
  [`${CO_A}|messenger|${PAGE}`]: { access_token: MSG_TOKEN, app_secret: MSG_APP_SECRET, verify_token: MSG_VERIFY },
  [`${CO_A}|instagram|${IG_ID}`]: {
    instagram_id: IG_ID,
    access_token: 'IGQVFakeInstagramToken1',
    app_secret: IG_APP_SECRET,
    verify_token: IG_VERIFY,
  },
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
      if (keys.has(k)) return { kind: 'duplicate', done: keys.get(k).done, externalMessageId: keys.get(k).id ?? null };
      keys.set(k, { done: false });
      return { kind: 'claimed' };
    },
    async complete(companyId, accountId, key, id) {
      keys.set(`${companyId}|${accountId}|${key}`, { done: true, id });
    },
    async release(companyId, accountId, key) {
      keys.delete(`${companyId}|${accountId}|${key}`);
    },
  };
};

function buildRegistry() {
  const registry = createChannelRegistry();
  registry.register(createWhatsappProvider());
  registry.register(createTelegramProvider({ ledger: memoryLedger() }));
  registry.register(createMessengerProvider({ ledger: memoryLedger() }));
  registry.register(createInstagramProvider());
  return registry;
}

// ---------- a real express app on loopback, with the four routers mounted at the documented paths ----------

const received = [];
let failReceipt = false;
const flagEnv = { CHATBOT_WHATSAPP_CHANNEL_ENABLED: 'true' };
let currentEnv = flagEnv;

const deps = {
  registry: buildRegistry(),
  credentials: credentialSource,
  onReceipt: async (companyId, receipt) => {
    if (failReceipt) throw new Error('store is down');
    received.push({ companyId, receipt });
  },
};

const app = express();
app.use('/api/chatbot/channels/:companyId/whatsapp', createWhatsappWebhookRouter({ ...deps, get env() { return currentEnv; } }));
app.use('/api/chatbot/channels/:companyId/telegram', createTelegramWebhookRouter(deps));
app.use('/api/chatbot/channels/:companyId/messenger', createMessengerWebhookRouter(deps));
app.use('/api/chatbot/channels/:companyId/instagram', createInstagramWebhookRouter(deps));

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => new Promise((resolve) => server.close(resolve)));

async function post(path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body });
  return { status: res.status, text: await res.text() };
}

async function get(path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, text: await res.text() };
}

// Bodies and signatures.
function waForm(overrides = {}) {
  return new URLSearchParams({
    MessageSid: 'SM0000000000000000000000000000001',
    SmsSid: 'SM0000000000000000000000000000001',
    AccountSid: 'AC00000000000000000000000000000000',
    From: `whatsapp:${WA_CUSTOMER}`,
    To: `whatsapp:${WA_ACCOUNT}`,
    WaId: WA_CUSTOMER.slice(1),
    ProfileName: 'Dana',
    MessageType: 'text',
    Body: 'Are you open Saturday?',
    NumMedia: '0',
    ...overrides,
  }).toString();
}

function waSignature(body, token = WA_TOKEN, url = WA_URL) {
  return computeTwilioSignature(token, url, [...new URLSearchParams(body).entries()]);
}

const TG_UPDATE = JSON.stringify({
  update_id: 1,
  message: { message_id: 5, date: 1788825600, chat: { id: 4242, type: 'private' }, from: { id: 4242, is_bot: false, first_name: 'Dana' }, text: 'Are you open?' },
});

const MSG_EVENT = JSON.stringify({
  object: 'page',
  entry: [{ id: PAGE, time: 1788825600000, messaging: [{ sender: { id: 'psid-1' }, recipient: { id: PAGE }, timestamp: 1788825600000, message: { mid: 'm_1', text: 'Hi' } }] }],
});

const IG_EVENT = JSON.stringify({
  object: 'instagram',
  entry: [{ id: IG_ID, time: 1, messaging: [{ sender: { id: 'igsid-1' }, recipient: { id: IG_ID }, timestamp: 1, message: { mid: 'ig_m_1', text: 'Hi' } }] }],
});

const sig = (secret, body) => `sha256=${computeSignatureHeader(secret, body).slice('sha256='.length)}`;

const path = (co, kind, rest = '/webhook') => `/api/chatbot/channels/${co}/${kind}${rest}`;

function resetReceived() {
  received.length = 0;
  failReceipt = false;
  currentEnv = flagEnv;
}

// ---------- bad signatures are refused on every channel ----------

test('whatsapp: a correctly signed form is accepted and handed to the store once', async () => {
  resetReceived();
  const body = waForm();
  const res = await post(path(CO_A, 'whatsapp'), body, {
    'content-type': 'application/x-www-form-urlencoded',
    'x-twilio-signature': waSignature(body),
  });
  assert.equal(res.status, 200);
  assert.equal(received.length, 1);
  assert.equal(received[0].companyId, CO_A);
  assert.equal(received[0].receipt.accountId, WA_ACCOUNT);
});

test('whatsapp: a wrong signature, a missing signature, and a signature for another URL are refused with 403', async () => {
  resetReceived();
  const body = waForm();
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  const wrong = await post(path(CO_A, 'whatsapp'), body, { ...headers, 'x-twilio-signature': 'bad' });
  const missing = await post(path(CO_A, 'whatsapp'), body, headers);
  const otherUrl = await post(path(CO_A, 'whatsapp'), body, { ...headers, 'x-twilio-signature': waSignature(body, WA_TOKEN, `${WA_URL}?x=1`) });
  const tampered = await post(path(CO_A, 'whatsapp'), waForm({ Body: 'changed' }), { ...headers, 'x-twilio-signature': waSignature(body) });
  for (const res of [wrong, missing, otherUrl, tampered]) assert.equal(res.status, 403);
  assert.equal(received.length, 0);
});

test('whatsapp: the route answers 404 unless CHATBOT_WHATSAPP_CHANNEL_ENABLED is exactly "true"', async () => {
  resetReceived();
  const body = waForm();
  const headers = { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': waSignature(body) };
  for (const env of [{}, { CHATBOT_WHATSAPP_CHANNEL_ENABLED: '1' }, { CHATBOT_WHATSAPP_CHANNEL_ENABLED: 'TRUE' }]) {
    currentEnv = env;
    assert.equal((await post(path(CO_A, 'whatsapp'), body, headers)).status, 404);
  }
  assert.equal(received.length, 0);
  currentEnv = flagEnv;
});

test('telegram: the right secret token is accepted; a wrong, missing, or prefix secret is refused with 403', async () => {
  resetReceived();
  const ok = await post(path(CO_A, 'telegram', `/webhook/${TG_BOT}`), TG_UPDATE, { 'x-telegram-bot-api-secret-token': TG_SECRET });
  assert.equal(ok.status, 200);
  assert.equal(received.length, 1);
  const wrong = await post(path(CO_A, 'telegram', `/webhook/${TG_BOT}`), TG_UPDATE, { 'x-telegram-bot-api-secret-token': 'nope-nope' });
  const prefix = await post(path(CO_A, 'telegram', `/webhook/${TG_BOT}`), TG_UPDATE, { 'x-telegram-bot-api-secret-token': TG_SECRET.slice(0, 5) });
  const missing = await post(path(CO_A, 'telegram', `/webhook/${TG_BOT}`), TG_UPDATE, {});
  for (const res of [wrong, prefix, missing]) assert.equal(res.status, 403);
  assert.equal(received.length, 1);
});

test('telegram: a caller cannot pick another bot by sending the account header; the path wins and that bot secret is checked', async () => {
  resetReceived();
  const spoofed = await post(path(CO_A, 'telegram', '/webhook/bot-2'), TG_UPDATE, {
    'x-telegram-bot-api-secret-token': TG_SECRET,
    [TELEGRAM_ACCOUNT_HEADER]: TG_BOT,
  });
  assert.equal(spoofed.status, 403, 'bot-2 has no credentials, so the request is refused');
  assert.equal(received.length, 0);
});

test('messenger: a correctly signed event is accepted; a tampered body, a wrong signature, or a missing one is refused', async () => {
  resetReceived();
  const headers = { 'content-type': 'application/json' };
  const ok = await post(path(CO_A, 'messenger', `/webhook/${PAGE}`), MSG_EVENT, { ...headers, 'x-hub-signature-256': sig(MSG_APP_SECRET, MSG_EVENT) });
  assert.equal(ok.status, 200);
  assert.equal(received.length, 1);
  const tampered = await post(path(CO_A, 'messenger', `/webhook/${PAGE}`), MSG_EVENT.replace('Hi', 'Yo'), { ...headers, 'x-hub-signature-256': sig(MSG_APP_SECRET, MSG_EVENT) });
  const wrong = await post(path(CO_A, 'messenger', `/webhook/${PAGE}`), MSG_EVENT, { ...headers, 'x-hub-signature-256': sig('other-secret-value', MSG_EVENT) });
  const missing = await post(path(CO_A, 'messenger', `/webhook/${PAGE}`), MSG_EVENT, headers);
  for (const res of [tampered, wrong, missing]) assert.equal(res.status, 403);
  assert.equal(received.length, 1);
});

test('messenger: an event for another page is refused even when its signature is valid for this page', async () => {
  resetReceived();
  const other = MSG_EVENT.replace(PAGE, '999000111');
  const res = await post(path(CO_A, 'messenger', `/webhook/${PAGE}`), other, { 'content-type': 'application/json', 'x-hub-signature-256': sig(MSG_APP_SECRET, other) });
  assert.equal(res.status, 403);
  assert.equal(received.length, 0);
});

test('instagram: a correctly signed event is accepted; a wrong or missing signature is refused with 403', async () => {
  resetReceived();
  const headers = { 'content-type': 'application/json' };
  const ok = await post(path(CO_A, 'instagram', `/webhook/${IG_ID}`), IG_EVENT, { ...headers, 'x-hub-signature-256': sig(IG_APP_SECRET, IG_EVENT) });
  assert.equal(ok.status, 200);
  assert.equal(received.length, 1);
  const wrong = await post(path(CO_A, 'instagram', `/webhook/${IG_ID}`), IG_EVENT, { ...headers, 'x-hub-signature-256': sig('other-secret-value', IG_EVENT) });
  const missing = await post(path(CO_A, 'instagram', `/webhook/${IG_ID}`), IG_EVENT, headers);
  assert.equal(wrong.status, 403);
  assert.equal(missing.status, 403);
  assert.equal(received.length, 1);
});

test('every channel: a company id that is not a UUID answers 404, and a company with no credentials answers 403', async () => {
  resetReceived();
  const bodyWa = waForm();
  const waHeaders = { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': waSignature(bodyWa) };
  assert.equal((await post(path('not-a-uuid', 'whatsapp'), bodyWa, waHeaders)).status, 404);
  assert.equal((await post(path('not-a-uuid', 'telegram', `/webhook/${TG_BOT}`), TG_UPDATE, { 'x-telegram-bot-api-secret-token': TG_SECRET })).status, 404);
  assert.equal((await post(path(CO_B, 'telegram', `/webhook/${TG_BOT}`), TG_UPDATE, { 'x-telegram-bot-api-secret-token': TG_SECRET })).status, 403);
  assert.equal((await post(path(CO_B, 'messenger', `/webhook/${PAGE}`), MSG_EVENT, { 'x-hub-signature-256': sig(MSG_APP_SECRET, MSG_EVENT) })).status, 403);
  assert.equal((await post(path(CO_B, 'instagram', `/webhook/${IG_ID}`), IG_EVENT, { 'x-hub-signature-256': sig(IG_APP_SECRET, IG_EVENT) })).status, 403);
  assert.equal(received.length, 0);
});

test('a store failure after a verified request answers 500 so the platform retries', async () => {
  resetReceived();
  failReceipt = true;
  const res = await post(path(CO_A, 'telegram', `/webhook/${TG_BOT}`), TG_UPDATE, { 'x-telegram-bot-api-secret-token': TG_SECRET });
  assert.equal(res.status, 500);
  resetReceived();
});

// ---------- challenge hooks ----------

test('messenger: the subscription challenge is echoed only for subscribe mode with the right verify token', async () => {
  const ok = await get(path(CO_A, 'messenger', `/webhook/${PAGE}?hub.mode=subscribe&hub.verify_token=${MSG_VERIFY}&hub.challenge=1158201444`));
  assert.equal(ok.status, 200);
  assert.equal(ok.text, '1158201444');
  assert.equal((await get(path(CO_A, 'messenger', `/webhook/${PAGE}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`))).status, 403);
  assert.equal((await get(path(CO_A, 'messenger', `/webhook/${PAGE}?hub.mode=unsubscribe&hub.verify_token=${MSG_VERIFY}&hub.challenge=1`))).status, 403);
  assert.equal((await get(path(CO_A, 'messenger', `/webhook/${PAGE}?hub_verify_token=${MSG_VERIFY}&hub_challenge=1`))).status, 403, 'the underscore keys the old PHP read are not Meta keys');
});

test('instagram: the subscription challenge is echoed only with the account verify token', async () => {
  const ok = await get(path(CO_A, 'instagram', `/webhook/${IG_ID}?hub.mode=subscribe&hub.verify_token=${IG_VERIFY}&hub.challenge=42`));
  assert.equal(ok.status, 200);
  assert.equal(ok.text, '42');
  assert.equal((await get(path(CO_A, 'instagram', `/webhook/${IG_ID}?hub.mode=subscribe&hub.verify_token=${MSG_VERIFY}&hub.challenge=42`))).status, 403);
});

test('answerChallenge: a kind without the hook, an unknown kind, and a missing company all return null', async () => {
  const d = { registry: buildRegistry(), credentials: credentialSource };
  const query = { 'hub.mode': 'subscribe', 'hub.verify_token': TG_SECRET, 'hub.challenge': 'x' };
  assert.equal(await answerChallenge(d, CO_A, 'telegram', TG_BOT, query), null);
  assert.equal(await answerChallenge(d, CO_A, 'sms', TG_BOT, query), null);
  assert.equal(await answerChallenge(d, '', 'messenger', PAGE, { ...query, 'hub.verify_token': MSG_VERIFY }), null);
});

// ---------- outbox ----------

function fakeProvider(kind, script) {
  const calls = [];
  return {
    calls,
    provider: {
      kind,
      capabilities: () => ({ templates: false, attachments: false, deliveryReceipts: false, readReceipts: false, typingIndicator: false, interactiveButtons: false, maxTextLength: null, sessionWindowHours: null }),
      resolveAccount: () => null,
      verifyWebhook: async () => ({ ok: true }),
      parseInbound: () => [],
      send: async (companyId, message) => {
        calls.push({ companyId, key: message.idempotencyKey });
        return script(calls.length);
      },
    },
  };
}

function outboxRig({ script = () => ({ status: 'sent', externalMessageId: 'ext-1' }), maxAttempts } = {}) {
  let now = new Date(NOW);
  const store = createMemoryChannelOutboxStore();
  const outbox = createChannelOutbox({ store, clock: () => now, maxAttempts, baseBackoffMs: 1000, maxBackoffMs: 60_000 });
  const fake = fakeProvider('telegram', script);
  const registry = createChannelRegistry();
  registry.register(fake.provider);
  const sendDeps = { registry, credentials: { async load(companyId) { return companyId === CO_A ? { telegram_token: TG_TOKEN, webhook_secret: TG_SECRET } : null; } }, http: async () => { throw new Error('no network in tests'); } };
  return {
    outbox,
    store,
    calls: fake.calls,
    drain: (companyId = CO_A) => outbox.drain(companyId, sendDeps),
    advance: (ms) => { now = new Date(now.getTime() + ms); },
    now: () => now,
  };
}

const message = (overrides = {}) => ({
  channel: 'telegram',
  accountId: TG_BOT,
  recipient: '4242',
  contentKind: 'text',
  text: 'Yes, open 9 to 2.',
  attachmentUrl: null,
  templateName: null,
  templateParams: null,
  replyToExternalMessageId: null,
  idempotencyKey: 'reply-1',
  ...overrides,
});

test('outbox: a row is sent once, and a second worker run finds nothing to send', async () => {
  const rig = outboxRig();
  await rig.outbox.enqueue(null, CO_A, message());
  const first = await rig.drain();
  const second = await rig.drain();
  assert.equal(first.sent, 1);
  assert.equal(second.claimed, 0);
  assert.equal(rig.calls.length, 1, 'one provider call in total');
  const [row] = rig.store.rowsFor(CO_A);
  assert.equal(row.status, 'sent');
  assert.equal(row.externalMessageId, 'ext-1');
});

test('outbox: two workers that run at the same moment still send once', async () => {
  const rig = outboxRig();
  await rig.outbox.enqueue(null, CO_A, message());
  const [a, b] = await Promise.all([rig.drain(), rig.drain()]);
  assert.equal(a.sent + b.sent, 1);
  assert.equal(rig.calls.length, 1);
});

test('outbox: a retryable failure is retried after backoff, then succeeds; no send happens before the time is due', async () => {
  const rig = outboxRig({
    script: (n) => (n < 3 ? { status: 'failed', errorCode: 'rate_limited', retryable: true, message: 'slow down' } : { status: 'sent', externalMessageId: 'ext-9' }),
  });
  await rig.outbox.enqueue(null, CO_A, message());
  assert.equal((await rig.drain()).retryScheduled, 1);
  assert.equal((await rig.drain()).claimed, 0, 'not due yet');
  rig.advance(backoffMs(1, 1000, 60_000));
  assert.equal((await rig.drain()).retryScheduled, 1);
  rig.advance(backoffMs(2, 1000, 60_000));
  assert.equal((await rig.drain()).sent, 1);
  assert.equal(rig.calls.length, 3);
  assert.equal(rig.store.rowsFor(CO_A)[0].status, 'sent');
  assert.equal((await rig.drain()).claimed, 0);
  assert.equal(rig.calls.length, 3, 'a sent row is never sent again');
});

test('outbox: a retryable failure stops after the attempt limit and is marked failed', async () => {
  const rig = outboxRig({ maxAttempts: 3, script: () => ({ status: 'failed', errorCode: 'timeout_retry', retryable: true, message: 'Channel send timed out' }) });
  await rig.outbox.enqueue(null, CO_A, message());
  for (let i = 0; i < 3; i += 1) {
    await rig.drain();
    rig.advance(10 * 60_000);
  }
  assert.equal(rig.calls.length, 3, 'exactly the limit');
  const [row] = rig.store.rowsFor(CO_A);
  assert.equal(row.status, 'failed');
  assert.equal(row.lastErrorCode, 'timeout_retry');
  assert.equal((await rig.drain()).claimed, 0);
  rig.advance(24 * 60 * 60_000);
  assert.equal((await rig.drain()).claimed, 0);
  assert.equal(rig.calls.length, 3, 'no send after the limit');
});

test('outbox: a non-retryable failure is not retried', async () => {
  const rig = outboxRig({ script: () => ({ status: 'failed', errorCode: 'bad_recipient', retryable: false, message: 'Recipient not found' }) });
  await rig.outbox.enqueue(null, CO_A, message());
  await rig.drain();
  rig.advance(24 * 60 * 60_000);
  await rig.drain();
  assert.equal(rig.calls.length, 1);
  assert.equal(rig.store.rowsFor(CO_A)[0].status, 'failed');
});

test('outbox: enqueue with the same idempotency key writes one row and returns it again', async () => {
  const rig = outboxRig();
  const first = await rig.outbox.enqueue(null, CO_A, message());
  const again = await rig.outbox.enqueue(null, CO_A, message({ text: 'a retried reply with the same key' }));
  assert.equal(again.id, first.id);
  assert.equal(rig.store.rowsFor(CO_A).length, 1);
});

test('outbox: the row is written through the caller transaction handle, so it commits or rolls back with the reply', async () => {
  const seen = [];
  const store = createMemoryChannelOutboxStore();
  const wrapped = { ...store, enqueue: (tx, row) => { seen.push(tx); return store.enqueue(tx, row); } };
  const outbox = createChannelOutbox({ store: wrapped, clock: () => NOW });
  const replyTx = { name: 'the staff reply transaction' };
  await outbox.enqueue(replyTx, CO_A, message({ idempotencyKey: 'tx-1' }));
  assert.equal(seen[0], replyTx);
});

test('outbox: a company never sees or sends another company row', async () => {
  const rig = outboxRig();
  await rig.outbox.enqueue(null, CO_A, message());
  const other = await rig.drain(CO_B);
  assert.equal(other.claimed, 0);
  assert.equal(rig.calls.length, 0);
  assert.equal(rig.store.rowsFor(CO_A)[0].status, 'pending');
});

test('outbox: a lease that expires while sending is marked failed and is never resent', async () => {
  const rig = outboxRig();
  await rig.outbox.enqueue(null, CO_A, message());
  await rig.store.claimDue(CO_A, rig.now(), 1, new Date(rig.now().getTime() + OUTBOX_DEFAULTS.leaseMs));
  rig.advance(OUTBOX_DEFAULTS.leaseMs + 1);
  const summary = await rig.drain();
  assert.equal(summary.expired, 1);
  assert.equal(rig.calls.length, 0);
  const [row] = rig.store.rowsFor(CO_A);
  assert.equal(row.status, 'failed');
  assert.equal(row.lastErrorCode, 'lease_expired');
});

test('outbox: invalid rows are refused at enqueue, before anything is written', async () => {
  const rig = outboxRig();
  await assert.rejects(() => rig.outbox.enqueue(null, '', message()), /Company scope required/);
  await assert.rejects(() => rig.outbox.enqueue(null, CO_A, message({ idempotencyKey: '' })), /idempotency key/);
  await assert.rejects(() => rig.outbox.enqueue(null, CO_A, message({ channel: 'sms' })), /unknown channel/);
  await assert.rejects(() => rig.outbox.enqueue(null, CO_A, message({ recipient: '' })), /recipient/);
  assert.equal(rig.store.rowsFor(CO_A).length, 0);
});

test('outbox: the backoff doubles from the base and stops at the cap', () => {
  assert.equal(backoffMs(1, 1000, 60_000), 1000);
  assert.equal(backoffMs(2, 1000, 60_000), 2000);
  assert.equal(backoffMs(3, 1000, 60_000), 4000);
  assert.equal(backoffMs(20, 1000, 60_000), 60_000);
});

// ---------- Drizzle rendering and table rules (no database connection) ----------

test('drizzle outbox: enqueue, claim and expire queries carry company_id, and claim locks with skip locked', () => {
  const pool = new Pool({ host: '127.0.0.1', port: 1 });
  test.after(() => pool.end());
  const db = drizzle(pool);
  const row = {
    id: '33333333-3333-4333-8333-333333333333',
    companyId: CO_A,
    channel: 'telegram',
    accountId: TG_BOT,
    recipient: '4242',
    contentKind: 'text',
    text: 'hi',
    attachmentUrl: null,
    templateName: null,
    templateParams: null,
    replyToExternalMessageId: null,
    idempotencyKey: 'k-1',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: NOW,
    leaseUntil: null,
    externalMessageId: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: NOW,
    sentAt: null,
  };
  const enqueue = buildEnqueueQuery(db, row).toSQL();
  assert.match(enqueue.sql, /insert into "chatbot_channel_outbox"/i);
  assert.ok(enqueue.params.includes(CO_A));
  const claim = buildClaimPickQuery(db, CO_A, NOW, 10).toSQL();
  assert.match(claim.sql, /for update skip locked/i);
  assert.ok(claim.params.includes(CO_A));
  const expire = buildExpireQuery(db, CO_A, NOW).toSQL();
  assert.match(expire.sql, /"company_id"\s*=\s*\$/);
  assert.ok(expire.params.includes(CO_A));
});

test('drizzle channel tables: every table has company_id, and every unique index includes it', () => {
  for (const table of [chatbotChannelOutbox, chatbotChannelAccounts]) {
    const cfg = getTableConfig(table);
    assert.ok(cfg.columns.some((c) => c.name === 'company_id' && c.notNull), cfg.name);
    for (const idx of cfg.indexes.filter((i) => i.config.unique)) {
      assert.ok(idx.config.columns.map((c) => c.name).includes('company_id'), `${cfg.name}: ${idx.config.name}`);
    }
  }
  assert.equal(typeof createDrizzleChannelOutboxStore, 'function');
});

// ---------- real database: runs only when the local harness cluster is up (see db/harness/README.md) ----------

const harnessUp = await new Promise((resolve) => {
  const socket = net.createConnection({ host: '127.0.0.1', port: 55432 });
  socket.once('connect', () => { socket.end(); resolve(true); });
  socket.once('error', () => resolve(false));
});

test('outbox on the local harness database: enqueue in a transaction, concurrent drains send once, lease expiry is not resent', { skip: harnessUp ? false : 'local harness cluster is not running' }, async () => {
  const dbPool = new Pool({ host: '127.0.0.1', port: 55432, user: 'pgtest', database: 'chatbot_harness' });
  const harnessDb = drizzle(dbPool);
  const store = createDrizzleChannelOutboxStore(harnessDb);
  const outboxDb = createChannelOutbox({ store });
  let sends = 0;
  const registry = createChannelRegistry();
  registry.register({
    ...fakeProvider('telegram', () => ({ status: 'sent', externalMessageId: 'ext' })).provider,
    send: async () => { sends += 1; await new Promise((r) => setTimeout(r, 20)); return { status: 'sent', externalMessageId: `ext-${sends}` }; },
  });
  const harnessDeps = { registry, credentials: { async load(companyId) { return companyId === CO_A ? { telegram_token: TG_TOKEN, webhook_secret: TG_SECRET } : null; } }, http: async () => { throw new Error('no network in tests'); } };
  const key = `harness-${Date.now()}`;
  try {
    await dbPool.query('DELETE FROM chatbot_channel_outbox WHERE company_id IN ($1, $2)', [CO_A, CO_B]);
    const row = await harnessDb.transaction((tx) => outboxDb.enqueue(tx, CO_A, message({ idempotencyKey: key })));
    assert.equal(row.status, 'pending');
    assert.equal((await harnessDb.transaction((tx) => outboxDb.enqueue(tx, CO_A, message({ idempotencyKey: key })))).id, row.id);

    const [x, y] = await Promise.all([outboxDb.drain(CO_A, harnessDeps), outboxDb.drain(CO_A, harnessDeps)]);
    assert.equal(sends, 1);
    assert.equal(x.sent + y.sent, 1);
    assert.equal((await store.findByKey(CO_A, key)).status, 'sent');
    assert.equal((await outboxDb.drain(CO_A, harnessDeps)).claimed, 0);
    assert.equal((await store.findByKey(CO_B, key)), null, 'another company cannot read the row');

    const leaseKey = `${key}-lease`;
    await harnessDb.transaction((tx) => outboxDb.enqueue(tx, CO_A, message({ idempotencyKey: leaseKey })));
    await store.claimDue(CO_A, new Date(), 5, new Date(Date.now() - 1000));
    const before = sends;
    const expired = await outboxDb.drain(CO_A, harnessDeps);
    assert.ok(expired.expired >= 1);
    assert.equal(sends, before, 'an expired lease is not resent');
    assert.equal((await store.findByKey(CO_A, leaseKey)).lastErrorCode, 'lease_expired');
  } finally {
    await dbPool.query('DELETE FROM chatbot_channel_outbox WHERE company_id IN ($1, $2)', [CO_A, CO_B]);
    await dbPool.end();
  }
});

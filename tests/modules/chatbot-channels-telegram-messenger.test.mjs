// Telegram and Messenger channel providers: webhook verification, challenge, parsing, send, ledger, credential sealing.
// Run: NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types tests/modules/chatbot-channels-telegram-messenger.test.mjs
// No network. HttpClient is faked. Drizzle queries are rendered with PgDialect and run against an in-memory fake db.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import {
  createTelegramProvider,
  createTelegramStore,
  generateTelegramWebhookSecret,
  buildSetWebhookRequest,
  TELEGRAM_ACCOUNT_HEADER,
} from '../../server/modules/chatbot/channels/telegram/index.ts';
import {
  createMessengerProvider,
  createMessengerStore,
  answerMessengerChallenge,
  verifyMessengerSignature,
  MESSENGER_SIGNATURE_HEADER,
} from '../../server/modules/chatbot/channels/messenger/index.ts';
import { accountWhere, sendKeyWhere } from '../../server/modules/chatbot/channels/telegram/store.ts';
import { chatbotChannelAccounts, chatbotChannelSendKeys } from '../../server/modules/chatbot/db/channels-core.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const RECEIVED = new Date('2026-11-08T00:00:00Z');

// Fake secrets. Not provider keys. Long enough that a leak would be caught by substring checks.
const TG_TOKEN = '987654:AAFakeTelegramBotTokenValue_xyz';
const TG_SECRET = 'tg-webhook-secret-Abc123_-value';
const MSG_TOKEN = 'EAAFakePageTokenValue0123456789';
const MSG_APP_SECRET = 'messenger-app-secret-value-zz9';
const MSG_VERIFY = 'verify-me-please-42-xyz';
const ALL_SECRETS = [TG_TOKEN, TG_SECRET, MSG_TOKEN, MSG_APP_SECRET, MSG_VERIFY];

const dialect = new PgDialect();

function raw(body, headers = {}) {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  return { headers, rawBody, receivedAt: RECEIVED };
}

function fakeHttp(responder) {
  const calls = [];
  const http = async (req) => {
    calls.push(req);
    return responder(req);
  };
  return { http, calls };
}

const ok = (body, status = 200) => ({ status, headers: {}, body: JSON.stringify(body) });

function memoryLedger() {
  const keys = new Map();
  return {
    keys,
    ledger: {
      async claim(companyId, accountId, key) {
        const id = `${companyId}|${accountId}|${key}`;
        if (!keys.has(id)) {
          keys.set(id, { done: false, externalMessageId: null });
          return { kind: 'claimed' };
        }
        const row = keys.get(id);
        return { kind: 'duplicate', done: row.done, externalMessageId: row.externalMessageId };
      },
      async complete(companyId, accountId, key, externalMessageId) {
        keys.set(`${companyId}|${accountId}|${key}`, { done: true, externalMessageId });
      },
      async release(companyId, accountId, key) {
        keys.delete(`${companyId}|${accountId}|${key}`);
      },
    },
  };
}

function outbound(overrides = {}) {
  return {
    channel: 'telegram',
    accountId: 'bot-1',
    recipient: '4242',
    contentKind: 'text',
    text: 'Hello there',
    attachmentUrl: null,
    templateName: null,
    templateParams: null,
    replyToExternalMessageId: null,
    idempotencyKey: 'msg-1',
    ...overrides,
  };
}

// AES-256-GCM with the company id as associated data, so a ciphertext from one company fails under another.
function makeSecretBox() {
  const key = randomBytes(32);
  return {
    async encrypt(companyId, plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(companyId, 'utf8'));
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return {
        v: 1,
        alg: 'aes-256-gcm',
        keyId: 'v1',
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ct.toString('base64'),
      };
    },
    async decrypt(companyId, sealed) {
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
      d.setAAD(Buffer.from(companyId, 'utf8'));
      d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(sealed.ciphertext, 'base64')), d.final()]).toString('utf8');
    },
  };
}

// In-memory stand-in for the Drizzle db. Rows are keyed by db column names. A select matches a row only when the
// rendered WHERE clause carries that row's company_id, so a query without the right company returns nothing.
function fakeDb() {
  const tables = { chatbot_channel_accounts: [], chatbot_channel_send_keys: [] };
  const snake = (s) => s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
  const nameOf = (t) => getTableConfig(t).name;
  const paramsOf = (w) => dialect.sqlToQuery(w).params;
  const matches = (row, params) =>
    params.includes(row.company_id) &&
    params.includes(row.channel ?? row.kind) &&
    params.includes(row.account_id) &&
    (row.idempotency_key === undefined || params.includes(row.idempotency_key));
  const toRow = (values) => {
    const out = {};
    for (const [k, v] of Object.entries(values)) out[snake(k)] = v;
    return out;
  };
  return {
    tables,
    selectCalls: [],
    select(fields) {
      return {
        from(t) {
          return {
            where(w) {
              const params = paramsOf(w);
              this.lastParams = params;
              return {
                limit: async () => {
                  const rows = tables[nameOf(t)].filter((r) => matches(r, params));
                  return rows.slice(0, 1).map((r) => {
                    const out = {};
                    for (const [alias, col] of Object.entries(fields)) out[alias] = r[col.name];
                    return out;
                  });
                },
              };
            },
          };
        },
      };
    },
    insert(t) {
      return {
        values(values) {
          const row = toRow(values);
          const tableRows = tables[nameOf(t)];
          const findExisting = () =>
            tableRows.find(
              (r) =>
                r.company_id === row.company_id &&
                (r.channel ?? r.kind) === (row.channel ?? row.kind) &&
                r.account_id === row.account_id &&
                (row.idempotency_key === undefined || r.idempotency_key === row.idempotency_key),
            );
          return {
            async onConflictDoUpdate({ set }) {
              const existing = findExisting();
              if (existing) {
                existing.sealed = set.sealed ?? existing.sealed;
              } else {
                tableRows.push({ ...row });
              }
            },
            onConflictDoNothing() {
              return {
                returning: async () => {
                  if (findExisting()) return [];
                  tableRows.push({ ...row, id: `row-${tableRows.length + 1}` });
                  return [{ id: `row-${tableRows.length}` }];
                },
              };
            },
          };
        },
      };
    },
    update(t) {
      return {
        set(values) {
          return {
            where: async (w) => {
              const params = paramsOf(w);
              for (const r of tables[nameOf(t)].filter((x) => matches(x, params))) {
                for (const [k, v] of Object.entries(toRow(values))) r[k] = v;
              }
            },
          };
        },
      };
    },
    delete(t) {
      return {
        where: async (w) => {
          const params = paramsOf(w);
          const table = tables[nameOf(t)];
          for (let i = table.length - 1; i >= 0; i--) {
            if (matches(table[i], params)) table.splice(i, 1);
          }
        },
      };
    },
  };
}

// ---------- Telegram: verification ----------

test('telegram: a request with no configured secret is refused (credentials_missing)', async () => {
  const provider = createTelegramProvider({ ledger: memoryLedger().ledger });
  const r = await provider.verifyWebhook(CO_A, 'bot-1', raw({ update_id: 1 }, { [TELEGRAM_ACCOUNT_HEADER]: 'bot-1' }), {});
  assert.deepEqual(r, { ok: false, reason: 'credentials_missing' });
});

test('telegram: a request with no secret-token header is refused (signature_missing)', async () => {
  const provider = createTelegramProvider({ ledger: memoryLedger().ledger });
  const r = await provider.verifyWebhook(CO_A, 'bot-1', raw({ update_id: 1 }), { webhook_secret: TG_SECRET, telegram_token: TG_TOKEN });
  assert.deepEqual(r, { ok: false, reason: 'signature_missing' });
});

test('telegram: a wrong secret, or a prefix of the right one, is refused (signature_invalid)', async () => {
  const provider = createTelegramProvider({ ledger: memoryLedger().ledger });
  const creds = { webhook_secret: TG_SECRET, telegram_token: TG_TOKEN };
  const wrong = await provider.verifyWebhook(CO_A, 'bot-1', raw({ update_id: 1 }, { 'x-telegram-bot-api-secret-token': 'nope' }), creds);
  assert.deepEqual(wrong, { ok: false, reason: 'signature_invalid' });
  const prefix = await provider.verifyWebhook(
    CO_A,
    'bot-1',
    raw({ update_id: 1 }, { 'x-telegram-bot-api-secret-token': TG_SECRET.slice(0, 10) }),
    creds,
  );
  assert.deepEqual(prefix, { ok: false, reason: 'signature_invalid' });
});

test('telegram: the right secret-token header is accepted', async () => {
  const provider = createTelegramProvider({ ledger: memoryLedger().ledger });
  const r = await provider.verifyWebhook(
    CO_A,
    'bot-1',
    raw({ update_id: 1 }, { 'x-telegram-bot-api-secret-token': TG_SECRET }),
    { webhook_secret: TG_SECRET, telegram_token: TG_TOKEN },
  );
  assert.deepEqual(r, { ok: true });
});

test('telegram: resolveAccount reads the account header and rejects odd characters', () => {
  const provider = createTelegramProvider({ ledger: memoryLedger().ledger });
  assert.equal(provider.resolveAccount(raw({}, { [TELEGRAM_ACCOUNT_HEADER]: 'bot-1' })), 'bot-1');
  assert.equal(provider.resolveAccount(raw({}, { [TELEGRAM_ACCOUNT_HEADER]: '../etc' })), null);
  assert.equal(provider.resolveAccount(raw({}, {})), null);
});

test('telegram: the generated webhook secret uses Telegram\'s allowed characters and length', () => {
  const s = generateTelegramWebhookSecret();
  assert.match(s, /^[A-Za-z0-9_-]{1,256}$/);
  assert.ok(s.length >= 32);
  assert.notEqual(s, generateTelegramWebhookSecret());
});

test('telegram: setWebhook is a JSON POST with the secret, and the token stays out of the query string', () => {
  const req = buildSetWebhookRequest({ telegram_token: TG_TOKEN, webhook_secret: TG_SECRET }, 'https://example.test/hook', 5000);
  assert.equal(req.method, 'POST');
  assert.equal(req.url.includes('?'), false);
  assert.ok(req.url.startsWith('https://api.telegram.org/bot'));
  const body = JSON.parse(req.body);
  assert.equal(body.secret_token, TG_SECRET);
  assert.equal(body.url, 'https://example.test/hook');
  assert.equal(req.timeoutMs, 5000);
  assert.throws(() => buildSetWebhookRequest({ telegram_token: TG_TOKEN }, 'https://example.test/hook', 5000));
});

// ---------- Telegram: parsing ----------

test('telegram: a text update parses to the normalised message shape', () => {
  const provider = createTelegramProvider({ ledger: memoryLedger().ledger });
  const body = {
    update_id: 9001,
    message: {
      message_id: 55,
      date: 1788825600,
      text: 'Do you do gutter cleaning?',
      chat: { id: 4242, first_name: 'Sam', last_name: 'Lee', type: 'private' },
      from: { id: 4242, is_bot: false, first_name: 'Sam', last_name: 'Lee' },
    },
  };
  const [result] = provider.parseInbound(raw(body), 'bot-1');
  assert.equal(result.kind, 'message');
  assert.deepEqual(result.message, {
    channel: 'telegram',
    accountId: 'bot-1',
    externalThreadId: '4242',
    externalMessageId: '4242:55',
    sender: { externalId: '4242', displayName: 'Sam Lee' },
    contentKind: 'text',
    text: 'Do you do gutter cleaning?',
    attachments: [],
    sentAt: new Date(1788825600 * 1000),
  });
});

test('telegram: a photo with a caption is an image with the largest size as its attachment', () => {
  const provider = createTelegramProvider({ ledger: memoryLedger().ledger });
  const body = {
    update_id: 9002,
    message: {
      message_id: 56,
      date: 1788825601,
      caption: 'Broken tile here',
      chat: { id: 7 },
      photo: [
        { file_id: 'small-id', file_size: 100 },
        { file_id: 'large-id', file_size: 900 },
      ],
    },
  };
  const [result] = provider.parseInbound(raw(body), 'bot-1');
  assert.equal(result.message.contentKind, 'image');
  assert.equal(result.message.text, 'Broken tile here');
  assert.deepEqual(result.message.attachments, [{ kind: 'image', externalRef: 'large-id', mimeType: 'image/jpeg', sizeBytes: 900 }]);
  assert.equal(result.message.sender.externalId, '7', 'falls back to chat id when from is absent');
});

test('telegram: bot senders, edited messages, bad JSON and updates with no chat are ignored', () => {
  const provider = createTelegramProvider({ ledger: memoryLedger().ledger });
  const bot = provider.parseInbound(raw({ update_id: 1, message: { message_id: 1, chat: { id: 1 }, from: { id: 2, is_bot: true }, text: 'hi' } }), 'bot-1');
  assert.deepEqual(bot, [{ kind: 'ignored', reason: 'bot_sender' }]);
  const edited = provider.parseInbound(raw({ update_id: 2, edited_message: { message_id: 1, chat: { id: 1 }, text: 'x' } }), 'bot-1');
  assert.deepEqual(edited, [{ kind: 'ignored', reason: 'no_message_in_update' }]);
  assert.deepEqual(provider.parseInbound(raw('{not json'), 'bot-1'), [{ kind: 'ignored', reason: 'invalid_json' }]);
  const noChat = provider.parseInbound(raw({ update_id: 3, message: { message_id: 1, text: 'x' } }), 'bot-1');
  assert.deepEqual(noChat, [{ kind: 'ignored', reason: 'missing_chat_or_message_id' }]);
});

// ---------- Telegram: send ----------

test('telegram: send posts JSON to sendMessage with the token in the path only, and returns the message id', async () => {
  const { ledger } = memoryLedger();
  const provider = createTelegramProvider({ ledger });
  const { http, calls } = fakeHttp(() => ok({ ok: true, result: { message_id: 777 } }));
  const result = await provider.send(CO_A, outbound(), { telegram_token: TG_TOKEN }, http);
  assert.deepEqual(result, { status: 'sent', externalMessageId: '777' });
  assert.equal(calls.length, 1);
  const [req] = calls;
  assert.equal(req.method, 'POST');
  assert.equal(req.url, `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`);
  assert.equal(req.url.includes('?'), false, 'token must not be in a query string');
  assert.ok(Number.isInteger(req.timeoutMs) && req.timeoutMs > 0);
  assert.deepEqual(JSON.parse(req.body), { chat_id: '4242', text: 'Hello there' });
  assert.equal(req.body.includes(TG_TOKEN), false);
});

test('telegram: a reply is sent only when it points at the same chat', async () => {
  const provider = createTelegramProvider({ ledger: memoryLedger().ledger });
  const { http, calls } = fakeHttp(() => ok({ ok: true, result: { message_id: 1 } }));
  await provider.send(CO_A, outbound({ idempotencyKey: 'a', replyToExternalMessageId: '4242:55' }), { telegram_token: TG_TOKEN }, http);
  await provider.send(CO_A, outbound({ idempotencyKey: 'b', replyToExternalMessageId: '9999:55' }), { telegram_token: TG_TOKEN }, http);
  assert.equal(JSON.parse(calls[0].body).reply_to_message_id, 55);
  assert.equal('reply_to_message_id' in JSON.parse(calls[1].body), false);
});

test('telegram: Telegram error responses map to retryable and non-retryable failures without the token', async () => {
  const cases = [
    [429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } }, 'rate_limited', true],
    [500, { ok: false, description: 'Internal error' }, 'provider_unavailable', true],
    [401, { ok: false, description: 'Unauthorized' }, 'auth_failed', false],
    [403, { ok: false, description: 'Forbidden: bot was blocked by the user' }, 'recipient_blocked', false],
    [400, { ok: false, description: 'Bad Request: chat not found' }, 'rejected', false],
  ];
  for (const [status, body, code, retryable] of cases) {
    const provider = createTelegramProvider({ ledger: memoryLedger().ledger });
    const { http } = fakeHttp(() => ok(body, status));
    const r = await provider.send(CO_A, outbound({ idempotencyKey: `k-${status}` }), { telegram_token: TG_TOKEN }, http);
    assert.equal(r.status, 'failed', `status ${status}`);
    assert.equal(r.errorCode, code, `status ${status}`);
    assert.equal(r.retryable, retryable, `status ${status}`);
    assert.equal(JSON.stringify(r).includes(TG_TOKEN), false);
  }
});

test('telegram: a description that echoes the bot token is redacted', async () => {
  const provider = createTelegramProvider({ ledger: memoryLedger().ledger });
  const { http } = fakeHttp(() => ok({ ok: false, description: `bad url https://api.telegram.org/bot${TG_TOKEN}/x` }, 400));
  const r = await provider.send(CO_A, outbound(), { telegram_token: TG_TOKEN }, http);
  assert.equal(r.status, 'failed');
  assert.equal(r.message.includes(TG_TOKEN), false);
});

test('telegram: a transport timeout is retryable and the message names no URL or token', async () => {
  const provider = createTelegramProvider({ ledger: memoryLedger().ledger });
  const { http } = fakeHttp(() => {
    throw { kind: 'timeout', message: `timed out ${TG_TOKEN}` };
  });
  const r = await provider.send(CO_A, outbound(), { telegram_token: TG_TOKEN }, http);
  assert.deepEqual(r, { status: 'failed', errorCode: 'timeout', retryable: true, message: 'Telegram request failed or timed out.' });
});

test('telegram: text over 4096 characters and non-text content fail before any HTTP call', async () => {
  const provider = createTelegramProvider({ ledger: memoryLedger().ledger });
  const { http, calls } = fakeHttp(() => ok({ ok: true, result: { message_id: 1 } }));
  const long = await provider.send(CO_A, outbound({ text: 'x'.repeat(4097) }), { telegram_token: TG_TOKEN }, http);
  assert.equal(long.errorCode, 'text_too_long');
  const media = await provider.send(CO_A, outbound({ contentKind: 'image', text: null, attachmentUrl: 'https://x.test/a.png' }), { telegram_token: TG_TOKEN }, http);
  assert.equal(media.errorCode, 'unsupported_content');
  assert.equal(calls.length, 0);
});

// ---------- Messenger: signature and challenge ----------

function sign(secret, body) {
  return 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

test('messenger: a correctly signed body is accepted', () => {
  const body = JSON.stringify({ object: 'page', entry: [] });
  const r = verifyMessengerSignature(raw(body, { [MESSENGER_SIGNATURE_HEADER]: sign(MSG_APP_SECRET, body) }), { app_secret: MSG_APP_SECRET });
  assert.deepEqual(r, { ok: true });
});

test('messenger: a tampered body, a wrong secret, and a bad header are refused', () => {
  const body = JSON.stringify({ object: 'page', entry: [] });
  const creds = { app_secret: MSG_APP_SECRET };
  const tampered = verifyMessengerSignature(raw(body + ' ', { [MESSENGER_SIGNATURE_HEADER]: sign(MSG_APP_SECRET, body) }), creds);
  assert.deepEqual(tampered, { ok: false, reason: 'signature_invalid' });
  const wrongSecret = verifyMessengerSignature(raw(body, { [MESSENGER_SIGNATURE_HEADER]: sign('other-secret-value-000', body) }), creds);
  assert.deepEqual(wrongSecret, { ok: false, reason: 'signature_invalid' });
  const sha1 = verifyMessengerSignature(raw(body, { [MESSENGER_SIGNATURE_HEADER]: 'sha1=' + 'a'.repeat(40) }), creds);
  assert.deepEqual(sha1, { ok: false, reason: 'signature_invalid' });
  const short = verifyMessengerSignature(raw(body, { [MESSENGER_SIGNATURE_HEADER]: 'sha256=abcd' }), creds);
  assert.deepEqual(short, { ok: false, reason: 'signature_invalid' });
});

test('messenger: a missing header or a missing app secret is refused', () => {
  const body = '{}';
  assert.deepEqual(verifyMessengerSignature(raw(body, {}), { app_secret: MSG_APP_SECRET }), { ok: false, reason: 'signature_missing' });
  assert.deepEqual(verifyMessengerSignature(raw(body, { [MESSENGER_SIGNATURE_HEADER]: sign(MSG_APP_SECRET, body) }), {}), { ok: false, reason: 'credentials_missing' });
});

test('messenger: the subscription challenge is answered only with subscribe mode and the right verify token', () => {
  const creds = { verify_token: MSG_VERIFY };
  const good = answerMessengerChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': MSG_VERIFY, 'hub.challenge': '1158201444' }, creds);
  assert.deepEqual(good, { status: 200, contentType: 'text/plain; charset=utf-8', body: '1158201444' });
  assert.equal(answerMessengerChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' }, creds), null);
  assert.equal(answerMessengerChallenge({ 'hub.mode': 'unsubscribe', 'hub.verify_token': MSG_VERIFY, 'hub.challenge': '1' }, creds), null);
  assert.equal(answerMessengerChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': MSG_VERIFY }, creds), null);
  assert.equal(answerMessengerChallenge({ hub_verify_token: MSG_VERIFY, hub_challenge: '1' }, creds), null, 'underscore keys are not Meta\'s');
  assert.equal(answerMessengerChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': MSG_VERIFY, 'hub.challenge': '1' }, {}), null, 'no configured token');
  assert.equal(answerMessengerChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': MSG_VERIFY, 'hub.challenge': 'x'.repeat(513) }, creds), null);
});

// ---------- Messenger: parsing ----------

const PAGE = '1029384756';

function pageEvent(messaging, id = PAGE) {
  return { object: 'page', entry: [{ id, time: 1788825600000, messaging }] };
}

test('messenger: resolveAccount returns the Page id from the payload', () => {
  const provider = createMessengerProvider({ ledger: memoryLedger().ledger });
  assert.equal(provider.resolveAccount(raw(pageEvent([]))), PAGE);
  assert.equal(provider.resolveAccount(raw('not json')), null);
  assert.equal(provider.resolveAccount(raw({ object: 'page', entry: [{ id: 'abc' }] })), null);
});

test('messenger: a text message parses to the normalised shape', () => {
  const provider = createMessengerProvider({ ledger: memoryLedger().ledger });
  const body = pageEvent([{ sender: { id: 'psid-1' }, recipient: { id: PAGE }, timestamp: 1788825600123, message: { mid: 'm_abc', text: 'Hi, are you open Sunday?' } }]);
  const [result] = provider.parseInbound(raw(body), PAGE);
  assert.equal(result.kind, 'message');
  assert.deepEqual(result.message, {
    channel: 'messenger',
    accountId: PAGE,
    externalThreadId: 'psid-1',
    externalMessageId: 'm_abc',
    sender: { externalId: 'psid-1', displayName: null },
    contentKind: 'text',
    text: 'Hi, are you open Sunday?',
    attachments: [],
    sentAt: new Date(1788825600123),
  });
});

test('messenger: echoes, events for another page, and non-page objects are ignored', () => {
  const provider = createMessengerProvider({ ledger: memoryLedger().ledger });
  const echo = provider.parseInbound(raw(pageEvent([{ sender: { id: 'p' }, message: { mid: 'x', text: 'mine', is_echo: true } }])), PAGE);
  assert.deepEqual(echo, [{ kind: 'ignored', reason: 'echo' }]);
  const other = provider.parseInbound(raw(pageEvent([{ sender: { id: 'p' }, message: { mid: 'y', text: 'hi' } }], '5550001')), PAGE);
  assert.deepEqual(other, [{ kind: 'ignored', reason: 'account_mismatch' }]);
  assert.deepEqual(provider.parseInbound(raw({ object: 'instagram', entry: [] }), PAGE), [{ kind: 'ignored', reason: 'not_a_page_event' }]);
});

test('messenger: image, location and postback events map to their content kinds', () => {
  const provider = createMessengerProvider({ ledger: memoryLedger().ledger });
  const body = pageEvent([
    { sender: { id: 'p1' }, timestamp: 1, message: { mid: 'img-1', attachments: [{ type: 'image', payload: { url: 'https://cdn.test/a.jpg' } }] } },
    { sender: { id: 'p2' }, timestamp: 2, message: { mid: 'loc-1', attachments: [{ type: 'location', payload: { coordinates: { lat: 1, long: 2 } } }] } },
    { sender: { id: 'p3' }, timestamp: 3, postback: { title: 'Get started', payload: 'START' } },
  ]);
  const [img, loc, post] = provider.parseInbound(raw(body), PAGE);
  assert.equal(img.message.contentKind, 'image');
  assert.deepEqual(img.message.attachments, [{ kind: 'image', externalRef: 'https://cdn.test/a.jpg', mimeType: null, sizeBytes: null }]);
  assert.equal(loc.message.contentKind, 'location');
  assert.equal(post.message.contentKind, 'interactive');
  assert.equal(post.message.text, 'Get started');
  assert.equal(post.message.externalMessageId.startsWith('postback:p3:'), true);
});

test('messenger: delivery receipts become one delivered update per message id; read receipts are ignored', () => {
  const provider = createMessengerProvider({ ledger: memoryLedger().ledger });
  const body = pageEvent([
    { sender: { id: 'p1' }, delivery: { mids: ['m_1', 'm_2'], watermark: 1788825600000 } },
    { sender: { id: 'p1' }, read: { watermark: 1788825600000 } },
  ]);
  const results = provider.parseInbound(raw(body), PAGE);
  assert.equal(results.length, 3);
  assert.deepEqual(results[0], {
    kind: 'status',
    update: { channel: 'messenger', accountId: PAGE, externalMessageId: 'm_1', status: 'delivered', reason: null, occurredAt: new Date(1788825600000) },
  });
  assert.equal(results[1].update.externalMessageId, 'm_2');
  assert.deepEqual(results[2], { kind: 'ignored', reason: 'read_watermark_only' });
});

// ---------- Messenger: send ----------

test('messenger: send posts to the Send API with the page token in the Authorization header only', async () => {
  const provider = createMessengerProvider({ ledger: memoryLedger().ledger });
  const { http, calls } = fakeHttp(() => ok({ recipient_id: 'psid-1', message_id: 'm_out_1' }));
  const r = await provider.send(CO_A, outbound({ channel: 'messenger', accountId: PAGE, recipient: 'psid-1', text: 'Yes, Sunday 10 to 2.' }), { access_token: MSG_TOKEN }, http);
  assert.deepEqual(r, { status: 'sent', externalMessageId: 'm_out_1' });
  const [req] = calls;
  assert.equal(req.method, 'POST');
  assert.equal(req.url, 'https://graph.facebook.com/v18.0/me/messages');
  assert.equal(req.headers.authorization, `Bearer ${MSG_TOKEN}`);
  assert.equal(req.url.includes(MSG_TOKEN) || req.body.includes(MSG_TOKEN), false);
  assert.deepEqual(JSON.parse(req.body), {
    recipient: { id: 'psid-1' },
    messaging_type: 'RESPONSE',
    message: { text: 'Yes, Sunday 10 to 2.' },
  });
});

test('messenger: Graph errors map to the right codes and retry flags, with the token redacted', async () => {
  const cases = [
    [400, { error: { code: 10, message: 'Not allowed outside window' } }, 'messaging_not_allowed', false],
    [400, { error: { code: 190, message: `Invalid OAuth access token ${MSG_TOKEN}` } }, 'auth_failed', false],
    [400, { error: { code: 4, message: 'Application request limit reached' } }, 'rate_limited', true],
    [503, { error: { code: 2, message: 'Service temporarily unavailable' } }, 'provider_unavailable', true],
    [400, { error: { code: 100, message: 'Invalid parameter' } }, 'rejected', false],
  ];
  for (const [status, body, code, retryable] of cases) {
    const provider = createMessengerProvider({ ledger: memoryLedger().ledger });
    const { http } = fakeHttp(() => ok(body, status));
    const r = await provider.send(CO_A, outbound({ channel: 'messenger', accountId: PAGE, recipient: 'p', idempotencyKey: `g-${code}` }), { access_token: MSG_TOKEN }, http);
    assert.equal(r.status, 'failed', code);
    assert.equal(r.errorCode, code, code);
    assert.equal(r.retryable, retryable, code);
    assert.equal(JSON.stringify(r).includes(MSG_TOKEN), false, code);
  }
});

test('messenger: attachments send with their URL; templates, empty media and over-long text fail before HTTP', async () => {
  const provider = createMessengerProvider({ ledger: memoryLedger().ledger });
  const { http, calls } = fakeHttp(() => ok({ recipient_id: 'p', message_id: 'm_img' }));
  const creds = { access_token: MSG_TOKEN };
  const img = await provider.send(CO_A, outbound({ channel: 'messenger', accountId: PAGE, recipient: 'p', contentKind: 'image', text: null, attachmentUrl: 'https://cdn.test/a.jpg', idempotencyKey: 'i1' }), creds, http);
  assert.equal(img.status, 'sent');
  assert.deepEqual(JSON.parse(calls[0].body).message, { attachment: { type: 'image', payload: { url: 'https://cdn.test/a.jpg', is_reusable: false } } });
  const noUrl = await provider.send(CO_A, outbound({ channel: 'messenger', accountId: PAGE, recipient: 'p', contentKind: 'file', text: null, idempotencyKey: 'i2' }), creds, http);
  assert.equal(noUrl.errorCode, 'missing_attachment');
  const tpl = await provider.send(CO_A, outbound({ channel: 'messenger', accountId: PAGE, recipient: 'p', contentKind: 'template', text: null, idempotencyKey: 'i3' }), creds, http);
  assert.equal(tpl.errorCode, 'unsupported_content');
  const long = await provider.send(CO_A, outbound({ channel: 'messenger', accountId: PAGE, recipient: 'p', text: 'y'.repeat(2001), idempotencyKey: 'i4' }), creds, http);
  assert.equal(long.errorCode, 'text_too_long');
  assert.equal(calls.length, 1);
});

// ---------- Ledger: no double sends ----------

test('telegram and messenger: a repeated idempotency key does not send twice', async () => {
  for (const kind of ['telegram', 'messenger']) {
    const { ledger } = memoryLedger();
    const provider = kind === 'telegram' ? createTelegramProvider({ ledger }) : createMessengerProvider({ ledger });
    const creds = kind === 'telegram' ? { telegram_token: TG_TOKEN } : { access_token: MSG_TOKEN };
    const { http, calls } = fakeHttp(() => (kind === 'telegram' ? ok({ ok: true, result: { message_id: 10 } }) : ok({ recipient_id: 'p', message_id: 'm10' })));
    const msg = outbound({ channel: kind, accountId: kind === 'telegram' ? 'bot-1' : PAGE, recipient: kind === 'telegram' ? '4242' : 'p', idempotencyKey: 'dup-key' });
    const first = await provider.send(CO_A, msg, creds, http);
    const second = await provider.send(CO_A, msg, creds, http);
    assert.equal(first.status, 'sent');
    assert.equal(second.status, 'sent');
    assert.equal(second.externalMessageId, first.externalMessageId);
    assert.equal(calls.length, 1, `${kind} sent once`);
  }
});

test('telegram: a failed send releases its key so a retry can send, and a claim still pending returns queued', async () => {
  const { ledger, keys } = memoryLedger();
  const provider = createTelegramProvider({ ledger });
  let fail = true;
  const { http, calls } = fakeHttp(() => (fail ? ok({ ok: false, description: 'x' }, 500) : ok({ ok: true, result: { message_id: 3 } })));
  const msg = outbound({ idempotencyKey: 'retry-key' });
  const first = await provider.send(CO_A, msg, { telegram_token: TG_TOKEN }, http);
  assert.equal(first.retryable, true);
  assert.equal(keys.size, 0, 'failed send leaves no claim');
  fail = false;
  const second = await provider.send(CO_A, msg, { telegram_token: TG_TOKEN }, http);
  assert.deepEqual(second, { status: 'sent', externalMessageId: '3' });
  assert.equal(calls.length, 2);
  await ledger.claim(CO_A, 'bot-1', 'pending-key');
  const pending = await provider.send(CO_A, outbound({ idempotencyKey: 'pending-key' }), { telegram_token: TG_TOKEN }, http);
  assert.deepEqual(pending, { status: 'queued', externalMessageId: null });
  assert.equal(calls.length, 2, 'pending claim blocks a second HTTP call');
});

// ---------- Drizzle: company scoping and sealing ----------

test('drizzle: account and send-key queries render with company_id and channel bound as parameters', () => {
  const a = dialect.sqlToQuery(accountWhere(CO_A, 'bot-1'));
  assert.match(a.sql, /"company_id"\s*=\s*\$1/);
  assert.ok(a.params.includes(CO_A));
  assert.ok(a.params.includes('telegram'));
  const k = dialect.sqlToQuery(sendKeyWhere(CO_A, 'bot-1', 'key-1'));
  assert.match(k.sql, /"company_id"/);
  assert.ok(k.params.includes(CO_A) && k.params.includes('key-1'));
});

test('drizzle: every table carries company_id and its unique indexes include it', () => {
  for (const table of [chatbotChannelAccounts, chatbotChannelSendKeys]) {
    const cfg = getTableConfig(table);
    assert.ok(cfg.columns.some((c) => c.name === 'company_id' && c.notNull));
    for (const idx of cfg.indexes.filter((i) => i.config.unique)) {
      const cols = idx.config.columns.map((c) => c.name);
      assert.ok(cols.includes('company_id'), `${cfg.name}: ${idx.config.name}`);
    }
  }
});

test('telegram store: credentials are sealed at rest, load back for the same company only, and never for another channel kind', async () => {
  const box = makeSecretBox();
  const db = fakeDb();
  const store = createTelegramStore(db, box);
  await store.saveCredentials(CO_A, 'bot-1', { telegram_token: TG_TOKEN, webhook_secret: TG_SECRET });

  const stored = db.tables.chatbot_channel_accounts[0];
  assert.equal(JSON.stringify(stored).includes(TG_TOKEN), false, 'no plaintext token in the row');
  assert.equal(JSON.stringify(stored).includes(TG_SECRET), false, 'no plaintext secret in the row');

  const own = await store.credentials.load(CO_A, 'telegram', 'bot-1');
  assert.deepEqual(own, { telegram_token: TG_TOKEN, webhook_secret: TG_SECRET });
  assert.equal(await store.credentials.load(CO_B, 'telegram', 'bot-1'), null, 'another company sees nothing');
  assert.equal(await store.credentials.load(CO_A, 'messenger', 'bot-1'), null, 'another channel kind sees nothing');
});

test('telegram store: a sealed row does not open under another company id', async () => {
  const box = makeSecretBox();
  const sealed = await box.encrypt(CO_A, JSON.stringify({ telegram_token: TG_TOKEN }));
  await assert.rejects(() => box.decrypt(CO_B, sealed));
});

test('messenger store: saving twice upserts one row and the latest credentials win', async () => {
  const box = makeSecretBox();
  const db = fakeDb();
  const store = createMessengerStore(db, box);
  await store.saveCredentials(CO_A, PAGE, { access_token: MSG_TOKEN, app_secret: MSG_APP_SECRET, verify_token: MSG_VERIFY });
  await store.saveCredentials(CO_A, PAGE, { access_token: 'EAAFakeRotatedToken9999', app_secret: MSG_APP_SECRET, verify_token: MSG_VERIFY });
  assert.equal(db.tables.chatbot_channel_accounts.length, 1);
  const creds = await store.credentials.load(CO_A, 'messenger', PAGE);
  assert.equal(creds.access_token, 'EAAFakeRotatedToken9999');
  assert.equal(await store.credentials.load(CO_B, 'messenger', PAGE), null);
});

test('messenger store: the send ledger is company-scoped', async () => {
  const db = fakeDb();
  const store = createMessengerStore(db, makeSecretBox());
  assert.equal((await store.ledger.claim(CO_A, PAGE, 'k')).kind, 'claimed');
  assert.equal((await store.ledger.claim(CO_B, PAGE, 'k')).kind, 'claimed', 'same key in another company is a fresh claim');
  assert.equal((await store.ledger.claim(CO_A, PAGE, 'k')).kind, 'duplicate');
});

// ---------- Cross-cutting: no credential in output ----------

test('no credential value appears in any provider output, error, or stored row', async () => {
  const { ledger } = memoryLedger();
  const tg = createTelegramProvider({ ledger });
  const ms = createMessengerProvider({ ledger });
  const outputs = [];

  outputs.push(await tg.verifyWebhook(CO_A, 'bot-1', raw({ update_id: 1 }), { webhook_secret: TG_SECRET, telegram_token: TG_TOKEN }));
  outputs.push(await ms.verifyWebhook(CO_A, PAGE, raw('{}', { [MESSENGER_SIGNATURE_HEADER]: 'sha256=' + '0'.repeat(64) }), { app_secret: MSG_APP_SECRET, access_token: MSG_TOKEN }));
  outputs.push(answerMessengerChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'bad', 'hub.challenge': '1' }, { verify_token: MSG_VERIFY }));
  outputs.push(tg.parseInbound(raw({ update_id: 2, message: { message_id: 1, chat: { id: 1 }, text: 'hi' } }), 'bot-1'));
  outputs.push(ms.parseInbound(raw(pageEvent([{ sender: { id: 'p' }, message: { mid: 'x', text: 'hi' } }])), PAGE));

  const failing = fakeHttp(() => ({ status: 401, headers: {}, body: JSON.stringify({ ok: false, description: `Unauthorized for ${TG_TOKEN} ${TG_SECRET}` }) }));
  outputs.push(await tg.send(CO_A, outbound({ idempotencyKey: 'leak-1' }), { telegram_token: TG_TOKEN, webhook_secret: TG_SECRET }, failing.http));
  const failingMs = fakeHttp(() => ({ status: 400, headers: {}, body: JSON.stringify({ error: { code: 190, message: `token ${MSG_TOKEN} expired` } }) }));
  outputs.push(await ms.send(CO_A, outbound({ channel: 'messenger', accountId: PAGE, recipient: 'p', idempotencyKey: 'leak-2' }), { access_token: MSG_TOKEN, app_secret: MSG_APP_SECRET }, failingMs.http));
  const thrown = fakeHttp(() => {
    throw { kind: 'network', message: `ECONNRESET ${MSG_TOKEN}` };
  });
  outputs.push(await ms.send(CO_A, outbound({ channel: 'messenger', accountId: PAGE, recipient: 'p', idempotencyKey: 'leak-3' }), { access_token: MSG_TOKEN }, thrown.http));

  const text = JSON.stringify(outputs, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
  for (const secret of ALL_SECRETS) {
    assert.equal(text.includes(secret), false, `output leaked a credential`);
  }
});

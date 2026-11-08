// Telegram webhook route tests. Real Express app on an ephemeral port, no network beyond localhost.
// Run: node --test --experimental-transform-types tests/modules/telegram-webhook-route.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createTelegramWebhookRouter } from '../../server/modules/comms/telegram-webhook-route.ts';

const SECRET = 'tg-webhook-secret-test-0001';
const ALLOWED_CHAT = -1001234;
const PATH = '/webhooks/telegram';

const allowedUpdate = (updateId = 900) => ({
  update_id: updateId,
  message: {
    message_id: 5,
    date: 1767225600,
    chat: { id: ALLOWED_CHAT, type: 'supergroup' },
    from: { id: 42, is_bot: false, first_name: 'Ana' },
    text: 'hello',
  },
});

const otherChatUpdate = (updateId = 901) => ({
  update_id: updateId,
  message: {
    message_id: 6,
    date: 1767225600,
    chat: { id: -100999, type: 'supergroup' },
    from: { id: 42, is_bot: false, first_name: 'Ana' },
    text: 'hello',
  },
});

function passThroughGuard(_req, _res, next) {
  next();
}

async function startServer(deps) {
  const app = express();
  app.use(express.json());
  app.use(createTelegramWebhookRouter({ modeGuard: passThroughGuard, ...deps }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}${PATH}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
}

const withSecret = (secret = SECRET) => ({ 'x-telegram-bot-api-secret-token': secret });

test('a request with a wrong secret is refused and the handler is not called', async () => {
  const calls = [];
  const srv = await startServer({
    secretToken: SECRET,
    allowedChatIds: [ALLOWED_CHAT],
    onMessage: (m) => calls.push(m),
  });
  try {
    const wrong = await post(srv.url, allowedUpdate(), withSecret('tg-webhook-secret-wrong-99'));
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.json, { error: 'unauthorized' });

    const shorter = await post(srv.url, allowedUpdate(), withSecret('short'));
    assert.equal(shorter.status, 401);

    const missing = await post(srv.url, allowedUpdate(), {});
    assert.equal(missing.status, 401);
    assert.deepEqual(missing.json, { error: 'unauthorized' });

    assert.equal(calls.length, 0, 'nothing is handled without the secret');
  } finally {
    await srv.close();
  }
});

test('a correct secret reaches the handler once', async () => {
  const calls = [];
  const srv = await startServer({
    secretToken: SECRET,
    allowedChatIds: [ALLOWED_CHAT],
    onMessage: (m) => calls.push(m),
  });
  try {
    const res = await post(srv.url, allowedUpdate(910), withSecret());
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].chatId, String(ALLOWED_CHAT));
    assert.equal(calls[0].externalId, '910');
  } finally {
    await srv.close();
  }
});

test('an update from a non-allowlisted chat is ignored with no reason in the response', async () => {
  const calls = [];
  const srv = await startServer({
    secretToken: SECRET,
    allowedChatIds: [ALLOWED_CHAT],
    onMessage: (m) => calls.push(m),
  });
  try {
    const other = await post(srv.url, otherChatUpdate(), withSecret());
    assert.equal(other.status, 200);
    assert.deepEqual(other.json, { ok: true });
    assert.equal(calls.length, 0);

    // The body for an ignored update must not reveal why it was ignored.
    const junk = await post(srv.url, { nonsense: true }, withSecret());
    assert.equal(junk.status, 200);
    assert.equal(other.text, junk.text, 'ignored updates share one response body');
    assert.doesNotMatch(other.text, /chat_not_allowed|allow|reason/);
  } finally {
    await srv.close();
  }
});

test('an empty allowlist ignores every chat', async () => {
  const calls = [];
  const srv = await startServer({
    secretToken: SECRET,
    allowedChatIds: [],
    onMessage: (m) => calls.push(m),
  });
  try {
    const res = await post(srv.url, allowedUpdate(920), withSecret());
    assert.equal(res.status, 200);
    assert.equal(calls.length, 0);
  } finally {
    await srv.close();
  }
});

test('a non-array allowlist fails closed and ignores every chat', async () => {
  const calls = [];
  const srv = await startServer({
    secretToken: SECRET,
    allowedChatIds: 'not-an-array',
    onMessage: (m) => calls.push(m),
  });
  try {
    const res = await post(srv.url, allowedUpdate(921), withSecret());
    assert.equal(res.status, 200);
    assert.equal(calls.length, 0);
  } finally {
    await srv.close();
  }
});

test('a repeated update_id is acknowledged but handled only once', async () => {
  const calls = [];
  const srv = await startServer({
    secretToken: SECRET,
    allowedChatIds: [ALLOWED_CHAT],
    onMessage: (m) => calls.push(m),
  });
  try {
    const first = await post(srv.url, allowedUpdate(930), withSecret());
    const again = await post(srv.url, allowedUpdate(930), withSecret());
    assert.equal(first.status, 200);
    assert.equal(again.status, 200);
    assert.deepEqual(again.json, { ok: true });
    assert.equal(calls.length, 1, 'the duplicate is not handled again');
  } finally {
    await srv.close();
  }
});

test('a failed handler returns 500 and the retry of the same update is handled', async () => {
  const calls = [];
  let fail = true;
  const srv = await startServer({
    secretToken: SECRET,
    allowedChatIds: [ALLOWED_CHAT],
    onMessage: (m) => {
      calls.push(m);
      if (fail) throw new Error('downstream down');
    },
  });
  try {
    const failed = await post(srv.url, allowedUpdate(940), withSecret());
    assert.equal(failed.status, 500);
    assert.deepEqual(failed.json, { error: 'internal_error' });
    assert.doesNotMatch(failed.text, /downstream down/, 'handler errors are not echoed');

    fail = false;
    const retry = await post(srv.url, allowedUpdate(940), withSecret());
    assert.equal(retry.status, 200);
    assert.equal(calls.length, 2, 'the retry reaches the handler');
  } finally {
    await srv.close();
  }
});

test('the mode guard runs before the secret check and can refuse the route', async () => {
  const calls = [];
  const denyGuard = (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  };
  const srv = await startServer({
    secretToken: SECRET,
    allowedChatIds: [ALLOWED_CHAT],
    modeGuard: denyGuard,
    onMessage: (m) => calls.push(m),
  });
  try {
    const res = await post(srv.url, allowedUpdate(950), withSecret());
    assert.equal(res.status, 404);
    assert.equal(calls.length, 0);
  } finally {
    await srv.close();
  }
});

test('construction refuses a missing secret, handler or mode guard', () => {
  const onMessage = () => {};
  assert.throws(
    () => createTelegramWebhookRouter({ secretToken: '', allowedChatIds: [], onMessage, modeGuard: passThroughGuard }),
    /secret token is required/,
  );
  assert.throws(
    () => createTelegramWebhookRouter({ secretToken: SECRET, allowedChatIds: [], onMessage: null, modeGuard: passThroughGuard }),
    /onMessage is required/,
  );
  assert.throws(
    () => createTelegramWebhookRouter({ secretToken: SECRET, allowedChatIds: [], onMessage }),
    /modeGuard is required/,
  );
});

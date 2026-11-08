// Sandbox tests: Telegram webhook duplicates, secret-token refusals and update parsing
// (server/modules/comms/telegram-update.ts). The module is pure: no network, no database, no clock.
// Telegram has no outbound call in this module, so the "provider outage" case is covered as an
// unreadable or malformed update, which must be refused, never thrown.
// Run: node --test --experimental-transform-types tests/sandbox/telegram-update.sandbox.test.mjs

// Test files must not write to stdout (it breaks the runner's IPC).
for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = () => {};

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  verifySecretToken,
  parseTelegramUpdate,
  createUpdateDeduplicator,
  identityKey,
  TELEGRAM_SECRET_HEADER,
} = await import(new URL('../../server/modules/comms/telegram-update.ts', import.meta.url).href);

const SECRET = 'fake-telegram-secret-token-0001';
const CHAT = -1001234567890;

const update = (overrides = {}) => ({
  update_id: 90001,
  message: {
    message_id: 55,
    date: 1_767_225_600,
    chat: { id: CHAT, type: 'supergroup' },
    from: { id: 42, is_bot: false, first_name: 'Test' },
    text: 'hello',
    ...overrides,
  },
});

// ---- invalid secret token (the Telegram signature check) ---------------------

test('secret token: the matching header verifies', () => {
  assert.deepEqual(verifySecretToken({ header: SECRET, expected: SECRET }), { ok: true });
  assert.equal(TELEGRAM_SECRET_HEADER, 'x-telegram-bot-api-secret-token');
});

test('secret token invalid: a wrong value, a different length and a missing header are all refused', () => {
  assert.deepEqual(verifySecretToken({ header: 'wrong-value-0001-xxxx-yyyy', expected: SECRET }),
    { ok: false, reason: 'verification_failed' });
  assert.deepEqual(verifySecretToken({ header: 'short', expected: SECRET }),
    { ok: false, reason: 'verification_failed' });
  assert.deepEqual(verifySecretToken({ header: undefined, expected: SECRET }),
    { ok: false, reason: 'verification_failed' });
});

test('secret token invalid: a repeated header (array) is refused, not joined', () => {
  assert.deepEqual(verifySecretToken({ header: [SECRET, SECRET], expected: SECRET }),
    { ok: false, reason: 'verification_failed' });
});

test('secret token outage analogue: no configured secret fails closed with not_configured', () => {
  for (const expected of [undefined, null, '']) {
    assert.deepEqual(verifySecretToken({ header: SECRET, expected }), { ok: false, reason: 'not_configured' });
  }
});

test('secret token: the secret never appears in a refusal result', () => {
  const result = verifySecretToken({ header: 'x', expected: SECRET });
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

// ---- duplicates --------------------------------------------------------------

test('duplicate: the first delivery of an update_id is accepted and every repeat is refused', () => {
  const dedupe = createUpdateDeduplicator();
  assert.equal(dedupe.accept(90001), true);
  assert.equal(dedupe.accept(90001), false);
  assert.equal(dedupe.accept('90001'), false, 'string and number forms of the same id are one key');
  assert.equal(dedupe.accept(90002), true);
});

test('duplicate: a failed handler releases the id, so Telegram redelivery is processed, not dropped', () => {
  const dedupe = createUpdateDeduplicator();
  assert.equal(dedupe.accept(7), true);
  dedupe.release(7); // handler threw or timed out; route answers 500
  assert.equal(dedupe.accept(7), true, 'redelivery after a failure is accepted');
});

test('duplicate: a parsed update keeps the same externalId on every redelivery', () => {
  const a = parseTelegramUpdate(update());
  const b = parseTelegramUpdate(update());
  assert.equal(a.externalId, '90001');
  assert.equal(a.externalId, b.externalId);
});

test('duplicate: the dedupe memory is bounded and the oldest id is evicted first', () => {
  // Documented limit: an id evicted from memory is accepted again if Telegram re-sends it.
  const dedupe = createUpdateDeduplicator(2);
  assert.equal(dedupe.accept(1), true);
  assert.equal(dedupe.accept(2), true);
  assert.equal(dedupe.accept(3), true); // evicts 1
  assert.equal(dedupe.accept(3), false);
  assert.equal(dedupe.accept(1), true, 'evicted id is accepted again (documented)');
});

test('duplicate: bad or missing ids are refused and do not get stored', () => {
  const dedupe = createUpdateDeduplicator();
  assert.equal(dedupe.accept(undefined), false);
  assert.equal(dedupe.accept(null), false);
  assert.equal(dedupe.accept(''), false);
  assert.equal(dedupe.accept(Number.NaN), false);
  assert.throws(() => createUpdateDeduplicator(0), RangeError);
});

// ---- timeout -----------------------------------------------------------------

test('timeout: a handler that stalls past the deadline is released, so the next delivery runs', () => {
  // The route calls release() on failure. A stalled handler that is cut off must follow the same path.
  const dedupe = createUpdateDeduplicator();
  assert.equal(dedupe.accept(501), true, 'first delivery starts processing');
  // ... deadline passes, handler is abandoned, caller releases ...
  dedupe.release(501);
  assert.equal(dedupe.accept(501), true, 'Telegram retry after the timeout is processed');
});

test('timeout: without a release, a redelivery after a stall is refused as a duplicate (caller contract)', () => {
  const dedupe = createUpdateDeduplicator();
  assert.equal(dedupe.accept(502), true);
  assert.equal(dedupe.accept(502), false, 'caller must call release() on timeout, or the update is dropped');
});

// ---- invalid updates ---------------------------------------------------------

test('invalid update: non-object, array and null inputs are ignored as invalid, never thrown', () => {
  for (const input of [null, undefined, 'text', 42, [update()]]) {
    assert.deepEqual(parseTelegramUpdate(input), { ignored: true, reason: 'invalid_update' });
  }
});

test('invalid update: missing chat id, missing update_id or non-numeric date are refused', () => {
  const noChat = update(); delete noChat.message.chat;
  assert.deepEqual(parseTelegramUpdate(noChat), { ignored: true, reason: 'invalid_update' });

  const noId = update(); delete noId.update_id;
  assert.deepEqual(parseTelegramUpdate(noId), { ignored: true, reason: 'invalid_update' });

  const badDate = update({ date: 'yesterday' });
  assert.deepEqual(parseTelegramUpdate(badDate), { ignored: true, reason: 'invalid_update' });
});

test('invalid update: a sender object without an id is refused', () => {
  assert.deepEqual(
    parseTelegramUpdate(update({ from: { first_name: 'no id' } })),
    { ignored: true, reason: 'invalid_update' },
  );
});

test('invalid update: a getter that throws is contained and reported as invalid', () => {
  const hostile = new Proxy({}, { get() { throw new Error('boom: token=SECRET'); } });
  const result = parseTelegramUpdate(hostile);
  assert.deepEqual(result, { ignored: true, reason: 'invalid_update' });
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('invalid update: edited messages and callbacks are unsupported, not parsed as messages', () => {
  const edited = { update_id: 3, edited_message: update().message };
  assert.deepEqual(parseTelegramUpdate(edited), { ignored: true, reason: 'unsupported_update' });
});

// ---- chat allowlist (fail closed) --------------------------------------------

test('allowlist: an empty list ignores every chat (fail closed)', () => {
  assert.deepEqual(
    parseTelegramUpdate(update(), { allowedChatIds: [] }),
    { ignored: true, reason: 'chat_not_allowed' },
  );
});

test('allowlist: a chat not on the list is refused and a listed chat is parsed', () => {
  assert.deepEqual(
    parseTelegramUpdate(update(), { allowedChatIds: ['1'] }),
    { ignored: true, reason: 'chat_not_allowed' },
  );
  const ok = parseTelegramUpdate(update(), { allowedChatIds: [String(CHAT)] });
  assert.equal(ok.channel, 'telegram');
  assert.equal(ok.chatId, String(CHAT));
  assert.equal(ok.receivedAt, 1_767_225_600_000);
  assert.equal(ok.fromId, '42');
});

// ---- identity key ------------------------------------------------------------

test('identity key: combines chat and sender, and is null when either is missing', () => {
  assert.equal(identityKey({ chatId: CHAT, fromId: '42' }), `telegram:${CHAT}:42`);
  assert.equal(identityKey({ chatId: null, fromId: '42' }), null);
  assert.equal(identityKey({ chatId: CHAT, fromId: '' }), null);
});

// Security sandbox test: Meta webhook refusals and Telegram chat allowlist / replay guard.
// Pure functions only: no network, no database, no clock. Run:
//   node --test --experimental-transform-types tests/security/meta-telegram-sandbox.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySubscription, verifySignature } from '../../server/modules/comms/meta-webhook.ts';
import {
  parseTelegramUpdate,
  createUpdateDeduplicator,
} from '../../server/modules/comms/telegram-update.ts';

const APP_SECRET = 'meta-app-secret-sandbox-01';
const VERIFY_TOKEN = 'meta-verify-token-sandbox-01';
const BODY = Buffer.from(JSON.stringify({ object: 'page', entry: [{ id: '1', time: 1 }] }));

const sign = (body, secret) =>
  'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

test('Meta webhook with a bad X-Hub-Signature-256 is refused', () => {
  // Signed with the wrong secret.
  assert.deepEqual(
    verifySignature({ rawBody: BODY, signatureHeader: sign(BODY, 'attacker-secret'), appSecret: APP_SECRET }),
    { ok: false, reason: 'signature_mismatch' },
  );
  // Correct signature over a tampered body.
  const tampered = Buffer.from(BODY.toString().replace('"1"', '"2"'));
  assert.deepEqual(
    verifySignature({ rawBody: tampered, signatureHeader: sign(BODY, APP_SECRET), appSecret: APP_SECRET }),
    { ok: false, reason: 'signature_mismatch' },
  );
  // Missing and malformed headers.
  assert.equal(
    verifySignature({ rawBody: BODY, signatureHeader: undefined, appSecret: APP_SECRET }).ok,
    false,
  );
  assert.deepEqual(
    verifySignature({ rawBody: BODY, signatureHeader: 'sha1=abcd', appSecret: APP_SECRET }),
    { ok: false, reason: 'malformed_signature' },
  );
  // Control: the correct signature is accepted.
  assert.deepEqual(
    verifySignature({ rawBody: BODY, signatureHeader: sign(BODY, APP_SECRET), appSecret: APP_SECRET }),
    { ok: true },
  );
});

test('Meta verification challenge with the wrong token is refused', () => {
  const result = verifySubscription({
    mode: 'subscribe',
    token: 'guessed-token-000000000',
    challenge: '123456',
    expectedToken: VERIFY_TOKEN,
  });
  assert.deepEqual(result, { ok: false, reason: 'verification_failed' });
  assert.equal('challenge' in result, false, 'no challenge must be echoed on refusal');
  // Control: the correct token echoes the challenge.
  assert.deepEqual(
    verifySubscription({ mode: 'subscribe', token: VERIFY_TOKEN, challenge: '123456', expectedToken: VERIFY_TOKEN }),
    { ok: true, challenge: '123456' },
  );
});

const ALLOWED = ['-1001234'];
const messageFrom = (chatId, updateId = 500) => ({
  update_id: updateId,
  message: { message_id: 1, date: 1767225600, chat: { id: chatId, type: 'supergroup' }, from: { id: 42 }, text: 'hi' },
});

test('Telegram update from a non-allowed chat is ignored', () => {
  assert.deepEqual(
    parseTelegramUpdate(messageFrom(-100999, 501), { allowedChatIds: ALLOWED }),
    { ignored: true, reason: 'chat_not_allowed' },
  );
  // Fail closed: an empty allowlist ignores every chat.
  assert.deepEqual(
    parseTelegramUpdate(messageFrom(-1001234, 502), { allowedChatIds: [] }),
    { ignored: true, reason: 'chat_not_allowed' },
  );
  // Control: an allowed chat parses, whether the id is a number or a string.
  assert.equal(parseTelegramUpdate(messageFrom(-1001234, 503), { allowedChatIds: ALLOWED }).channel, 'telegram');
  assert.equal(parseTelegramUpdate(messageFrom(-1001234, 504), { allowedChatIds: [-1001234] }).channel, 'telegram');
});

test('repeated Telegram update id is ignored', () => {
  const dedupe = createUpdateDeduplicator();
  assert.equal(dedupe.accept(900), true, 'first delivery is accepted');
  assert.equal(dedupe.accept(900), false, 'repeat of the same update_id is refused');
  assert.equal(dedupe.accept('900'), false, 'string form of the same id is also a repeat');
  assert.equal(dedupe.accept(901), true, 'a different update_id is accepted');
  assert.equal(dedupe.accept(undefined), false, 'an update with no id is refused');
});

test('update id dedupe memory is bounded and evicts the oldest id first', () => {
  const dedupe = createUpdateDeduplicator(2);
  assert.equal(dedupe.accept(1), true);
  assert.equal(dedupe.accept(2), true);
  assert.equal(dedupe.accept(3), true); // evicts 1
  assert.equal(dedupe.accept(3), false);
  assert.equal(dedupe.accept(2), false);
  assert.equal(dedupe.accept(1), true, 'evicted id is accepted again (documented trade-off)');
  assert.throws(() => createUpdateDeduplicator(0), RangeError);
});

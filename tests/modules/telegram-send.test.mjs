// Telegram outbound send helpers (node:test). No network: http is always injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTelegramSendRequest,
  sendTelegram,
  TELEGRAM_MAX_TEXT_LENGTH,
} from '../../server/modules/comms/telegram-send.ts';

const TOKEN = '123456:SECRET-TOKEN-VALUE';

function refusalOf(fn) {
  try {
    fn();
  } catch (error) {
    return error.reason;
  }
  return null;
}

test('payload shape: method, string chat_id and text, no reply field when omitted', () => {
  const req = buildTelegramSendRequest({ chatId: 98765, text: 'Hello' });
  assert.equal(req.method, 'sendMessage');
  assert.deepEqual(req.body, { chat_id: '98765', text: 'Hello' });
  assert.equal(typeof req.body.chat_id, 'string');
  assert.equal('reply_to_message_id' in req.body, false);
});

test('chat id given as string is kept as string', () => {
  const req = buildTelegramSendRequest({ chatId: '-1001234', text: 'hi' });
  assert.equal(req.body.chat_id, '-1001234');
});

test('text limits: 1 character and 4096 characters are accepted', () => {
  assert.equal(buildTelegramSendRequest({ chatId: 1, text: 'a' }).body.text, 'a');
  const max = 'x'.repeat(TELEGRAM_MAX_TEXT_LENGTH);
  assert.equal(buildTelegramSendRequest({ chatId: 1, text: max }).body.text.length, 4096);
});

test('text limits: 4097 characters is refused as text_too_long', () => {
  const tooLong = 'x'.repeat(TELEGRAM_MAX_TEXT_LENGTH + 1);
  assert.equal(refusalOf(() => buildTelegramSendRequest({ chatId: 1, text: tooLong })), 'text_too_long');
});

test('empty and whitespace-only text is refused as empty_text', () => {
  assert.equal(refusalOf(() => buildTelegramSendRequest({ chatId: 1, text: '' })), 'empty_text');
  assert.equal(refusalOf(() => buildTelegramSendRequest({ chatId: 1, text: '   \n\t ' })), 'empty_text');
});

test('plain text only: parse_mode is never set, even when text contains markup', () => {
  const req = buildTelegramSendRequest({ chatId: 1, text: '<b>bold</b> *star* _under_', replyToMessageId: 7 });
  assert.equal('parse_mode' in req.body, false);
  assert.equal(req.body.text, '<b>bold</b> *star* _under_');
  assert.equal(JSON.stringify(req).includes('parse_mode'), false);
});

test('reply id: positive integer is passed through as reply_to_message_id', () => {
  const req = buildTelegramSendRequest({ chatId: 1, text: 'ok', replyToMessageId: 42 });
  assert.equal(req.body.reply_to_message_id, 42);
});

test('reply id: null and undefined are treated as absent', () => {
  assert.equal('reply_to_message_id' in buildTelegramSendRequest({ chatId: 1, text: 'ok', replyToMessageId: null }).body, false);
  assert.equal('reply_to_message_id' in buildTelegramSendRequest({ chatId: 1, text: 'ok', replyToMessageId: undefined }).body, false);
});

test('reply id: zero, negative, fractional, NaN and string values are refused', () => {
  for (const bad of [0, -3, 1.5, Number.NaN, '12', Number.MAX_SAFE_INTEGER + 2]) {
    assert.equal(
      refusalOf(() => buildTelegramSendRequest({ chatId: 1, text: 'ok', replyToMessageId: bad })),
      'invalid_reply_to_message_id',
      `expected refusal for ${String(bad)}`,
    );
  }
});

test('chat id: empty string and unsafe numbers are refused', () => {
  assert.equal(refusalOf(() => buildTelegramSendRequest({ chatId: '  ', text: 'ok' })), 'invalid_chat_id');
  assert.equal(refusalOf(() => buildTelegramSendRequest({ chatId: 1.5, text: 'ok' })), 'invalid_chat_id');
});

test('sendTelegram: posts to the bot URL with the request body and returns messageId', async () => {
  const calls = [];
  const http = {
    post(url, body) {
      calls.push({ url, body });
      return { ok: true, result: { message_id: 555 } };
    },
  };
  const req = buildTelegramSendRequest({ chatId: 98765, text: 'Hello', replyToMessageId: 9 });
  const result = await sendTelegram({ token: TOKEN, request: req, http });

  assert.deepEqual(result, { ok: true, messageId: 555 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.deepEqual(calls[0].body, { chat_id: '98765', text: 'Hello', reply_to_message_id: 9 });
});

test('sendTelegram: a provider error response becomes provider_error with no token in the output', async () => {
  const http = {
    post() {
      return { ok: false, error_code: 401, description: 'Unauthorized' };
    },
  };
  const req = buildTelegramSendRequest({ chatId: 1, text: 'hi' });
  const result = await sendTelegram({ token: TOKEN, request: req, http });

  assert.deepEqual(result, { ok: false, reason: 'provider_error' });
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(JSON.stringify(result).includes('123456'), false);
});

test('sendTelegram: a transport exception becomes provider_error and does not leak the URL or token', async () => {
  const http = {
    post(url) {
      throw new Error(`connect failed for ${url}`);
    },
  };
  const req = buildTelegramSendRequest({ chatId: 1, text: 'hi' });
  const result = await sendTelegram({ token: TOKEN, request: req, http });

  assert.deepEqual(result, { ok: false, reason: 'provider_error' });
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('sendTelegram: rejected promise and missing message_id both become provider_error', async () => {
  const req = buildTelegramSendRequest({ chatId: 1, text: 'hi' });
  const rejecting = { post: async () => { throw new Error(TOKEN); } };
  const noId = { post: async () => ({ ok: true, result: {} }) };

  const a = await sendTelegram({ token: TOKEN, request: req, http: rejecting });
  const b = await sendTelegram({ token: TOKEN, request: req, http: noId });

  assert.deepEqual(a, { ok: false, reason: 'provider_error' });
  assert.deepEqual(b, { ok: false, reason: 'provider_error' });
  assert.equal(JSON.stringify([a, b]).includes(TOKEN), false);
});

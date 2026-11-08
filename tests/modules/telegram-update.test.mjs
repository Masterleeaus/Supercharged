import test from 'node:test';
import assert from 'node:assert/strict';
import {
  verifySecretToken,
  parseTelegramUpdate,
  identityKey,
} from '../../server/modules/comms/telegram-update.ts';

// Pure tests. No network, no database, no Telegram API.

const baseMessage = {
  message_id: 7,
  date: 1767225600,
  chat: { id: -1001234, type: 'supergroup' },
  from: { id: 42, is_bot: false, first_name: 'Ana' },
};

test('verifySecretToken accepts the matching secret', () => {
  assert.deepEqual(
    verifySecretToken({ header: 's3cret-value', expected: 's3cret-value' }),
    { ok: true },
  );
});

test('verifySecretToken refuses a wrong secret of equal length', () => {
  assert.deepEqual(
    verifySecretToken({ header: 's3cret-valuX', expected: 's3cret-value' }),
    { ok: false, reason: 'verification_failed' },
  );
});

test('verifySecretToken refuses a wrong secret of different length', () => {
  assert.deepEqual(
    verifySecretToken({ header: 'short', expected: 's3cret-value' }),
    { ok: false, reason: 'verification_failed' },
  );
});

test('verifySecretToken refuses a missing header', () => {
  assert.deepEqual(
    verifySecretToken({ header: undefined, expected: 's3cret-value' }),
    { ok: false, reason: 'verification_failed' },
  );
  assert.deepEqual(
    verifySecretToken({ header: '', expected: 's3cret-value' }),
    { ok: false, reason: 'verification_failed' },
  );
});

test('verifySecretToken refuses when no secret is configured', () => {
  assert.deepEqual(
    verifySecretToken({ header: 'anything', expected: undefined }),
    { ok: false, reason: 'not_configured' },
  );
  assert.deepEqual(
    verifySecretToken({ header: 'anything', expected: '' }),
    { ok: false, reason: 'not_configured' },
  );
});

test('verifySecretToken never returns the secret', () => {
  const secret = 'top-secret-token-value';
  const results = [
    verifySecretToken({ header: secret, expected: secret }),
    verifySecretToken({ header: 'nope', expected: secret }),
    verifySecretToken({ header: undefined, expected: secret }),
    verifySecretToken({ header: 'nope', expected: undefined }),
  ];
  for (const result of results) {
    assert.ok(!JSON.stringify(result).includes(secret));
  }
});

test('parseTelegramUpdate parses a text message', () => {
  const parsed = parseTelegramUpdate({
    update_id: 900,
    message: { ...baseMessage, text: 'Hello there' },
  });
  assert.deepEqual(parsed, {
    channel: 'telegram',
    externalId: '900',
    chatId: '-1001234',
    fromId: '42',
    text: 'Hello there',
    mediaType: null,
    receivedAt: 1767225600000,
  });
});

test('parseTelegramUpdate gives mediaType photo with text null', () => {
  const parsed = parseTelegramUpdate({
    update_id: 901,
    message: {
      ...baseMessage,
      photo: [{ file_id: 'a', width: 10, height: 10 }],
    },
  });
  assert.equal(parsed.mediaType, 'photo');
  assert.equal(parsed.text, null);
  assert.equal(parsed.channel, 'telegram');
});

test('parseTelegramUpdate maps video, document, voice and audio', () => {
  const kinds = {
    video: { file_id: 'v' },
    document: { file_id: 'd' },
    voice: { file_id: 'o' },
    audio: { file_id: 'u' },
  };
  for (const [kind, payload] of Object.entries(kinds)) {
    const parsed = parseTelegramUpdate({
      update_id: 902,
      message: { ...baseMessage, [kind]: payload },
    });
    assert.equal(parsed.mediaType, kind);
  }
});

test('parseTelegramUpdate leaves fromId null when from is absent', () => {
  const { from, ...noFrom } = baseMessage;
  const parsed = parseTelegramUpdate({
    update_id: 903,
    message: { ...noFrom, text: 'channel post' },
  });
  assert.equal(parsed.fromId, null);
  assert.equal(parsed.text, 'channel post');
});

test('parseTelegramUpdate ignores edited_message as unsupported', () => {
  const result = parseTelegramUpdate({
    update_id: 904,
    edited_message: { ...baseMessage, text: 'edited' },
  });
  assert.deepEqual(result, { ignored: true, reason: 'unsupported_update' });
});

test('parseTelegramUpdate ignores callback_query as unsupported', () => {
  const result = parseTelegramUpdate({
    update_id: 905,
    callback_query: { id: 'cb', from: { id: 42 } },
  });
  assert.deepEqual(result, { ignored: true, reason: 'unsupported_update' });
});

test('parseTelegramUpdate marks malformed input as invalid and never throws', () => {
  const malformed = [
    null,
    undefined,
    'not an object',
    42,
    [],
    { update_id: 906, message: 'text' },
    { update_id: 906, message: { ...baseMessage, chat: undefined } },
    { update_id: 906, message: { ...baseMessage, chat: { type: 'private' } } },
    { update_id: 906, message: { ...baseMessage, date: 'yesterday' } },
    { update_id: 906, message: { ...baseMessage, from: { first_name: 'no id' } } },
    { message: { ...baseMessage, text: 'no update id' } },
  ];
  for (const input of malformed) {
    assert.deepEqual(parseTelegramUpdate(input), {
      ignored: true,
      reason: 'invalid_update',
    });
  }
});

test('identityKey builds telegram:<chatId>:<fromId>', () => {
  assert.equal(identityKey({ chatId: -1001234, fromId: 42 }), 'telegram:-1001234:42');
  assert.equal(identityKey({ chatId: '555', fromId: '9' }), 'telegram:555:9');
});

test('identityKey refuses a missing chatId', () => {
  assert.equal(identityKey({ chatId: undefined, fromId: 42 }), null);
  assert.equal(identityKey({ chatId: '', fromId: 42 }), null);
  assert.equal(identityKey({ chatId: null, fromId: 42 }), null);
});

test('identityKey refuses a missing fromId', () => {
  assert.equal(identityKey({ chatId: 1, fromId: undefined }), null);
});

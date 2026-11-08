// Telegram provider adapter (node:test). No network: the HTTP client is always a stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTelegramProviderAdapter,
  TelegramAdapterRefusedError,
} from '../../server/modules/comms/telegram-provider-adapter.ts';

const TOKEN = '123456:SECRET-TOKEN-VALUE';
const NOW = '2026-11-03T10:00:00Z';

const consentedContact = {
  handles: { telegram: '98765' },
  consents: [{ channel: 'telegram', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }],
};

const optedOutContact = {
  handles: { telegram: '98765' },
  consents: [
    { channel: 'telegram', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' },
    { channel: 'telegram', action: 'opt_out', at: '2026-02-01T00:00:00Z', source: 'contact' },
  ],
};

// Stub client: records every call. Mode 'ok' returns a Telegram-shaped success.
// Mode 'throw' fails with an error whose message embeds the request URL, which contains the token.
function stubHttp(mode = 'ok') {
  const calls = [];
  return {
    calls,
    async post(url, body) {
      calls.push({ url, body });
      if (mode === 'throw') {
        throw new Error(`socket hang up while calling ${url}`);
      }
      return { ok: true, result: { message_id: 42 } };
    },
  };
}

// Collects every message reachable from an error or result, so the token can be searched for.
function allText(value) {
  return JSON.stringify(value, (_key, v) => (v instanceof Error ? { name: v.name, message: v.message, reason: v.reason, stack: v.stack } : v));
}

test('consented contact: message is sent through the injected client and the id is returned', async () => {
  const http = stubHttp('ok');
  const adapter = createTelegramProviderAdapter({ token: TOKEN, http });
  const result = await adapter.send({ contact: consentedContact, chatId: 98765, text: 'Hello', now: NOW });
  assert.deepEqual(result, { ok: true, messageId: 42, auditRecorded: false });
  assert.equal(http.calls.length, 1);
  assert.deepEqual(http.calls[0].body, { chat_id: '98765', text: 'Hello' });
});

test('opted-out contact is refused before any HTTP call, with reason opted_out', async () => {
  const http = stubHttp('ok');
  const adapter = createTelegramProviderAdapter({ token: TOKEN, http });
  let thrown;
  try {
    await adapter.send({ contact: optedOutContact, chatId: 98765, text: 'Hello', now: NOW });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof TelegramAdapterRefusedError);
  assert.equal(thrown.reason, 'opted_out');
  assert.equal(http.calls.length, 0);
});

test('contact with no telegram handle is refused as invalid_contact', async () => {
  const http = stubHttp('ok');
  const adapter = createTelegramProviderAdapter({ token: TOKEN, http });
  await assert.rejects(
    adapter.send({ contact: { handles: { email: 'a@example.com' }, consents: consentedContact.consents }, chatId: 1, text: 'hi', now: NOW }),
    (error) => error instanceof TelegramAdapterRefusedError && error.reason === 'invalid_contact',
  );
  assert.equal(http.calls.length, 0);
});

test('contact with no consent records is refused as no_consent', async () => {
  const http = stubHttp('ok');
  const adapter = createTelegramProviderAdapter({ token: TOKEN, http });
  await assert.rejects(
    adapter.send({ contact: { handles: { telegram: '98765' }, consents: [] }, chatId: 1, text: 'hi', now: NOW }),
    (error) => error.reason === 'no_consent',
  );
  assert.equal(http.calls.length, 0);
});

test('invalid send input after consent is refused with the telegram-send reason code', async () => {
  const http = stubHttp('ok');
  const adapter = createTelegramProviderAdapter({ token: TOKEN, http });
  await assert.rejects(
    adapter.send({ contact: consentedContact, chatId: 98765, text: '   ', now: NOW }),
    (error) => error instanceof TelegramAdapterRefusedError && error.reason === 'empty_text',
  );
  assert.equal(http.calls.length, 0);
});

test('transport failure returns provider_error and the token is absent from the result', async () => {
  const http = stubHttp('throw');
  const adapter = createTelegramProviderAdapter({ token: TOKEN, http });
  const result = await adapter.send({ contact: consentedContact, chatId: 98765, text: 'Hello', now: NOW });
  assert.deepEqual(result, { ok: false, reason: 'provider_error', auditRecorded: false });
  assert.equal(allText(result).includes(TOKEN), false);
});

test('the token is absent from every thrown refusal message, across all refusal paths', async () => {
  const http = stubHttp('throw');
  const adapter = createTelegramProviderAdapter({ token: TOKEN, http });
  const cases = [
    { contact: optedOutContact, chatId: 98765, text: 'Hello', now: NOW },
    { contact: null, chatId: 98765, text: 'Hello', now: NOW },
    { contact: consentedContact, chatId: 98765, text: '', now: NOW },
    { contact: consentedContact, chatId: 98765, text: 'x'.repeat(4097), now: NOW },
    { contact: consentedContact, chatId: 98765, text: 'Hello', replyToMessageId: -1, now: NOW },
    { contact: consentedContact, chatId: '', text: 'Hello', now: NOW },
  ];
  for (const input of cases) {
    let thrown;
    try {
      await adapter.send(input);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof TelegramAdapterRefusedError, `expected a refusal for ${JSON.stringify(input.text.length)}`);
    assert.equal(thrown.message.includes(TOKEN), false);
    assert.equal(allText(thrown).includes(TOKEN), false);
  }
  assert.equal(http.calls.length, 0);
});

test('an empty or missing token yields provider_error without reaching the client', async () => {
  const http = stubHttp('ok');
  const adapter = createTelegramProviderAdapter({ token: '', http });
  const result = await adapter.send({ contact: consentedContact, chatId: 98765, text: 'Hello', now: NOW });
  assert.deepEqual(result, { ok: false, reason: 'provider_error', auditRecorded: false });
  assert.equal(http.calls.length, 0);
});

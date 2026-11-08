// Messenger provider adapter (node:test). The HTTP client is a stub; no network calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendMessengerReply } from '../../server/modules/comms/messenger-provider-adapter.ts';

const TOKEN = 'EAAG-secret-token-xyz789';
const RID = '1234567890';
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-03T12:00:00Z');

function stubHttp(impl) {
  const calls = [];
  return {
    calls,
    http: {
      async post(url, body, headers) {
        calls.push({ url, body, headers });
        return impl ? impl(url, body, headers) : { message_id: 'm_1' };
      },
    },
  };
}

function contact(consents) {
  return { handles: { messenger: RID }, consents };
}

function run(overrides = {}) {
  const stub = overrides.stub ?? stubHttp();
  const input = {
    accessToken: TOKEN,
    recipientId: RID,
    text: 'Hello',
    contact: contact([]),
    lastInboundAt: NOW - HOUR,
    now: NOW,
    http: stub.http,
    ...overrides,
  };
  delete input.stub;
  return { stub, promise: sendMessengerReply(input) };
}

// ---------- happy path ----------

test('sends a free-form reply inside the 24-hour window', async () => {
  const { stub, promise } = run();
  const result = await promise;
  assert.deepEqual(result, { ok: true, messageId: 'm_1', auditRecorded: false });
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].url, 'https://graph.facebook.com/v20.0/me/messages');
  assert.deepEqual(stub.calls[0].body, {
    recipient: { id: RID },
    messaging_type: 'RESPONSE',
    message: { text: 'Hello' },
  });
  assert.equal(stub.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
});

test('contact with no consent records is allowed (messaged the page, no opt-in record)', async () => {
  const { stub, promise } = run({ contact: contact([]) });
  assert.equal((await promise).ok, true);
  assert.equal(stub.calls.length, 1);
});

test('a contact opt-in newer than the opt-out does not reinstate Messenger (decision 47: only SMS START does)', async () => {
  const { stub, promise } = run({
    contact: contact([
      { channel: 'messenger', action: 'opt_out', at: NOW - 3 * HOUR, source: 'contact' },
      { channel: 'messenger', action: 'opt_in', at: NOW - 2 * HOUR, source: 'contact' },
    ]),
  });
  assert.equal((await promise).ok, false);
  assert.equal(stub.calls.length, 0);
});

// ---------- opt-out ----------

test('an opted-out contact is refused and nothing is sent', async () => {
  const { stub, promise } = run({
    contact: contact([{ channel: 'messenger', action: 'opt_out', at: NOW - HOUR, source: 'contact' }]),
  });
  assert.deepEqual(await promise, { ok: false, reason: 'opted_out' });
  assert.equal(stub.calls.length, 0);
});

test('an all-channel opt-out refuses Messenger', async () => {
  const { stub, promise } = run({
    contact: contact([{ channel: 'all', action: 'opt_out', at: NOW - HOUR, source: 'staff' }]),
  });
  assert.deepEqual(await promise, { ok: false, reason: 'opted_out' });
  assert.equal(stub.calls.length, 0);
});

test('a staff-recorded opt-in does not reinstate an opted-out contact', async () => {
  const { stub, promise } = run({
    contact: contact([
      { channel: 'messenger', action: 'opt_out', at: NOW - 3 * HOUR, source: 'contact' },
      { channel: 'messenger', action: 'opt_in', at: NOW - 2 * HOUR, source: 'staff' },
    ]),
  });
  assert.deepEqual(await promise, { ok: false, reason: 'opted_out' });
  assert.equal(stub.calls.length, 0);
});

test('a missing contact fails closed', async () => {
  for (const c of [null, undefined]) {
    const { stub, promise } = run({ contact: c });
    assert.deepEqual(await promise, { ok: false, reason: 'contact_invalid' });
    assert.equal(stub.calls.length, 0);
  }
});

test('a malformed consent record fails closed', async () => {
  const { stub, promise } = run({
    contact: contact([{ channel: 'carrier-pigeon', action: 'opt_in', at: NOW, source: 'contact' }]),
  });
  assert.deepEqual(await promise, { ok: false, reason: 'contact_invalid' });
  assert.equal(stub.calls.length, 0);
});

// ---------- 24-hour window ----------

test('a message exactly 24 hours old is outside the window and refused (no template fallback)', async () => {
  const { stub, promise } = run({ lastInboundAt: NOW - 24 * HOUR });
  assert.deepEqual(await promise, { ok: false, reason: 'window_closed' });
  assert.equal(stub.calls.length, 0);
});

test('a message just under 24 hours old is inside the window', async () => {
  const { stub, promise } = run({ lastInboundAt: NOW - 24 * HOUR + 1000 });
  assert.equal((await promise).ok, true);
  assert.equal(stub.calls.length, 1);
});

test('accepts Date objects for lastInboundAt and now', async () => {
  const { stub, promise } = run({
    lastInboundAt: new Date(NOW - 25 * HOUR),
    now: new Date(NOW),
  });
  assert.deepEqual(await promise, { ok: false, reason: 'window_closed' });
  assert.equal(stub.calls.length, 0);
});

test('no inbound message on record is refused', async () => {
  for (const lastInboundAt of [null, undefined]) {
    const { stub, promise } = run({ lastInboundAt });
    assert.deepEqual(await promise, { ok: false, reason: 'no_inbound' });
    assert.equal(stub.calls.length, 0);
  }
});

test('an inbound timestamp in the future is refused as clock skew', async () => {
  const { stub, promise } = run({ lastInboundAt: NOW + HOUR });
  assert.deepEqual(await promise, { ok: false, reason: 'clock_skew' });
  assert.equal(stub.calls.length, 0);
});

test('an invalid now is refused without sending', async () => {
  const { stub, promise } = run({ now: Number.NaN });
  assert.deepEqual(await promise, { ok: false, reason: 'invalid_time' });
  assert.equal(stub.calls.length, 0);
});

// ---------- request validation ----------

test('invalid recipients, empty text and overlong text are refused before any gate or send', async () => {
  const cases = [
    [{ recipientId: '12 34' }, 'invalid_recipient'],
    [{ recipientId: 1234567890 }, 'invalid_recipient'],
    [{ text: '   ' }, 'empty_text'],
    [{ text: 'x'.repeat(1001) }, 'text_too_long'],
  ];
  for (const [override, reason] of cases) {
    const { stub, promise } = run(override);
    assert.deepEqual(await promise, { ok: false, reason });
    assert.equal(stub.calls.length, 0);
  }
});

test('an empty access token is a provider error and nothing is posted', async () => {
  const { stub, promise } = run({ accessToken: '' });
  assert.deepEqual(await promise, { ok: false, reason: 'provider_error', auditRecorded: false });
  assert.equal(stub.calls.length, 0);
});

// ---------- provider failures and token secrecy ----------

test('a thrown transport error is a provider error and never exposes the token', async () => {
  const stub = stubHttp(() => {
    throw new Error(`request failed with Authorization Bearer ${TOKEN}`);
  });
  const result = await run({ stub }).promise;
  assert.deepEqual(result, { ok: false, reason: 'provider_error', auditRecorded: false });
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('a response without a message_id is a provider error', async () => {
  for (const response of [{}, null, undefined, { message_id: 42 }]) {
    const stub = stubHttp(() => response);
    assert.deepEqual(await run({ stub }).promise, { ok: false, reason: 'provider_error', auditRecorded: false });
  }
});

test('the token never appears in any result, across refusals and successes', async () => {
  const outcomes = [
    await run().promise,
    await run({ lastInboundAt: null }).promise,
    await run({ recipientId: 'bad id' }).promise,
    await run({ stub: stubHttp(() => { throw new Error(TOKEN); }) }).promise,
  ];
  for (const outcome of outcomes) {
    assert.equal(JSON.stringify(outcome).includes(TOKEN), false);
  }
});

// ---------- purpose: marketing needs an opt-in, transactional does not ----------

test('a marketing reply to a contact with no consent record is refused and nothing is posted', async () => {
  const { stub, promise } = run({ purpose: 'marketing', contact: contact([]) });
  assert.deepEqual(await promise, { ok: false, reason: 'opt_in_required' });
  assert.equal(stub.calls.length, 0);
});

test('a marketing reply is refused when the contact has only a non-Messenger opt-in', async () => {
  const { stub, promise } = run({
    purpose: 'marketing',
    contact: contact([{ channel: 'sms', action: 'opt_in', at: NOW - 2 * HOUR, source: 'contact' }]),
  });
  assert.deepEqual(await promise, { ok: false, reason: 'opt_in_required' });
  assert.equal(stub.calls.length, 0);
});

test('a marketing reply to a contact with a Messenger opt-in is sent', async () => {
  const { stub, promise } = run({
    purpose: 'marketing',
    contact: contact([{ channel: 'messenger', action: 'opt_in', at: NOW - 2 * HOUR, source: 'contact' }]),
  });
  assert.deepEqual(await promise, { ok: true, messageId: 'm_1', auditRecorded: false });
  assert.equal(stub.calls.length, 1);
});

test('a transactional reply to a contact with no consent record is sent without an opt-in', async () => {
  const { stub, promise } = run({ purpose: 'transactional', contact: contact([]) });
  assert.equal((await promise).ok, true);
  assert.equal(stub.calls.length, 1);
});

test('an unknown purpose is refused before any post', async () => {
  const { stub, promise } = run({ purpose: 'promo' });
  assert.deepEqual(await promise, { ok: false, reason: 'invalid_purpose' });
  assert.equal(stub.calls.length, 0);
});

// ---------- marketing gate reaches the builder too (purpose, contact and window passed through) ----------

test('a marketing reply with no contact at all is refused by the builder gate and nothing is posted', async () => {
  const { stub, promise } = run({ purpose: 'marketing', contact: null });
  assert.deepEqual(await promise, { ok: false, reason: 'opt_in_required' });
  assert.equal(stub.calls.length, 0);
});

test('a marketing reply with a Messenger opt-in but a closed window is refused and nothing is posted', async () => {
  const optedIn = contact([{ channel: 'messenger', action: 'opt_in', at: NOW - 48 * HOUR, source: 'contact' }]);
  const { stub, promise } = run({ purpose: 'marketing', contact: optedIn, lastInboundAt: NOW - 25 * HOUR });
  assert.equal((await promise).ok, false);
  assert.equal(stub.calls.length, 0);
});

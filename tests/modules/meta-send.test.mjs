// Meta send request builder and sender (node:test). The HTTP client is a fake; no network calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMetaMessageRequest,
  sendMeta,
  META_GRAPH_SEND_URL,
  META_TEXT_MAX_LENGTH,
} from '../../server/modules/comms/meta-send.ts';

const TOKEN = 'EAAG-secret-token-abc123';
const RID = '1234567890';

function fakeHttp(impl) {
  const calls = [];
  return {
    calls,
    http: {
      async post(url, body, headers) {
        calls.push({ url, body, headers });
        return impl ? impl(url, body, headers) : {};
      },
    },
  };
}

// ---------- payload shape ----------

test('messenger payload has the Graph send shape', () => {
  const r = buildMetaMessageRequest({ channel: 'messenger', recipientId: RID, text: 'Hi' });
  assert.equal(r.ok, true);
  assert.equal(r.request.url, 'https://graph.facebook.com/v20.0/me/messages');
  assert.equal(META_GRAPH_SEND_URL, r.request.url);
  assert.deepEqual(r.request.body, {
    recipient: { id: RID },
    messaging_type: 'RESPONSE',
    message: { text: 'Hi' },
  });
});

test('instagram payload has the same shape as messenger', () => {
  const r = buildMetaMessageRequest({ channel: 'instagram', recipientId: RID, text: 'Hello' });
  assert.equal(r.ok, true);
  assert.equal(r.request.url, META_GRAPH_SEND_URL);
  assert.deepEqual(r.request.body, {
    recipient: { id: RID },
    messaging_type: 'RESPONSE',
    message: { text: 'Hello' },
  });
});

test('unsupported channels are refused', () => {
  for (const channel of ['whatsapp', 'sms', 'email', 'Messenger', '', 'telegram']) {
    assert.deepEqual(buildMetaMessageRequest({ channel, recipientId: RID, text: 'x' }), {
      ok: false,
      reason: 'unsupported_channel',
    });
  }
  assert.deepEqual(buildMetaMessageRequest({ channel: undefined, recipientId: RID, text: 'x' }), {
    ok: false,
    reason: 'unsupported_channel',
  });
});

// ---------- recipient validation ----------

test('recipient must be a non-empty string of digits', () => {
  for (const recipientId of ['', 'abc', '12 34', '12-34', '+1234', '12.5', ' 123', '123\n']) {
    assert.deepEqual(buildMetaMessageRequest({ channel: 'messenger', recipientId, text: 'x' }), {
      ok: false,
      reason: 'invalid_recipient',
    }, `recipientId ${JSON.stringify(recipientId)}`);
  }
});

test('non-string recipients are refused as invalid_recipient', () => {
  for (const recipientId of [1234567890, null, undefined, { id: RID }]) {
    assert.deepEqual(buildMetaMessageRequest({ channel: 'instagram', recipientId, text: 'x' }), {
      ok: false,
      reason: 'invalid_recipient',
    });
  }
});

// ---------- text limits ----------

test('text of 1 and of exactly 1000 characters is accepted', () => {
  assert.equal(buildMetaMessageRequest({ channel: 'messenger', recipientId: RID, text: 'a' }).ok, true);
  const max = 'x'.repeat(META_TEXT_MAX_LENGTH);
  assert.equal(META_TEXT_MAX_LENGTH, 1000);
  const r = buildMetaMessageRequest({ channel: 'instagram', recipientId: RID, text: max });
  assert.equal(r.ok, true);
  assert.equal(r.request.body.message.text.length, 1000);
});

test('text over 1000 characters is text_too_long on both channels', () => {
  const over = 'x'.repeat(1001);
  for (const channel of ['messenger', 'instagram']) {
    assert.deepEqual(buildMetaMessageRequest({ channel, recipientId: RID, text: over }), {
      ok: false,
      reason: 'text_too_long',
    });
  }
});

test('empty and whitespace-only text is empty_text', () => {
  for (const text of ['', '   ', '\n\t']) {
    assert.deepEqual(buildMetaMessageRequest({ channel: 'messenger', recipientId: RID, text }), {
      ok: false,
      reason: 'empty_text',
    });
  }
  assert.deepEqual(buildMetaMessageRequest({ channel: 'messenger', recipientId: RID, text: null }), {
    ok: false,
    reason: 'empty_text',
  });
});

// ---------- sendMeta ----------

test('token travels only in the Authorization header, never in url or body', async () => {
  const built = buildMetaMessageRequest({ channel: 'messenger', recipientId: RID, text: 'Hi' });
  const { calls, http } = fakeHttp(() => ({ message_id: 'm_1' }));
  const out = await sendMeta({ accessToken: TOKEN, request: built.request, http });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(!calls[0].url.includes(TOKEN));
  assert.ok(!JSON.stringify(calls[0].body).includes(TOKEN));
  assert.ok(!JSON.stringify(out).includes(TOKEN));
  assert.equal(calls[0].url, META_GRAPH_SEND_URL);
  assert.deepEqual(calls[0].body, built.request.body);
});

test('success returns the message id', async () => {
  const built = buildMetaMessageRequest({ channel: 'instagram', recipientId: RID, text: 'Hi' });
  const { http } = fakeHttp(() => ({ recipient_id: RID, message_id: 'mid.abc123' }));
  assert.deepEqual(await sendMeta({ accessToken: TOKEN, request: built.request, http }), {
    ok: true,
    messageId: 'mid.abc123',
  });
});

test('provider error response becomes provider_error with no token in the output', async () => {
  const built = buildMetaMessageRequest({ channel: 'messenger', recipientId: RID, text: 'Hi' });
  const { http } = fakeHttp(() => ({ error: { message: `bad token ${TOKEN}` } }));
  const out = await sendMeta({ accessToken: TOKEN, request: built.request, http });
  assert.deepEqual(out, { ok: false, reason: 'provider_error' });
  assert.ok(!JSON.stringify(out).includes(TOKEN));
});

test('thrown provider error becomes provider_error and never leaks the token', async () => {
  const built = buildMetaMessageRequest({ channel: 'messenger', recipientId: RID, text: 'Hi' });
  const http = {
    async post(url, body, headers) {
      throw new Error(`network failed for ${headers.Authorization}`);
    },
  };
  let out;
  await assert.doesNotReject(async () => {
    out = await sendMeta({ accessToken: TOKEN, request: built.request, http });
  });
  assert.deepEqual(out, { ok: false, reason: 'provider_error' });
  assert.ok(!JSON.stringify(out).includes(TOKEN));
});

test('response without a message_id is provider_error', async () => {
  const built = buildMetaMessageRequest({ channel: 'messenger', recipientId: RID, text: 'Hi' });
  for (const resp of [{}, null, undefined, { message_id: '' }, { message_id: 42 }]) {
    const { http } = fakeHttp(() => resp);
    assert.deepEqual(await sendMeta({ accessToken: TOKEN, request: built.request, http }), {
      ok: false,
      reason: 'provider_error',
    });
  }
});

test('missing access token is provider_error and no request is made', async () => {
  const built = buildMetaMessageRequest({ channel: 'messenger', recipientId: RID, text: 'Hi' });
  const { calls, http } = fakeHttp();
  assert.deepEqual(await sendMeta({ accessToken: '', request: built.request, http }), {
    ok: false,
    reason: 'provider_error',
  });
  assert.equal(calls.length, 0);
});

// ---------- marketing gate: opt-in plus 24-hour window, Messenger only (fake contacts) ----------

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const MKT_MSG = { channel: 'messenger', recipientId: RID, text: 'Promo', purpose: 'marketing' };
const OPTED_IN_MSG = {
  handles: { messenger: RID },
  consents: [{ channel: 'messenger', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }],
};

test('marketing Messenger send inside the window with an opt-in builds', () => {
  const r = buildMetaMessageRequest({ ...MKT_MSG, contact: OPTED_IN_MSG, lastInboundAt: NOW - HOUR, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.request.url, META_GRAPH_SEND_URL);
});

test('marketing Messenger send with no opt-in is refused even inside the window', () => {
  const r = buildMetaMessageRequest({
    ...MKT_MSG,
    contact: { handles: { messenger: RID } },
    lastInboundAt: NOW - HOUR,
    now: NOW,
  });
  assert.deepEqual(r, { ok: false, reason: 'opt_in_required' });
});

test('marketing Messenger send with no contact is refused', () => {
  assert.deepEqual(buildMetaMessageRequest({ ...MKT_MSG, lastInboundAt: NOW - HOUR, now: NOW }), {
    ok: false,
    reason: 'opt_in_required',
  });
});

test('marketing Messenger send outside the window is refused, even with an opt-in', () => {
  const r = buildMetaMessageRequest({
    ...MKT_MSG,
    contact: OPTED_IN_MSG,
    lastInboundAt: NOW - 25 * HOUR,
    now: NOW,
  });
  assert.deepEqual(r, { ok: false, reason: 'window_closed' });
});

test('marketing Messenger send with no inbound message is refused', () => {
  const r = buildMetaMessageRequest({ ...MKT_MSG, contact: OPTED_IN_MSG, lastInboundAt: null, now: NOW });
  assert.deepEqual(r, { ok: false, reason: 'no_inbound' });
});

test('sponsored route is refused until its own send path exists', () => {
  const r = buildMetaMessageRequest({
    ...MKT_MSG,
    route: 'sponsored',
    contact: OPTED_IN_MSG,
    lastInboundAt: NOW - HOUR,
    now: NOW,
  });
  assert.deepEqual(r, { ok: false, reason: 'sponsored_unavailable' });
});

test('marketing on instagram is refused', () => {
  const r = buildMetaMessageRequest({
    ...MKT_MSG,
    channel: 'instagram',
    contact: { ...OPTED_IN_MSG, handles: { instagram: RID } },
    lastInboundAt: NOW - HOUR,
    now: NOW,
  });
  assert.deepEqual(r, { ok: false, reason: 'marketing_channel_unsupported' });
});

test('marketing send with a malformed clock is refused', () => {
  const r = buildMetaMessageRequest({ ...MKT_MSG, contact: OPTED_IN_MSG, lastInboundAt: NOW - HOUR, now: 'soon' });
  assert.deepEqual(r, { ok: false, reason: 'invalid_time' });
});

test('transactional Messenger reply is unchanged and builds with no contact or window', () => {
  assert.equal(buildMetaMessageRequest({ channel: 'messenger', recipientId: RID, text: 'Hi' }).ok, true);
});

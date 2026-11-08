import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWhatsAppRequest, sendWhatsApp } from '../../server/modules/comms/whatsapp-send.ts';

// Pure logic plus an injected fake http. No network, no database.

const PHONE_ID = '109876543210987';
const TO = '61412345678';
const FREE = { send: 'free_form' };
const TEMPLATE = { send: 'template' };
const REFUSE = { send: 'refuse', reason: 'template_required' };
const TOKEN = 'EAAG-secret-token-value-123';
const URL = `https://graph.facebook.com/v20.0/${PHONE_ID}/messages`;

const base = (overrides = {}) => ({
  phoneNumberId: PHONE_ID,
  to: TO,
  decision: FREE,
  text: 'Hello from Clean Smart',
  ...overrides,
});

test('free-form request is a text message to the versioned Graph URL', () => {
  const r = buildWhatsAppRequest(base());
  assert.deepEqual(r, {
    ok: true,
    url: URL,
    body: {
      messaging_product: 'whatsapp',
      to: TO,
      type: 'text',
      text: { body: 'Hello from Clean Smart' },
    },
  });
});

test('template request carries name, language and variables as body parameters', () => {
  const r = buildWhatsAppRequest(
    base({
      decision: TEMPLATE,
      text: undefined,
      templateName: 'booking_reminder_1',
      templateLanguage: 'en_AU',
      variables: ['Sam', '3 Nov'],
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.url, URL);
  assert.deepEqual(r.body, {
    messaging_product: 'whatsapp',
    to: TO,
    type: 'template',
    template: {
      name: 'booking_reminder_1',
      language: { code: 'en_AU' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'Sam' },
            { type: 'text', text: '3 Nov' },
          ],
        },
      ],
    },
  });
});

test('template request without variables has no components', () => {
  const r = buildWhatsAppRequest(
    base({ decision: TEMPLATE, text: undefined, templateName: 'welcome', templateLanguage: 'en_US' }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.body.template.components, undefined);
});

test('refuse yields template_required and builds nothing', () => {
  const r = buildWhatsAppRequest(base({ decision: REFUSE, templateName: 'welcome', templateLanguage: 'en_AU' }));
  assert.deepEqual(r, { ok: false, reason: 'template_required' });
  assert.equal('url' in r, false);
  assert.equal('body' in r, false);
});

test('a leading plus is stripped from the recipient, other symbols are refused', () => {
  const r = buildWhatsAppRequest(base({ to: '+61412345678' }));
  assert.equal(r.ok, true);
  assert.equal(r.body.to, TO);

  for (const bad of ['', '+', '61 412 345 678', '+61-412', 'abc', '++61412', 12345678]) {
    assert.deepEqual(buildWhatsAppRequest(base({ to: bad })), { ok: false, reason: 'invalid_recipient' }, bad);
  }
});

test('phone number id must be digits', () => {
  for (const bad of ['', 'abc', '123/../x', '12 3']) {
    assert.deepEqual(buildWhatsAppRequest(base({ phoneNumberId: bad })), { ok: false, reason: 'invalid_sender' }, bad);
  }
});

test('invalid template names and languages are refused', () => {
  const ok = { decision: TEMPLATE, text: undefined, templateLanguage: 'en_AU' };
  for (const name of ['', 'Welcome', 'has-dash', 'space here', 'a'.repeat(513)]) {
    assert.deepEqual(buildWhatsAppRequest(base({ ...ok, templateName: name })), { ok: false, reason: 'invalid_template' }, name);
  }
  assert.deepEqual(
    buildWhatsAppRequest(base({ decision: TEMPLATE, text: undefined, templateName: 'welcome' })),
    { ok: false, reason: 'invalid_template' },
  );
  assert.deepEqual(
    buildWhatsAppRequest(base({ decision: TEMPLATE, text: undefined, templateName: 'welcome', templateLanguage: 'en AU' })),
    { ok: false, reason: 'invalid_template' },
  );
});

test('text limit is 4096 characters and empty text is refused', () => {
  assert.equal(buildWhatsAppRequest(base({ text: 'x'.repeat(4096) })).ok, true);
  assert.deepEqual(buildWhatsAppRequest(base({ text: 'x'.repeat(4097) })), { ok: false, reason: 'invalid_text' });
  assert.deepEqual(buildWhatsAppRequest(base({ text: '' })), { ok: false, reason: 'invalid_text' });
});

test('variables are capped at 1024 characters each and must be strings', () => {
  const tmpl = { decision: TEMPLATE, text: undefined, templateName: 'welcome', templateLanguage: 'en_AU' };
  assert.equal(buildWhatsAppRequest(base({ ...tmpl, variables: ['v'.repeat(1024)] })).ok, true);
  assert.deepEqual(
    buildWhatsAppRequest(base({ ...tmpl, variables: ['ok', 'v'.repeat(1025)] })),
    { ok: false, reason: 'invalid_variable' },
  );
  assert.deepEqual(
    buildWhatsAppRequest(base({ ...tmpl, variables: [42] })),
    { ok: false, reason: 'invalid_variable' },
  );
});

test('token appears only in the Authorization header, never in the URL or body', async () => {
  const built = buildWhatsAppRequest(base());
  let seen;
  const http = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.ABC' }] }) };
  };
  const r = await sendWhatsApp({ accessToken: TOKEN, request: built, http });
  assert.deepEqual(r, { ok: true, externalId: 'wamid.ABC' });
  assert.equal(seen.url, URL);
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(seen.url.includes(TOKEN), false);
  assert.equal(seen.init.body.includes(TOKEN), false);
  assert.equal(JSON.stringify(r).includes(TOKEN), false);
});

test('provider error becomes provider_error and the token never appears in the output', async () => {
  const built = buildWhatsAppRequest(base());
  const http = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { message: `Invalid token ${TOKEN}` } }),
  });
  const r = await sendWhatsApp({ accessToken: TOKEN, request: built, http });
  assert.deepEqual(r, { ok: false, reason: 'provider_error' });
  assert.equal(JSON.stringify(r).includes(TOKEN), false);
});

test('a thrown http call or a malformed response is provider_error and never throws', async () => {
  const built = buildWhatsAppRequest(base());
  const throwing = async () => {
    throw new Error(`socket reset with ${TOKEN}`);
  };
  const r1 = await sendWhatsApp({ accessToken: TOKEN, request: built, http: throwing });
  assert.deepEqual(r1, { ok: false, reason: 'provider_error' });

  const noId = async () => ({ ok: true, status: 200, json: async () => ({ messages: [] }) });
  const r2 = await sendWhatsApp({ accessToken: TOKEN, request: built, http: noId });
  assert.deepEqual(r2, { ok: false, reason: 'provider_error' });
});

test('missing token or a non-Graph request is refused before any http call', async () => {
  const built = buildWhatsAppRequest(base());
  let calls = 0;
  const http = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  assert.deepEqual(await sendWhatsApp({ accessToken: '', request: built, http }), { ok: false, reason: 'invalid_token' });
  assert.deepEqual(
    await sendWhatsApp({ accessToken: TOKEN, request: { url: 'https://evil.example/x', body: {} }, http }),
    { ok: false, reason: 'invalid_request' },
  );
  assert.equal(calls, 0);
});

// ---------- marketing opt-in gate (fake contacts only) ----------

const MKT = { purpose: 'marketing' };
const OPTED_IN_WA = {
  handles: { phone: TO },
  consents: [{ channel: 'whatsapp', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }],
};

test('marketing send to a contact with a WhatsApp opt-in builds', () => {
  assert.equal(buildWhatsAppRequest(base({ ...MKT, contact: OPTED_IN_WA })).ok, true);
});

test('marketing send to a contact with no consent record is refused', () => {
  const r = buildWhatsAppRequest(base({ ...MKT, contact: { handles: { phone: TO } } }));
  assert.deepEqual(r, { ok: false, reason: 'opt_in_required' });
  assert.equal('url' in r, false);
});

test('marketing send with no contact at all is refused', () => {
  assert.deepEqual(buildWhatsAppRequest(base({ ...MKT })), { ok: false, reason: 'opt_in_required' });
  assert.deepEqual(buildWhatsAppRequest(base({ ...MKT, contact: null })), { ok: false, reason: 'opt_in_required' });
});

test('a Messenger opt-in does not count as a WhatsApp opt-in', () => {
  const contact = {
    handles: { phone: TO, messenger: '1234567890' },
    consents: [{ channel: 'messenger', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }],
  };
  assert.deepEqual(buildWhatsAppRequest(base({ ...MKT, contact })), { ok: false, reason: 'opt_in_required' });
});

test('a later opt-out on all channels blocks a marketing send', () => {
  const contact = {
    handles: { phone: TO },
    consents: [
      { channel: 'whatsapp', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' },
      { channel: 'all', action: 'opt_out', at: '2026-02-01T00:00:00Z', source: 'contact' },
    ],
  };
  assert.deepEqual(buildWhatsAppRequest(base({ ...MKT, contact })), { ok: false, reason: 'opt_in_required' });
});

test('an opt-in on a different phone number than the recipient is refused', () => {
  const contact = { ...OPTED_IN_WA, handles: { phone: '61400000000' } };
  assert.deepEqual(buildWhatsAppRequest(base({ ...MKT, contact })), { ok: false, reason: 'opt_in_required' });
});

test('an unknown purpose is refused', () => {
  assert.deepEqual(buildWhatsAppRequest(base({ purpose: 'promo', contact: OPTED_IN_WA })), {
    ok: false,
    reason: 'invalid_purpose',
  });
});

test('transactional send with no contact is unchanged and still builds', () => {
  assert.equal(buildWhatsAppRequest(base({ purpose: 'transactional' })).ok, true);
});

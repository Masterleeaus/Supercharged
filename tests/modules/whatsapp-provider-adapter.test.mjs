// WhatsApp provider adapter (node:test). The HTTP client is a stub; no network, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWhatsAppProviderAdapter } from '../../server/modules/comms/whatsapp-provider-adapter.ts';
import { defineTemplate } from '../../server/modules/comms/template-rules.ts';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const PHONE_ID = '109876543210987';
const TO = '61412345678';
const TOKEN = 'EAAG-secret-token-value-123';
const COMPANY = 'Clean Smart';

const optedInContact = {
  handles: { phone: TO },
  consents: [{ channel: 'whatsapp', action: 'opt_in', at: NOW - 48 * HOUR, source: 'contact' }],
};

const optedOutContact = {
  handles: { phone: TO },
  consents: [
    { channel: 'whatsapp', action: 'opt_in', at: NOW - 72 * HOUR, source: 'contact' },
    { channel: 'whatsapp', action: 'opt_out', at: NOW - 24 * HOUR, source: 'contact' },
  ],
};

// A staff opt-in after the opt-out does not reinstate the contact; only a contact opt-in does.
const staffReinstatedContact = {
  handles: { phone: TO },
  consents: [
    { channel: 'whatsapp', action: 'opt_out', at: NOW - 24 * HOUR, source: 'contact' },
    { channel: 'whatsapp', action: 'opt_in', at: NOW - HOUR, source: 'staff' },
  ],
};

const approvedTemplate = defineTemplate({
  id: 'booking-reminder',
  channel: 'whatsapp',
  body: 'Hi {{first_name}}, your clean is on {{day}}.',
  variables: ['first_name', 'day'],
  approved: true,
});

const unapprovedTemplate = defineTemplate({
  id: 'draft-reminder',
  channel: 'whatsapp',
  body: 'Hi {{first_name}}.',
  variables: ['first_name'],
  approved: false,
});

const linkTemplate = defineTemplate({
  id: 'link-reminder',
  channel: 'whatsapp',
  body: 'See {{note}}',
  variables: ['note'],
  approved: true,
});

const emailTemplate = defineTemplate({
  id: 'email-reminder',
  channel: 'email',
  body: 'Hi {{first_name}}.',
  variables: ['first_name'],
  approved: true,
});

function okResponse(id = 'wamid.HBgL1') {
  return { ok: true, status: 200, json: async () => ({ messages: [{ id }] }) };
}

function stubHttp(impl = async () => okResponse()) {
  const calls = [];
  const http = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init);
  };
  return { calls, http };
}

function adapterWith(http) {
  return createWhatsAppProviderAdapter({
    phoneNumberId: PHONE_ID,
    accessToken: TOKEN,
    http,
    company: COMPANY,
  });
}

const freeForm = (overrides = {}) => ({
  to: TO,
  contact: optedInContact,
  now: NOW,
  lastInboundAt: NOW - 2 * HOUR,
  text: 'See you Tuesday',
  ...overrides,
});

const templated = (overrides = {}) => ({
  to: TO,
  contact: optedInContact,
  now: NOW,
  lastInboundAt: null,
  template: {
    template: approvedTemplate,
    templateName: 'booking_reminder',
    templateLanguage: 'en_AU',
    values: { first_name: 'Sam', day: 'Tuesday' },
  },
  ...overrides,
});

// ---------- free-form window ----------

test('free-form text inside the 24-hour window is sent through the stub client', async () => {
  const { calls, http } = stubHttp();
  const r = await adapterWith(http).send(freeForm());
  assert.deepEqual(r, { ok: true, externalId: 'wamid.HBgL1', auditRecorded: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://graph.facebook.com/v20.0/${PHONE_ID}/messages`);
  assert.equal(JSON.parse(calls[0].init.body).type, 'text');
});

test('free-form text outside the window is refused and nothing is sent', async () => {
  const { calls, http } = stubHttp();
  const r = await adapterWith(http).send(freeForm({ lastInboundAt: NOW - 25 * HOUR }));
  assert.deepEqual(r, { ok: false, reason: 'window_closed' });
  assert.equal(calls.length, 0);
});

test('free-form text with no inbound message is refused', async () => {
  const { calls, http } = stubHttp();
  const r = await adapterWith(http).send(freeForm({ lastInboundAt: null }));
  assert.deepEqual(r, { ok: false, reason: 'window_closed' });
  assert.equal(calls.length, 0);
});

test('an inbound message stamped after now is refused as clock_skew', async () => {
  const { calls, http } = stubHttp();
  const r = await adapterWith(http).send(freeForm({ lastInboundAt: NOW + HOUR }));
  assert.deepEqual(r, { ok: false, reason: 'clock_skew' });
  assert.equal(calls.length, 0);
});

test('empty free-form text inside the window is refused as invalid_text', async () => {
  const { calls, http } = stubHttp();
  const r = await adapterWith(http).send(freeForm({ text: '' }));
  assert.deepEqual(r, { ok: false, reason: 'invalid_text' });
  assert.equal(calls.length, 0);
});

// ---------- templates outside the window ----------

test('an approved template is sent outside the window with variables in declared order', async () => {
  const { calls, http } = stubHttp();
  const r = await adapterWith(http).send(templated());
  assert.deepEqual(r, { ok: true, externalId: 'wamid.HBgL1', auditRecorded: false });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.type, 'template');
  assert.equal(body.template.name, 'booking_reminder');
  assert.equal(body.template.language.code, 'en_AU');
  assert.deepEqual(body.template.components[0].parameters, [
    { type: 'text', text: 'Sam' },
    { type: 'text', text: 'Tuesday' },
  ]);
});

test('a template is also accepted inside the window', async () => {
  const { calls, http } = stubHttp();
  const r = await adapterWith(http).send(templated({ lastInboundAt: NOW - HOUR }));
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(calls[0].init.body).type, 'template');
});

test('an unapproved template is refused outside the window and nothing is sent', async () => {
  const { calls, http } = stubHttp();
  const r = await adapterWith(http).send(
    templated({
      template: {
        template: unapprovedTemplate,
        templateName: 'draft_reminder',
        templateLanguage: 'en_AU',
        values: { first_name: 'Sam' },
      },
    }),
  );
  assert.deepEqual(r, { ok: false, reason: 'template_rejected' });
  assert.equal(calls.length, 0);
});

test('a hand-built template object that was not defined is refused', async () => {
  const { calls, http } = stubHttp();
  const fake = { id: 'booking-reminder', channel: 'whatsapp', body: 'x', variables: [], approved: true };
  const r = await adapterWith(http).send(
    templated({
      template: { template: fake, templateName: 'booking_reminder', templateLanguage: 'en_AU', values: {} },
    }),
  );
  assert.deepEqual(r, { ok: false, reason: 'template_rejected' });
  assert.equal(calls.length, 0);
});

test('a template value containing a link is refused by the template rules', async () => {
  const { calls, http } = stubHttp();
  const r = await adapterWith(http).send(
    templated({
      template: {
        template: linkTemplate,
        templateName: 'link_reminder',
        templateLanguage: 'en_AU',
        values: { note: 'visit https://example.com/offer' },
      },
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'template_rejected');
  assert.deepEqual(r.names, ['note']);
  assert.equal(calls.length, 0);
});

test('a template defined for another channel is refused', async () => {
  const { calls, http } = stubHttp();
  const r = await adapterWith(http).send(
    templated({
      template: {
        template: emailTemplate,
        templateName: 'email_reminder',
        templateLanguage: 'en_AU',
        values: { first_name: 'Sam' },
      },
    }),
  );
  assert.deepEqual(r, { ok: false, reason: 'template_channel_mismatch' });
  assert.equal(calls.length, 0);
});

test('a template with a missing variable is refused', async () => {
  const { calls, http } = stubHttp();
  const r = await adapterWith(http).send(
    templated({
      template: {
        template: approvedTemplate,
        templateName: 'booking_reminder',
        templateLanguage: 'en_AU',
        values: { first_name: 'Sam' },
      },
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'template_rejected');
  assert.deepEqual(r.names, ['day']);
  assert.equal(calls.length, 0);
});

// ---------- opt-out ----------

test('an opted-out contact is refused even inside the window', async () => {
  const { calls, http } = stubHttp();
  const r = await adapterWith(http).send(freeForm({ contact: optedOutContact }));
  assert.deepEqual(r, { ok: false, reason: 'opted_out' });
  assert.equal(calls.length, 0);
});

test('an opted-out contact is refused for an approved template too', async () => {
  const { calls, http } = stubHttp();
  const r = await adapterWith(http).send(templated({ contact: optedOutContact }));
  assert.deepEqual(r, { ok: false, reason: 'opted_out' });
  assert.equal(calls.length, 0);
});

test('a staff opt-in after an opt-out does not reinstate the contact', async () => {
  const { calls, http } = stubHttp();
  const r = await adapterWith(http).send(freeForm({ contact: staffReinstatedContact }));
  assert.deepEqual(r, { ok: false, reason: 'opted_out' });
  assert.equal(calls.length, 0);
});

// ---------- provider failures ----------

test('a provider error is returned as provider_error and the token never appears in the result', async () => {
  const { http } = stubHttp(async () => ({ ok: false, status: 401, json: async () => ({ error: TOKEN }) }));
  const r = await adapterWith(http).send(freeForm());
  assert.deepEqual(r, { ok: false, reason: 'provider_error', auditRecorded: false });
  assert.equal(JSON.stringify(r).includes(TOKEN), false);
});

test('a thrown http call is returned as provider_error and never throws', async () => {
  const { http } = stubHttp(async () => {
    throw new Error(`network down ${TOKEN}`);
  });
  const r = await adapterWith(http).send(freeForm());
  assert.deepEqual(r, { ok: false, reason: 'provider_error', auditRecorded: false });
  assert.equal(JSON.stringify(r).includes(TOKEN), false);
});

test('an invalid recipient is refused before any http call', async () => {
  const { calls, http } = stubHttp();
  const r = await adapterWith(http).send(freeForm({ to: 'not-a-number' }));
  assert.deepEqual(r, { ok: false, reason: 'invalid_recipient' });
  assert.equal(calls.length, 0);
});

// ---------- purpose: marketing needs an opt-in, transactional does not ----------

test('a marketing free-form send to a contact with no consent record is refused and nothing is sent', async () => {
  const { calls, http } = stubHttp();
  const r = await adapterWith(http).send(
    freeForm({ purpose: 'marketing', contact: { handles: { phone: TO } } }),
  );
  assert.deepEqual(r, { ok: false, reason: 'opt_in_required' });
  assert.equal(calls.length, 0);
});

test('a marketing send is refused when the contact has only another channel opt-in', async () => {
  const { calls, http } = stubHttp();
  const smsOnly = {
    handles: { phone: TO },
    consents: [{ channel: 'sms', action: 'opt_in', at: NOW - 48 * HOUR, source: 'contact' }],
  };
  const r = await adapterWith(http).send(freeForm({ purpose: 'marketing', contact: smsOnly }));
  assert.deepEqual(r, { ok: false, reason: 'opt_in_required' });
  assert.equal(calls.length, 0);
});

test('a marketing send to a contact with a WhatsApp opt-in is sent', async () => {
  const { calls, http } = stubHttp();
  const r = await adapterWith(http).send(freeForm({ purpose: 'marketing' }));
  assert.deepEqual(r, { ok: true, externalId: 'wamid.HBgL1', auditRecorded: false });
  assert.equal(calls.length, 1);
});

test('a transactional send to a contact with no consent record is not refused by the opt-in rule', async () => {
  const { calls, http } = stubHttp();
  const r = await adapterWith(http).send(
    freeForm({ purpose: 'transactional', contact: { handles: { phone: TO } } }),
  );
  assert.deepEqual(r, { ok: true, externalId: 'wamid.HBgL1', auditRecorded: false });
  assert.equal(calls.length, 1);
});

test('an unknown purpose is refused before any send', async () => {
  const { calls, http } = stubHttp();
  const r = await adapterWith(http).send(freeForm({ purpose: 'newsletter' }));
  assert.deepEqual(r, { ok: false, reason: 'invalid_purpose' });
  assert.equal(calls.length, 0);
});

// ---------- marketing gate reaches the builder too (purpose and contact passed through) ----------

test('a marketing template send to a contact with no WhatsApp opt-in is refused and nothing is sent', async () => {
  const { calls, http } = stubHttp();
  const r = await adapterWith(http).send(
    templated({ purpose: 'marketing', contact: { handles: { phone: TO } } }),
  );
  assert.deepEqual(r, { ok: false, reason: 'opt_in_required' });
  assert.equal(calls.length, 0);
});

test('a marketing send with no contact is refused and nothing is sent', async () => {
  const { calls, http } = stubHttp();
  const r = await adapterWith(http).send(freeForm({ purpose: 'marketing', contact: null }));
  assert.deepEqual(r, { ok: false, reason: 'opt_in_required' });
  assert.equal(calls.length, 0);
});

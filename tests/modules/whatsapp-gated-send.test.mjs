// WhatsApp sends go only through the pre-send gate (#551). node:test, no network, no database.
// The Cloud API is a stub. The gate is the real createPreSendGate with in-memory ports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWhatsAppProviderAdapter } from '../../server/modules/comms/whatsapp-provider-adapter.ts';
import { createPreSendGate } from '../../server/modules/comms/presend-gate.ts';
import { createSuppressionList } from '../../server/modules/comms/suppression.ts';
import { defineTemplate } from '../../server/modules/comms/template-rules.ts';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 3, 2, 0, 0); // 02:00 UTC = 13:00 Melbourne, outside a night window
const CO = '11111111-1111-4111-8111-111111111111';
const PHONE_ID = '109876543210987';
const TO = '61412345678';
const TOKEN = 'EAAG-gate-test-token-456';
const MIDDAY = { startHour: 12, endHour: 14 }; // 13:00 Melbourne at the test clock

const optedIn = {
  handles: { phone: TO },
  consents: [{ channel: 'whatsapp', action: 'opt_in', at: NOW - 48 * HOUR, source: 'contact' }],
  timezone: 'Australia/Melbourne',
};

const optedOut = {
  handles: { phone: TO },
  consents: [
    { channel: 'whatsapp', action: 'opt_in', at: NOW - 72 * HOUR, source: 'contact' },
    { channel: 'whatsapp', action: 'opt_out', at: NOW - 24 * HOUR, source: 'contact' },
  ],
  timezone: 'Australia/Melbourne',
};

const smsOnly = {
  handles: { phone: TO },
  consents: [{ channel: 'sms', action: 'opt_in', at: NOW - 48 * HOUR, source: 'contact' }],
  timezone: 'Australia/Melbourne',
};

const otherNumber = {
  handles: { phone: '61400000099' },
  consents: [{ channel: 'whatsapp', action: 'opt_in', at: NOW - 48 * HOUR, source: 'contact' }],
  timezone: 'Australia/Melbourne',
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

const emailTemplate = defineTemplate({
  id: 'email-reminder',
  channel: 'email',
  body: 'Hi {{first_name}}.',
  variables: ['first_name'],
  approved: true,
});

function realGate({ contact = optedIn, quiet = null, suppressed = false, loadContactThrows = false, recordThrows = false } = {}) {
  const blocked = [];
  const checks = [];
  const suppression = createSuppressionList({ audit: () => {}, clock: () => new Date(NOW).toISOString() });
  if (suppressed) suppression.suppress(CO, { channel: 'whatsapp', address: TO, reason: 'unsubscribed', actorId: 'system' });
  const gate = createPreSendGate({
    suppression,
    async loadContact() {
      if (loadContactThrows) throw new Error(`lookup failed for ${TO}`);
      return contact;
    },
    async loadQuietHours() {
      return quiet;
    },
    now: () => new Date(NOW),
    async recordBlocked(record) {
      if (recordThrows) throw new Error('audit store down');
      blocked.push(record);
    },
  });
  const wrapped = {
    check: async (input) => {
      checks.push(input);
      return gate.check(input);
    },
    recordBlock: (...args) => gate.recordBlock(...args),
  };
  return { gate: wrapped, blocked, checks };
}

function stubHttp(impl = async () => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.G1' }] }) })) {
  const calls = [];
  const http = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init);
  };
  return { calls, http };
}

function adapterWith(gate, http, extra = {}) {
  return createWhatsAppProviderAdapter({
    phoneNumberId: PHONE_ID,
    accessToken: TOKEN,
    http,
    company: 'Clean Smart',
    companyId: CO,
    gate,
    ...extra,
  });
}

const freeForm = (overrides = {}) => ({
  to: TO,
  contact: optedIn,
  now: NOW,
  lastInboundAt: NOW - 2 * HOUR,
  text: 'See you Tuesday',
  actorId: 'agent-1',
  ...overrides,
});

const templated = (template, overrides = {}) => ({
  to: TO,
  contact: optedIn,
  now: NOW,
  lastInboundAt: null,
  template: {
    template,
    templateName: 'booking_reminder',
    templateLanguage: 'en_AU',
    values: { first_name: 'Sam', day: 'Tuesday' },
  },
  actorId: 'agent-1',
  ...overrides,
});

// ---------- allowed send ----------

test('a send the gate allows reaches the Cloud API exactly once and is not recorded as blocked', async () => {
  const { gate, blocked, checks } = realGate();
  const { calls, http } = stubHttp();
  const r = await adapterWith(gate, http).send(freeForm());
  assert.equal(r.ok, true);
  assert.equal(r.externalId, 'wamid.G1');
  assert.equal(calls.length, 1);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].channel, 'whatsapp');
  assert.equal(checks[0].surface, 'inbox');
  assert.equal(blocked.length, 0);
});

// ---------- every gate reason blocks before the provider ----------

const blockCases = [
  ['suppressed', { suppressed: true }, 'suppressed'],
  ['no consent record at all', { contact: null }, 'no_consent'],
  ['channel not consented', { contact: smsOnly }, 'channel_not_consented'],
  ['opted out', { contact: optedOut }, 'opted_out'],
  ['quiet hours in the contact timezone', { quiet: MIDDAY }, 'quiet_hours'],
  ['contact owns a different number', { contact: otherNumber }, 'invalid_contact'],
];

for (const [label, opts, reason] of blockCases) {
  test(`gate block "${label}" refuses the send, records it, and never calls the provider`, async () => {
    const { gate, blocked } = realGate(opts);
    const { calls, http } = stubHttp();
    const r = await adapterWith(gate, http).send(freeForm());
    assert.deepEqual(r, { ok: false, reason });
    assert.equal(calls.length, 0, 'provider must not be called');
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].reason, reason);
    assert.equal(blocked[0].channel, 'whatsapp');
    assert.equal(blocked[0].surface, 'inbox');
    assert.equal(blocked[0].companyId, CO);
    // The block record carries no phone number or provider detail.
    assert.equal(JSON.stringify(blocked).includes(TO), false);
  });
}

// ---------- fail closed ----------

test('a gate that throws is a block: the provider is not called and the block is recorded as gate_error', async () => {
  const blocked = [];
  const throwing = {
    check: async () => {
      throw new Error(`boom for ${TO}`);
    },
    recordBlock: async (input, reason) => {
      blocked.push({ ...input, reason });
    },
  };
  const { calls, http } = stubHttp();
  const r = await adapterWith(throwing, http).send(freeForm());
  assert.deepEqual(r, { ok: false, reason: 'gate_error' });
  assert.equal(calls.length, 0);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].reason, 'gate_error');
  assert.equal(JSON.stringify(r).includes(TO), false);
});

test('a gate whose contact lookup fails closes with gate_error and sends nothing', async () => {
  const { gate, blocked } = realGate({ loadContactThrows: true });
  const { calls, http } = stubHttp();
  const r = await adapterWith(gate, http).send(freeForm());
  assert.deepEqual(r, { ok: false, reason: 'gate_error' });
  assert.equal(calls.length, 0);
  assert.equal(blocked[0].reason, 'gate_error');
});

test('if the block cannot be recorded, the send is still refused and the provider is not called', async () => {
  const { gate } = realGate({ contact: null, recordThrows: true });
  const { calls, http } = stubHttp();
  const r = await adapterWith(gate, http).send(freeForm());
  assert.deepEqual(r, { ok: false, reason: 'provider_error' });
  assert.equal(calls.length, 0);
});

test('a send with no companyId is refused before the gate is consulted', async () => {
  const { gate, checks } = realGate();
  const { calls, http } = stubHttp();
  const adapter = createWhatsAppProviderAdapter({ phoneNumberId: PHONE_ID, accessToken: TOKEN, http, company: 'Clean Smart', gate });
  assert.deepEqual(await adapter.send(freeForm()), { ok: false, reason: 'invalid_company' });
  assert.equal(checks.length, 0);
  assert.equal(calls.length, 0);
});

// ---------- no retry on the send ----------

test('a provider failure is not retried: the Cloud API is called once', async () => {
  const { gate } = realGate();
  const { calls, http } = stubHttp(async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'x' } }) }));
  const r = await adapterWith(gate, http).send(freeForm());
  assert.equal(r.ok, false);
  assert.equal(calls.length, 1);
});

// ---------- outside the 24-hour window and template rules ----------

test('free-form text outside the 24-hour window is refused by the window rule after the gate passes', async () => {
  const { gate, blocked } = realGate();
  const { calls, http } = stubHttp();
  const r = await adapterWith(gate, http).send(freeForm({ lastInboundAt: NOW - 25 * HOUR }));
  assert.deepEqual(r, { ok: false, reason: 'window_closed' });
  assert.equal(calls.length, 0);
  assert.equal(blocked.length, 0, 'a window refusal is not a gate block');
});

test('an unapproved template is refused and nothing is sent, even outside the window', async () => {
  const { gate } = realGate();
  const { calls, http } = stubHttp();
  const r = await adapterWith(gate, http).send(templated(unapprovedTemplate));
  assert.deepEqual(r, { ok: false, reason: 'template_rejected' });
  assert.equal(calls.length, 0);
});

test('a template defined for another channel is refused and nothing is sent', async () => {
  const { gate } = realGate();
  const { calls, http } = stubHttp();
  const r = await adapterWith(gate, http).send(templated(emailTemplate));
  assert.deepEqual(r, { ok: false, reason: 'template_channel_mismatch' });
  assert.equal(calls.length, 0);
});

test('an approved template is sent outside the window, after the gate allows it', async () => {
  const { gate } = realGate();
  const { calls, http } = stubHttp();
  const r = await adapterWith(gate, http).send(templated(approvedTemplate));
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).type, 'template');
});

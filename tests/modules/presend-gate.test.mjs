// Pre-send compliance gate: one test per rule, plus a check that a send passes only when every rule
// runs and passes. No database, no network, no provider. Clock is injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreSendGate } from '../../server/modules/comms/presend-gate.ts';
import { createSuppressionList } from '../../server/modules/comms/suppression.ts';

const CO = '11111111-1111-4111-8111-111111111111';
const PHONE = '+61400000001';
const EMAIL = 'ana@example.com';
// 2026-11-15 10:00 UTC. Melbourne (UTC+11) reads 21:00, Tokyo (UTC+9) reads 19:00.
const NOW = '2026-11-15T10:00:00Z';
const NIGHT = { startHour: 21, endHour: 7 };

const optIn = (channel, source = 'contact', at = '2026-01-01T00:00:00Z') => ({ channel, action: 'opt_in', at, source });
const optOut = (channel, source = 'contact', at = '2026-03-01T00:00:00Z') => ({ channel, action: 'opt_out', at, source });

function harness({
  consents = [optIn('sms')],
  timezone = 'Australia/Melbourne',
  handlePhone = PHONE,
  contact,
  suppress = null,
  quiet = null,
  loadQuietCalls = [],
  loadContactError = null,
  recordError = null,
} = {}) {
  const suppression = createSuppressionList({
    audit: () => {},
    clock: () => '2026-11-15T10:00:00.000Z',
  });
  if (suppress) suppression.suppress(CO, { ...suppress, actorId: 'system' });
  const blocked = [];
  const order = [];
  const gate = createPreSendGate({
    suppression: {
      isSuppressed: (c, i) => {
        order.push('suppression');
        return suppression.isSuppressed(c, i);
      },
      suppress: suppression.suppress,
      reasonFor: suppression.reasonFor,
      unsuppress: suppression.unsuppress,
    },
    async loadContact(companyId, channel, address) {
      order.push('contact');
      if (loadContactError) throw loadContactError;
      if (contact !== undefined) return contact;
      return { handles: { phone: handlePhone, email: EMAIL }, consents, timezone };
    },
    async loadQuietHours(companyId) {
      order.push('quiet');
      loadQuietCalls.push(companyId);
      return quiet;
    },
    now: () => new Date(NOW),
    async recordBlocked(record) {
      if (recordError) throw recordError;
      blocked.push(record);
    },
  });
  return { gate, blocked, order };
}

const check = (gate, over = {}) =>
  gate.check({ companyId: CO, channel: 'sms', address: PHONE, surface: 'inbox', actorId: 'staff-1', ...over });

test('a consented, unsuppressed recipient inside the send window is allowed', async () => {
  const { gate } = harness();
  assert.deepEqual(await check(gate), { allowed: true });
});

test('rule: channels outside the consent model are blocked as unsupported', async () => {
  const { gate } = harness();
  assert.deepEqual(await check(gate, { channel: 'web_chat', address: 'visitor-1' }), { allowed: false, reason: 'unsupported_channel' });
});

test('rule: a malformed address is blocked before any lookup', async () => {
  const { gate, order } = harness();
  assert.deepEqual(await check(gate, { channel: 'email', address: 'not-an-address' }), { allowed: false, reason: 'invalid_address' });
  assert.deepEqual(order, []);
});

test('rule: a suppressed address (hard bounce) is blocked, even with consent', async () => {
  const { gate } = harness({ consents: [optIn('email')], suppress: { channel: 'email', address: EMAIL, reason: 'bounce_hard' } });
  assert.deepEqual(await check(gate, { channel: 'email', address: EMAIL }), { allowed: false, reason: 'suppressed' });
});

test('rule: a suppression list that cannot read the company fails closed as suppressed', async () => {
  const { gate } = harness();
  assert.deepEqual(await check(gate, { companyId: 'not-a-company' }), { allowed: false, reason: 'suppressed' });
});

test('rule: no contact record means no consent', async () => {
  const { gate } = harness({ contact: null });
  assert.deepEqual(await check(gate), { allowed: false, reason: 'no_consent' });
});

test('rule: a contact record that names another number is refused as invalid_contact', async () => {
  const { gate } = harness({ handlePhone: '+61400000999' });
  assert.deepEqual(await check(gate), { allowed: false, reason: 'invalid_contact' });
});

test('rule: consent is per channel; an email opt-in does not cover sms', async () => {
  const { gate } = harness({ consents: [optIn('email')] });
  assert.deepEqual(await check(gate), { allowed: false, reason: 'channel_not_consented' });
});

test('rule: an opt-out on the channel blocks the send', async () => {
  const { gate } = harness({ consents: [optIn('sms'), optOut('sms', 'contact', '2026-04-01T00:00:00Z')] });
  assert.deepEqual(await check(gate), { allowed: false, reason: 'opted_out' });
});

test('rule: an opt-out for all channels blocks every channel', async () => {
  const { gate } = harness({ consents: [optIn('sms'), { channel: 'all', action: 'opt_out', at: '2026-04-01T00:00:00Z', source: 'staff' }] });
  assert.deepEqual(await check(gate), { allowed: false, reason: 'opted_out' });
});

test('rule: a later opt-in does not reinstate a staff opt-out', async () => {
  const { gate } = harness({
    consents: [optOut('sms', 'staff', '2026-04-01T00:00:00Z'), optIn('sms', 'contact', '2026-05-01T00:00:00Z')],
  });
  assert.deepEqual(await check(gate), { allowed: false, reason: 'opted_out' });
});

test('rule: quiet hours block a send inside the window read in the recipient timezone', async () => {
  const { gate } = harness({ quiet: NIGHT });
  // Melbourne reads 21:00 at NOW, inside 21:00 to 07:00.
  assert.deepEqual(await check(gate), { allowed: false, reason: 'quiet_hours' });
});

test('rule: the recipient timezone decides quiet hours, not the company or the server', async () => {
  const sameInstant = { quiet: NIGHT };
  // Tokyo reads 19:00 at NOW, outside the window: allowed.
  const tokyo = harness({ ...sameInstant, timezone: 'Asia/Tokyo' });
  assert.deepEqual(await check(tokyo.gate), { allowed: true });
  // Melbourne reads 21:00 at the same instant: blocked.
  const melbourne = harness({ ...sameInstant, timezone: 'Australia/Melbourne' });
  assert.deepEqual(await check(melbourne.gate), { allowed: false, reason: 'quiet_hours' });
});

test('rule: a quiet-hours window with no valid recipient timezone fails closed as invalid_contact', async () => {
  const { gate } = harness({ quiet: NIGHT, timezone: null });
  assert.deepEqual(await check(gate), { allowed: false, reason: 'invalid_contact' });
});

test('rule: with no quiet-hours window, a missing timezone does not block', async () => {
  const { gate } = harness({ quiet: null, timezone: null });
  assert.deepEqual(await check(gate), { allowed: true });
});

test('an explicit quietHours argument overrides the company window (null means none)', async () => {
  const loads = [];
  const { gate } = harness({ quiet: NIGHT, loadQuietCalls: loads });
  assert.deepEqual(await check(gate, { quietHours: null }), { allowed: true });
  assert.equal(loads.length, 0, 'the company window is not read when the caller passes one');
  assert.deepEqual(await check(gate), { allowed: false, reason: 'quiet_hours' });
  assert.equal(loads.length, 1);
});

test('a lookup error fails closed as gate_error and the reason carries no detail', async () => {
  const { gate } = harness({ loadContactError: new Error('db down for +61400000001') });
  const result = await check(gate);
  assert.deepEqual(result, { allowed: false, reason: 'gate_error' });
  assert.ok(!JSON.stringify(result).includes('61400000001'));
});

test('a send passes only when every rule runs in order: suppression, then contact and consent, then quiet hours', async () => {
  const { gate, order } = harness({ quiet: null });
  assert.deepEqual(await check(gate), { allowed: true });
  assert.deepEqual(order, ['suppression', 'contact', 'quiet']);
});

test('recordBlock writes the reason, the surface, the actor and the time, and a failed write is not swallowed', async () => {
  const { gate, blocked } = harness();
  await gate.recordBlock(
    { companyId: CO, channel: 'sms', surface: 'inbox', actorId: 'staff-1' },
    'opted_out',
    { messageId: 'msg-1', threadId: 'thr-1' },
  );
  assert.deepEqual(blocked, [
    {
      companyId: CO,
      channel: 'sms',
      surface: 'inbox',
      actorId: 'staff-1',
      reason: 'opted_out',
      at: '2026-11-15T10:00:00.000Z',
      messageId: 'msg-1',
      threadId: 'thr-1',
    },
  ]);

  const failing = harness({ recordError: new Error('audit write failed') });
  await assert.rejects(
    failing.gate.recordBlock({ companyId: CO, channel: 'sms', surface: 'marketing', actorId: 'system' }, 'suppressed'),
    /audit write failed/,
  );
});

test('construction refuses missing ports', () => {
  assert.throws(() => createPreSendGate(undefined), /ports required/);
  assert.throws(() => createPreSendGate({ suppression: {} }), /suppression list required/);
});

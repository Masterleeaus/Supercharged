// Inbound STOP / START handling tests (node:test). Pure in-memory: no database, no network, no clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { consentEventForInboundKeyword, handleInboundOptOut } from '../../server/modules/comms/inbound-optout.ts';
import { checkConsent } from '../../server/modules/comms/consent.ts';
import { createSuppressionList } from '../../server/modules/comms/suppression.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const FROM = 'ada@example.com';

function run(suppression, overrides = {}) {
  return handleInboundOptOut({
    companyId: CO_A,
    channel: 'email',
    from: FROM,
    body: 'STOP',
    suppression,
    now: new Date('2026-11-03T10:00:00Z'),
    ...overrides,
  });
}

test('STOP suppresses the sender as unsubscribed', () => {
  const list = createSuppressionList();
  assert.deepEqual(run(list), { action: 'suppressed' });
  assert.equal(list.isSuppressed(CO_A, { address: FROM, channel: 'email' }), true);
});

test('STOP is case-insensitive and trimmed, and the other opt-out words also suppress', () => {
  const list = createSuppressionList();
  assert.deepEqual(run(list, { body: '  stop ' }), { action: 'suppressed' });
  assert.deepEqual(run(list, { from: 'b@example.com', body: 'Unsubscribe' }), { action: 'suppressed' });
  assert.equal(list.isSuppressed(CO_A, { address: 'b@example.com', channel: 'email' }), true);
});

test('START unsuppresses an unsubscribed address', () => {
  const list = createSuppressionList();
  run(list);
  assert.deepEqual(run(list, { body: 'START' }), { action: 'unsuppressed' });
  assert.equal(list.isSuppressed(CO_A, { address: FROM, channel: 'email' }), false);
});

test('YES also counts as an opt-in keyword', () => {
  const list = createSuppressionList();
  run(list);
  assert.deepEqual(run(list, { body: 'yes' }), { action: 'unsuppressed' });
});

test('START does not clear a hard bounce: the list refuses and the result is not_changed', () => {
  const list = createSuppressionList();
  list.suppress(CO_A, { address: FROM, channel: 'email', reason: 'bounce_hard' });
  assert.deepEqual(run(list, { body: 'START' }), { action: 'not_changed', reason: 'not_opt_out' });
  assert.equal(list.isSuppressed(CO_A, { address: FROM, channel: 'email' }), true);
});

test('START for an address that was never suppressed is not_changed', () => {
  const list = createSuppressionList();
  assert.deepEqual(run(list, { body: 'START' }), { action: 'not_changed', reason: 'not_opt_out' });
});

test('normal text does nothing and touches nothing', () => {
  const list = createSuppressionList();
  run(list);
  assert.deepEqual(run(list, { body: 'Can I book Tuesday?' }), { action: 'none' });
  assert.equal(list.isSuppressed(CO_A, { address: FROM, channel: 'email' }), true);
  assert.deepEqual(run(createSuppressionList(), { body: 'stop it' }), { action: 'none' });
  assert.deepEqual(run(createSuppressionList(), { body: 'STOP.' }), { action: 'none' });
  assert.deepEqual(run(createSuppressionList(), { body: 42 }), { action: 'none' });
});

test('a missing from does nothing, even for STOP', () => {
  const list = createSuppressionList();
  assert.deepEqual(run(list, { from: undefined }), { action: 'none' });
  assert.deepEqual(run(list, { from: null }), { action: 'none' });
  assert.deepEqual(run(list, { from: '   ' }), { action: 'none' });
  assert.equal(list.isSuppressed(CO_A, { address: FROM, channel: 'email' }), false);
});

test('an opt-out for one company does not affect another company', () => {
  const list = createSuppressionList();
  run(list);
  assert.equal(list.isSuppressed(CO_A, { address: FROM, channel: 'email' }), true);
  assert.equal(list.isSuppressed(CO_B, { address: FROM, channel: 'email' }), false);
  assert.deepEqual(run(list, { companyId: CO_B, body: 'START' }), {
    action: 'not_changed',
    reason: 'not_opt_out',
  });
  assert.equal(list.isSuppressed(CO_A, { address: FROM, channel: 'email' }), true);
});

test('a non-UUID company is refused with invalid_company and nothing is written', () => {
  const list = createSuppressionList();
  assert.deepEqual(run(list, { companyId: 'not-a-uuid' }), {
    action: 'not_changed',
    reason: 'invalid_company',
  });
  assert.deepEqual(run(list, { companyId: undefined }), {
    action: 'not_changed',
    reason: 'invalid_company',
  });
  assert.equal(list.isSuppressed(CO_A, { address: FROM, channel: 'email' }), false);
});

const NOON = '2026-11-03T12:00:00Z';
const LATER = '2026-11-03T13:00:00Z';
const JAN = '2026-01-01T00:00:00Z';

const withConsents = (consents) => ({ handles: { phone: '+61400000000', email: 'ada@example.com' }, consents });
const allowed = (contact, channel) => checkConsent({ channel, contact, now: NOON }).allowed;

test('inbound STOP on SMS gives an sms opt_out from the contact, and only SMS is refused', () => {
  const contact = withConsents([
    { channel: 'sms', action: 'opt_in', at: JAN, source: 'contact' },
    { channel: 'whatsapp', action: 'opt_in', at: JAN, source: 'contact' },
    { channel: 'email', action: 'opt_in', at: JAN, source: 'contact' },
  ]);
  const event = consentEventForInboundKeyword({ channel: 'sms', body: 'stop', contact, at: NOON });
  assert.deepEqual(event, { channel: 'sms', action: 'opt_out', at: NOON, source: 'contact' });

  const after = withConsents([...contact.consents, event]);
  assert.equal(allowed(after, 'sms'), false);
  assert.equal(checkConsent({ channel: 'sms', contact: after, now: NOON }).reason, 'opted_out');
  assert.equal(allowed(after, 'whatsapp'), true);
  assert.equal(allowed(after, 'email'), true);
});

test('inbound START after an SMS STOP reinstates SMS only when it is later and from the contact', () => {
  const contact = withConsents([
    { channel: 'sms', action: 'opt_in', at: JAN, source: 'contact' },
    { channel: 'sms', action: 'opt_out', at: NOON, source: 'contact' },
  ]);
  assert.equal(allowed(contact, 'sms'), false);

  const start = consentEventForInboundKeyword({ channel: 'sms', body: ' Yes ', contact, at: LATER });
  assert.deepEqual(start, { channel: 'sms', action: 'opt_in', at: LATER, source: 'contact' });
  assert.equal(allowed(withConsents([...contact.consents, start]), 'sms'), true);

  const sameTime = consentEventForInboundKeyword({ channel: 'sms', body: 'START', contact, at: NOON });
  assert.equal(allowed(withConsents([...contact.consents, sameTime]), 'sms'), false);
});

test('START with no opt-out on record grants nothing (fail closed)', () => {
  const contact = withConsents([]);
  assert.equal(consentEventForInboundKeyword({ channel: 'sms', body: 'START', contact, at: NOON }), null);
  const withOtherChannel = withConsents([{ channel: 'email', action: 'opt_out', at: JAN, source: 'contact' }]);
  assert.equal(consentEventForInboundKeyword({ channel: 'sms', body: 'START', contact: withOtherChannel, at: NOON }), null);
});

test('a staff channel-wide opt-out is not lifted by a contact START (decision 47), and an email opt-out does not block SMS', () => {
  const allOut = withConsents([
    { channel: 'sms', action: 'opt_in', at: JAN, source: 'contact' },
    { channel: 'all', action: 'opt_out', at: JAN, source: 'staff' },
  ]);
  const start = consentEventForInboundKeyword({ channel: 'sms', body: 'START', contact: allOut, at: NOON });
  assert.equal(allowed(withConsents([...allOut.consents, start]), 'sms'), false);

  const emailOut = withConsents([
    { channel: 'sms', action: 'opt_in', at: JAN, source: 'contact' },
    { channel: 'email', action: 'opt_out', at: JAN, source: 'contact' },
  ]);
  assert.equal(allowed(emailOut, 'sms'), true);
});

test('normal text, a missing contact or a non-string body gives no consent event', () => {
  const contact = withConsents([]);
  assert.equal(consentEventForInboundKeyword({ channel: 'sms', body: 'Can I book?', contact, at: NOON }), null);
  assert.equal(consentEventForInboundKeyword({ channel: 'sms', body: 'STOP', contact: null, at: NOON }), null);
  assert.equal(consentEventForInboundKeyword({ channel: 'sms', body: 42, contact, at: NOON }), null);
});

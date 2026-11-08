// Suppression list tests (node:test). Pure in-memory module: no database, no network, no clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuppressionList } from '../../server/modules/comms/suppression.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const EMAIL = 'ada@example.com';

test('hard bounce suppresses immediately', () => {
  const list = createSuppressionList();
  const r = list.suppress(CO_A, { address: EMAIL, channel: 'email', reason: 'bounce_hard' });
  assert.deepEqual(r, { ok: true, suppressed: true, reason: 'bounce_hard' });
  assert.equal(list.isSuppressed(CO_A, { address: EMAIL, channel: 'email' }), true);
});

test('complaint suppresses immediately', () => {
  const list = createSuppressionList();
  const r = list.suppress(CO_A, { address: EMAIL, channel: 'email', reason: 'complaint' });
  assert.deepEqual(r, { ok: true, suppressed: true, reason: 'complaint' });
  assert.equal(list.isSuppressed(CO_A, { address: EMAIL, channel: 'email' }), true);
});

test('invalid address suppresses immediately', () => {
  const list = createSuppressionList();
  const r = list.suppress(CO_A, { address: '+61 400 000 000', channel: 'sms', reason: 'invalid_address' });
  assert.deepEqual(r, { ok: true, suppressed: true, reason: 'invalid_address' });
  assert.equal(list.isSuppressed(CO_A, { address: '+61400000000', channel: 'sms' }), true);
});

test('unsubscribed suppresses immediately', () => {
  const list = createSuppressionList();
  const r = list.suppress(CO_A, { address: EMAIL, channel: 'email', reason: 'unsubscribed' });
  assert.deepEqual(r, { ok: true, suppressed: true, reason: 'unsubscribed' });
  assert.equal(list.isSuppressed(CO_A, { address: EMAIL, channel: 'email' }), true);
});

test('soft bounce needs three: first and second do not suppress, third does', () => {
  const list = createSuppressionList();
  const input = { address: EMAIL, channel: 'email', reason: 'bounce_soft' };
  assert.deepEqual(list.suppress(CO_A, input), { ok: true, suppressed: false, softBounces: 1 });
  assert.equal(list.isSuppressed(CO_A, { address: EMAIL, channel: 'email' }), false);
  assert.deepEqual(list.suppress(CO_A, input), { ok: true, suppressed: false, softBounces: 2 });
  assert.equal(list.isSuppressed(CO_A, { address: EMAIL, channel: 'email' }), false);
  assert.deepEqual(list.suppress(CO_A, input), { ok: true, suppressed: true, reason: 'soft_bounce_count' });
  assert.equal(list.isSuppressed(CO_A, { address: EMAIL, channel: 'email' }), true);
});

test('soft bounce counts are per address and per channel', () => {
  const list = createSuppressionList();
  list.suppress(CO_A, { address: EMAIL, channel: 'email', reason: 'bounce_soft' });
  list.suppress(CO_A, { address: EMAIL, channel: 'email', reason: 'bounce_soft' });
  const other = list.suppress(CO_A, { address: 'bob@example.com', channel: 'email', reason: 'bounce_soft' });
  assert.deepEqual(other, { ok: true, suppressed: false, softBounces: 1 });
});

test('hard bounce cannot be lifted', () => {
  const list = createSuppressionList();
  list.suppress(CO_A, { address: EMAIL, channel: 'email', reason: 'bounce_hard' });
  assert.deepEqual(list.unsuppress(CO_A, { address: EMAIL, channel: 'email' }), { ok: false, error: 'permanent' });
  assert.equal(list.isSuppressed(CO_A, { address: EMAIL, channel: 'email' }), true);
});

test('complaint cannot be lifted', () => {
  const list = createSuppressionList();
  list.suppress(CO_A, { address: EMAIL, channel: 'email', reason: 'complaint' });
  assert.deepEqual(list.unsuppress(CO_A, { address: EMAIL, channel: 'email' }), { ok: false, error: 'permanent' });
  assert.equal(list.isSuppressed(CO_A, { address: EMAIL, channel: 'email' }), true);
});

test('invalid address cannot be lifted', () => {
  const list = createSuppressionList();
  list.suppress(CO_A, { address: EMAIL, channel: 'email', reason: 'invalid_address' });
  assert.deepEqual(list.unsuppress(CO_A, { address: EMAIL, channel: 'email' }), { ok: false, error: 'permanent' });
});

test('soft bounce suppression and unsubscribe can be lifted by a human re-opt-in', () => {
  const list = createSuppressionList();
  for (let i = 0; i < 3; i++) list.suppress(CO_A, { address: EMAIL, channel: 'email', reason: 'bounce_soft' });
  assert.deepEqual(list.unsuppress(CO_A, { address: EMAIL, channel: 'email' }), { ok: true });
  assert.equal(list.isSuppressed(CO_A, { address: EMAIL, channel: 'email' }), false);

  list.suppress(CO_A, { address: 'bob@example.com', channel: 'email', reason: 'unsubscribed' });
  assert.deepEqual(list.unsuppress(CO_A, { address: 'bob@example.com', channel: 'email' }), { ok: true });
  assert.equal(list.isSuppressed(CO_A, { address: 'bob@example.com', channel: 'email' }), false);
});

test('lifting a soft bounce resets its count', () => {
  const list = createSuppressionList();
  for (let i = 0; i < 3; i++) list.suppress(CO_A, { address: EMAIL, channel: 'email', reason: 'bounce_soft' });
  list.unsuppress(CO_A, { address: EMAIL, channel: 'email' });
  assert.deepEqual(
    list.suppress(CO_A, { address: EMAIL, channel: 'email', reason: 'bounce_soft' }),
    { ok: true, suppressed: false, softBounces: 1 },
  );
});

test('unsuppress on an address that is not suppressed is refused', () => {
  const list = createSuppressionList();
  assert.deepEqual(list.unsuppress(CO_A, { address: EMAIL, channel: 'email' }), { ok: false, error: 'not_suppressed' });
});

test('a permanent suppression is not weakened by a later softer reason', () => {
  const list = createSuppressionList();
  list.suppress(CO_A, { address: EMAIL, channel: 'email', reason: 'complaint' });
  const r = list.suppress(CO_A, { address: EMAIL, channel: 'email', reason: 'unsubscribed' });
  assert.deepEqual(r, { ok: true, suppressed: true, reason: 'complaint' });
  assert.deepEqual(list.unsuppress(CO_A, { address: EMAIL, channel: 'email' }), { ok: false, error: 'permanent' });
});

test('another company is unaffected by a suppression', () => {
  const list = createSuppressionList();
  list.suppress(CO_A, { address: EMAIL, channel: 'email', reason: 'complaint' });
  assert.equal(list.isSuppressed(CO_A, { address: EMAIL, channel: 'email' }), true);
  assert.equal(list.isSuppressed(CO_B, { address: EMAIL, channel: 'email' }), false);
});

test('another company keeps its own soft bounce count', () => {
  const list = createSuppressionList();
  list.suppress(CO_A, { address: EMAIL, channel: 'email', reason: 'bounce_soft' });
  list.suppress(CO_A, { address: EMAIL, channel: 'email', reason: 'bounce_soft' });
  assert.deepEqual(
    list.suppress(CO_B, { address: EMAIL, channel: 'email', reason: 'bounce_soft' }),
    { ok: true, suppressed: false, softBounces: 1 },
  );
  assert.equal(list.isSuppressed(CO_B, { address: EMAIL, channel: 'email' }), false);
});

test('another company cannot lift a suppression', () => {
  const list = createSuppressionList();
  list.suppress(CO_A, { address: EMAIL, channel: 'email', reason: 'unsubscribed' });
  assert.deepEqual(list.unsuppress(CO_B, { address: EMAIL, channel: 'email' }), { ok: false, error: 'not_suppressed' });
  assert.equal(list.isSuppressed(CO_A, { address: EMAIL, channel: 'email' }), true);
});

test('email matches case-insensitively and ignores surrounding whitespace', () => {
  const list = createSuppressionList();
  list.suppress(CO_A, { address: '  Ada@Example.COM ', channel: 'email', reason: 'complaint' });
  assert.equal(list.isSuppressed(CO_A, { address: 'ada@example.com', channel: 'email' }), true);
  assert.equal(list.isSuppressed(CO_A, { address: 'ADA@EXAMPLE.COM', channel: 'email' }), true);
});

test('phone numbers normalise to digits with a leading plus', () => {
  const list = createSuppressionList();
  list.suppress(CO_A, { address: '+61 (400) 000-000', channel: 'whatsapp', reason: 'complaint' });
  assert.equal(list.isSuppressed(CO_A, { address: '+61400000000', channel: 'whatsapp' }), true);
  assert.equal(list.isSuppressed(CO_A, { address: '61.400.000.000', channel: 'whatsapp' }), false);
});

test('suppression is channel-specific', () => {
  const list = createSuppressionList();
  list.suppress(CO_A, { address: EMAIL, channel: 'email', reason: 'complaint' });
  assert.equal(list.isSuppressed(CO_A, { address: EMAIL, channel: 'telegram' }), false);
});

test('invalid company id is refused by suppress and unsuppress', () => {
  const list = createSuppressionList();
  const input = { address: EMAIL, channel: 'email', reason: 'complaint' };
  assert.deepEqual(list.suppress('not-a-uuid', input), { ok: false, error: 'invalid_company' });
  assert.deepEqual(list.suppress('', input), { ok: false, error: 'invalid_company' });
  assert.deepEqual(list.unsuppress('not-a-uuid', { address: EMAIL, channel: 'email' }), { ok: false, error: 'invalid_company' });
});

test('invalid company id makes isSuppressed fail closed', () => {
  const list = createSuppressionList();
  assert.equal(list.isSuppressed('not-a-uuid', { address: EMAIL, channel: 'email' }), true);
});

test('unknown reason is refused with invalid_reason', () => {
  const list = createSuppressionList();
  assert.deepEqual(
    list.suppress(CO_A, { address: EMAIL, channel: 'email', reason: 'soft_bounce_count' }),
    { ok: false, error: 'invalid_reason' },
  );
  assert.deepEqual(
    list.suppress(CO_A, { address: EMAIL, channel: 'email', reason: 'spam' }),
    { ok: false, error: 'invalid_reason' },
  );
  assert.equal(list.isSuppressed(CO_A, { address: EMAIL, channel: 'email' }), false);
});

test('malformed address and unknown channel are refused', () => {
  const list = createSuppressionList();
  assert.deepEqual(
    list.suppress(CO_A, { address: 'not-an-email', channel: 'email', reason: 'complaint' }),
    { ok: false, error: 'invalid_address' },
  );
  assert.deepEqual(
    list.suppress(CO_A, { address: EMAIL, channel: 'fax', reason: 'complaint' }),
    { ok: false, error: 'invalid_channel' },
  );
});

// Suppression rule tests (node:test). Pure in-memory list: no database, no network, no clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuppressionList, SOFT_BOUNCE_THRESHOLD } from '../../server/modules/comms/suppression.ts';

const COMPANY_A = '11111111-1111-4111-8111-111111111111';
const COMPANY_B = '22222222-2222-4222-8222-222222222222';
const ADA = { channel: 'email', address: 'ada@example.com' };
const GRACE = { channel: 'email', address: 'grace@example.com' };

test('a hard bounce suppresses the address immediately', () => {
  const list = createSuppressionList();
  const result = list.suppress(COMPANY_A, { ...ADA, reason: 'bounce_hard' });
  assert.deepEqual(result, { ok: true, suppressed: true, reason: 'bounce_hard' });
  assert.equal(list.isSuppressed(COMPANY_A, ADA), true);
  assert.equal(list.reasonFor(COMPANY_A, ADA), 'bounce_hard');
});

test('a soft bounce does not suppress before the third one', () => {
  const list = createSuppressionList();
  assert.equal(SOFT_BOUNCE_THRESHOLD, 3);
  const first = list.suppress(COMPANY_A, { ...ADA, reason: 'bounce_soft' });
  assert.deepEqual(first, { ok: true, suppressed: false, softBounces: 1 });
  assert.equal(list.isSuppressed(COMPANY_A, ADA), false);
  const second = list.suppress(COMPANY_A, { ...ADA, reason: 'bounce_soft' });
  assert.deepEqual(second, { ok: true, suppressed: false, softBounces: 2 });
  assert.equal(list.isSuppressed(COMPANY_A, ADA), false);
  assert.equal(list.reasonFor(COMPANY_A, ADA), null);
});

test('a third soft bounce suppresses the address', () => {
  const list = createSuppressionList();
  for (let i = 0; i < SOFT_BOUNCE_THRESHOLD - 1; i += 1) {
    list.suppress(COMPANY_A, { ...ADA, reason: 'bounce_soft' });
  }
  const third = list.suppress(COMPANY_A, { ...ADA, reason: 'bounce_soft' });
  assert.deepEqual(third, { ok: true, suppressed: true, reason: 'soft_bounce_count' });
  assert.equal(list.isSuppressed(COMPANY_A, ADA), true);
  assert.equal(list.reasonFor(COMPANY_A, ADA), 'soft_bounce_count');
});

test('a complaint suppresses the address immediately', () => {
  const list = createSuppressionList();
  const result = list.suppress(COMPANY_A, { ...ADA, reason: 'complaint' });
  assert.deepEqual(result, { ok: true, suppressed: true, reason: 'complaint' });
  assert.equal(list.isSuppressed(COMPANY_A, ADA), true);
  assert.equal(list.reasonFor(COMPANY_A, ADA), 'complaint');
});

test('a complaint cannot be weakened by a later soft bounce', () => {
  const list = createSuppressionList();
  list.suppress(COMPANY_A, { ...ADA, reason: 'complaint' });
  const later = list.suppress(COMPANY_A, { ...ADA, reason: 'bounce_soft' });
  assert.deepEqual(later, { ok: true, suppressed: true, reason: 'complaint' });
  assert.equal(list.reasonFor(COMPANY_A, ADA), 'complaint');
});

test('suppression is per company: another company is not affected', () => {
  const list = createSuppressionList();
  list.suppress(COMPANY_A, { ...ADA, reason: 'complaint' });
  assert.equal(list.isSuppressed(COMPANY_A, ADA), true);
  assert.equal(list.isSuppressed(COMPANY_B, ADA), false);
  assert.equal(list.reasonFor(COMPANY_B, ADA), null);
});

test('soft bounce counts are per company', () => {
  const list = createSuppressionList();
  list.suppress(COMPANY_A, { ...ADA, reason: 'bounce_soft' });
  list.suppress(COMPANY_A, { ...ADA, reason: 'bounce_soft' });
  const otherCompany = list.suppress(COMPANY_B, { ...ADA, reason: 'bounce_soft' });
  assert.deepEqual(otherCompany, { ok: true, suppressed: false, softBounces: 1 });
  assert.equal(list.isSuppressed(COMPANY_B, ADA), false);
});

test('suppression is per contact: another address in the same company is not affected', () => {
  const list = createSuppressionList();
  list.suppress(COMPANY_A, { ...ADA, reason: 'bounce_hard' });
  assert.equal(list.isSuppressed(COMPANY_A, ADA), true);
  assert.equal(list.isSuppressed(COMPANY_A, GRACE), false);
});

test('suppression matches the same contact address regardless of letter case', () => {
  const list = createSuppressionList();
  list.suppress(COMPANY_A, { channel: 'email', address: 'Ada@Example.com', reason: 'complaint' });
  assert.equal(list.isSuppressed(COMPANY_A, ADA), true);
});

test('an unknown company or address fails closed', () => {
  const list = createSuppressionList();
  assert.equal(list.isSuppressed('not-a-uuid', ADA), true);
  assert.equal(list.isSuppressed(COMPANY_A, { channel: 'email', address: 'nope' }), true);
});

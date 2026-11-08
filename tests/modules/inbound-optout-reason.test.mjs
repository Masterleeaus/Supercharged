// Inbound START / YES must only lift an 'unsubscribed' suppression (node:test).
// Pure in-memory: no database, no network, no clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleInboundOptOut } from '../../server/modules/comms/inbound-optout.ts';
import { createSuppressionList } from '../../server/modules/comms/suppression.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const FROM = 'ada@example.com';

function run(suppression, overrides = {}) {
  return handleInboundOptOut({
    companyId: CO_A,
    channel: 'email',
    from: FROM,
    body: 'STOP',
    suppression,
    ...overrides,
  });
}

// Wraps a real list and counts unsuppress calls, so tests can prove START never reaches it.
function spied(list) {
  const calls = { unsuppress: 0 };
  const wrapped = {
    ...list,
    unsuppress: (...args) => {
      calls.unsuppress += 1;
      return list.unsuppress(...args);
    },
  };
  return { wrapped, calls };
}

test('START clears an unsubscribed address', () => {
  const list = createSuppressionList();
  run(list);
  const { wrapped, calls } = spied(list);
  assert.deepEqual(run(wrapped, { body: 'START' }), { action: 'unsuppressed' });
  assert.equal(calls.unsuppress, 1);
  assert.equal(list.isSuppressed(CO_A, { address: FROM, channel: 'email' }), false);
});

test('START does not clear a soft-bounce suppression', () => {
  const list = createSuppressionList();
  for (let i = 0; i < 3; i++) list.suppress(CO_A, { address: FROM, channel: 'email', reason: 'bounce_soft' });
  assert.equal(list.reasonFor(CO_A, { address: FROM, channel: 'email' }), 'soft_bounce_count');
  const { wrapped, calls } = spied(list);
  assert.deepEqual(run(wrapped, { body: 'START' }), { action: 'not_changed', reason: 'not_opt_out' });
  assert.equal(calls.unsuppress, 0);
  assert.equal(list.isSuppressed(CO_A, { address: FROM, channel: 'email' }), true);
});

test('YES does not clear a soft-bounce suppression either', () => {
  const list = createSuppressionList();
  for (let i = 0; i < 3; i++) list.suppress(CO_A, { address: FROM, channel: 'email', reason: 'bounce_soft' });
  assert.deepEqual(run(list, { body: 'yes' }), { action: 'not_changed', reason: 'not_opt_out' });
  assert.equal(list.isSuppressed(CO_A, { address: FROM, channel: 'email' }), true);
});

test('START does not clear a complaint', () => {
  const list = createSuppressionList();
  list.suppress(CO_A, { address: FROM, channel: 'email', reason: 'complaint' });
  const { wrapped, calls } = spied(list);
  assert.deepEqual(run(wrapped, { body: 'START' }), { action: 'not_changed', reason: 'not_opt_out' });
  assert.equal(calls.unsuppress, 0);
  assert.equal(list.reasonFor(CO_A, { address: FROM, channel: 'email' }), 'complaint');
});

test('STOP still suppresses as unsubscribed', () => {
  const list = createSuppressionList();
  assert.deepEqual(run(list, { body: 'STOP' }), { action: 'suppressed' });
  assert.equal(list.reasonFor(CO_A, { address: FROM, channel: 'email' }), 'unsubscribed');
});

test('reasonFor refuses a non-UUID company', () => {
  const list = createSuppressionList();
  list.suppress(CO_A, { address: FROM, channel: 'email', reason: 'unsubscribed' });
  assert.throws(() => list.reasonFor('not-a-uuid', { address: FROM, channel: 'email' }), TypeError);
  assert.throws(() => list.reasonFor('', { address: FROM, channel: 'email' }), TypeError);
  assert.throws(() => list.reasonFor(undefined, { address: FROM, channel: 'email' }), TypeError);
});

test('reasonFor returns null when the address is not suppressed', () => {
  const list = createSuppressionList();
  assert.equal(list.reasonFor(CO_A, { address: FROM, channel: 'email' }), null);
});

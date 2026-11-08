// Test for the inbox insert-conflict branch. Lives in the bundle at tests/modules/.
// Run: node --test --experimental-transform-types tests/modules/inbox-conflict-retry.test.mjs
// STATUS: 5 of 5 pass on Node 22.23.4, run in place in the bundle (tests/modules/).
// Not run against the bundle in place. Mutation check: removing the unique-conflict catch makes tests 1 and 2 fail.
//
// Covers the insert-conflict branch of recordInbound (server/modules/inbox/inbox-service.ts, the
// catch around store.insertMessage). No existing test reaches that branch: the duplicate tests
// hit the early findMessageByExternalId return, and the race test serializes through the keyed lock.
// Here the first externalId lookup is made stale on purpose, as if another instance inserted the
// same message between the read and the insert. The in-memory store then raises the same
// UniqueConflictError the Drizzle store would raise as 23505.
//
// No database, no provider, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInboxService, InMemoryInboxStore, InMemoryApprovalPort, sha256 } from '../../server/modules/inbox/index.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';

const inbound = (over = {}) => ({
  channel: 'sms',
  address: '+61400000003',
  displayName: 'Lin',
  body: 'Can we move to 10am?',
  externalId: 'ext-retry-1',
  ...over,
});

function build() {
  const store = new InMemoryInboxStore();
  const approvals = new InMemoryApprovalPort();
  let seq = 0;
  const service = createInboxService({ store, approvals, newId: () => `retry_${++seq}` });
  return { store, approvals, service };
}

/**
 * Makes the first findMessageByExternalId call return null (a stale read), so the service goes on
 * to insertMessage. Later calls read the real store. Returns a counter of inserts that were attempted.
 */
function makeFirstLookupStale(store) {
  const real = store.findMessageByExternalId.bind(store);
  let lookups = 0;
  store.findMessageByExternalId = async (companyId, channel, externalId) => {
    lookups += 1;
    if (lookups === 1) return null;
    return real(companyId, channel, externalId);
  };
  return () => lookups;
}

function countInsertAttempts(store) {
  const real = store.insertMessage.bind(store);
  const attempts = { total: 0, succeeded: 0 };
  store.insertMessage = async (message) => {
    attempts.total += 1;
    await real(message);
    attempts.succeeded += 1;
  };
  return attempts;
}

test('conflict: a stale lookup then a unique conflict on insert returns the stored message as a duplicate', async () => {
  const { store, service } = build();
  const first = await service.recordInbound(CO_A, inbound());

  const attempts = countInsertAttempts(store);
  makeFirstLookupStale(store);
  const retry = await service.recordInbound(CO_A, inbound({ body: 'a different retry body' }));

  assert.equal(attempts.total, 1, 'the service tried to insert once, after the stale read');
  assert.equal(attempts.succeeded, 0, 'the retry insert hit the unique key and stored nothing');
  assert.equal(retry.duplicate, true);
  assert.equal(retry.message.id, first.message.id, 'returns the stored row, not a new one');
  assert.equal(retry.thread.id, first.thread.id, 'returns the stored message\'s thread');
  assert.equal((await service.listMessages(CO_A, first.thread.id)).length, 1, 'still one message');
});

test('conflict: the retry returns the stored body and hash, not the body of the losing delivery', async () => {
  const { store, service } = build();
  const first = await service.recordInbound(CO_A, inbound());

  makeFirstLookupStale(store);
  const retry = await service.recordInbound(CO_A, inbound({ body: 'a different retry body' }));

  assert.equal(retry.message.body, 'Can we move to 10am?');
  assert.equal(retry.message.bodySha256, sha256('Can we move to 10am?'));
  assert.equal(retry.message.bodySha256, first.message.bodySha256);
});

test('conflict: a unique conflict with no stored row to return is rethrown, not swallowed', async () => {
  const { store, service } = build();
  await service.recordInbound(CO_A, inbound());

  // The stale read stays null, and the store's lookup after the conflict also finds nothing.
  store.findMessageByExternalId = async () => null;
  await assert.rejects(service.recordInbound(CO_A, inbound()), (err) => err.name === 'UniqueConflictError');
});

test('conflict: a non-unique insert error is rethrown and is not treated as a duplicate', async () => {
  const { store, service } = build();
  store.insertMessage = async () => {
    throw new Error('disk full');
  };
  await assert.rejects(service.recordInbound(CO_A, inbound()), /disk full/);
});

test('concurrent: three simultaneous deliveries of one externalId make exactly one insert', async () => {
  const { store, service } = build();
  const attempts = countInsertAttempts(store);

  const results = await Promise.all([
    service.recordInbound(CO_A, inbound()),
    service.recordInbound(CO_A, inbound()),
    service.recordInbound(CO_A, inbound()),
  ]);

  assert.equal(attempts.succeeded, 1, 'exactly one row was inserted');
  assert.equal(results.filter((r) => r.duplicate === false).length, 1, 'exactly one original');
  assert.equal(results.filter((r) => r.duplicate === true).length, 2, 'the other two are duplicates');
  const ids = new Set(results.map((r) => r.message.id));
  assert.equal(ids.size, 1, 'all three return the same stored message');
});

// Durable suppression list, tested with an in-memory fake persistence (no database, no network).
// The real PostgreSQL adapter and the restart test are in tests/postgres/suppression-postgres-durable.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSuppressionList,
  createDurableSuppressionList,
} from '../../server/modules/comms/suppression.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const ADA = { address: 'ada@example.com', channel: 'email' };

// Fake store keyed by company. It applies each write the way the SQL does, and can be told to fail.
function fakeStore(initial = {}) {
  const rows = new Map();
  for (const [company, data] of Object.entries(initial)) rows.set(company, structuredClone(data));
  const log = [];
  const state = { failWrites: false };
  const bucket = (company) => {
    if (!rows.has(company)) rows.set(company, { suppressions: [], softBounces: [] });
    return rows.get(company);
  };
  const same = (r, c) => r.channel === c.channel && r.address === c.address;
  return {
    log,
    state,
    rowsFor: (company) => structuredClone(rows.get(company) ?? { suppressions: [], softBounces: [] }),
    persistence: {
      async load(company) {
        return structuredClone(bucket(company));
      },
      async write(change) {
        log.push(change.op);
        if (state.failWrites) throw new Error(`db refused ${change.address}`);
        const b = bucket(change.companyId);
        if (change.op === 'suppressed') {
          const existing = b.suppressions.find((r) => same(r, change));
          if (existing) existing.reason = change.reason;
          else b.suppressions.push({ channel: change.channel, address: change.address, reason: change.reason });
          b.softBounces = b.softBounces.filter((r) => !same(r, change));
        } else if (change.op === 'soft_bounce') {
          const existing = b.softBounces.find((r) => same(r, change));
          if (existing) existing.count = change.count;
          else b.softBounces.push({ channel: change.channel, address: change.address, count: change.count });
        } else {
          b.suppressions = b.suppressions.filter((r) => !same(r, change));
          b.softBounces = b.softBounces.filter((r) => !same(r, change));
        }
      },
    },
  };
}

test('an unwarmed company fails closed: every address reads as suppressed and nothing is written', async () => {
  const store = fakeStore();
  const list = createDurableSuppressionList({ persistence: store.persistence });
  assert.equal(list.isSuppressed(CO_A, ADA), true);
  assert.deepEqual(list.suppress(CO_A, { ...ADA, reason: 'complaint' }), { ok: false, error: 'not_loaded' });
  assert.deepEqual(list.unsuppress(CO_A, ADA), { ok: false, error: 'not_loaded' });
  assert.throws(() => list.reasonFor(CO_A, ADA), /not_loaded/);
  await list.flush();
  assert.deepEqual(store.log, []);
});

test('a warmed company reads the rows from storage, and another company is not affected', async () => {
  const store = fakeStore({
    [CO_A]: { suppressions: [{ channel: 'email', address: 'ada@example.com', reason: 'bounce_hard' }], softBounces: [] },
  });
  const list = createDurableSuppressionList({ persistence: store.persistence });
  await list.warm(CO_A);
  await list.warm(CO_B);
  assert.equal(list.isSuppressed(CO_A, ADA), true);
  assert.equal(list.reasonFor(CO_A, ADA), 'bounce_hard');
  assert.equal(list.isSuppressed(CO_B, ADA), false);
  assert.equal(list.reasonFor(CO_B, ADA), null);
});

test('changes reach storage in order, and flush resolves only after they are written', async () => {
  const store = fakeStore();
  const list = createDurableSuppressionList({ persistence: store.persistence });
  await list.warm(CO_A);
  list.suppress(CO_A, { ...ADA, reason: 'bounce_soft' });
  list.suppress(CO_A, { ...ADA, reason: 'bounce_soft' });
  list.suppress(CO_A, { ...ADA, reason: 'bounce_soft' });
  list.suppress(CO_A, { address: 'bob@example.com', channel: 'email', reason: 'unsubscribed' });
  list.unsuppress(CO_A, { address: 'bob@example.com', channel: 'email' });
  await list.flush();
  assert.deepEqual(store.log, ['soft_bounce', 'soft_bounce', 'suppressed', 'suppressed', 'unsuppressed']);
  assert.deepEqual(store.rowsFor(CO_A).suppressions, [{ channel: 'email', address: 'ada@example.com', reason: 'soft_bounce_count' }]);
  assert.deepEqual(store.rowsFor(CO_A).softBounces, []);
});

test('a suppression written by one list is read by a new list that warms the same company', async () => {
  const store = fakeStore();
  const first = createDurableSuppressionList({ persistence: store.persistence });
  await first.warm(CO_A);
  first.suppress(CO_A, { ...ADA, reason: 'complaint' });
  first.suppress(CO_A, { address: 'bob@example.com', channel: 'email', reason: 'bounce_soft' });
  first.suppress(CO_A, { address: 'bob@example.com', channel: 'email', reason: 'bounce_soft' });
  await first.flush();

  // A new list, as after a restart. Nothing is shared with the first one except the store.
  const second = createDurableSuppressionList({ persistence: store.persistence });
  await second.warm(CO_A);
  assert.equal(second.isSuppressed(CO_A, ADA), true);
  assert.equal(second.reasonFor(CO_A, ADA), 'complaint');
  // The two earlier soft bounces were stored, so one more reaches the threshold.
  assert.deepEqual(
    second.suppress(CO_A, { address: 'bob@example.com', channel: 'email', reason: 'bounce_soft' }),
    { ok: true, suppressed: true, reason: 'soft_bounce_count' },
  );
});

test('a failed write is reported by flush and the address stays blocked in this process', async () => {
  const store = fakeStore();
  store.state.failWrites = true;
  const list = createDurableSuppressionList({ persistence: store.persistence });
  await list.warm(CO_A);
  list.suppress(CO_A, { ...ADA, reason: 'complaint' });
  assert.equal(list.isSuppressed(CO_A, ADA), true);
  await assert.rejects(list.flush(), (error) => {
    assert.equal(error.message, 'suppression_write_failed');
    // The address is not in the error text.
    assert.equal(String(error.message).includes('ada@example.com'), false);
    return true;
  });
  // Sticky: a later flush still reports the lost write.
  await assert.rejects(list.flush(), /suppression_write_failed/);
});

test('warm merges storage into memory and never removes a suppression held in memory', async () => {
  const store = fakeStore();
  const list = createDurableSuppressionList({ persistence: store.persistence });
  await list.warm(CO_A);
  list.suppress(CO_A, { ...ADA, reason: 'complaint' });
  await list.flush();
  // Another process lifts it in storage. This process keeps blocking until restart (fail closed).
  await store.persistence.write({ op: 'unsuppressed', companyId: CO_A, channel: 'email', address: 'ada@example.com' });
  await list.warm(CO_A);
  assert.equal(list.isSuppressed(CO_A, ADA), true);
});

test('invalid company and channel are refused by the durable list as before', async () => {
  const store = fakeStore();
  const list = createDurableSuppressionList({ persistence: store.persistence });
  await assert.rejects(list.warm('not-a-uuid'), /invalid_company/);
  assert.deepEqual(list.suppress('not-a-uuid', { ...ADA, reason: 'complaint' }), { ok: false, error: 'invalid_company' });
  assert.equal(list.isSuppressed('not-a-uuid', ADA), true);
});

test('the in-memory list keeps its interface: no warm or flush, and it works without warming', () => {
  const list = createSuppressionList();
  assert.equal(list.warm, undefined);
  assert.equal(list.flush, undefined);
  assert.deepEqual(list.suppress(CO_A, { ...ADA, reason: 'complaint' }), { ok: true, suppressed: true, reason: 'complaint' });
  assert.equal(list.isSuppressed(CO_A, ADA), true);
});

test('the durable factory refuses a missing persistence adapter', () => {
  assert.throws(() => createDurableSuppressionList({}), /persistence_required/);
  assert.throws(() => createDurableSuppressionList({ persistence: { load() {} } }), /persistence_required/);
});

import test from 'node:test';
import assert from 'node:assert/strict';

const { createSyncEngine } = await import('../../server/connectors/sync/engine.ts');
const { createMemorySyncStores } = await import('../../server/connectors/sync/stores.ts');
const { createConnectorAdmin } = await import('../../server/connectors/admin/actions.ts');
const { ConnectorError } = await import('../../server/connectors/sdk/contract.ts');

const CO = '11111111-1111-4111-8111-111111111111';
const CO2 = '22222222-2222-4222-8222-222222222222';
const CONN = 'fake-crm';
const OTHER_CONN = 'other-crm';
const T0 = '2026-11-18T10:00:00Z';

// Stub registry: every connector id is registered. The dead-letter actions only check registration.
const registry = { get: () => ({ definition: {} }) };
const unused = {};

function setup({ withSync = true, withPush = true } = {}) {
  let n = 0;
  const stores = createMemorySyncStores();
  const sync = createSyncEngine({
    stores,
    now: () => new Date('2026-11-18T00:00:00Z'),
    newId: () => `id-${++n}`,
  });
  const pushes = [];
  const failNext = false;
  const push = async (change) => {
    pushes.push(change);
    if (failNext) throw new ConnectorError('upstream', 'vendor down');
    return { externalId: 'vj-1', updatedAt: change.updatedAt };
  };
  const admin = createConnectorAdmin({
    registry,
    vault: unused,
    state: unused,
    audit: { record: async () => {} },
    credentialsFor: async () => ({}),
    ...(withSync ? { sync } : {}),
    ...(withSync && withPush ? { pushFor: () => push } : {}),
  });
  return { admin, sync, pushes, stores };
}

/** Stages a local job edit and flushes it against a vendor that is down, so one outbound dead letter exists. */
async function deadLetterOne(sync, companyId = CO, connectorId = CONN) {
  await sync.stageLocal(companyId, connectorId, {
    entity: 'job',
    canonicalId: 'job-1',
    op: 'upsert',
    data: { status: 'booked', customerNote: 'PRIVATE-NOTE' },
    updatedAt: T0,
  });
  const failing = async () => {
    throw new ConnectorError('upstream', 'vendor down');
  };
  const report = await sync.flush(companyId, connectorId, failing);
  assert.equal(report.deadLettered, 1, 'the failed push is dead-lettered');
}

test('admin lists dead letters for one company and connector, without payloads', async () => {
  const { admin, sync } = setup();
  await deadLetterOne(sync);
  const letters = await admin.deadLetters(CO, CONN);
  assert.equal(letters.length, 1);
  const [row] = letters;
  assert.equal(row.connectorId, CONN);
  assert.equal(row.direction, 'outbound');
  assert.equal(row.entity, 'job');
  assert.equal(row.reason, 'upstream');
  assert.equal('event' in row, false, 'the event payload is not part of the admin view');
  assert.equal(JSON.stringify(letters).includes('PRIVATE-NOTE'), false, 'customer data is not exposed in the list');
});

test('admin replays a dead letter once: the vendor is pushed once and the letter is cleared', async () => {
  const { admin, sync, pushes } = setup();
  await deadLetterOne(sync);
  const [row] = await admin.deadLetters(CO, CONN);

  assert.deepEqual(await admin.replayDeadLetter(CO, CONN, row.id), { status: 'replayed' });
  assert.equal(pushes.length, 1, 'exactly one vendor push for the replay');
  assert.deepEqual(await admin.deadLetters(CO, CONN), []);

  assert.deepEqual(await admin.replayDeadLetter(CO, CONN, row.id), { status: 'not_found' }, 'a second replay does nothing');
  assert.equal(pushes.length, 1, 'no duplicate push after a second replay');
});

test('a dead letter is invisible and not replayable from another company', async () => {
  const { admin, sync, pushes } = setup();
  await deadLetterOne(sync);
  const [row] = await admin.deadLetters(CO, CONN);

  assert.deepEqual(await admin.deadLetters(CO2, CONN), []);
  assert.deepEqual(await admin.replayDeadLetter(CO2, CONN, row.id), { status: 'not_found' });
  assert.equal(pushes.length, 0, 'the other company caused no push');
  assert.equal((await admin.deadLetters(CO, CONN)).length, 1, 'the owning company still has the letter');
});

test('a dead letter cannot be replayed through a different connector id', async () => {
  const { admin, sync, pushes } = setup();
  await deadLetterOne(sync);
  const [row] = await admin.deadLetters(CO, CONN);

  assert.deepEqual(await admin.deadLetters(CO, OTHER_CONN), []);
  assert.deepEqual(await admin.replayDeadLetter(CO, OTHER_CONN, row.id), { status: 'not_found' });
  assert.equal(pushes.length, 0);
});

test('an outbound replay without a configured push fails closed and keeps the letter', async () => {
  const { admin, sync, pushes } = setup({ withPush: false });
  await deadLetterOne(sync);
  const [row] = await admin.deadLetters(CO, CONN);
  assert.deepEqual(await admin.replayDeadLetter(CO, CONN, row.id), { status: 'failed' });
  assert.equal(pushes.length, 0, 'no vendor call without a push');
  assert.equal((await admin.deadLetters(CO, CONN)).length, 1, 'the letter is kept for a later replay');
});

test('dead-letter actions refuse when the sync engine is not configured', async () => {
  const { admin } = setup({ withSync: false });
  await assert.rejects(() => admin.deadLetters(CO, CONN), (err) => err instanceof ConnectorError && err.code === 'validation');
  await assert.rejects(() => admin.replayDeadLetter(CO, CONN, 'x'), (err) => err instanceof ConnectorError && err.code === 'validation');
});

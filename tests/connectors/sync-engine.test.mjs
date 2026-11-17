import test from 'node:test';
import assert from 'node:assert/strict';

const { createSyncEngine } = await import('../../server/connectors/sync/engine.ts');
const { createMemorySyncStores } = await import('../../server/connectors/sync/stores.ts');
const { resolveConflict, DEFAULT_CONFLICT_RULES } = await import('../../server/connectors/sync/conflict.ts');
const { ConnectorError } = await import('../../server/connectors/sdk/contract.ts');

const CO = '11111111-1111-4111-8111-111111111111';
const CO2 = '22222222-2222-4222-8222-222222222222';
const CONN = 'fake-crm';

function setup(extra = {}) {
  let n = 0;
  const stores = createMemorySyncStores();
  const engine = createSyncEngine({
    stores,
    now: () => new Date('2026-11-18T00:00:00Z'),
    newId: () => `id-${++n}`,
    ...extra,
  });
  return { engine, stores };
}

const ev = (over = {}) => ({
  eventId: 'e1',
  entity: 'contact',
  externalId: 'x1',
  op: 'upsert',
  data: { name: 'Ada' },
  updatedAt: '2026-11-18T10:00:00Z',
  ...over,
});

test('replaying the same webhook delivery creates one record and reports a duplicate', async () => {
  const { engine } = setup();
  const first = await engine.receive(CO, CONN, [ev()]);
  const again = await engine.receive(CO, CONN, [ev()]);
  assert.equal(first.applied, 1);
  assert.equal(again.duplicate, 1);
  assert.equal(again.applied, 0);
  const dl = await engine.deadLetters(CO);
  assert.equal(dl.length, 0);
});

test('different vendor events for one external id dedupe onto one canonical record', async () => {
  const { engine, stores } = setup();
  await engine.receive(CO, CONN, [ev({ eventId: 'e1' })]);
  await engine.receive(CO, CONN, [ev({ eventId: 'e2', data: { name: 'Ada L' }, updatedAt: '2026-11-18T11:00:00Z' })]);
  const canonical = await stores.identities.canonicalFor(CO, CONN, 'contact', 'x1');
  assert.equal(canonical, 'id-1');
  const rec = await stores.records.get(CO, 'contact', 'id-1');
  assert.equal(rec.data.name, 'Ada L');
});

test('canonical id on the event links to an existing record instead of creating a second one', async () => {
  const { engine, stores } = setup();
  await stores.records.put(CO, { id: 'job-9', entity: 'contact', updatedAt: '2026-11-17T00:00:00Z', origin: 'local', data: { name: 'Old' }, deleted: false });
  await engine.receive(CO, CONN, [ev({ canonicalId: 'job-9', externalId: 'ext-77', updatedAt: '2026-11-18T09:00:00Z' })]);
  assert.equal(await stores.identities.canonicalFor(CO, CONN, 'contact', 'ext-77'), 'job-9');
  assert.equal((await stores.records.get(CO, 'contact', 'job-9')).data.name, 'Ada');
});

test('system of record wins for jobs: a remote change is ignored and reported, not applied', async () => {
  const { engine, stores } = setup();
  await stores.records.put(CO, { id: 'job-1', entity: 'job', updatedAt: '2026-11-17T00:00:00Z', origin: 'local', data: { status: 'booked' }, deleted: false });
  await stores.identities.link(CO, CONN, 'job', 'vj-1', 'job-1');
  const report = await engine.receive(CO, CONN, [ev({ entity: 'job', externalId: 'vj-1', eventId: 'j1', data: { status: 'cancelled' } })]);
  assert.equal(report.ignored, 1);
  assert.equal((await stores.records.get(CO, 'job', 'job-1')).data.status, 'booked');
});

test('latest_wins keeps the newer contact and ignores a stale change', async () => {
  assert.deepEqual(resolveConflict(DEFAULT_CONFLICT_RULES.contact, { updatedAt: '2026-11-18T10:00:00Z', data: {} }, { updatedAt: '2026-11-18T09:00:00Z', data: {} }), { action: 'ignore', reason: 'stale' });
  assert.deepEqual(resolveConflict(DEFAULT_CONFLICT_RULES.contact, { updatedAt: '2026-11-18T10:00:00Z', data: {} }, { updatedAt: '2026-11-18T11:00:00Z', data: {} }), { action: 'apply' });
});

test('manual conflict with differing data goes to the dead-letter queue with reason conflict_manual', async () => {
  const { engine, stores } = setup({ rules: { contact: { strategy: 'manual' } } });
  await stores.records.put(CO, { id: 'c-1', entity: 'contact', updatedAt: '2026-11-17T00:00:00Z', origin: 'local', data: { name: 'Local' }, deleted: false });
  await stores.identities.link(CO, CONN, 'contact', 'x1', 'c-1');
  const report = await engine.receive(CO, CONN, [ev({ eventId: 'm1' })]);
  assert.equal(report.deadLettered, 1);
  const [dl] = await engine.deadLetters(CO, CONN);
  assert.equal(dl.reason, 'conflict_manual');
  assert.equal(dl.attempts, 1);
});

test('a failed event is dead-lettered with a reason code and replay applies it once after the fix', async () => {
  const { engine, stores } = setup();
  const bad = ev({ eventId: 'bad', updatedAt: 'not-a-date' });
  const r1 = await engine.receive(CO, CONN, [bad]);
  assert.equal(r1.deadLettered, 1);
  const [dl] = await engine.deadLetters(CO);
  assert.equal(dl.reason, 'validation');

  // The same delivery arriving again must not create a second dead letter.
  await engine.receive(CO, CONN, [bad]);
  assert.equal((await engine.deadLetters(CO)).length, 1);
  assert.equal((await engine.deadLetters(CO))[0].attempts, 2);

  // Replay still fails while the payload is bad, and the attempt is counted.
  assert.equal(await engine.replay(CO, dl.id), 'failed');
  assert.equal((await engine.deadLetters(CO))[0].attempts, 3);

  // Replay after a fixed copy of the same event lands once; a second replay is a no-op.
  await engine.receive(CO, CONN, [ev({ eventId: 'fixed', externalId: 'x9' })]);
  const fixed = { ...dl.event, updatedAt: '2026-11-18T10:00:00Z' };
  await stores.deadLetters.update({ ...dl, event: fixed });
  assert.equal(await engine.replay(CO, dl.id), 'replayed');
  assert.equal(await engine.replay(CO, dl.id), 'not_found');
  assert.equal((await engine.deadLetters(CO)).length, 0);
  const canonicalCount = await countContacts(stores, CO);
  assert.equal(canonicalCount, 2, 'the fixed event creates one record, not a duplicate');
});

test('replaying a dead letter whose event was already applied does not duplicate the record', async () => {
  const { engine, stores } = setup();
  const e = ev({ eventId: 'dup-replay', externalId: 'z1' });
  await engine.receive(CO, CONN, [e]);
  await stores.deadLetters.add({ id: 'dl-x', companyId: CO, connectorId: CONN, eventId: e.eventId, event: e, reason: 'upstream', attempts: 1, createdAt: 'a', updatedAt: 'a' });
  assert.equal(await engine.replay(CO, 'dl-x'), 'replayed');
  assert.equal(await countContacts(stores, CO), 1);
});

test('poll advances the cursor only after the page is processed, and skips an unchanged cursor write', async () => {
  const { engine, stores } = setup();
  const seen = [];
  const fetch = async (cursor) => {
    seen.push(cursor);
    return cursor === null
      ? { events: [ev({ eventId: 'p1', externalId: 'a' })], nextCursor: 'c1' }
      : { events: [], nextCursor: cursor };
  };
  const r1 = await engine.pull(CO, CONN, fetch);
  assert.equal(r1.applied, 1);
  assert.equal(await stores.cursors.get(CO, CONN), 'c1');
  const r2 = await engine.pull(CO, CONN, fetch);
  assert.deepEqual(seen, [null, 'c1']);
  assert.equal(r2.cursor, 'c1');
});

test('a failing fetch leaves the cursor where it was', async () => {
  const { engine, stores } = setup();
  await stores.cursors.set(CO, CONN, 'c0');
  await assert.rejects(engine.pull(CO, CONN, async () => { throw new ConnectorError('rate_limited', 'slow down'); }), ConnectorError);
  assert.equal(await stores.cursors.get(CO, CONN), 'c0');
});

test('dead letters are scoped to their company', async () => {
  const { engine } = setup();
  await engine.receive(CO, CONN, [ev({ eventId: 'iso', updatedAt: 'bad' })]);
  assert.equal((await engine.deadLetters(CO2)).length, 0);
  assert.equal((await engine.deadLetters(CO)).length, 1);
  const [dl] = await engine.deadLetters(CO);
  assert.equal(await engine.replay(CO2, dl.id), 'not_found');
});

async function countContacts(stores, companyId) {
  const rows = [];
  for (const id of ['id-1', 'id-2', 'id-3', 'id-4', 'id-5', 'id-6', 'z', 'x']) {
    const r = await stores.records.get(companyId, 'contact', id);
    if (r) rows.push(r);
  }
  return rows.length;
}

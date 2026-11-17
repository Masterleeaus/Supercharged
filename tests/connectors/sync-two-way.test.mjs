import test from 'node:test';
import assert from 'node:assert/strict';

const { createSyncEngine } = await import('../../server/connectors/sync/engine.ts');
const { createMemorySyncStores } = await import('../../server/connectors/sync/stores.ts');
const { resolveOutbound, DEFAULT_CONFLICT_RULES } = await import('../../server/connectors/sync/conflict.ts');
const { ConnectorError } = await import('../../server/connectors/sdk/contract.ts');

const CO = '11111111-1111-4111-8111-111111111111';
const CO2 = '22222222-2222-4222-8222-222222222222';
const CONN = 'fake-crm';
const T0 = '2026-11-18T10:00:00Z';
const T1 = '2026-11-18T10:05:00Z';
const T2 = '2026-11-18T10:10:00Z';

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

/** A fake vendor. Records every push and can fail or answer with a fixed id and version. */
function vendor({ externalId = 'v-1', updatedAt = null, fail = null } = {}) {
  const calls = [];
  const push = async (change) => {
    calls.push(change);
    if (fail) throw fail();
    return { externalId, updatedAt: updatedAt ?? change.updatedAt };
  };
  return { calls, push };
}

const inbound = (over = {}) => ({
  eventId: 'in-1',
  entity: 'contact',
  externalId: 'vc-1',
  op: 'upsert',
  data: { name: 'Ada' },
  updatedAt: T0,
  ...over,
});

test('a local job edit is staged, pushed once with an idempotency key, and linked to the vendor id', async () => {
  const { engine, stores } = setup();
  const v = vendor({ externalId: 'vj-9' });
  const staged = await engine.stageLocal(CO, CONN, { entity: 'job', canonicalId: 'job-1', op: 'upsert', data: { status: 'booked' }, updatedAt: T0 });
  assert.equal(staged.status, 'staged');
  assert.equal((await engine.pendingChanges(CO, CONN)).length, 1);

  const report = await engine.flush(CO, CONN, v.push);
  assert.deepEqual(report, { pushed: 1, ignored: 0, deadLettered: 0, pending: 0 });
  assert.equal(v.calls[0].externalId, null, 'a new record is pushed without a vendor id');
  assert.equal(v.calls[0].idempotencyKey, staged.outboundId);
  assert.equal(await stores.identities.canonicalFor(CO, CONN, 'job', 'vj-9'), 'job-1');
});

test('two edits before a flush coalesce into one push that carries the latest data', async () => {
  const { engine } = setup();
  const v = vendor();
  const a = await engine.stageLocal(CO, CONN, { entity: 'job', canonicalId: 'job-2', op: 'upsert', data: { status: 'quoted' }, updatedAt: T0 });
  const b = await engine.stageLocal(CO, CONN, { entity: 'job', canonicalId: 'job-2', op: 'upsert', data: { status: 'booked' }, updatedAt: T1 });
  assert.equal(a.outboundId, b.outboundId, 'the pending change keeps its id');
  assert.equal((await engine.pendingChanges(CO, CONN)).length, 1);
  await engine.flush(CO, CONN, v.push);
  assert.equal(v.calls.length, 1);
  assert.deepEqual(v.calls[0].data, { status: 'booked' });
});

test('a remote-owned entity refuses local edits and stages nothing', async () => {
  const { engine } = setup();
  const r = await engine.stageLocal(CO, CONN, { entity: 'message', canonicalId: 'm-1', op: 'upsert', data: { body: 'hi' }, updatedAt: T0 });
  assert.deepEqual(r, { status: 'refused', reason: 'system_of_record' });
  assert.equal((await engine.pendingChanges(CO, CONN)).length, 0);
});

test('an echo of our own push does not stage another push or duplicate the record', async () => {
  const { engine, stores } = setup();
  const v = vendor({ externalId: 'vc-echo' });
  await engine.stageLocal(CO, CONN, { entity: 'contact', canonicalId: 'c-1', op: 'upsert', data: { name: 'Ada' }, updatedAt: T0 });
  await engine.flush(CO, CONN, v.push);

  const echo = await engine.receive(CO, CONN, [inbound({ eventId: 'echo-1', externalId: 'vc-echo', updatedAt: T0 })]);
  assert.equal(echo.deadLettered, 0);
  assert.equal((await engine.pendingChanges(CO, CONN)).length, 0);
  assert.equal(v.calls.length, 1, 'the echo causes no second push');
  assert.equal((await stores.records.get(CO, 'contact', 'c-1')).data.name, 'Ada');
});

test('latest_wins: a local edit older than the vendor version is refused at staging and not written', async () => {
  const { engine, stores } = setup();
  await engine.receive(CO, CONN, [inbound({ canonicalId: 'c-2', externalId: 'vc-2', data: { name: 'Remote' }, updatedAt: T2 })]);
  const r = await engine.stageLocal(CO, CONN, { entity: 'contact', canonicalId: 'c-2', op: 'upsert', data: { name: 'Local' }, updatedAt: T0 });
  assert.deepEqual(r, { status: 'refused', reason: 'stale' });
  assert.equal((await stores.records.get(CO, 'contact', 'c-2')).data.name, 'Remote');
  assert.equal((await engine.pendingChanges(CO, CONN)).length, 0);
});

test('latest_wins: a newer local edit is pushed', async () => {
  const { engine } = setup();
  const v = vendor({ externalId: 'vc-3' });
  await engine.receive(CO, CONN, [inbound({ canonicalId: 'c-3', externalId: 'vc-3', data: { name: 'Old' }, updatedAt: T0 })]);
  await engine.stageLocal(CO, CONN, { entity: 'contact', canonicalId: 'c-3', op: 'upsert', data: { name: 'New' }, updatedAt: T2 });
  const report = await engine.flush(CO, CONN, v.push);
  assert.equal(report.pushed, 1);
  assert.equal(v.calls[0].externalId, 'vc-3');
});

test('a remote version that arrives after staging makes the pending push stale at flush time', async () => {
  const { engine } = setup();
  const v = vendor();
  await engine.stageLocal(CO, CONN, { entity: 'contact', canonicalId: 'c-4', op: 'upsert', data: { name: 'Local' }, updatedAt: T0 });
  await engine.receive(CO, CONN, [inbound({ canonicalId: 'c-4', externalId: 'vc-4', data: { name: 'Local' }, updatedAt: T2, eventId: 'late' })]);
  const report = await engine.flush(CO, CONN, v.push);
  assert.equal(report.ignored, 1);
  assert.equal(v.calls.length, 0);
});

test('manual rule: a vendor change after the edit was based on it goes to the dead-letter queue, not the vendor', async () => {
  const { engine } = setup({ rules: { contact: { strategy: 'manual' } } });
  const v = vendor({ externalId: 'vc-5' });
  await engine.receive(CO, CONN, [inbound({ canonicalId: 'c-5', externalId: 'vc-5', data: { name: 'A' }, updatedAt: T0 })]);
  await engine.stageLocal(CO, CONN, { entity: 'contact', canonicalId: 'c-5', op: 'upsert', data: { name: 'B' }, updatedAt: T1 });
  // The vendor moves on to the same data it now shows us, so the inbound side is a no-op but the version advances.
  await engine.receive(CO, CONN, [inbound({ eventId: 'in-5b', externalId: 'vc-5', data: { name: 'B' }, updatedAt: T2 })]);

  const report = await engine.flush(CO, CONN, v.push);
  assert.equal(report.deadLettered, 1);
  assert.equal(v.calls.length, 0);
  const [dl] = await engine.deadLetters(CO, CONN);
  assert.equal(dl.direction, 'outbound');
  assert.equal(dl.reason, 'conflict_manual');
  assert.equal(dl.event.canonicalId, 'c-5');
});

test('a failed push is dead-lettered with its reason, and replay retries it with the same idempotency key', async () => {
  const { engine, stores } = setup();
  const failing = vendor({ fail: () => new ConnectorError('rate_limited', 'slow down') });
  await engine.stageLocal(CO, CONN, { entity: 'job', canonicalId: 'job-3', op: 'upsert', data: { status: 'booked' }, updatedAt: T0 });
  const report = await engine.flush(CO, CONN, failing.push);
  assert.equal(report.deadLettered, 1);
  assert.equal(report.pending, 0, 'a failed change leaves the outbox and waits in the dead-letter queue');

  const [dl] = await engine.deadLetters(CO, CONN);
  assert.equal(dl.reason, 'rate_limited');
  assert.equal(dl.attempts, 1);

  assert.equal(await engine.replay(CO, dl.id), 'failed', 'replay without a push function does not retry');
  assert.equal((await engine.deadLetters(CO))[0].attempts, 1);

  const healthy = vendor({ externalId: 'vj-3' });
  assert.equal(await engine.replay(CO, dl.id, healthy.push), 'replayed');
  assert.equal(healthy.calls[0].idempotencyKey, dl.event.id);
  assert.equal(await stores.identities.canonicalFor(CO, CONN, 'job', 'vj-3'), 'job-3');
  assert.equal(await engine.replay(CO, dl.id, healthy.push), 'not_found');
  assert.equal((await engine.deadLetters(CO)).length, 0);
});

test('a failed push retried after a dropped response keeps the vendor record single through the idempotency key', async () => {
  const { engine } = setup();
  const seenKeys = [];
  let first = true;
  const flaky = async (change) => {
    seenKeys.push(change.idempotencyKey);
    if (first) {
      first = false;
      throw new ConnectorError('timeout', 'response lost');
    }
    return { externalId: 'vj-4', updatedAt: change.updatedAt };
  };
  await engine.stageLocal(CO, CONN, { entity: 'job', canonicalId: 'job-4', op: 'upsert', data: { status: 'booked' }, updatedAt: T0 });
  await engine.flush(CO, CONN, flaky);
  const [dl] = await engine.deadLetters(CO, CONN);
  assert.equal(dl.reason, 'upstream');
  assert.equal(await engine.replay(CO, dl.id, flaky), 'replayed');
  assert.equal(seenKeys.length, 2);
  assert.equal(seenKeys[0], seenKeys[1]);
});

test('an outbound dead letter superseded by a newer local edit is dropped on replay, so the old value is never pushed', async () => {
  const { engine } = setup();
  const failing = vendor({ fail: () => new ConnectorError('upstream', 'down') });
  await engine.stageLocal(CO, CONN, { entity: 'job', canonicalId: 'job-5', op: 'upsert', data: { status: 'quoted' }, updatedAt: T0 });
  await engine.flush(CO, CONN, failing.push);
  const [dl] = await engine.deadLetters(CO, CONN);

  await engine.stageLocal(CO, CONN, { entity: 'job', canonicalId: 'job-5', op: 'upsert', data: { status: 'booked' }, updatedAt: T1 });
  const healthy = vendor();
  assert.equal(await engine.replay(CO, dl.id, healthy.push), 'replayed');
  assert.equal(healthy.calls.length, 0);
  assert.equal((await engine.pendingChanges(CO, CONN)).length, 1, 'the newer edit is still waiting');
});

test('a vendor id already linked to another record is dead-lettered as a validation failure, not linked twice', async () => {
  const { engine, stores } = setup();
  await engine.receive(CO, CONN, [inbound({ canonicalId: 'other-1', externalId: 'vx', data: { name: 'X' } })]);
  const v = vendor({ externalId: 'vx' });
  await engine.stageLocal(CO, CONN, { entity: 'contact', canonicalId: 'c-9', op: 'upsert', data: { name: 'Y' }, updatedAt: T1 });
  const report = await engine.flush(CO, CONN, v.push);
  assert.equal(report.deadLettered, 1);
  const [dl] = await engine.deadLetters(CO, CONN);
  assert.equal(dl.reason, 'validation');
  assert.equal(await stores.identities.canonicalFor(CO, CONN, 'contact', 'vx'), 'other-1');
});

test('deleting a record the vendor never saw pushes nothing', async () => {
  const { engine } = setup();
  const v = vendor();
  await engine.stageLocal(CO, CONN, { entity: 'contact', canonicalId: 'c-10', op: 'delete', data: {}, updatedAt: T0 });
  const report = await engine.flush(CO, CONN, v.push);
  assert.deepEqual(report, { pushed: 0, ignored: 1, deadLettered: 0, pending: 0 });
  assert.equal(v.calls.length, 0);
});

test('an inbound change never stages an outbound change', async () => {
  const { engine } = setup();
  await engine.receive(CO, CONN, [inbound({ canonicalId: 'c-11', externalId: 'vc-11', updatedAt: T0 })]);
  assert.equal((await engine.pendingChanges(CO, CONN)).length, 0);
});

test('dead-letter queue entries for outbound changes are scoped to their company', async () => {
  const { engine } = setup();
  const failing = vendor({ fail: () => new ConnectorError('auth', 'refused') });
  await engine.stageLocal(CO, CONN, { entity: 'job', canonicalId: 'job-6', op: 'upsert', data: {}, updatedAt: T0 });
  await engine.flush(CO, CONN, failing.push);
  const [dl] = await engine.deadLetters(CO, CONN);
  assert.equal((await engine.deadLetters(CO2)).length, 0);
  assert.equal(await engine.replay(CO2, dl.id, vendor().push), 'not_found');
});

test('resolveOutbound: system of record and latest_wins decide without a push when they should', () => {
  assert.deepEqual(resolveOutbound(DEFAULT_CONFLICT_RULES.job, { updatedAt: T0, baseUpdatedAt: null }, null), { action: 'push' });
  assert.deepEqual(resolveOutbound(DEFAULT_CONFLICT_RULES.message, { updatedAt: T0, baseUpdatedAt: null }, null), { action: 'ignore', reason: 'system_of_record' });
  assert.deepEqual(resolveOutbound(DEFAULT_CONFLICT_RULES.contact, { updatedAt: T0, baseUpdatedAt: T0 }, T1), { action: 'ignore', reason: 'stale' });
  assert.deepEqual(resolveOutbound(DEFAULT_CONFLICT_RULES.contact, { updatedAt: T1, baseUpdatedAt: T0 }, T0), { action: 'push' });
});

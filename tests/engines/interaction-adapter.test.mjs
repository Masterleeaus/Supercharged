// Run with: node --test --experimental-transform-types tests/engines/interaction-adapter.test.mjs
// The copied offline companion uses constructor parameter properties, which need transform mode.
import test from 'node:test';
import assert from 'node:assert/strict';
await import('./loader-hook.mjs');
const { DeskInteractionOutbox, DeskInteractionError, MIN_OUTBOX_SECRET_LENGTH } = await import(
  '../../server/engines/interaction/desk-adapter.ts'
);
const { MemoryStore } = await import('../../server/engines/interaction/offline/memory-store.ts');

const SECRET = 'k8Pq2Zt7Lm4Vx9Rw1Ns6Bh3Jd0Fg5Ya8';
const OTHER = 'Q1wE2rT3yU4iO5pA6sD7fG8hJ9kL0zXc';
const CO_A = 'company-a';
const CO_B = 'company-b';

// A persistence double that keeps one store per company and records which company was asked for.
function fakePersistence() {
  const stores = new Map();
  const requested = [];
  return {
    requested,
    stores,
    forCompany(companyId) {
      requested.push(companyId);
      if (!stores.has(companyId)) stores.set(companyId, new MemoryStore());
      return stores.get(companyId);
    },
  };
}

const enqueueInput = (companyId, extra = {}) => ({
  companyId,
  userId: 7,
  deviceId: 'dev-1',
  capability: 'job.note',
  payload: { text: 'hello' },
  ...extra,
});

test('every operation refuses when persistence is not bound', async () => {
  const adapter = new DeskInteractionOutbox({ secret: SECRET });
  const calls = [
    () => adapter.enqueue(enqueueInput(CO_A)),
    () => adapter.pending(CO_A),
    () => adapter.decrypt(CO_A, 'x'),
    () => adapter.markSyncing(CO_A, 'x'),
    () => adapter.markSynced(CO_A, 'x'),
    () => adapter.markFailed(CO_A, 'x', 'err'),
    () => adapter.markConflict(CO_A, 'x'),
    () => adapter.remove(CO_A, 'x'),
  ];
  for (const call of calls) {
    await assert.rejects(call, (err) => err instanceof DeskInteractionError && err.code === 'persistence_not_injected');
  }
});

test('company_id is required on every operation and checked before persistence is touched', async () => {
  const persistence = fakePersistence();
  const adapter = new DeskInteractionOutbox({ secret: SECRET, persistence });
  for (const bad of [undefined, null, '', '   ', 3]) {
    await assert.rejects(() => adapter.pending(bad), (err) => err.code === 'company_id_required');
    await assert.rejects(() => adapter.enqueue(enqueueInput(bad)), (err) => err.code === 'company_id_required');
    await assert.rejects(() => adapter.remove(bad, 'x'), (err) => err.code === 'company_id_required');
  }
  assert.deepEqual(persistence.requested, []);
});

test('the secret must be injected, long enough, and not a known placeholder', () => {
  assert.throws(() => new DeskInteractionOutbox({ secret: undefined }), (e) => e.code === 'secret_not_injected');
  assert.throws(() => new DeskInteractionOutbox({ secret: '' }), (e) => e.code === 'secret_not_injected');
  assert.throws(
    () => new DeskInteractionOutbox({ secret: 'x'.repeat(MIN_OUTBOX_SECRET_LENGTH - 1) }),
    (e) => e.code === 'secret_too_short',
  );
  assert.throws(() => new DeskInteractionOutbox({ secret: 'change-me' }), (e) => e.code === 'secret_is_placeholder');
  assert.throws(
    () => new DeskInteractionOutbox({ secret: 'change-this-approval-secret' }),
    (e) => e.code === 'secret_is_placeholder',
  );
});

test('the secret is never read from the environment', () => {
  const previous = process.env.DESK_OUTBOX_SECRET;
  process.env.DESK_OUTBOX_SECRET = SECRET;
  try {
    // No secret injected, so the constructor refuses even though the env var holds a valid value.
    assert.throws(() => new DeskInteractionOutbox({ persistence: fakePersistence() }), (e) => e.code === 'secret_not_injected');
  } finally {
    if (previous === undefined) delete process.env.DESK_OUTBOX_SECRET;
    else process.env.DESK_OUTBOX_SECRET = previous;
  }
});

test('enqueue, pending and decrypt round-trip within one company', async () => {
  const adapter = new DeskInteractionOutbox({ secret: SECRET, persistence: fakePersistence() });
  const env = await adapter.enqueue(enqueueInput(CO_A));
  assert.equal(env.status, 'pending');
  assert.equal((await adapter.pending(CO_A)).length, 1);
  const cmd = await adapter.decrypt(CO_A, env.id);
  assert.equal(cmd.capability, 'job.note');
  assert.deepEqual(cmd.payload, { text: 'hello' });
  assert.equal(cmd.metadata.tenant_id, CO_A);
});

test('companies are isolated: company B sees none of company A commands', async () => {
  const adapter = new DeskInteractionOutbox({ secret: SECRET, persistence: fakePersistence() });
  await adapter.enqueue(enqueueInput(CO_A));
  assert.equal((await adapter.pending(CO_B)).length, 0);
});

test('company is taken from the input, never from the payload', async () => {
  const adapter = new DeskInteractionOutbox({ secret: SECRET, persistence: fakePersistence() });
  const env = await adapter.enqueue(enqueueInput(CO_A, { payload: { tenant_id: CO_B, company_id: CO_B } }));
  const cmd = await adapter.decrypt(CO_A, env.id);
  assert.equal(cmd.metadata.tenant_id, CO_A);
  assert.equal(cmd.payload.tenant_id, CO_B);
  // Company B's store has no such envelope, so the lookup fails. It does not return company A's command.
  await assert.rejects(() => adapter.decrypt(CO_B, env.id), /not found/);
});

test('a command copied into another company store is refused as tenant_mismatch', async () => {
  const persistence = fakePersistence();
  const adapter = new DeskInteractionOutbox({ secret: SECRET, persistence });
  const env = await adapter.enqueue(enqueueInput(CO_A));
  // Simulate a storage bug that copies company A's envelope into company B's store.
  await persistence.forCompany(CO_B).put(env.id, env);
  await assert.rejects(() => adapter.decrypt(CO_B, env.id), (err) => err.code === 'tenant_mismatch');
});

test('a different secret cannot decrypt a stored command', async () => {
  const persistence = fakePersistence();
  const env = await new DeskInteractionOutbox({ secret: SECRET, persistence }).enqueue(enqueueInput(CO_A));
  const other = new DeskInteractionOutbox({ secret: OTHER, persistence });
  await assert.rejects(() => other.decrypt(CO_A, env.id));
});

test('state transitions: syncing, synced, failed, conflict, remove', async () => {
  const adapter = new DeskInteractionOutbox({ secret: SECRET, persistence: fakePersistence() });
  const env = await adapter.enqueue(enqueueInput(CO_A));

  // pending() returns only 'pending' and 'failed' envelopes, so a command in flight is not re-listed.
  await adapter.markSyncing(CO_A, env.id);
  assert.equal((await adapter.pending(CO_A)).length, 0);

  await adapter.markFailed(CO_A, env.id, 'network');
  let pending = await adapter.pending(CO_A);
  assert.equal(pending[0].status, 'failed');
  assert.equal(pending[0].lastError, 'network');
  assert.equal(pending[0].attempts, 1);

  await adapter.markConflict(CO_A, env.id);
  assert.equal((await adapter.pending(CO_A)).length, 0);

  await adapter.markSynced(CO_A, env.id);
  assert.equal((await adapter.pending(CO_A)).length, 0);

  await adapter.remove(CO_A, env.id);
  await assert.rejects(() => adapter.decrypt(CO_A, env.id), /not found/);
});

test('a bad payload is refused', async () => {
  const adapter = new DeskInteractionOutbox({ secret: SECRET, persistence: fakePersistence() });
  for (const payload of [null, 'text', [1, 2]]) {
    await assert.rejects(() => adapter.enqueue(enqueueInput(CO_A, { payload })), (err) => err.code === 'payload_must_be_object');
  }
});

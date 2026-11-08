import test from 'node:test';
import assert from 'node:assert/strict';
import { GovernedExecutionRecovery, InMemoryExecutionLifecycleStore } from './governed-execution-recovery.mjs';

function request(overrides = {}) {
  return {
    execution_id: 'execution-1', company_id: 'company-a', capability: 'job.complete',
    idempotency_key: 'job-1-complete', authority: { status: 'approved' }, risk: { status: 'approved' },
    ...overrides,
  };
}

test('resumes a persisted execution and records the verified terminal outcome', async () => {
  const calls = [];
  const recovery = new GovernedExecutionRecovery({
    store: new InMemoryExecutionLifecycleStore(),
    gateway: { execute: async (input) => { calls.push(input); return { state: 'VERIFIED', execution_id: input.execution_id, company_id: input.company_id }; } },
  });

  await recovery.start(request());
  const result = await recovery.resume('execution-1', request());

  assert.equal(result.state, 'VERIFIED');
  assert.equal(calls.length, 1);
  assert.equal((await recovery.get('execution-1', 'company-a')).status, 'VERIFIED');
  assert.deepEqual((await recovery.history('execution-1', 'company-a')).map((event) => event.type), ['STARTED', 'RESUMED', 'COMPLETED']);
});

test('retry is a fresh governed attempt and does not retry a terminal execution', async () => {
  let attempts = 0;
  const recovery = new GovernedExecutionRecovery({
    store: new InMemoryExecutionLifecycleStore(),
    gateway: { execute: async (input) => ({ state: ++attempts === 1 ? 'FAILED' : 'VERIFIED', non_execution_proven: true, execution_id: input.execution_id, company_id: input.company_id }) },
  });

  await recovery.start(request());
  assert.equal((await recovery.resume('execution-1', request())).state, 'FAILED');
  assert.equal((await recovery.retry('execution-1', request())).state, 'VERIFIED');
  await assert.rejects(() => recovery.retry('execution-1', request()), /terminal-execution/);
});

test('compensation is a new governed execution linked to the original', async () => {
  const seen = [];
  const recovery = new GovernedExecutionRecovery({
    store: new InMemoryExecutionLifecycleStore(),
    gateway: { execute: async (input) => { seen.push(input); return { state: 'VERIFIED', execution_id: input.execution_id, company_id: input.company_id }; } },
  });

  await recovery.start(request());
  await recovery.resume('execution-1', request());
  const compensation = await recovery.compensate('execution-1', request({ execution_id: 'execution-2', capability: 'job.reopen', idempotency_key: 'job-1-reopen' }));

  assert.equal(compensation.state, 'VERIFIED');
  assert.equal(seen[1].compensation_of, 'execution-1');
  assert.equal((await recovery.get('execution-2', 'company-a')).kind, 'COMPENSATION');
});

test('company scope and authority are revalidated on resume and recovery actions', async () => {
  const recovery = new GovernedExecutionRecovery({
    store: new InMemoryExecutionLifecycleStore(),
    gateway: { execute: async (input) => { if (input.authority.status !== 'approved') return {state:'DENIED'}; return { state: 'VERIFIED', execution_id: input.execution_id, company_id: input.company_id }; } },
  });

  await recovery.start(request());
  await assert.rejects(() => recovery.resume('execution-1', request({ company_id: 'company-b' })), /company-context/);
  assert.equal((await recovery.resume('execution-1', request({ authority: { status: 'revoked' } }))).state, 'DENIED');
  assert.equal((await recovery.get('execution-1', 'company-a')).status, 'DENIED');
});


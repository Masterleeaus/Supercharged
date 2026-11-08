/**
 * Tests for server/workforce/runtime/reconcile-schedule.ts. Injected clock and fake schedule only, no timers.
 * Run: node --test --experimental-transform-types tests/workforce/reconcile-schedule.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleReconciliation, NIGHTLY_JOB_ID } from '../../server/workforce/runtime/reconcile-schedule.ts';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 3, 9, 30); // 2026-11-03 09:30 UTC

function clock(start = T0) {
  const c = { t: start };
  c.now = () => c.t;
  return c;
}

function harness(start) {
  const c = clock(start);
  const specs = [];
  const calls = [];
  const sched = scheduleReconciliation({
    schedule: (spec) => specs.push(spec),
    reconcile: (companyId, trigger) => calls.push({ companyId, trigger }),
    now: c.now,
  });
  return { c, specs, calls, sched };
}

test('registers one nightly recurring job at the next UTC midnight', () => {
  const { specs } = harness();
  assert.equal(specs.length, 1);
  const [spec] = specs;
  assert.equal(spec.id, NIGHTLY_JOB_ID);
  assert.equal(spec.kind, 'recurring');
  assert.equal(spec.intervalMs, DAY);
  assert.equal(spec.workKind, 'scheduled');
  assert.equal(spec.runAt, Date.UTC(2026, 10, 4, 0, 0));
});

test('runAfterRun calls reconcile once for the completed run', async () => {
  const { calls, sched } = harness();
  assert.equal(await sched.runAfterRun('co-a', 'run-1'), true);
  assert.deepEqual(calls, [{ companyId: 'co-a', trigger: 'run' }]);
});

test('a second runAfterRun on the same night does not reconcile again', async () => {
  const { c, calls, sched } = harness();
  assert.equal(await sched.runAfterRun('co-a', 'run-1'), true);
  c.t = T0 + 5 * 60 * 60 * 1000; // still 2026-11-03 UTC
  assert.equal(await sched.runAfterRun('co-a', 'run-2'), false);
  assert.equal(calls.length, 1);
});

test('the nightly job skips a company already reconciled that night, and runs again the next night', async () => {
  const { c, specs, calls, sched } = harness();
  await sched.runAfterRun('co-a', 'run-1');
  await specs[0].work({ companyId: 'workforce-system', jobId: NIGHTLY_JOB_ID, agentId: 'reconciler', attempt: 1 });
  assert.equal(calls.length, 1);

  c.t = Date.UTC(2026, 10, 4, 0, 1);
  await specs[0].work({ companyId: 'workforce-system', jobId: NIGHTLY_JOB_ID, agentId: 'reconciler', attempt: 1 });
  assert.deepEqual(calls.slice(1), [{ companyId: 'co-a', trigger: 'nightly' }]);
});

test('a failed reconcile clears its guard so a later call can retry', async () => {
  let fail = true;
  const calls = [];
  const sched = scheduleReconciliation({
    schedule: () => {},
    reconcile: () => {
      calls.push(1);
      if (fail) throw new Error('boom');
    },
    now: () => T0,
  });
  await assert.rejects(sched.runAfterRun('co-a', 'run-1'), /boom/);
  fail = false;
  assert.equal(await sched.runAfterRun('co-a', 'run-2'), true);
  assert.equal(calls.length, 2);
});

test('scheduleReconciliation rejects missing dependencies', () => {
  assert.throws(() => scheduleReconciliation({ schedule: () => {}, reconcile: () => {} }), TypeError);
});

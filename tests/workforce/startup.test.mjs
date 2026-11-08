/**
 * Tests for server/workforce/runtime/startup.ts. Every dependency is passed in, so no database, approval module or
 * admin route module loads. Fixed clock, in-memory store, fake retention store, no real timers (startTimer false).
 * Run: cd /home/claude/desk-review && node --test --experimental-transform-types tests/workforce/startup.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorkforceRuntime, createUnavailableReadStore } from '../../server/workforce/runtime/startup.ts';
import { getActiveWorkforceRuntime, resetCompanySweepsForTests } from '../../server/workforce/runtime/compose.ts';
import { runtimeHealth } from '../../server/workforce/runtime/health.ts';
import { createControlState } from '../../server/workforce/runtime/controls.ts';
import { createMemoryRunStore, createTeam } from '../../server/workforce/runtime/index.ts';
import { NIGHTLY_JOB_ID } from '../../server/workforce/runtime/reconcile-schedule.ts';
import { RETENTION_JOB_ID } from '../../server/workforce/runtime/retention.ts';
import { StoreUnavailableError } from '../../server/workforce/runtime/store.ts';

const CO = 'co-1';
const NOW = new Date('2026-11-03T12:00:00.000Z');
const ROLES = new Map([
  ['coordinator', { id: 'coordinator', handoffTo: ['writer'], autonomy: 'auto' }],
  ['writer', { id: 'writer', handoffTo: [], autonomy: 'auto' }],
]);
const roleSource = { getRole: (id) => ROLES.get(id) ?? null };
const CATALOGUE = new Map([['writer', { id: 'writer' }]]);

const approvalService = {
  async gateAction() {
    return { status: 'pending', approval: { id: 'a1' } };
  },
  async getApproval() {
    return null;
  },
  async markExecuted() {
    return null;
  },
};

/** Fake retention store that records every call. */
function fakeRetention() {
  const calls = { list: [], deletes: [], companies: 0 };
  return {
    calls,
    async listRetentionRows(companyId, table) {
      calls.list.push(table);
      return [];
    },
    async deleteRetentionRows(companyId, table, ids) {
      calls.deletes.push({ table, ids });
      return ids.length;
    },
    async listCompanyIds() {
      calls.companies += 1;
      return [CO];
    },
  };
}

function recordingLogger() {
  const lines = [];
  return {
    lines,
    log: (message) => lines.push(`log ${message}`),
    error: (message) => lines.push(`error ${message}`),
  };
}

function baseDeps(overrides = {}) {
  return {
    catalogue: CATALOGUE,
    store: createMemoryRunStore(),
    approvalService,
    controls: { state: () => createControlState() },
    retentionStore: fakeRetention(),
    startTimer: false,
    logger: recordingLogger(),
    now: () => NOW,
    ...overrides,
  };
}

test('startup composes the runtime, registers it for health, and refuses a run because no model is configured', async () => {
  resetCompanySweepsForTests();
  const result = await startWorkforceRuntime(baseDeps());
  assert.ok(result.runtime, 'a runtime is composed');
  assert.equal(result.reason, null);
  assert.equal(getActiveWorkforceRuntime(), result.runtime);
  assert.equal(result.runtime.model, null);

  const refused = await result.runtime.engine.startRun(CO, 'run-1');
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'model_not_configured');

  const health = runtimeHealth(getActiveWorkforceRuntime());
  assert.equal(health.status, 'not_ready');
  assert.equal(health.dependencies.model, 'NOT CONFIGURED');
  assert.equal(health.dependencies.identity, 'not_ready', 'no company scope is set for a multi-company process');
  result.stop();
});

test('with no role catalogue loaded, nothing is registered and health reports not ready', async () => {
  resetCompanySweepsForTests();
  const logger = recordingLogger();
  const result = await startWorkforceRuntime(baseDeps({ catalogue: undefined, logger }));
  assert.equal(result.runtime, null);
  assert.equal(result.reason, 'catalogue_unavailable');
  assert.equal(getActiveWorkforceRuntime(), null);
  assert.equal(runtimeHealth(getActiveWorkforceRuntime()).status, 'not_ready');
  assert.ok(logger.lines.some((line) => line.includes('catalogue_unavailable')));
  result.stop();
});

test('a composition failure is logged by its code only, and nothing is registered', async () => {
  resetCompanySweepsForTests();
  const logger = recordingLogger();
  const result = await startWorkforceRuntime(baseDeps({ store: {}, logger }));
  assert.equal(result.runtime, null);
  assert.equal(result.reason, 'config_invalid');
  assert.equal(getActiveWorkforceRuntime(), null);
  assert.ok(logger.lines.some((line) => line.includes('config_invalid')));
  assert.ok(!logger.lines.some((line) => line.includes('run store is missing')), 'the error message is not logged');
  result.stop();
});

test('the nightly retention job is scheduled and, by default, runs as a dry run that deletes nothing', async () => {
  resetCompanySweepsForTests();
  const retention = fakeRetention();
  let clock = NOW;
  const result = await startWorkforceRuntime(baseDeps({ retentionStore: retention, now: () => clock }));
  assert.ok(result.jobs.includes(RETENTION_JOB_ID));
  const [view] = result.scheduler.list('workforce-system').filter((job) => job.id === RETENTION_JOB_ID);
  assert.ok(view, 'the retention job is listed with the scheduler');

  clock = new Date(view.runAt);
  await result.scheduler.tick();
  assert.equal(retention.calls.companies, 1);
  assert.equal(retention.calls.deletes.length, 0, 'dry run: nothing is deleted');
  assert.equal(retention.calls.list.includes('audit'), false, 'audit is never listed');
  result.stop();
});

test('a reconcile function is scheduled, and each completed run is reported to it', async () => {
  resetCompanySweepsForTests();
  const reconcileCalls = [];
  const result = await startWorkforceRuntime(
    baseDeps({ reconcile: (companyId, trigger) => reconcileCalls.push({ companyId, trigger }) }),
  );
  assert.ok(result.jobs.includes(NIGHTLY_JOB_ID));

  const team = createTeam(
    {
      id: 'team-1',
      name: 'Content',
      members: [
        { roleId: 'coordinator', coordinator: true },
        { roleId: 'writer', coordinator: false },
      ],
    },
    roleSource,
  );
  const created = await result.runtime.engine.createRun({ companyId: CO, team, budget: { maxTokens: 100, maxToolCalls: 10 } });
  assert.equal(created.ok, true);
  const running = await result.runtime.store.updateRun(CO, { ...created.run, status: 'running' }, created.run.version);
  const done = await result.runtime.engine.complete(CO, running.id, 'done');
  assert.equal(done.ok, true);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reconcileCalls, [{ companyId: CO, trigger: 'run' }]);
  result.stop();
});

test('without a reconcile function no reconciliation job is scheduled', async () => {
  resetCompanySweepsForTests();
  const result = await startWorkforceRuntime(baseDeps());
  assert.equal(result.jobs.includes(NIGHTLY_JOB_ID), false);
  result.stop();
});

test('the default read store refuses every read with store_unavailable', async () => {
  const reads = createUnavailableReadStore();
  await assert.rejects(reads.listBookings(CO, { limit: 1 }), StoreUnavailableError);
  await assert.rejects(reads.listInvoices(CO, { limit: 1 }), (err) => err.code === 'store_unavailable');
  await assert.rejects(reads.listPayments(CO, { limit: 1 }), (err) => err.code === 'store_unavailable');
});

test('stop is safe to call twice', async () => {
  resetCompanySweepsForTests();
  const result = await startWorkforceRuntime(baseDeps({ startTimer: true, tickMs: 60_000 }));
  result.stop();
  result.stop();
});

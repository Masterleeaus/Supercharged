/**
 * Recovery of runs left in status 'running' after a crash.
 *
 * Required behaviour (no recovery pass exists yet; these tests document it):
 * 1. On recovery, a run left in 'running' is moved out of 'running' into a visible state, not resumed.
 * 2. The move is recorded in the audit log for that run (a 'run.status' event with from: 'running').
 * 3. A recovered run is not silently resumed: no tool handler runs and callTool refuses it.
 * 4. Recovery is scoped to the company that owns the run.
 * 5. A second recovery pass does not write a second audit event for the same run.
 *
 * Assumed entry point: engine.recoverInterruptedRuns(companyId) returning a result. The name is not fixed by
 * the runtime; the tests fail with a "missing" message until an engine exposes a function under that name.
 *
 * In-memory store, fixed clock, no network, no database.
 * Run: cd /home/claude/desk-review && node --test --experimental-transform-types tests/workforce/stuck-runs.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createToolRegistry,
  createRunEngine,
  createTeam,
  createMemoryRunStore,
} from '../../server/workforce/runtime/index.ts';
import { recoverInterruptedRuns } from '../../server/workforce/runtime/recovery.ts';

const CO = 'company-1';
const OTHER_CO = 'company-2';
const COORD = { kind: 'agent', agentId: 'coordinator-1', roleId: 'coordinator' };

const ROLES = new Map([
  ['coordinator', { id: 'coordinator', handoffTo: ['writer'], autonomy: 'auto' }],
  ['writer', { id: 'writer', handoffTo: [], autonomy: 'auto' }],
]);
const roleSource = { getRole: (id) => ROLES.get(id) ?? null };
const team = createTeam(
  { id: 'team-1', name: 'Content', members: [{ roleId: 'coordinator', coordinator: true }, { roleId: 'writer' }] },
  roleSource,
);

const NOW = new Date('2026-11-03T00:00:00Z');

/** Builds an engine over the given store. A new engine on the same store models a restart after a crash. */
function buildEngine(store, handler) {
  const registry = createToolRegistry({
    gate: { gateAction: async () => ({ status: 'pending', approval: { id: 'x' } }), readApproval: async () => null, claimApproval: async () => false },
    redact: (v) => v,
    audit: { record: (e) => store.appendAudit(e) },
    now: () => NOW,
  });
  registry.register({ id: 'send_note', risk: 'low', schema: {}, handler });
  return createRunEngine({
    registry,
    store,
    audit: { record: (e) => store.appendAudit(e) },
    now: () => NOW,
    sleep: async () => {},
  });
}

/** Creates a run and starts it, so it is in 'running'. The returned engine is then discarded to model a crash. */
async function runLeftInRunning(store, companyId) {
  const engine = buildEngine(store, async () => ({ ok: true }));
  const created = await engine.createRun({ companyId, team, budget: { maxTokens: 100, maxToolCalls: 10 } });
  assert.equal(created.ok, true, `createRun failed: ${created.reason}`);
  const started = await engine.startRun(companyId, created.run.id);
  assert.equal(started.ok, true, `startRun failed: ${started.reason}`);
  assert.equal(started.run.status, 'running');
  return started.run.id;
}

/** Calls the recovery pass on the store, as the lead's wiring will. Same store, fixed clock, same audit sink. */
function recoverPass(store, companyId) {
  return recoverInterruptedRuns({ store, audit: { record: (e) => store.appendAudit(e) }, now: () => NOW }, companyId);
}

test('a run left in running after a crash is moved out of running on recovery', async () => {
  const store = createMemoryRunStore();
  const runId = await runLeftInRunning(store, CO);

  const engine = buildEngine(store, async () => ({ ok: true }));
  await recoverPass(store, CO);

  const after = await store.getRun(CO, runId);
  assert.notEqual(after.status, 'running', 'run is still in running after recovery; it was silently left or resumed');
  assert.notEqual(after.status, 'completed', 'an interrupted run must not be reported as completed');
  assert.ok(after.reason && after.reason.trim() !== '', 'recovered run has no reason explaining the interruption');
});

test('recovery writes an audit event recording the move out of running', async () => {
  const store = createMemoryRunStore();
  const runId = await runLeftInRunning(store, CO);
  const before = (await store.listAudit(CO, runId)).length;

  const engine = buildEngine(store, async () => ({ ok: true }));
  await recoverPass(store, CO);

  const events = await store.listAudit(CO, runId);
  assert.ok(events.length > before, 'recovery wrote no audit event for the run');
  const moved = events.slice(before).find((e) => e.kind === 'run.status' && e.data.from === 'running');
  assert.ok(moved, 'no run.status audit event with from: running was written by recovery');
  assert.notEqual(moved.data.to, 'running', 'the audit event records the run as still running');
});

test('a recovered run is not silently resumed: no handler runs and callTool refuses it', async () => {
  const store = createMemoryRunStore();
  const runId = await runLeftInRunning(store, CO);

  let executions = 0;
  const engine = buildEngine(store, async () => {
    executions += 1;
    return { ok: true };
  });
  await recoverPass(store, CO);

  const attempt = await engine.callTool(CO, runId, { toolId: 'send_note', params: {}, actor: COORD });
  assert.equal(attempt.ok, false, 'a recovered run accepted a tool call as if it were still running');
  assert.equal(executions, 0, 'a tool handler ran during or after recovery');
});

test('recovery does not touch runs owned by another company', async () => {
  const store = createMemoryRunStore();
  const otherRunId = await runLeftInRunning(store, OTHER_CO);

  const engine = buildEngine(store, async () => ({ ok: true }));
  await recoverPass(store, CO);

  const other = await store.getRun(OTHER_CO, otherRunId);
  assert.equal(other.status, 'running', 'recovery for one company changed a run owned by another company');
});

test('a second recovery pass does not write a second audit event for the same run', async () => {
  const store = createMemoryRunStore();
  const runId = await runLeftInRunning(store, CO);

  const engine = buildEngine(store, async () => ({ ok: true }));
  await recoverPass(store, CO);
  const afterFirst = (await store.listAudit(CO, runId)).length;
  await recoverPass(store, CO);
  const afterSecond = (await store.listAudit(CO, runId)).length;

  assert.equal(afterSecond, afterFirst, 'a second recovery pass wrote another audit event for an already recovered run');
});

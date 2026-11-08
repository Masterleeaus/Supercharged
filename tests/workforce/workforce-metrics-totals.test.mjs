/**
 * Totals for workforce metrics (server/workforce/runtime/workforce-metrics.ts), computed from events the run
 * engine really emits. No metric event is recorded by hand: every run goes through createRunEngine, and its
 * audit records feed the metrics through metricsAuditSink.
 * Run: node --test --experimental-transform-types tests/workforce/workforce-metrics-totals.test.mjs
 *
 * Fixture (one company, five runs, driven through the engine):
 *   run 1 completed
 *   run 2 completed
 *   run 3 completed
 *   run 4 failed
 *   run 5 handed off to the human-review role (escalation) and left open
 *
 * Expected totals:
 *   completion rate = 3 completed / 5 started = 0.6
 *   error rate      = 1 failed / 5 started    = 0.2
 *   escalations     = 1
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createToolRegistry,
  createRunEngine,
  createTeam,
  createMemoryRunStore,
} from '../../server/workforce/runtime/index.ts';
import { createWorkforceMetrics, metricsAuditSink } from '../../server/workforce/runtime/workforce-metrics.ts';

const T0 = Date.UTC(2026, 10, 3, 9, 0, 0);
const COMPANY = 'co-fixture';

const ROLE_LIST = [
  { id: 'coordinator', handoffTo: ['worker', 'human-review'], autonomy: 'auto', tools: [] },
  { id: 'worker', handoffTo: [], autonomy: 'auto', tools: [] },
  { id: 'human-review', handoffTo: [], autonomy: 'suggest', tools: [] },
];
const ROLES = new Map(ROLE_LIST.map((r) => [r.id, r]));
const roleSource = { getRole: (id) => ROLES.get(id) ?? null };

const TEAM = createTeam(
  {
    id: 'team-fixture',
    name: 'Fixture',
    members: ROLE_LIST.map((r) => ({ roleId: r.id, coordinator: r.id === 'coordinator' })),
  },
  roleSource,
);

const COORD = { kind: 'agent', agentId: 'coordinator-1', roleId: 'coordinator' };

async function fixtureMetrics() {
  const store = createMemoryRunStore();
  const metrics = createWorkforceMetrics({ now: () => T0 });
  const metricsSink = metricsAuditSink(metrics);
  const registry = createToolRegistry({
    gate: { gateAction: async () => ({ status: 'pending', approval: { id: 'x' } }), readApproval: async () => null, claimApproval: async () => false },
    redact: (v) => v,
    audit: { record: (e) => store.appendAudit(e) },
  });
  const engine = createRunEngine({
    registry,
    store,
    audit: {
      record: async (event) => {
        metricsSink.record(event);
        await store.appendAudit(event);
      },
    },
    now: () => new Date(T0),
    sleep: async () => {},
  });

  async function newRun() {
    const created = await engine.createRun({ companyId: COMPANY, team: TEAM, budget: { maxTokens: 1000, maxToolCalls: 10 } });
    assert.equal(created.ok, true, 'createRun must succeed');
    const started = await engine.startRun(COMPANY, created.run.id);
    assert.equal(started.ok, true, 'startRun must succeed');
    return created.run.id;
  }

  for (let i = 0; i < 3; i++) {
    const runId = await newRun();
    assert.equal((await engine.complete(COMPANY, runId)).ok, true);
  }
  const failedId = await newRun();
  assert.equal((await engine.fail(COMPANY, failedId, 'fixture failure')).ok, true);
  const escalatedId = await newRun();
  assert.equal((await engine.handoff(COMPANY, escalatedId, { actor: COORD, toRole: 'human-review' })).ok, true);
  return metrics;
}

test('error rate: runsFailed / runsStarted equals 0.2 for the fixture', async () => {
  const snap = (await fixtureMetrics()).snapshot();
  assert.equal(snap.runsStarted, 5);
  assert.equal(snap.runsFailed, 1);
  assert.equal(snap.runsFailed / snap.runsStarted, 0.2);
});

test('completion rate: a completed-run count or rate is computed (expected 0.6)', async () => {
  const snap = (await fixtureMetrics()).snapshot();
  const computed = typeof snap.completionRate === 'number' || typeof snap.runsCompleted === 'number';
  assert.ok(
    computed,
    'completion rate is not computed: snapshot() has no completionRate or runsCompleted, and no event records completed runs',
  );
  const rate = typeof snap.completionRate === 'number' ? snap.completionRate : snap.runsCompleted / snap.runsStarted;
  assert.equal(rate, 0.6);
});

test('escalation count: escalations are computed (expected 1)', async () => {
  const snap = (await fixtureMetrics()).snapshot();
  assert.ok(
    typeof snap.escalations === 'number',
    'escalation count is not computed: snapshot() has no escalations field and WorkforceEvent has no escalation kind',
  );
  assert.equal(snap.escalations, 1);
});

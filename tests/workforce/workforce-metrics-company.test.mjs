/**
 * Per-company metrics and audit mapping for server/workforce/runtime/workforce-metrics.ts.
 * Injected clock, in-memory fakes only. No database, network or prom-client.
 * Run: node --test --experimental-transform-types tests/workforce/workforce-metrics-company.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkforceMetrics,
  metricsAuditSink,
  workforceEventFromAudit,
} from '../../server/workforce/runtime/workforce-metrics.ts';

// Silence logging so the test runner's IPC stays clean.
console.log = () => {};
console.info = () => {};
console.warn = () => {};

const T0 = Date.UTC(2026, 10, 4, 9, 0, 0);
const HOUR = 60 * 60 * 1000;
const CO_A = 'co-a';
const CO_B = 'co-b';

function clock(start = T0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

let seq = 0;
function audit(companyId, kind, data = {}) {
  seq++;
  return { id: `e${seq}`, companyId, runId: `r${seq}`, kind, at: new Date(T0).toISOString(), data };
}

test('audit records map to completion, escalation, retry and refusal events', () => {
  assert.deepEqual(workforceEventFromAudit(audit(CO_A, 'run.status', { from: 'running', to: 'completed' })), {
    kind: 'run_completed',
    companyId: CO_A,
  });
  assert.deepEqual(workforceEventFromAudit(audit(CO_A, 'run.handoff', { escalation: true })), { kind: 'escalation', companyId: CO_A });
  assert.deepEqual(workforceEventFromAudit(audit(CO_A, 'run.retry', { attempt: 1 })), { kind: 'tool_retry', companyId: CO_A });
  assert.deepEqual(workforceEventFromAudit(audit(CO_A, 'tool.decision', { outcome: 'refused' })), {
    kind: 'tool_refused',
    companyId: CO_A,
  });
  assert.equal(workforceEventFromAudit(audit(CO_A, 'tool.decision', { outcome: 'allowed' })), null);
  assert.equal(workforceEventFromAudit(audit(CO_A, 'run.handoff', { to: 'worker' })), null);
});

test('audit records with no company id still map, without a company', () => {
  const event = workforceEventFromAudit({ ...audit(null, 'tool.decision', { outcome: 'refused' }) });
  assert.deepEqual(event, { kind: 'tool_refused', companyId: undefined });
});

test('metricsAuditSink feeds the company counters from real-shaped audit records', () => {
  const c = clock();
  const m = createWorkforceMetrics({ now: c.now });
  const sink = metricsAuditSink(m);
  sink.record(audit(CO_A, 'run.status', { from: 'queued', to: 'running' }));
  sink.record(audit(CO_A, 'run.status', { from: 'running', to: 'completed' }));
  sink.record(audit(CO_A, 'run.handoff', { escalation: true }));
  sink.record(audit(CO_B, 'run.status', { from: 'queued', to: 'running' }));
  sink.record(audit(CO_B, 'run.status', { from: 'running', to: 'failed' }));
  const a = m.companySnapshot(CO_A);
  assert.equal(a.runsStarted, 1);
  assert.equal(a.runsCompleted, 1);
  assert.equal(a.completionRate, 1);
  assert.equal(a.escalations, 1);
  const b = m.companySnapshot(CO_B);
  assert.equal(b.runsStarted, 1);
  assert.equal(b.runsFailed, 1);
});

test('companySnapshot: completion and error rates use the company runs started', () => {
  const c = clock();
  const m = createWorkforceMetrics({ now: c.now });
  m.record({ kind: 'run_started', companyId: CO_A });
  m.record({ kind: 'run_started', companyId: CO_A });
  m.record({ kind: 'run_started', companyId: CO_A });
  m.record({ kind: 'run_started', companyId: CO_A });
  m.record({ kind: 'run_started', companyId: CO_A });
  m.record({ kind: 'run_completed', companyId: CO_A });
  m.record({ kind: 'run_completed', companyId: CO_A });
  m.record({ kind: 'run_completed', companyId: CO_A });
  m.record({ kind: 'run_failed', companyId: CO_A });
  m.record({ kind: 'escalation', companyId: CO_A });
  const s = m.companySnapshot(CO_A);
  assert.equal(s.completionRate, 0.6);
  assert.equal(s.errorRate, 0.2);
  assert.equal(s.escalations, 1);
  assert.deepEqual(Object.keys(s).sort(), [
    'actions',
    'completionRate',
    'errorRate',
    'escalations',
    'runsCompleted',
    'runsFailed',
    'runsStarted',
    'spendCents',
    'toolCallsRefused',
    'toolRetries',
  ]);
});

test('companySnapshot never includes another company', () => {
  const c = clock();
  const m = createWorkforceMetrics({ now: c.now });
  m.record({ kind: 'run_started', companyId: CO_B });
  m.record({ kind: 'run_failed', companyId: CO_B });
  m.record({ kind: 'escalation', companyId: CO_B });
  m.record({ kind: 'spend', cents: 500, companyId: CO_B });
  m.record({ kind: 'tool_refused', companyId: CO_B });
  m.record({ kind: 'action', companyId: CO_B });
  const a = m.companySnapshot(CO_A);
  assert.deepEqual(a, {
    runsStarted: 0,
    runsCompleted: 0,
    completionRate: 0,
    runsFailed: 0,
    errorRate: 0,
    escalations: 0,
    toolCallsRefused: 0,
    toolRetries: 0,
    spendCents: 0,
    actions: 0,
  });
});

test('unknown company returns zeros and creates no per-company state', () => {
  const c = clock();
  const m = createWorkforceMetrics({ now: c.now });
  m.companySnapshot('co-ghost');
  m.companyAlerts('co-ghost');
  assert.deepEqual(m.perCompany(), {});
});

test('spend and tool retries are counted per company as well as globally', () => {
  const c = clock();
  const m = createWorkforceMetrics({ now: c.now });
  m.record({ kind: 'spend', cents: 150, companyId: CO_A });
  m.record({ kind: 'spend', cents: 50 });
  m.record({ kind: 'tool_retry', companyId: CO_A });
  m.record({ kind: 'tool_retry' });
  assert.equal(m.snapshot().spendCents, 200);
  assert.equal(m.companySnapshot(CO_A).spendCents, 150);
  assert.equal(m.companySnapshot(CO_A).toolRetries, 1);
  assert.equal(m.snapshot().toolRetries, 2);
});

test('companyAlerts: failure ratio fires for the company at the threshold only', () => {
  const c = clock();
  const m = createWorkforceMetrics({ now: c.now, thresholds: { maxFailureRatio: 0.5 } });
  m.record({ kind: 'run_started', companyId: CO_A });
  m.record({ kind: 'run_started', companyId: CO_A });
  m.record({ kind: 'run_failed', companyId: CO_A });
  assert.deepEqual(m.companyAlerts(CO_A).map((a) => a.code), ['failure_ratio_high']);
  m.record({ kind: 'run_started', companyId: CO_B });
  m.record({ kind: 'run_failed', companyId: CO_B });
  assert.deepEqual(m.companyAlerts(CO_B).map((a) => a.code), ['failure_ratio_high']);
});

test('companyAlerts: a failure ratio below the threshold does not fire', () => {
  const c = clock();
  const m = createWorkforceMetrics({ now: c.now, thresholds: { maxFailureRatio: 0.5 } });
  m.record({ kind: 'run_started', companyId: CO_A });
  m.record({ kind: 'run_started', companyId: CO_A });
  m.record({ kind: 'run_started', companyId: CO_A });
  m.record({ kind: 'run_failed', companyId: CO_A });
  assert.deepEqual(m.companyAlerts(CO_A), []);
});

test('companyAlerts: spend cap is checked against the company spend, not the global total', () => {
  const c = clock();
  const m = createWorkforceMetrics({ now: c.now, thresholds: { maxSpendCents: 100 } });
  m.record({ kind: 'spend', cents: 90, companyId: CO_A });
  m.record({ kind: 'spend', cents: 90, companyId: CO_B });
  assert.deepEqual(m.companyAlerts(CO_A), []);
  assert.deepEqual(m.companyAlerts(CO_B), []);
  m.record({ kind: 'spend', cents: 10, companyId: CO_A });
  assert.deepEqual(m.companyAlerts(CO_A).map((a) => a.code), ['spend_over_cap']);
  assert.deepEqual(m.companyAlerts(CO_B), []);
});

test('companyAlerts: action volume names no other company and uses the trailing hour', () => {
  const c = clock();
  const m = createWorkforceMetrics({ now: c.now, thresholds: { maxActionsPerCompanyPerHour: 2 } });
  m.record({ kind: 'action', companyId: CO_B });
  m.record({ kind: 'action', companyId: CO_B });
  assert.deepEqual(m.companyAlerts(CO_A), []);
  const alerts = m.companyAlerts(CO_B);
  assert.deepEqual(alerts.map((a) => a.code), ['action_volume_high']);
  assert.ok(!alerts[0].message.includes(CO_A));
  c.advance(HOUR + 1);
  assert.deepEqual(m.companyAlerts(CO_B), []);
});

test('companyAlerts never include provider errors, which have no company', () => {
  const c = clock();
  const m = createWorkforceMetrics({ now: c.now, thresholds: { maxProviderErrors: 1 } });
  m.record({ kind: 'provider_error', provider: 'x' });
  assert.equal(m.alerts().length, 1, 'global alert still exists');
  assert.deepEqual(m.companyAlerts(CO_A), []);
});

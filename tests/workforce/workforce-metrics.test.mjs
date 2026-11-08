/**
 * Tests for server/workforce/runtime/workforce-metrics.ts. Injected clock only, no prom-client, no timers, no network.
 * Run: node --test --experimental-transform-types tests/workforce/workforce-metrics.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkforceMetrics } from '../../server/workforce/runtime/workforce-metrics.ts';

const T0 = Date.UTC(2026, 10, 3, 9, 0, 0);
const HOUR = 60 * 60 * 1000;

function clock(start = T0) {
  let t = start;
  return {
    now: () => t,
    set(v) {
      t = v;
    },
    advance(ms) {
      t += ms;
    },
  };
}

function make(thresholds, start = T0) {
  const c = clock(start);
  const m = createWorkforceMetrics({ now: c.now, thresholds });
  return { m, c };
}

const codes = (alerts) => alerts.map((a) => a.code).sort();

// ---------- counters ----------

test('runsStarted and runsFailed count their events', () => {
  const { m } = make();
  m.record({ kind: 'run_started', companyId: 'co-1' });
  m.record({ kind: 'run_started', companyId: 'co-2' });
  m.record({ kind: 'run_failed', companyId: 'co-1' });
  const s = m.snapshot();
  assert.equal(s.runsStarted, 2);
  assert.equal(s.runsFailed, 1);
});

test('toolCallsRefused and toolRetries count their events', () => {
  const { m } = make();
  m.record({ kind: 'tool_refused', companyId: 'co-1' });
  m.record({ kind: 'tool_refused' });
  m.record({ kind: 'tool_retry' });
  m.record({ kind: 'tool_retry', companyId: 'co-1' });
  m.record({ kind: 'tool_retry' });
  const s = m.snapshot();
  assert.equal(s.toolCallsRefused, 2);
  assert.equal(s.toolRetries, 3);
});

test('approvalsPending is a gauge set by the caller, not accumulated', () => {
  const { m } = make();
  m.setApprovalsPending(4);
  m.setApprovalsPending(1);
  assert.equal(m.snapshot().approvalsPending, 1);
  assert.throws(() => m.setApprovalsPending(-1), RangeError);
  assert.throws(() => m.setApprovalsPending(Number.NaN), RangeError);
});

test('approvalsDelayedOver counts approvals requested at least thresholdMs ago', () => {
  const { m } = make();
  const requested = [T0 - 10_000, T0 - 5 * 60_000, T0 - 30 * 60_000, T0 - 1000];
  assert.equal(m.approvalsDelayedOver(5 * 60_000, requested), 2);
  assert.equal(m.approvalsDelayedOver(HOUR, requested), 0);
  assert.equal(m.approvalsDelayedOver(0, requested), 4);
  assert.equal(m.snapshot().approvalsDelayed, 4, 'snapshot holds the most recent computed value');
});

test('providerErrors counts every provider_error event', () => {
  const { m } = make();
  m.record({ kind: 'provider_error', provider: 'openai' });
  m.record({ kind: 'provider_error' });
  assert.equal(m.snapshot().providerErrors, 2);
});

test('spendCents sums the cents passed in', () => {
  const { m } = make();
  m.record({ kind: 'spend', cents: 125, companyId: 'co-1' });
  m.record({ kind: 'spend', cents: 75 });
  assert.equal(m.snapshot().spendCents, 200);
  assert.throws(() => m.record({ kind: 'spend', cents: -5 }), RangeError);
});

test('actions are counted globally and per company', () => {
  const { m } = make();
  m.record({ kind: 'action', companyId: 'co-1' });
  m.record({ kind: 'action', companyId: 'co-1' });
  m.record({ kind: 'action', companyId: 'co-2' });
  assert.equal(m.snapshot().actions, 3);
  assert.deepEqual(m.perCompany(), {
    'co-1': { runsStarted: 0, runsFailed: 0, toolCallsRefused: 0, actions: 2 },
    'co-2': { runsStarted: 0, runsFailed: 0, toolCallsRefused: 0, actions: 1 },
  });
});

test('per-company counts track runs and refusals by company', () => {
  const { m } = make();
  m.record({ kind: 'run_started', companyId: 'co-1' });
  m.record({ kind: 'run_failed', companyId: 'co-1' });
  m.record({ kind: 'tool_refused', companyId: 'co-1' });
  assert.deepEqual(m.perCompany()['co-1'], { runsStarted: 1, runsFailed: 1, toolCallsRefused: 1, actions: 0 });
});

test('unknown event kinds are rejected', () => {
  const { m } = make();
  assert.throws(() => m.record({ kind: 'bogus' }), TypeError);
});

// ---------- snapshot ----------

test('snapshot returns plain numbers only', () => {
  const { m } = make();
  m.record({ kind: 'run_started', companyId: 'co-1' });
  m.record({ kind: 'spend', cents: 10 });
  m.setApprovalsPending(2);
  m.approvalsDelayedOver(0, [T0 - 1]);
  const s = m.snapshot();
  assert.deepEqual(Object.keys(s).sort(), [
    'actions',
    'approvalsDelayed',
    'approvalsPending',
    'completionRate',
    'escalations',
    'providerErrors',
    'runsCompleted',
    'runsFailed',
    'runsStarted',
    'spendCents',
    'toolCallsRefused',
    'toolRetries',
  ]);
  for (const [k, v] of Object.entries(s)) {
    assert.equal(typeof v, 'number', `${k} should be a number`);
  }
  assert.equal(s.approvalsDelayed, 1);
});

test('snapshot is a copy, not a live view', () => {
  const { m } = make();
  const before = m.snapshot();
  m.record({ kind: 'run_started' });
  assert.equal(before.runsStarted, 0);
  assert.equal(m.snapshot().runsStarted, 1);
});

// ---------- alerts: failure ratio ----------

test('failure ratio alert fires at the threshold and not below', () => {
  const { m } = make({ maxFailureRatio: 0.5 });
  for (let i = 0; i < 4; i++) m.record({ kind: 'run_started' });
  m.record({ kind: 'run_failed' });
  assert.deepEqual(codes(m.alerts()), [], '1 of 4 is 0.25, below 0.5');
  m.record({ kind: 'run_failed' });
  assert.deepEqual(codes(m.alerts()), ['failure_ratio_high'], '2 of 4 is 0.5, at threshold');
  const [alert] = m.alerts();
  assert.equal(alert.severity, 'warning');
});

test('failure ratio alert never fires with zero started runs', () => {
  const { m } = make({ maxFailureRatio: 0 });
  assert.deepEqual(m.alerts(), []);
});

test('failure ratio threshold must be between 0 and 1', () => {
  assert.throws(() => createWorkforceMetrics({ now: () => T0, thresholds: { maxFailureRatio: 1.5 } }), RangeError);
});

// ---------- alerts: provider errors in window ----------

test('provider error alert fires at the count threshold and not below', () => {
  const { m } = make({ maxProviderErrors: 3, providerErrorWindowMs: 10 * 60_000 });
  m.record({ kind: 'provider_error' });
  m.record({ kind: 'provider_error' });
  assert.deepEqual(codes(m.alerts()), []);
  m.record({ kind: 'provider_error' });
  const alerts = m.alerts();
  assert.deepEqual(codes(alerts), ['provider_errors_high']);
  assert.equal(alerts[0].severity, 'critical');
});

test('provider error window expires with the injected clock', () => {
  const { m, c } = make({ maxProviderErrors: 2, providerErrorWindowMs: 10 * 60_000 });
  m.record({ kind: 'provider_error' });
  c.advance(4 * 60_000);
  m.record({ kind: 'provider_error' });
  assert.deepEqual(codes(m.alerts()), ['provider_errors_high']);
  // First error is now 11 minutes old, outside the 10 minute window.
  c.advance(7 * 60_000);
  assert.deepEqual(codes(m.alerts()), [], 'only one error remains in the window');
  assert.equal(m.snapshot().providerErrors, 2, 'the lifetime counter is not windowed');
});

test('provider error window defaults to one hour', () => {
  const { m, c } = make({ maxProviderErrors: 1 });
  m.record({ kind: 'provider_error' });
  c.advance(HOUR - 1);
  assert.deepEqual(codes(m.alerts()), ['provider_errors_high'], 'still inside the hour');
  c.advance(2);
  assert.deepEqual(codes(m.alerts()), [], 'expired once more than an hour has passed');
});

// ---------- alerts: spend cap ----------

test('spend alert fires at the cap and not below', () => {
  const { m } = make({ maxSpendCents: 1000 });
  m.record({ kind: 'spend', cents: 999 });
  assert.deepEqual(codes(m.alerts()), []);
  m.record({ kind: 'spend', cents: 1 });
  const alerts = m.alerts();
  assert.deepEqual(codes(alerts), ['spend_over_cap']);
  assert.equal(alerts[0].severity, 'critical');
  assert.match(alerts[0].message, /1000/);
});

// ---------- alerts: action volume per company per hour ----------

test('action volume alert names only the company over the hourly threshold', () => {
  const { m } = make({ maxActionsPerCompanyPerHour: 3 });
  m.record({ kind: 'action', companyId: 'co-busy' });
  m.record({ kind: 'action', companyId: 'co-busy' });
  m.record({ kind: 'action', companyId: 'co-quiet' });
  assert.deepEqual(m.alerts(), [], 'two actions for co-busy is below 3');
  m.record({ kind: 'action', companyId: 'co-busy' });
  const alerts = m.alerts();
  assert.deepEqual(codes(alerts), ['action_volume_high']);
  assert.match(alerts[0].message, /co-busy/);
  assert.doesNotMatch(alerts[0].message, /co-quiet/);
});

test('action volume window is the trailing hour from the injected clock', () => {
  const { m, c } = make({ maxActionsPerCompanyPerHour: 2 });
  m.record({ kind: 'action', companyId: 'co-1' });
  c.advance(30 * 60_000);
  m.record({ kind: 'action', companyId: 'co-1' });
  assert.deepEqual(codes(m.alerts()), ['action_volume_high']);
  // The first action is now 60 minutes + 1 ms old, outside the trailing hour.
  c.advance(30 * 60_000 + 1);
  assert.deepEqual(m.alerts(), []);
  assert.equal(m.perCompany()['co-1'].actions, 2, 'the cumulative per-company total is not windowed');
});

// ---------- unset thresholds ----------

test('no thresholds configured means no alerts, however large the numbers', () => {
  const { m } = make();
  for (let i = 0; i < 50; i++) {
    m.record({ kind: 'run_started' });
    m.record({ kind: 'run_failed' });
    m.record({ kind: 'provider_error' });
    m.record({ kind: 'spend', cents: 100_000 });
    m.record({ kind: 'action', companyId: 'co-1' });
  }
  assert.deepEqual(m.alerts(), []);
});

test('only the configured thresholds alert', () => {
  const { m } = make({ maxSpendCents: 100 });
  for (let i = 0; i < 20; i++) {
    m.record({ kind: 'run_started' });
    m.record({ kind: 'run_failed' });
    m.record({ kind: 'provider_error' });
    m.record({ kind: 'action', companyId: 'co-1' });
  }
  m.record({ kind: 'spend', cents: 100 });
  assert.deepEqual(codes(m.alerts()), ['spend_over_cap']);
});

test('invalid threshold values are rejected at construction', () => {
  assert.throws(() => createWorkforceMetrics({ now: () => T0, thresholds: { maxSpendCents: -1 } }), RangeError);
  assert.throws(() => createWorkforceMetrics({ now: () => T0, thresholds: { maxProviderErrors: Infinity } }), RangeError);
  assert.throws(() => createWorkforceMetrics({ now: 'nope' }), TypeError);
});

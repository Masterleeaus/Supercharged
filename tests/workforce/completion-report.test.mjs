/**
 * Completion report for a finished run (checklist 3). Pure functions only: no I/O, no database, no network.
 * Run: node --test --experimental-transform-types tests/workforce/completion-report.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCompletionReport } from '../../server/workforce/runtime/completion-report.ts';

const CO = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const OTHER = '1c2d3e4f-5061-4b7c-9d8e-0f1a2b3c4d5e';

function run(overrides = {}) {
  return {
    id: 'run-1',
    companyId: CO,
    status: 'completed',
    path: ['coordinator', 'writer', 'reviewer'],
    finishedAt: '2026-11-03T10:00:00.000Z',
    ...overrides,
  };
}

test('roles are listed in first-appearance order with no duplicates', () => {
  const report = buildCompletionReport({
    companyId: CO,
    run: run(),
    handoffs: [
      { companyId: CO, from: 'coordinator', to: 'writer', at: '2026-11-03T09:00:00.000Z' },
      { companyId: CO, from: 'writer', to: 'reviewer', at: '2026-11-03T09:10:00.000Z' },
      { companyId: CO, from: 'reviewer', to: 'writer', at: '2026-11-03T09:20:00.000Z' },
    ],
    escalations: [{ companyId: CO, reason: 'needs sign-off', escalatedTo: 'coordinator', at: '2026-11-03T09:30:00.000Z' }],
  });
  assert.deepEqual(report.rolesInvolved, ['coordinator', 'writer', 'reviewer']);
});

test('handoff chain keeps the order the handoffs happened in', () => {
  const report = buildCompletionReport({
    companyId: CO,
    run: run(),
    handoffs: [
      { companyId: CO, from: 'coordinator', to: 'writer', at: '2026-11-03T09:00:00.000Z' },
      { companyId: CO, from: 'writer', to: 'reviewer', at: '2026-11-03T09:10:00.000Z' },
    ],
  });
  assert.deepEqual(report.handoffChain, [
    { from: 'coordinator', to: 'writer', at: '2026-11-03T09:00:00.000Z' },
    { from: 'writer', to: 'reviewer', at: '2026-11-03T09:10:00.000Z' },
  ]);
  assert.equal(report.startedByRole, 'coordinator');
});

test('tool calls are summarised by tool and outcome with counts', () => {
  const report = buildCompletionReport({
    companyId: CO,
    run: run(),
    toolCalls: [
      { companyId: CO, tool: 'search', outcome: 'ok' },
      { companyId: CO, tool: 'search', outcome: 'ok' },
      { companyId: CO, tool: 'search', outcome: 'refused' },
      { companyId: CO, tool: 'email', outcome: 'ok' },
    ],
  });
  assert.deepEqual(report.toolCallSummary, [
    { tool: 'search', outcome: 'ok', count: 2 },
    { tool: 'search', outcome: 'refused', count: 1 },
    { tool: 'email', outcome: 'ok', count: 1 },
  ]);
});

test('escalations are included with reason, target and time', () => {
  const report = buildCompletionReport({
    companyId: CO,
    run: run(),
    escalations: [{ companyId: CO, reason: 'refund over limit', escalatedTo: 'manager', at: '2026-11-03T09:45:00.000Z' }],
  });
  assert.deepEqual(report.escalations, [
    { reason: 'refund over limit', escalatedTo: 'manager', at: '2026-11-03T09:45:00.000Z' },
  ]);
  assert.ok(report.rolesInvolved.includes('manager'));
});

test('rows from another company are excluded everywhere', () => {
  const report = buildCompletionReport({
    companyId: CO,
    run: run(),
    handoffs: [
      { companyId: CO, from: 'coordinator', to: 'writer', at: '2026-11-03T09:00:00.000Z' },
      { companyId: OTHER, from: 'coordinator', to: 'spy', at: '2026-11-03T09:01:00.000Z' },
    ],
    toolCalls: [
      { companyId: CO, tool: 'search', outcome: 'ok' },
      { companyId: OTHER, tool: 'search', outcome: 'ok' },
      { companyId: OTHER, tool: 'secret', outcome: 'ok' },
    ],
    escalations: [{ companyId: OTHER, reason: 'leak', escalatedTo: 'rival', at: '2026-11-03T09:02:00.000Z' }],
  });
  assert.equal(report.handoffChain.length, 1);
  assert.deepEqual(report.toolCallSummary, [{ tool: 'search', outcome: 'ok', count: 1 }]);
  assert.deepEqual(report.escalations, []);
  assert.ok(!report.rolesInvolved.includes('spy'));
  assert.ok(!report.rolesInvolved.includes('rival'));
});

test('outcomeText for a completed run uses only status and counts', () => {
  const report = buildCompletionReport({
    companyId: CO,
    run: run({ status: 'completed' }),
    handoffs: [{ companyId: CO, from: 'coordinator', to: 'writer', at: '2026-11-03T09:00:00.000Z' }],
    toolCalls: [
      { companyId: CO, tool: 'search', outcome: 'ok' },
      { companyId: CO, tool: 'search', outcome: 'ok' },
    ],
    escalations: [],
  });
  assert.equal(report.outcomeText, 'The run completed with 2 tool calls, 1 handoff and 0 escalations.');
});

test('outcomeText for a failed run says it failed and keeps the counts', () => {
  const report = buildCompletionReport({
    companyId: CO,
    run: run({ status: 'failed' }),
    toolCalls: [{ companyId: CO, tool: 'email', outcome: 'error' }],
    escalations: [{ companyId: CO, reason: 'provider down', escalatedTo: 'coordinator', at: '2026-11-03T09:05:00.000Z' }],
  });
  assert.equal(report.outcomeText, 'The run failed after 1 tool call, 0 handoffs and 1 escalation.');
  assert.equal(report.status, 'failed');
});

test('unknown finishedAt is shown as unknown, not guessed', () => {
  const report = buildCompletionReport({ companyId: CO, run: run({ finishedAt: undefined }) });
  assert.equal(report.finishedAt, 'unknown');
});

test('missing values are shown as unknown', () => {
  const report = buildCompletionReport({
    companyId: CO,
    run: { id: 'run-2', companyId: CO },
    toolCalls: [{ companyId: CO }],
    handoffs: [{ companyId: CO, from: 'writer' }],
  });
  assert.equal(report.status, 'unknown');
  assert.equal(report.startedByRole, 'unknown');
  assert.deepEqual(report.toolCallSummary, [{ tool: 'unknown', outcome: 'unknown', count: 1 }]);
  assert.deepEqual(report.handoffChain, [{ from: 'writer', to: 'unknown', at: 'unknown' }]);
  assert.deepEqual(report.rolesInvolved, ['writer']);
});

test('a non-UUID companyId is refused with invalid_company', () => {
  for (const bad of ['7', 'company-1', '', null, undefined, 7, '0b1c2d3e4f504a6b8c7d9e0f1a2b3c4d']) {
    assert.throws(
      () => buildCompletionReport({ companyId: bad, run: run({ companyId: bad }) }),
      (error) => error.code === 'invalid_company' && error.message === 'invalid_company',
    );
  }
});

test('a run that belongs to another company is refused', () => {
  assert.throws(
    () => buildCompletionReport({ companyId: CO, run: run({ companyId: OTHER }) }),
    (error) => error.code === 'run_not_in_company',
  );
});

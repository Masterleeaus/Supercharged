/**
 * Tests for server/workforce/runtime/task-view.ts. Pure: no database, no network, no timers.
 * Run: node --test --experimental-transform-types tests/workforce/task-view.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskView } from '../../server/workforce/runtime/task-view.ts';

const CO = 'co-a';
const OTHER = 'co-b';

function run(overrides = {}) {
  return {
    id: 'run-1',
    companyId: CO,
    status: 'completed',
    version: 3,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:05:00.000Z',
    team: {},
    path: ['coord'],
    delegations: [],
    limits: {},
    budget: { maxTokens: 100, maxToolCalls: 10, tokensUsed: 5, toolCalls: 2 },
    retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    pendingApproval: null,
    reason: 'finished cleanly',
    ...overrides,
  };
}

function call(overrides = {}) {
  return {
    companyId: CO,
    runId: 'run-1',
    toolId: 'quote.lookup',
    callIndex: 0,
    outcome: 'executed',
    attempt: 1,
    summary: 'Found quote',
    ...overrides,
  };
}

function event(overrides = {}) {
  return {
    id: 'ev',
    companyId: CO,
    runId: 'run-1',
    kind: 'run.status',
    at: '2026-11-01T10:01:00.000Z',
    data: {},
    ...overrides,
  };
}

test('a run from another company returns nothing', () => {
  const view = buildTaskView({
    run: run({ companyId: OTHER }),
    toolCalls: [call({ companyId: OTHER })],
    approvals: [{ id: 'ap', companyId: OTHER, runId: 'run-1', action: 'send', status: 'approved' }],
    auditEvents: [event({ companyId: OTHER })],
    companyId: CO,
  });
  assert.equal(view, null);
});

test('records from another company are never included in a run view', () => {
  const view = buildTaskView({
    run: run(),
    toolCalls: [call(), call({ companyId: OTHER, toolId: 'leak.tool', callIndex: 1 })],
    approvals: [{ id: 'ap-other', companyId: OTHER, runId: 'run-1', action: 'leak', status: 'pending' }],
    auditEvents: [event(), event({ companyId: OTHER, kind: 'tool.execution' })],
    companyId: CO,
  });
  assert.equal(view.toolCalls.length, 1);
  assert.equal(view.evidence.length, 1);
  assert.equal(view.approvals.length, 0);
  assert.equal(view.audit.length, 1);
  assert.equal(JSON.stringify(view).includes('leak'), false);
});

test('redact is applied to evidence summaries and other free text', () => {
  const redact = (t) => t.replace(/\b\d{9}\b/g, '[id]');
  const view = buildTaskView({
    run: run({ reason: 'customer 123456789 done', plan: ['check 123456789'] }),
    toolCalls: [call({ summary: 'account 987654321 matched' })],
    approvals: [{ id: 'ap', companyId: CO, runId: 'run-1', action: 'send to 111222333', status: 'approved' }],
    auditEvents: [event({ kind: 'tool.decision' })],
    companyId: CO,
    redact,
  });
  assert.equal(view.evidence[0].summary, 'account [id] matched');
  assert.equal(view.outcome.reason, 'customer [id] done');
  assert.equal(view.plan[0].text, 'check [id]');
  assert.equal(view.approvals[0].action, 'send to [id]');
  assert.equal(JSON.stringify(view).includes('123456789'), false);
});

test('raw params are never copied into the evidence', () => {
  const view = buildTaskView({
    run: run(),
    toolCalls: [{ ...call(), params: { secret: 'hunter2' } }],
    companyId: CO,
  });
  assert.equal(JSON.stringify(view).includes('hunter2'), false);
  assert.equal(JSON.stringify(view).includes('params'), false);
});

test('tool calls are ordered by callIndex, not by input order', () => {
  const view = buildTaskView({
    run: run(),
    toolCalls: [
      call({ toolId: 'c', callIndex: 2, attempt: 1 }),
      call({ toolId: 'a', callIndex: 0, attempt: 1 }),
      call({ toolId: 'b', callIndex: 1, attempt: 2, outcome: 'failed' }),
    ],
    companyId: CO,
  });
  assert.deepEqual(
    view.toolCalls.map((t) => [t.tool, t.callIndex, t.attempt, t.outcome]),
    [
      ['a', 0, 1, 'executed'],
      ['b', 1, 2, 'failed'],
      ['c', 2, 1, 'executed'],
    ],
  );
  assert.deepEqual(
    view.evidence.map((e) => e.tool),
    ['a', 'b', 'c'],
  );
});

test('approvals are included only for this run', () => {
  const view = buildTaskView({
    run: run({ pendingApproval: { approvalId: 'ap-1' } }),
    approvals: [
      { id: 'ap-1', companyId: CO, runId: 'run-1', action: 'invoice.send', status: 'approved' },
      { id: 'ap-2', companyId: CO, runId: 'run-2', action: 'invoice.send', status: 'pending' },
    ],
    companyId: CO,
  });
  assert.deepEqual(view.approvals, [{ id: 'ap-1', status: 'approved', action: 'invoice.send' }]);
});

test('a missing plan gives an empty list, not a guess', () => {
  const view = buildTaskView({
    run: run(),
    toolCalls: [call({ toolId: 'quote.lookup' })],
    companyId: CO,
  });
  assert.deepEqual(view.plan, []);
  assert.equal(view.toolCalls.length, 1);
});

test('plan uses the recorded steps when present, and outcome and audit keep order', () => {
  const view = buildTaskView({
    run: run({ plan: ['step one', { text: 'step two' }, 42] }),
    auditEvents: [
      event({ kind: 'run.created', at: '2026-11-01T10:00:00.000Z' }),
      event({ kind: 'tool.execution', at: '2026-11-01T10:02:00.000Z' }),
      event({ kind: 'run.status', at: '2026-11-01T10:03:00.000Z' }),
    ],
    companyId: CO,
  });
  assert.deepEqual(view.plan, [{ text: 'step one' }, { text: 'step two' }]);
  assert.deepEqual(view.outcome, { status: 'completed', reason: 'finished cleanly' });
  assert.deepEqual(
    view.audit.map((a) => a.action),
    ['run.created', 'tool.execution', 'run.status'],
  );
  assert.equal(view.audit[0].createdAt, '2026-11-01T10:00:00.000Z');
});

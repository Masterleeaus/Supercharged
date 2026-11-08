/**
 * Tests for server/workforce/runtime/agent-view.ts. Pure: no database, no network, no timers.
 * Run: node --test --experimental-transform-types tests/workforce/agent-view.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentView } from '../../server/workforce/runtime/agent-view.ts';
import { createControlState, pauseAgent } from '../../server/workforce/runtime/controls.ts';

const NOW = new Date('2026-11-03T12:00:00.000Z');
const HUMAN = { kind: 'human', userId: 'user-1' };

const AGENT = Object.freeze({
  companyId: 'co-a',
  agentId: 'agent-1',
  roleId: 'field-cleaner',
  teamId: 'team-1',
  channels: Object.freeze(['chat', 'sms']),
  permissions: Object.freeze(['tool.read', 'tool.write']),
  autonomy: 'suggest',
  status: 'active',
});

const ROLE = { name: 'Field Cleaner' };

function run(id, status, updatedAt, extra = {}) {
  return {
    id,
    companyId: 'co-a',
    agentId: 'agent-1',
    status,
    updatedAt,
    createdAt: updatedAt,
    pendingApproval: null,
    reason: null,
    ...extra,
  };
}

/** Terminal runs with an hour-by-hour timestamp: index i finishes at 00:00 + i hours on 2026-11-02. */
function finishedAt(i) {
  return new Date(Date.UTC(2026, 10, 2, i, 0, 0)).toISOString();
}

test('fields come through from the agent, role and control state', () => {
  const controls = pauseAgent(createControlState(), 'co-a', 'agent-1', HUMAN).state;
  const view = buildAgentView({
    agent: AGENT,
    role: ROLE,
    controlState: controls,
    runs: [run('r-open', 'running', '2026-11-03T11:00:00.000Z')],
    now: NOW,
  });

  assert.equal(view.agentId, 'agent-1');
  assert.equal(view.roleId, 'field-cleaner');
  assert.equal(view.roleName, 'Field Cleaner');
  assert.equal(view.autonomy, 'suggest');
  assert.deepEqual(view.channels, ['chat', 'sms']);
  assert.deepEqual(view.permissions, ['tool.read', 'tool.write']);
  assert.equal(view.state, 'paused');
  assert.equal(view.assignedWork.length, 1);
  assert.equal(view.assignedWork[0].runId, 'r-open');
  assert.equal(view.assignedWork[0].label, 'running');
  assert.equal(view.assignedWork[0].text, 'In progress');
  assert.deepEqual(view.recentResults, []);
  assert.deepEqual(view.errors, []);
});

test('state is unknown when no control entry exists', () => {
  const view = buildAgentView({ agent: AGENT, role: ROLE, controlState: createControlState(), runs: [], now: NOW });
  assert.equal(view.state, 'unknown');
});

test("another company's control state does not supply the agent's state", () => {
  const controls = pauseAgent(createControlState(), 'co-b', 'agent-1', HUMAN).state;
  const view = buildAgentView({ agent: AGENT, role: ROLE, controlState: controls, runs: [], now: NOW });
  assert.equal(view.state, 'unknown');
});

test('roleName is unknown when no role is given', () => {
  const view = buildAgentView({ agent: AGENT, controlState: createControlState(), runs: [], now: NOW });
  assert.equal(view.roleName, 'unknown');
  const nullRole = buildAgentView({ agent: AGENT, role: null, controlState: createControlState(), runs: [], now: NOW });
  assert.equal(nullRole.roleName, 'unknown');
});

test("another company's runs are excluded from every list", () => {
  const foreign = [
    run('foreign-open', 'running', '2026-11-03T11:00:00.000Z', { companyId: 'co-b' }),
    run('foreign-done', 'completed', finishedAt(3), { companyId: 'co-b' }),
    run('foreign-fail', 'failed', finishedAt(4), { companyId: 'co-b' }),
  ];
  const view = buildAgentView({
    agent: AGENT,
    role: ROLE,
    controlState: createControlState(),
    runs: [...foreign, run('own-open', 'queued', '2026-11-03T11:30:00.000Z')],
    now: NOW,
  });
  assert.deepEqual(view.assignedWork.map((w) => w.runId), ['own-open']);
  assert.deepEqual(view.recentResults, []);
  assert.deepEqual(view.errors, []);
});

test('runs belonging to other agents in the same company are excluded', () => {
  const view = buildAgentView({
    agent: AGENT,
    role: ROLE,
    controlState: createControlState(),
    runs: [run('other-agent', 'running', '2026-11-03T11:00:00.000Z', { agentId: 'agent-2' })],
    now: NOW,
  });
  assert.deepEqual(view.assignedWork, []);
});

test('assignedWork holds only non-terminal runs, with their labels', () => {
  const view = buildAgentView({
    agent: AGENT,
    role: ROLE,
    controlState: createControlState(),
    runs: [
      run('q', 'queued', '2026-11-03T11:00:00.000Z'),
      run('a', 'awaiting_approval', '2026-11-03T11:50:00.000Z', {
        pendingApproval: { approvalId: 'x', toolId: 't', paramsSha256: 'h', actorKey: 'agent-1' },
      }),
      run('done', 'completed', finishedAt(1)),
    ],
    now: NOW,
  });
  assert.deepEqual(view.assignedWork.map((w) => [w.runId, w.label]), [
    ['q', 'queued'],
    ['a', 'awaiting_approval'],
  ]);
});

test('recentResults is limited to 5 terminal runs, newest first', () => {
  const runs = [];
  for (let i = 0; i < 8; i += 1) {
    runs.push(run(`done-${i}`, 'completed', finishedAt(i)));
  }
  // Out of order on input: the view must sort, not rely on input order.
  runs.reverse();
  const view = buildAgentView({ agent: AGENT, role: ROLE, controlState: createControlState(), runs, now: NOW });
  assert.equal(view.recentResults.length, 5);
  assert.deepEqual(
    view.recentResults.map((r) => r.runId),
    ['done-7', 'done-6', 'done-5', 'done-4', 'done-3'],
  );
  assert.equal(view.recentResults[0].label, 'completed');
  assert.equal(view.recentResults[0].finishedAt, finishedAt(7));
});

test('recentResults includes failed, cancelled and budget-exhausted runs as terminal results', () => {
  const view = buildAgentView({
    agent: AGENT,
    role: ROLE,
    controlState: createControlState(),
    runs: [
      run('c', 'cancelled', finishedAt(1)),
      run('b', 'budget_exhausted', finishedAt(2)),
      run('f', 'failed', finishedAt(3)),
    ],
    now: NOW,
  });
  assert.deepEqual(view.recentResults.map((r) => [r.runId, r.label]), [
    ['f', 'failed'],
    ['b', 'needs_attention'],
    ['c', 'cancelled'],
  ]);
});

test('errors holds only failed runs, limited to 5, newest first', () => {
  const runs = [];
  for (let i = 0; i < 7; i += 1) {
    runs.push(run(`fail-${i}`, 'failed', finishedAt(i), { reason: `boom ${i}` }));
  }
  runs.push(run('done', 'completed', finishedAt(20)));
  runs.push(run('cancel', 'cancelled', finishedAt(21)));
  const view = buildAgentView({ agent: AGENT, role: ROLE, controlState: createControlState(), runs, now: NOW });

  assert.equal(view.errors.length, 5);
  assert.deepEqual(
    view.errors.map((e) => e.runId),
    ['fail-6', 'fail-5', 'fail-4', 'fail-3', 'fail-2'],
  );
  assert.equal(view.errors[0].label, 'failed');
  assert.equal(view.errors[0].reason, 'boom 6');
  assert.equal(view.errors.every((e) => e.label === 'failed'), true);
});

test('finishedAt is read from the run when present', () => {
  const view = buildAgentView({
    agent: AGENT,
    role: ROLE,
    controlState: createControlState(),
    runs: [run('f', 'failed', '2026-11-03T09:00:00.000Z', { finishedAt: '2026-11-02T06:00:00.000Z' })],
    now: NOW,
  });
  assert.equal(view.errors[0].finishedAt, '2026-11-02T06:00:00.000Z');
  assert.equal(view.recentResults[0].finishedAt, '2026-11-02T06:00:00.000Z');
});

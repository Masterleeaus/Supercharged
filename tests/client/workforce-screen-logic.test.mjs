/**
 * Tests for client/src/pages/workforce/workforce-screen-logic.ts, the pure helpers behind the roster,
 * hierarchy and agent detail screens. Pure: no network, no DOM, no stdout.
 * Run: node --test --experimental-transform-types tests/client/workforce-screen-logic.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentStateLabel,
  buildHierarchy,
  formatWhen,
  loadErrorMessage,
  parseAgentDetail,
  rosterStatusLabel,
  runLabelText,
  runLabelTone,
  sortRoster,
  tierLabel,
  toRosterItems,
} from '../../client/src/pages/workforce/workforce-screen-logic.ts';

const item = (id, extra = {}) => ({
  id,
  roleId: 'field-cleaner',
  status: 'active',
  name: id,
  teamId: null,
  coordinatorId: null,
  autonomy: null,
  ...extra,
});

test('toRosterItems: keeps roster fields and drops rows without a string id', () => {
  const out = toRosterItems([
    { id: 'a1', roleId: 'field-cleaner', status: 'paused', name: 'Ava' },
    { id: '', roleId: 'x' },
    null,
    'nope',
    { roleId: 'no-id' },
    { id: 42 },
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    id: 'a1', roleId: 'field-cleaner', status: 'paused', name: 'Ava',
    teamId: null, coordinatorId: null, autonomy: null,
  });
});

test('toRosterItems: missing name falls back to id, missing role and status read as unknown', () => {
  const [row] = toRosterItems([{ id: 'a2', name: '  ' }]);
  assert.equal(row.name, 'a2');
  assert.equal(row.roleId, 'unknown');
  assert.equal(row.status, 'unknown');
});

test('toRosterItems: optional team, coordinator and tier are read only when present', () => {
  const [row] = toRosterItems([{ id: 'a3', teamId: 't1', coordinatorId: 'a1', autonomy: 'suggest' }]);
  assert.equal(row.teamId, 't1');
  assert.equal(row.coordinatorId, 'a1');
  assert.equal(row.autonomy, 'suggest');
});

test('toRosterItems: a non-array body gives an empty list', () => {
  assert.deepEqual(toRosterItems(undefined), []);
  assert.deepEqual(toRosterItems({ items: [] }), []);
});

test('sortRoster: by name then id, returns a copy', () => {
  const input = [item('b', { name: 'Zed' }), item('a', { name: 'Amy' }), item('c', { name: 'Amy' })];
  const out = sortRoster(input);
  assert.notEqual(out, input);
  assert.deepEqual(out.map((i) => i.id), ['a', 'c', 'b']);
  assert.deepEqual(input.map((i) => i.id), ['b', 'a', 'c']);
});

test('status and tier labels: known values are named, unknown values are not guessed', () => {
  assert.equal(rosterStatusLabel('active'), 'Active');
  assert.equal(rosterStatusLabel('retired'), 'Retired');
  assert.equal(rosterStatusLabel('constructor'), 'Unknown status');
  assert.equal(tierLabel('auto'), 'Auto');
  assert.equal(tierLabel('predictive'), 'Predictive');
  assert.equal(tierLabel('toString'), 'Unknown tier');
  assert.equal(tierLabel(null), 'Not in roster list');
});

test('buildHierarchy: children nest under their coordinator, each agent appears once', () => {
  const nodes = buildHierarchy([
    item('boss'),
    item('w1', { coordinatorId: 'boss' }),
    item('w2', { coordinatorId: 'boss' }),
    item('sub', { coordinatorId: 'w1' }),
  ]);
  const ids = nodes.map((n) => n.item.id);
  assert.equal(new Set(ids).size, 4);
  assert.equal(ids.length, 4);
  const depth = Object.fromEntries(nodes.map((n) => [n.item.id, n.depth]));
  assert.deepEqual(depth, { boss: 0, w1: 1, w2: 1, sub: 2 });
  assert.ok(nodes.every((n) => !n.coordinatorMissing && !n.inCycle));
});

test('buildHierarchy: a coordinator missing from the list is flagged and shown at top level', () => {
  const nodes = buildHierarchy([item('orphan', { coordinatorId: 'gone' })]);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].depth, 0);
  assert.equal(nodes[0].coordinatorMissing, true);
  assert.equal(nodes[0].inCycle, false);
});

test('buildHierarchy: a coordinator loop is still fully shown, flagged, with no infinite walk', () => {
  const nodes = buildHierarchy([
    item('x', { coordinatorId: 'y' }),
    item('y', { coordinatorId: 'x' }),
    item('self', { coordinatorId: 'self' }),
  ]);
  const ids = nodes.map((n) => n.item.id).sort();
  assert.deepEqual(ids, ['self', 'x', 'y']);
  const selfNode = nodes.find((n) => n.item.id === 'self');
  assert.equal(selfNode.coordinatorMissing, true);
  assert.equal(nodes.filter((n) => n.inCycle).length >= 2, true);
});

test('buildHierarchy: empty list gives no nodes', () => {
  assert.deepEqual(buildHierarchy([]), []);
});

test('parseAgentDetail: returns null when the agent id is missing', () => {
  assert.equal(parseAgentDetail(null), null);
  assert.equal(parseAgentDetail({ roleName: 'x' }), null);
  assert.equal(parseAgentDetail('text'), null);
});

test('parseAgentDetail: reads the AgentView fields and drops work rows without a run id', () => {
  const detail = parseAgentDetail({
    agentId: 'agent-1',
    roleId: 'field-cleaner',
    roleName: 'Field Cleaner',
    autonomy: 'suggest',
    channels: ['chat', 42, 'sms'],
    permissions: ['tool.read'],
    state: 'paused',
    assignedWork: [
      { runId: 'r1', label: 'running', text: 'In progress', detail: null, updatedAt: '2026-11-03T10:00:00.000Z' },
      { label: 'running', text: 'no id' },
    ],
    recentResults: [{ runId: 'r2', label: 'completed', text: 'Finished', finishedAt: '2026-11-03T09:00:00.000Z' }],
    errors: [{ runId: 'r3', label: 'failed', text: 'Stopped because of an error', reason: 'timeout', finishedAt: '2026-11-03T08:00:00.000Z' }],
  });
  assert.equal(detail.agentId, 'agent-1');
  assert.equal(detail.roleName, 'Field Cleaner');
  assert.deepEqual(detail.channels, ['chat', 'sms']);
  assert.equal(detail.state, 'paused');
  assert.equal(detail.assignedWork.length, 1);
  assert.equal(detail.assignedWork[0].runId, 'r1');
  assert.equal(detail.recentResults[0].runId, 'r2');
  assert.equal(detail.errors[0].reason, 'timeout');
});

test('parseAgentDetail: missing fields default to unknown and empty lists', () => {
  const detail = parseAgentDetail({ agentId: 'agent-2' });
  assert.equal(detail.roleName, 'unknown');
  assert.equal(detail.autonomy, 'unknown');
  assert.equal(detail.state, 'unknown');
  assert.deepEqual(detail.permissions, []);
  assert.deepEqual(detail.assignedWork, []);
  assert.deepEqual(detail.recentResults, []);
  assert.deepEqual(detail.errors, []);
});

test('agentStateLabel: states from the control model get plain labels, anything else is not guessed', () => {
  assert.equal(agentStateLabel('disabled'), 'Disabled');
  assert.equal(agentStateLabel('unknown'), 'Status not known');
  assert.equal(agentStateLabel('weird'), 'Status not known');
});

test('run labels: failed is danger, attention and approval are attention, unknown labels need attention', () => {
  assert.equal(runLabelTone('failed'), 'danger');
  assert.equal(runLabelTone('needs_attention'), 'attention');
  assert.equal(runLabelTone('awaiting_approval'), 'attention');
  assert.equal(runLabelTone('completed'), 'neutral');
  assert.equal(runLabelText('awaiting_approval'), 'Needs approval');
  assert.equal(runLabelText('made_up'), 'Needs attention');
});

test('formatWhen: invalid or empty times read as unknown', () => {
  assert.equal(formatWhen(''), 'Time unknown');
  assert.equal(formatWhen('not a date'), 'Time unknown');
  assert.notEqual(formatWhen('2026-11-03T10:00:00.000Z'), 'Time unknown');
});

test('loadErrorMessage: generic text per status, never a response body', () => {
  assert.equal(loadErrorMessage(403), 'You need an admin or manager role to see this.');
  assert.equal(loadErrorMessage(404), 'This agent was not found in your company.');
  assert.equal(loadErrorMessage(503), 'The workforce service is not available yet.');
  assert.equal(loadErrorMessage(500), 'This could not be loaded. Try again.');
  assert.equal(loadErrorMessage(null), 'This could not be loaded. Try again.');
});

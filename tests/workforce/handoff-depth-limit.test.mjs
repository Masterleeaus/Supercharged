/**
 * planHandoff honours the limits argument for maxDelegationDepth (team.ts). Without the argument it keeps the default of 3.
 * Depth is the handoff path length before the handoff, as the planner counts it (the coordinator is entry 1).
 * Pure functions only: no I/O, no database, no network.
 * Run: node --test --experimental-transform-types tests/workforce/handoff-depth-limit.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeam, planHandoff, DEFAULT_TEAM_LIMITS } from '../../server/workforce/runtime/team.ts';

// A straight chain: coordinator -> r1 -> r2 -> ... -> r7. Each role may only hand to the next one.
const CHAIN = ['coordinator', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'];
const ROLE_LIST = CHAIN.map((id, i) => ({
  id,
  handoffTo: i + 1 < CHAIN.length ? [CHAIN[i + 1]] : [],
  autonomy: 'auto',
}));
const ROLES = new Map(ROLE_LIST.map((r) => [r.id, r]));
const roleSource = { getRole: (id) => ROLES.get(id) ?? null };

const TEAM = createTeam(
  {
    id: 'team-chain',
    name: 'Chain team',
    members: CHAIN.map((roleId) => ({ roleId, coordinator: roleId === 'coordinator' })),
  },
  roleSource,
);

/** The handoff path with `length` entries, starting at the coordinator. */
function pathOf(length) {
  return CHAIN.slice(0, length);
}

test('a run with maxDelegationDepth 5 hands off from a path of length 4 (depth 4)', () => {
  const limits = { maxDelegationDepth: 5, maxFanOut: 4 };
  const path = pathOf(4);
  const plan = planHandoff(TEAM, path, path[3], CHAIN[4], limits);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.path, pathOf(5));
});

test('a run with maxDelegationDepth 5 allows the handoff at its limit (depth 5)', () => {
  const limits = { maxDelegationDepth: 5, maxFanOut: 4 };
  const path = pathOf(5);
  const plan = planHandoff(TEAM, path, path[4], CHAIN[5], limits);
  assert.equal(plan.ok, true);
});

test('a run with maxDelegationDepth 5 refuses a handoff at depth 6 as depth_exceeded', () => {
  const limits = { maxDelegationDepth: 5, maxFanOut: 4 };
  const path = pathOf(6);
  assert.deepEqual(planHandoff(TEAM, path, path[5], CHAIN[6], limits), { ok: false, reason: 'depth_exceeded' });
});

test('a run with maxDelegationDepth 1 refuses a handoff at depth 2', () => {
  const limits = { maxDelegationDepth: 1, maxFanOut: 4 };
  const path = pathOf(2);
  assert.deepEqual(planHandoff(TEAM, path, path[1], CHAIN[2], limits), { ok: false, reason: 'depth_exceeded' });
});

test('a run with maxDelegationDepth 1 allows the first handoff at depth 1', () => {
  const limits = { maxDelegationDepth: 1, maxFanOut: 4 };
  const path = pathOf(1);
  assert.equal(planHandoff(TEAM, path, path[0], CHAIN[1], limits).ok, true);
});

test('calls without limits use the default depth of 3', () => {
  assert.equal(DEFAULT_TEAM_LIMITS.maxDelegationDepth, 3);
  const atDefault = pathOf(3);
  assert.equal(planHandoff(TEAM, atDefault, atDefault[2], CHAIN[3]).ok, true);
  const beyondDefault = pathOf(4);
  assert.deepEqual(planHandoff(TEAM, beyondDefault, beyondDefault[3], CHAIN[4]), { ok: false, reason: 'depth_exceeded' });
});

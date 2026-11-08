/**
 * Runtime enforcement of handoffTo rules in server/workforce/runtime/team.ts (checklist section 3).
 * Pure functions only: no I/O, no database, no network.
 * Run: node --test --experimental-transform-types tests/workforce/handoff-enforcement.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeam, planHandoff, DEFAULT_TEAM_LIMITS } from '../../server/workforce/runtime/team.ts';

const ROLE_LIST = [
  { id: 'coordinator', handoffTo: ['writer', 'reviewer', 'booker', 'a'], autonomy: 'auto' },
  { id: 'writer', handoffTo: ['reviewer'], autonomy: 'auto' },
  { id: 'reviewer', handoffTo: ['writer', 'coordinator'], autonomy: 'auto' },
  { id: 'booker', handoffTo: [], autonomy: 'auto' },
  { id: 'a', handoffTo: ['b'], autonomy: 'auto' },
  { id: 'b', handoffTo: ['c'], autonomy: 'auto' },
  { id: 'c', handoffTo: ['d'], autonomy: 'auto' },
  { id: 'd', handoffTo: [], autonomy: 'auto' },
];
const ROLES = new Map(ROLE_LIST.map((r) => [r.id, r]));
const roleSource = { getRole: (id) => ROLES.get(id) ?? null };

function makeTeam(members = ROLE_LIST.map((r) => r.id)) {
  return createTeam(
    {
      id: 'team-1',
      name: 'Test team',
      members: members.map((roleId) => ({ roleId, coordinator: roleId === 'coordinator' })),
    },
    roleSource,
  );
}

test('rule 1: a handoff to a role not in handoffTo is refused as unauthorized (not_in_handoff_to)', () => {
  const team = makeTeam();
  // writer may only hand to reviewer; booker is a team member but not on writer's list.
  const plan = planHandoff(team, ['coordinator', 'writer'], 'writer', 'booker');
  assert.deepEqual(plan, { ok: false, reason: 'not_in_handoff_to' });
});

test('rule 2: a handoff that revisits a role already in the chain is refused as a loop (handoff_cycle)', () => {
  const team = makeTeam();
  // Chain is coordinator -> writer -> reviewer. reviewer may hand to writer, but writer is already on the chain.
  const plan = planHandoff(team, ['coordinator', 'writer', 'reviewer'], 'reviewer', 'writer');
  assert.deepEqual(plan, { ok: false, reason: 'handoff_cycle' });
});

test('rule 3: a team with zero or more than one coordinator is refused as invalid_team', () => {
  const noCoordinator = {
    id: 't',
    name: 'n',
    members: [{ roleId: 'writer' }, { roleId: 'reviewer' }],
  };
  assert.throws(() => createTeam(noCoordinator, roleSource), (e) => /^invalid_team:/.test(e.message));

  const twoCoordinators = {
    id: 't',
    name: 'n',
    members: [
      { roleId: 'writer', coordinator: true },
      { roleId: 'reviewer', coordinator: true },
    ],
  };
  assert.throws(() => createTeam(twoCoordinators, roleSource), (e) => /^invalid_team:/.test(e.message));
});

test('rule 4: a handoff chain deeper than the limit is refused as depth_exceeded', () => {
  const team = makeTeam();
  // Chain coordinator -> a -> b -> c has 3 hops, which is the limit. Handing c -> d would make 4.
  const atLimit = planHandoff(team, ['coordinator', 'a', 'b'], 'b', 'c');
  assert.equal(atLimit.ok, true, 'a chain of exactly the limit is allowed');
  assert.equal(DEFAULT_TEAM_LIMITS.maxDelegationDepth, 3);

  const tooDeep = planHandoff(team, ['coordinator', 'a', 'b', 'c'], 'c', 'd');
  assert.deepEqual(tooDeep, { ok: false, reason: 'depth_exceeded' });
});

test('happy path: an authorized handoff to a new role within depth is allowed and extends the path', () => {
  const team = makeTeam();
  const plan = planHandoff(team, ['coordinator'], 'coordinator', 'writer');
  assert.deepEqual(plan, { ok: true, path: ['coordinator', 'writer'] });

  const next = planHandoff(team, plan.path, 'writer', 'reviewer');
  assert.deepEqual(next, { ok: true, path: ['coordinator', 'writer', 'reviewer'] });
});

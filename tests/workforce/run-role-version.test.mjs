/**
 * createRun records the role version the run was started with. In-memory store and registry, no network,
 * no database.
 * Run: cd /home/claude/desk-review && node --test --experimental-transform-types tests/workforce/run-role-version.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry, createRunEngine, createTeam, createMemoryRunStore } from '../../server/workforce/runtime/index.ts';
import { roleVersion } from '../../server/workforce/catalogue/prompt-version.ts';

const CO = 'company-1';

const ROLE_LIST = [
  { id: 'coordinator', handoffTo: ['writer'], autonomy: 'auto' },
  { id: 'writer', handoffTo: [], autonomy: 'auto' },
];
const ROLES = new Map(ROLE_LIST.map((r) => [r.id, r]));
const roleSource = { getRole: (id) => ROLES.get(id) ?? null };

function makeTeam() {
  return createTeam(
    {
      id: 'team-1',
      name: 'Content',
      members: [
        { roleId: 'coordinator', coordinator: true },
        { roleId: 'writer', coordinator: false },
      ],
    },
    roleSource,
  );
}

/** A plain copy of a role with the fields the version is computed from. */
function sampleRole(overrides = {}) {
  return {
    id: 'pool-service-scheduler',
    systemPrompt: 'You are the scheduling assistant for {{company_name}}. Offer times and confirm each booking.',
    tools: ['calendar.read'],
    toolRisk: { 'calendar.read': 'low' },
    autonomy: 'suggest',
    channels: ['sms', 'email'],
    ...overrides,
  };
}

function setup() {
  const store = createMemoryRunStore();
  const registry = createToolRegistry({
    gate: { gateAction: async () => ({ status: 'pending', approval: { id: 'x' } }), readApproval: async () => null, claimApproval: async () => false },
    redact: (v) => v,
    audit: { record: (e) => store.appendAudit(e) },
  });
  const engine = createRunEngine({
    registry,
    store,
    audit: { record: (e) => store.appendAudit(e) },
    now: () => new Date('2026-11-03T00:00:00Z'),
    newId: (() => {
      let n = 0;
      return () => `run-${++n}`;
    })(),
  });
  return { store, engine };
}

const BUDGET = { maxTokens: 100, maxToolCalls: 10 };

test('a run created with a role records the same version as roleVersion(role)', async () => {
  const { engine, store } = setup();
  const role = sampleRole();
  const created = await engine.createRun({ companyId: CO, team: makeTeam(), budget: BUDGET, roleVersion: roleVersion(role) });
  assert.equal(created.ok, true, `createRun failed: ${created.reason}`);
  assert.equal(created.run.roleVersion, roleVersion(role));
  assert.match(created.run.roleVersion, /^[0-9a-f]{16}$/);

  const loaded = await store.getRun(CO, created.run.id);
  assert.equal(loaded.roleVersion, roleVersion(role), 'the in-memory store keeps the field');
});

test('a run created without a role has no roleVersion', async () => {
  const { engine, store } = setup();
  const created = await engine.createRun({ companyId: CO, team: makeTeam(), budget: BUDGET });
  assert.equal(created.ok, true, `createRun failed: ${created.reason}`);
  assert.equal(created.run.roleVersion, undefined);
  assert.equal(Object.hasOwn(created.run, 'roleVersion'), false);

  const loaded = await store.getRun(CO, created.run.id);
  assert.equal(Object.hasOwn(loaded, 'roleVersion'), false);
});

test('a blank roleVersion is not recorded', async () => {
  const { engine } = setup();
  const created = await engine.createRun({ companyId: CO, team: makeTeam(), budget: BUDGET, roleVersion: '  ' });
  assert.equal(created.ok, true, `createRun failed: ${created.reason}`);
  assert.equal(Object.hasOwn(created.run, 'roleVersion'), false);
});

test('a changed role gives a different roleVersion on a new run', async () => {
  const { engine } = setup();
  const before = sampleRole();
  const after = sampleRole({ systemPrompt: 'You are the scheduling assistant for {{company_name}}. Offer times only.' });
  assert.notEqual(roleVersion(before), roleVersion(after));

  const first = await engine.createRun({ companyId: CO, team: makeTeam(), budget: BUDGET, roleVersion: roleVersion(before) });
  const second = await engine.createRun({ companyId: CO, team: makeTeam(), budget: BUDGET, roleVersion: roleVersion(after) });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.run.roleVersion, roleVersion(before));
  assert.equal(second.run.roleVersion, roleVersion(after));
  assert.notEqual(first.run.roleVersion, second.run.roleVersion);
  // The earlier run keeps the version it started with.
  assert.equal(first.run.roleVersion, roleVersion(before));
});

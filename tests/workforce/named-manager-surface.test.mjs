/**
 * Issue #50: Hub, Go and Command appear as three separately named agents, and a company can only see its own.
 * Reads the real role catalogue and the real roster. No database.
 * Run: node --test --experimental-transform-types tests/workforce/named-manager-surface.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

for (const method of ['log', 'info', 'warn', 'error']) console[method] = () => {};

const { loadRoleCatalogue } = await import('../../server/workforce/catalogue/loader.ts');
const { NAMED_MANAGER_DIRECTORY, NAMED_MANAGER_IDS, listNamedManagers } = await import(
  '../../server/workforce/catalogue/named-managers.ts'
);
const { createRoster, createAgent, listAgents, getAgent } = await import('../../server/workforce/roster.ts');

const ROLES_DIR = fileURLToPath(new URL('../../server/workforce/catalogue/roles', import.meta.url));
const catalogue = await loadRoleCatalogue(ROLES_DIR);

const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';

test('the directory lists exactly the three named Managers, with unique ids and full descriptions', () => {
  assert.deepEqual([...NAMED_MANAGER_IDS], ['hub-manager', 'go-manager', 'command-manager']);
  assert.equal(new Set(NAMED_MANAGER_DIRECTORY.map((m) => m.id)).size, 3);
  for (const m of NAMED_MANAGER_DIRECTORY) {
    assert.ok(m.audience.length > 0, `${m.id} has an audience`);
    assert.ok(m.entryPoint.length > 0, `${m.id} has an entry point`);
    assert.ok(m.responsibilities.length > 0, `${m.id} has responsibilities`);
    assert.ok(m.escalationPath.length > 0, `${m.id} has an escalation path`);
  }
});

test('the three Managers are separately named in the real catalogue', () => {
  const result = listNamedManagers(catalogue);
  assert.equal(result.ok, true);
  assert.deepEqual(result.managers.map((m) => m.name), ['Hub Manager', 'Go Manager', 'Command Manager']);
});

test('listNamedManagers fails closed when a Manager is missing from the catalogue', () => {
  const partial = new Map([...catalogue].filter(([id]) => id !== 'go-manager'));
  const result = listNamedManagers(partial);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['go-manager']);
});

test('listNamedManagers fails closed when a Manager is renamed in the catalogue', () => {
  const hub = catalogue.get('hub-manager');
  const renamed = new Map(catalogue);
  renamed.set('hub-manager', { ...hub, name: 'Reception Bot' });
  const result = listNamedManagers(renamed);
  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatched, ['hub-manager']);
});

test('a company can hold its own Hub, Go and Command agents, and another company cannot see them', () => {
  const roster = createRoster(catalogue);
  for (const id of NAMED_MANAGER_IDS) {
    const role = catalogue.get(id);
    const created = createAgent(roster, {
      companyId: COMPANY_A,
      roleId: id,
      agentId: `${id}-a`,
      channels: [role.channels[0]],
      autonomy: 'suggest',
    });
    assert.equal(created.ok, true, `${id} agent created for company A`);
  }

  const seenByA = listAgents(roster, COMPANY_A).map((agent) => agent.roleId).sort();
  assert.deepEqual(seenByA, ['command-manager', 'go-manager', 'hub-manager']);

  assert.deepEqual(listAgents(roster, COMPANY_B), []);
  assert.equal(getAgent(roster, COMPANY_B, 'hub-manager-a'), undefined);
});

test('a Manager agent cannot be given a tool its role does not hold', () => {
  const roster = createRoster(catalogue);
  const result = createAgent(roster, {
    companyId: COMPANY_A,
    roleId: 'hub-manager',
    agentId: 'hub-with-money',
    channels: ['web'],
    permissions: ['invoices.create'],
    autonomy: 'suggest',
  });
  assert.equal(result.ok, false);
});

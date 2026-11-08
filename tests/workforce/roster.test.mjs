import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

// Same zod fallback as tests/workforce/catalogue-loader.test.mjs.
try {
  await import('zod');
} catch {
  const entry = process.env.ZOD_FALLBACK_ENTRY ?? '/opt/npm-tools/node_modules/zod/index.js';
  register('./zod-fallback.hooks.mjs', import.meta.url, { data: { entry } });
}

const loader = await import('../../server/workforce/catalogue/loader.ts');
const roster = await import('../../server/workforce/roster.ts');

const rolesDir = fileURLToPath(new URL('../../server/workforce/catalogue/roles/', import.meta.url));
const catalogue = await loader.loadRoleCatalogue(rolesDir);

// Real roles from the catalogue. appointment-reminder: autonomy auto, channels sms and email.
// compliance-expiry-tracker: autonomy suggest, channels email only.
const AUTO_ROLE = 'appointment-reminder';
const SUGGEST_ROLE = 'compliance-expiry-tracker';

function base(overrides = {}) {
  return {
    companyId: 'co-a',
    roleId: AUTO_ROLE,
    agentId: 'agent-1',
    teamId: 'team-north',
    channels: ['sms'],
    permissions: ['booking_requests.list'],
    autonomy: 'auto',
    ...overrides,
  };
}

test('creates an agent from a real role as active with the requested settings', () => {
  const r = roster.createRoster(catalogue);
  const result = roster.createAgent(r, base());
  assert.equal(result.ok, true);
  assert.equal(result.agent.companyId, 'co-a');
  assert.equal(result.agent.roleId, AUTO_ROLE);
  assert.equal(result.agent.teamId, 'team-north');
  assert.deepEqual([...result.agent.channels], ['sms']);
  assert.deepEqual([...result.agent.permissions], ['booking_requests.list']);
  assert.equal(result.agent.autonomy, 'auto');
  assert.equal(result.agent.status, 'active');
});

test('autonomy above the role maximum is refused, equal or lower is accepted', () => {
  const r = roster.createRoster(catalogue);
  const refused = roster.createAgent(r, base({ autonomy: 'predictive' }));
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'autonomy_exceeds_role');

  assert.equal(roster.createAgent(r, base({ agentId: 'a2', autonomy: 'auto' })).ok, true);
  assert.equal(roster.createAgent(r, base({ agentId: 'a3', autonomy: 'suggest' })).ok, true);
  assert.equal(roster.createAgent(r, base({ agentId: 'a4', autonomy: 'assist' })).ok, true);

  const suggestRole = roster.createAgent(r, base({
    agentId: 'a5', roleId: SUGGEST_ROLE, channels: ['email'], autonomy: 'auto',
  }));
  assert.equal(suggestRole.reason, 'autonomy_exceeds_role');
});

test('an autonomy value outside the four tiers is refused', () => {
  const r = roster.createRoster(catalogue);
  const result = roster.createAgent(r, base({ autonomy: 'turbo' }));
  assert.equal(result.reason, 'invalid_autonomy');
});

test('a channel the role does not allow is refused on create and on configure', () => {
  const r = roster.createRoster(catalogue);
  const created = roster.createAgent(r, base({ channels: ['voice'] }));
  assert.equal(created.ok, false);
  assert.equal(created.reason, 'channel_not_allowed');

  assert.equal(roster.createAgent(r, base()).ok, true);
  const configured = roster.configureAgent(r, 'co-a', 'agent-1', { channels: ['sms', 'whatsapp'] });
  assert.equal(configured.reason, 'channel_not_allowed');
  assert.deepEqual([...roster.listAgents(r, 'co-a')[0].channels], ['sms'], 'refused patch changes nothing');
});

test('a permission that is not a tool of the role is refused', () => {
  const r = roster.createRoster(catalogue);
  const result = roster.createAgent(r, base({ permissions: ['payments.refund'] }));
  assert.equal(result.reason, 'permission_not_allowed');
});

test('an unknown role is refused and no agent is created', () => {
  const r = roster.createRoster(catalogue);
  const result = roster.createAgent(r, base({ roleId: 'no-such-role' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unknown_role');
  assert.deepEqual(roster.listAgents(r, 'co-a'), []);
});

test('the same agent id is allowed in two companies but not twice in one', () => {
  const r = roster.createRoster(catalogue);
  assert.equal(roster.createAgent(r, base()).ok, true);
  assert.equal(roster.createAgent(r, base({ companyId: 'co-b' })).ok, true);
  assert.equal(roster.createAgent(r, base()).reason, 'duplicate_agent');
});

test('company isolation: list returns only that company, configure and status cannot cross', () => {
  const r = roster.createRoster(catalogue);
  roster.createAgent(r, base({ agentId: 'a-only-a' }));
  roster.createAgent(r, base({ companyId: 'co-b', agentId: 'b-only-b' }));

  const listA = roster.listAgents(r, 'co-a');
  assert.deepEqual(listA.map((a) => a.agentId), ['a-only-a']);
  assert.deepEqual(roster.listAgents(r, 'co-b').map((a) => a.agentId), ['b-only-b']);
  assert.deepEqual(roster.listAgents(r, 'co-missing'), []);

  const crossConfigure = roster.configureAgent(r, 'co-b', 'a-only-a', { autonomy: 'assist' });
  assert.equal(crossConfigure.reason, 'agent_not_found');
  const crossStatus = roster.setAgentStatus(r, 'co-b', 'a-only-a', 'paused');
  assert.equal(crossStatus.reason, 'agent_not_found');
  assert.equal(roster.listAgents(r, 'co-a')[0].autonomy, 'auto');
  assert.equal(roster.listAgents(r, 'co-a')[0].status, 'active');
});

test('configure applies a valid patch and refuses changing companyId or roleId', () => {
  const r = roster.createRoster(catalogue);
  roster.createAgent(r, base());

  const ok = roster.configureAgent(r, 'co-a', 'agent-1', { autonomy: 'assist', teamId: 'team-south' });
  assert.equal(ok.ok, true);
  assert.equal(ok.agent.autonomy, 'assist');
  assert.equal(ok.agent.teamId, 'team-south');

  assert.equal(roster.configureAgent(r, 'co-a', 'agent-1', { companyId: 'co-b' }).reason, 'immutable_field');
  assert.equal(roster.configureAgent(r, 'co-a', 'agent-1', { roleId: SUGGEST_ROLE }).reason, 'immutable_field');
  assert.equal(roster.configureAgent(r, 'co-a', 'agent-1', { agentId: 'other' }).reason, 'immutable_field');
  assert.equal(roster.listAgents(r, 'co-a')[0].roleId, AUTO_ROLE);
});

test('pause and resume move an agent between active and paused', () => {
  const r = roster.createRoster(catalogue);
  roster.createAgent(r, base());
  assert.equal(roster.setAgentStatus(r, 'co-a', 'agent-1', 'paused').agent.status, 'paused');
  assert.equal(roster.setAgentStatus(r, 'co-a', 'agent-1', 'active').agent.status, 'active');
  assert.equal(roster.setAgentStatus(r, 'co-a', 'agent-1', 'deleted').reason, 'invalid_status');
});

test('retired is terminal: no status change and no configure', () => {
  const r = roster.createRoster(catalogue);
  roster.createAgent(r, base());
  assert.equal(roster.setAgentStatus(r, 'co-a', 'agent-1', 'retired').agent.status, 'retired');

  for (const status of ['active', 'paused', 'retired']) {
    assert.equal(roster.setAgentStatus(r, 'co-a', 'agent-1', status).reason, 'agent_retired', status);
  }
  assert.equal(roster.configureAgent(r, 'co-a', 'agent-1', { autonomy: 'assist' }).reason, 'agent_retired');
  const listed = roster.listAgents(r, 'co-a');
  assert.equal(listed.length, 1, 'retired agents stay listed');
  assert.equal(listed[0].status, 'retired');
});

test('the catalogue is not changed by any roster operation', () => {
  const before = JSON.stringify([...catalogue.values()]);
  const r = roster.createRoster(catalogue);
  const created = roster.createAgent(r, base());
  roster.configureAgent(r, 'co-a', 'agent-1', { channels: ['sms'], permissions: [] });
  // Caller-held arrays must not be shared with the roster.
  const listed = roster.listAgents(r, 'co-a');
  assert.throws(() => listed[0].channels.push('email'), TypeError);
  assert.equal(created.agent.channels.length, 1);
  assert.equal(JSON.stringify([...catalogue.values()]), before);
});

test('getAgent returns a frozen copy for its own company only; other companies and unknown ids get undefined', () => {
  const r = roster.createRoster(catalogue);
  roster.createAgent(r, base());
  const found = roster.getAgent(r, 'co-a', 'agent-1');
  assert.equal(found.agentId, 'agent-1');
  assert.equal(Object.isFrozen(found), true);
  assert.equal(roster.getAgent(r, 'co-b', 'agent-1'), undefined);
  assert.equal(roster.getAgent(r, 'co-a', 'missing'), undefined);
  assert.equal(roster.getAgent(r, '', 'agent-1'), undefined);
});

test('the port adapter delegates each operation to the same roster', async () => {
  const r = roster.createRoster(catalogue);
  const port = roster.createRosterPort(r);
  assert.equal((await port.createAgent(base())).ok, true);
  assert.equal((await port.getAgent('co-a', 'agent-1')).status, 'active');
  assert.equal((await port.configureAgent('co-a', 'agent-1', { autonomy: 'assist' })).agent.autonomy, 'assist');
  assert.equal((await port.setAgentStatus('co-a', 'agent-1', 'retired')).agent.status, 'retired');
  assert.equal((await port.configureAgent('co-a', 'agent-1', { autonomy: 'auto' })).reason, 'agent_retired');
  assert.equal((await port.listAgents('co-a'))[0].status, 'retired');
});

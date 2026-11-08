import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

// Silence console output so the test runner's IPC is not disturbed.
for (const method of ['log', 'info', 'warn']) console[method] = () => {};

// Same zod fallback as tests/workforce/roster.test.mjs.
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
const ROLE = 'appointment-reminder';

function seed() {
  const r = roster.createRoster(catalogue);
  const made = roster.createAgent(r, {
    companyId: 'co-a',
    roleId: ROLE,
    agentId: 'agent-1',
    teamId: 'team-north',
    channels: ['sms'],
    permissions: ['booking_requests.list'],
    autonomy: 'auto',
  });
  assert.equal(made.ok, true);
  roster.createAgent(r, {
    companyId: 'co-b',
    roleId: ROLE,
    agentId: 'agent-1',
    channels: ['sms'],
    autonomy: 'auto',
  });
  return r;
}

const idle = () => false;
const busy = () => true;
const FIXED = () => new Date('2026-11-04T00:00:00.000Z');

test('retires an idle agent: status retired, who and when recorded, record kept and listed', async () => {
  const r = seed();
  const result = await roster.retireAgent(r, 'co-a', 'agent-1', { actor: 'user-7', isRunning: idle, now: FIXED });
  assert.equal(result.ok, true);
  assert.equal(result.agent.status, 'retired');
  assert.equal(result.agent.retiredAt, '2026-11-04T00:00:00.000Z');
  assert.equal(result.agent.retiredBy, 'user-7');
  assert.equal(result.agent.roleId, ROLE);
  const listed = roster.listAgents(r, 'co-a');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, 'retired');
  assert.equal(listed[0].retiredBy, 'user-7');
});

test('a paused agent can be retired', async () => {
  const r = seed();
  roster.setAgentStatus(r, 'co-a', 'agent-1', 'paused');
  const result = await roster.retireAgent(r, 'co-a', 'agent-1', { actor: 'user-7', isRunning: idle });
  assert.equal(result.ok, true);
  assert.equal(result.agent.status, 'retired');
});

test('refuses while the agent is running a task, and leaves it unchanged', async () => {
  const r = seed();
  const result = await roster.retireAgent(r, 'co-a', 'agent-1', { actor: 'user-7', isRunning: busy });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'agent_running');
  assert.equal(roster.getAgent(r, 'co-a', 'agent-1').status, 'active');
  assert.equal(roster.getAgent(r, 'co-a', 'agent-1').retiredAt, undefined);
});

test('fails closed when the running check is missing, throws, or does not answer with a boolean', async () => {
  const r = seed();
  const cases = [
    { isRunning: undefined },
    { isRunning: () => { throw new Error('db down'); } },
    { isRunning: async () => { throw new Error('db down'); } },
    { isRunning: () => 'no' },
    { isRunning: () => undefined },
    { isRunning: () => null },
  ];
  for (const options of cases) {
    const result = await roster.retireAgent(r, 'co-a', 'agent-1', { actor: 'user-7', ...options });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'run_check_unavailable');
    assert.equal(roster.getAgent(r, 'co-a', 'agent-1').status, 'active');
  }
  // The generic message does not leak the thrown error.
  const thrown = await roster.retireAgent(r, 'co-a', 'agent-1', { actor: 'user-7', isRunning: () => { throw new Error('secret-detail'); } });
  assert.equal(thrown.message.includes('secret-detail'), false);
});

test('refuses when the acting user is missing, and does not run the check', async () => {
  const r = seed();
  let calls = 0;
  const isRunning = () => { calls += 1; return false; };
  for (const actor of [undefined, '', '   ', null]) {
    const result = await roster.retireAgent(r, 'co-a', 'agent-1', { actor, isRunning });
    assert.equal(result.reason, 'invalid_input');
  }
  assert.equal(calls, 0);
  assert.equal(roster.getAgent(r, 'co-a', 'agent-1').status, 'active');
});

test('the running check is asked about the caller company only; another company agent is not found', async () => {
  const r = seed();
  const asked = [];
  const isRunning = (companyId, agentId) => { asked.push([companyId, agentId]); return false; };
  const cross = await roster.retireAgent(r, 'co-b', 'missing-agent', { actor: 'user-7', isRunning });
  assert.equal(cross.reason, 'agent_not_found');
  const ok = await roster.retireAgent(r, 'co-b', 'agent-1', { actor: 'user-7', isRunning });
  assert.equal(ok.ok, true);
  assert.deepEqual(asked, [['co-b', 'agent-1']]);
  assert.equal(roster.getAgent(r, 'co-a', 'agent-1').status, 'active');
  assert.equal(roster.getAgent(r, 'co-b', 'agent-1').status, 'retired');
});

test('retired is terminal: pause, resume, configure and a second retire all refuse', async () => {
  const r = seed();
  await roster.retireAgent(r, 'co-a', 'agent-1', { actor: 'user-7', isRunning: idle });
  assert.equal(roster.setAgentStatus(r, 'co-a', 'agent-1', 'paused').reason, 'agent_retired');
  assert.equal(roster.setAgentStatus(r, 'co-a', 'agent-1', 'active').reason, 'agent_retired');
  assert.equal(roster.configureAgent(r, 'co-a', 'agent-1', { autonomy: 'assist' }).reason, 'agent_retired');
  const again = await roster.retireAgent(r, 'co-a', 'agent-1', { actor: 'user-8', isRunning: idle });
  assert.equal(again.reason, 'agent_retired');
  assert.equal(roster.getAgent(r, 'co-a', 'agent-1').retiredBy, 'user-7');
});

test('a retirement that lands during the running check is not overwritten', async () => {
  const r = seed();
  const isRunning = async () => {
    await roster.retireAgent(r, 'co-a', 'agent-1', { actor: 'user-9', isRunning: idle });
    return false;
  };
  const result = await roster.retireAgent(r, 'co-a', 'agent-1', { actor: 'user-7', isRunning });
  assert.equal(result.reason, 'agent_retired');
  assert.equal(roster.getAgent(r, 'co-a', 'agent-1').retiredBy, 'user-9');
});

test('the returned agent is a frozen snapshot, not the roster record', async () => {
  const r = seed();
  const result = await roster.retireAgent(r, 'co-a', 'agent-1', { actor: 'user-7', isRunning: idle });
  assert.equal(Object.isFrozen(result.agent), true);
  assert.throws(() => { result.agent.status = 'active'; }, TypeError);
});

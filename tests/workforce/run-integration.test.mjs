/**
 * Run engine wired to operator controls, the budget ledger and the run's own delegation depth.
 * In-memory store and registry, fixed clock, no network, no database, no real timers.
 * Run: cd /home/claude/desk-review && node --test --experimental-transform-types tests/workforce/run-integration.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createToolRegistry,
  createRunEngine,
  createTeam,
  createMemoryRunStore,
} from '../../server/workforce/runtime/index.ts';
import {
  createControlState,
  pauseAgent,
  resumeAgent,
  stopRun,
} from '../../server/workforce/runtime/controls.ts';
import { createBudgetLedger } from '../../server/workforce/runtime/budgets.ts';

const CO = 'company-1';
const HUMAN = { kind: 'human', userId: 'owner-1' };

const ROLE_LIST = [
  // 'no_such_tool' is listed on purpose: it is not registered, so the call reaches the registry's own refusal.
  { id: 'coordinator', handoffTo: ['writer', 'reviewer', 'a', 'b', 'c'], tools: ['read_note', 'no_such_tool'], autonomy: 'auto' },
  { id: 'writer', handoffTo: ['reviewer'], autonomy: 'auto' },
  { id: 'reviewer', handoffTo: ['writer'], autonomy: 'auto' },
  { id: 'a', handoffTo: ['b'], autonomy: 'auto' },
  { id: 'b', handoffTo: ['c'], autonomy: 'auto' },
  { id: 'c', handoffTo: [], autonomy: 'auto' },
];
const ROLES = new Map(ROLE_LIST.map((r) => [r.id, r]));
const roleSource = { getRole: (id) => ROLES.get(id) ?? null };

function makeTeam(members = ['coordinator', 'writer', 'reviewer']) {
  return createTeam(
    { id: 'team-1', name: 'Content', members: members.map((roleId) => ({ roleId, coordinator: roleId === 'coordinator' })) },
    roleSource,
  );
}

const WRITER = { kind: 'agent', agentId: 'writer-1', roleId: 'writer' };
const COORD = { kind: 'agent', agentId: 'coordinator-1', roleId: 'coordinator' };

/** Engine with a read tool that counts its executions. Controls and budgets are optional. */
function setup(options = {}) {
  const store = createMemoryRunStore();
  const registry = createToolRegistry({ gate: { gateAction: async () => ({ status: 'pending', approval: { id: 'x' } }), readApproval: async () => null, claimApproval: async () => false }, redact: (v) => v, audit: { record: (e) => store.appendAudit(e) } });
  let executed = 0;
  registry.register({
    id: 'read_note',
    risk: 'low',
    schema: {},
    handler: () => {
      executed += 1;
      return { ok: true };
    },
  });
  let state = options.controlState ?? createControlState();
  const engine = createRunEngine({
    registry,
    store,
    audit: { record: (e) => store.appendAudit(e) },
    now: () => new Date('2026-11-03T00:00:00Z'),
    sleep: async () => {},
    controls: options.withControls === false ? undefined : { state: () => state },
    budgets: options.budgets,
    defaultLimits: options.defaultLimits,
  });
  return {
    store,
    engine,
    executed: () => executed,
    setControlState(next) {
      state = next;
    },
    getControlState: () => state,
  };
}

async function startedRun(engine, team = makeTeam(), extra = {}) {
  const created = await engine.createRun({ companyId: CO, team, budget: { maxTokens: 100, maxToolCalls: 10 }, ...extra });
  assert.equal(created.ok, true, `createRun failed: ${created.reason}`);
  const started = await engine.startRun(CO, created.run.id);
  assert.equal(started.ok, true);
  return started.run.id;
}

// ---------- operator controls ----------

test('a paused agent tool call is refused and the handler does not run', async () => {
  const env = setup();
  const runId = await startedRun(env.engine);

  env.setControlState(pauseAgent(env.getControlState(), CO, 'writer-1', HUMAN).state);
  const refused = await env.engine.callTool(CO, runId, { toolId: 'read_note', params: {}, actor: WRITER });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'agent_paused');
  assert.equal(refused.tool, null);
  assert.equal(env.executed(), 0, 'nothing runs while the agent is paused');
  assert.equal(refused.run.status, 'running', 'a pause refuses the call without ending the run');

  env.setControlState(resumeAgent(env.getControlState(), CO, 'writer-1', HUMAN).state);
  const allowed = await env.engine.callTool(CO, runId, { toolId: 'read_note', params: {}, actor: WRITER });
  assert.equal(allowed.ok, true);
  assert.equal(env.executed(), 1);
});

test('a human actor is not blocked by an agent pause', async () => {
  const env = setup();
  const runId = await startedRun(env.engine);
  env.setControlState(pauseAgent(env.getControlState(), CO, 'writer-1', HUMAN).state);
  const result = await env.engine.callTool(CO, runId, { toolId: 'read_note', params: {}, actor: { kind: 'human', userId: 'owner-1' } });
  assert.equal(result.ok, true);
  assert.equal(env.executed(), 1);
});

test('a stopped run ends and its next tool call does not run', async () => {
  const env = setup();
  const runId = await startedRun(env.engine);
  env.setControlState(stopRun(env.getControlState(), CO, runId, HUMAN).state);

  const result = await env.engine.callTool(CO, runId, { toolId: 'read_note', params: {}, actor: COORD });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'run_stopped');
  assert.equal(result.run.status, 'cancelled');
  assert.equal(result.run.reason, 'run_stopped');
  assert.equal(env.executed(), 0);

  const after = await env.engine.callTool(CO, runId, { toolId: 'read_note', params: {}, actor: COORD });
  assert.equal(after.reason, 'run_terminal', 'a cancelled run takes no more calls');
});

test('without controls the engine behaves as before', async () => {
  const env = setup({ withControls: false });
  const runId = await startedRun(env.engine);
  const result = await env.engine.callTool(CO, runId, { toolId: 'read_note', params: {}, actor: WRITER });
  assert.equal(result.ok, true);
  assert.equal(env.executed(), 1);
});

// ---------- budgets ----------

const LEDGER_LIMITS = {
  maxToolCallsPerRun: 1,
  maxTokensPerRun: 100,
  maxSpendCentsPerRun: 100,
  maxRunsPerCompanyPerDay: 10,
  maxSpendCentsPerCompanyPerDay: 100,
};

test('a budget refusal ends the run with tool_call_limit', async () => {
  const env = setup({ budgets: createBudgetLedger(LEDGER_LIMITS) });
  const runId = await startedRun(env.engine);

  const first = await env.engine.callTool(CO, runId, { toolId: 'read_note', params: {}, actor: COORD });
  assert.equal(first.ok, true);

  const second = await env.engine.callTool(CO, runId, { toolId: 'read_note', params: {}, actor: COORD });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'tool_call_limit');
  assert.equal(second.run.status, 'budget_exhausted');
  assert.equal(second.run.reason, 'tool_call_limit');
  assert.equal(env.executed(), 1, 'the refused call did not run');
});

test('a call refused before execution gives its reservation back', async () => {
  const env = setup({ budgets: createBudgetLedger(LEDGER_LIMITS) });
  const runId = await startedRun(env.engine);

  // An unknown tool is refused by the registry before it runs. The ledger allows one call, so the second
  // call succeeds only if the first reservation was released.
  const refused = await env.engine.callTool(CO, runId, { toolId: 'no_such_tool', params: {}, actor: COORD });
  assert.equal(refused.ok, true);
  assert.equal(refused.tool.outcome, 'refused');
  assert.equal(refused.run.status, 'running');

  const ran = await env.engine.callTool(CO, runId, { toolId: 'read_note', params: {}, actor: COORD });
  assert.equal(ran.ok, true);
  assert.equal(ran.tool.outcome, 'executed');
  assert.equal(env.executed(), 1);
});

test('without a budget ledger no budget is enforced', async () => {
  const env = setup();
  const runId = await startedRun(env.engine, makeTeam(), { budget: { maxTokens: 100, maxToolCalls: 10 } });
  for (let i = 0; i < 3; i += 1) {
    const result = await env.engine.callTool(CO, runId, { toolId: 'read_note', params: {}, actor: COORD });
    assert.equal(result.ok, true);
  }
  assert.equal(env.executed(), 3);
});

// ---------- team and depth ----------

test('a team with two coordinators is refused by run creation', async () => {
  const env = setup();
  const team = makeTeam();

  const twoInCoordinator = await env.engine.createRun({ companyId: CO, team: { ...team, coordinator: ['coordinator', 'writer'] }, budget: { maxTokens: 1, maxToolCalls: 1 } });
  assert.equal(twoInCoordinator.ok, false);
  assert.equal(twoInCoordinator.reason, 'invalid_team');

  const flaggedMember = await env.engine.createRun({
    companyId: CO,
    team: { ...team, members: [...team.members, { roleId: 'reviewer', coordinator: true }] },
    budget: { maxTokens: 1, maxToolCalls: 1 },
  });
  assert.equal(flaggedMember.ok, false);
  assert.equal(flaggedMember.reason, 'invalid_team');

  const ok = await env.engine.createRun({ companyId: CO, team, budget: { maxTokens: 1, maxToolCalls: 1 } });
  assert.equal(ok.ok, true, 'a team with one coordinator is still accepted');
});

test('the depth limit comes from the run options', async () => {
  const limited = setup();
  const runId = await startedRun(limited.engine, makeTeam(['coordinator', 'a', 'b', 'c']), { limits: { maxDelegationDepth: 1 } });
  const first = await limited.engine.handoff(CO, runId, { actor: COORD, toRole: 'a' });
  assert.equal(first.ok, true, 'the first hop is depth 1');
  const second = await limited.engine.handoff(CO, runId, { actor: { kind: 'agent', agentId: 'a-1', roleId: 'a' }, toRole: 'b' });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'depth_exceeded');

  const roomy = setup();
  const open = await startedRun(roomy.engine, makeTeam(['coordinator', 'a', 'b', 'c']));
  await roomy.engine.handoff(CO, open, { actor: COORD, toRole: 'a' });
  const deeper = await roomy.engine.handoff(CO, open, { actor: { kind: 'agent', agentId: 'a-1', roleId: 'a' }, toRole: 'b' });
  assert.equal(deeper.ok, true, 'the default limit of 3 allows a second hop');
});

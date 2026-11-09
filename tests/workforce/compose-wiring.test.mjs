/**
 * Wiring tests: compose passes controls, budgets and company policy into the run engine and tool registry;
 * controls are keyed by company; seedControls sets roster statuses for one company only.
 * In-memory store, fake approval service, fake read store, fixed clock. No network, no database.
 * Run: node --test --experimental-transform-types tests/workforce/compose-wiring.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { composeWorkforceRuntime, resetCompanySweepsForTests } from '../../server/workforce/runtime/compose.ts';
import { INTERRUPTED_RUN_REASON } from '../../server/workforce/runtime/recovery.ts';
import { createMemoryRunStore, createRunEngine, createTeam } from '../../server/workforce/runtime/index.ts';
import {
  createControlState,
  pauseAgent,
  retireAgent,
  seedControls,
  stopRun,
  canStartWork,
  isRunStopped,
} from '../../server/workforce/runtime/controls.ts';
import { createBudgetLedger } from '../../server/workforce/runtime/budgets.ts';

const CO = 'company-1';
const OTHER = 'company-2';
const HUMAN = { kind: 'human', userId: 'owner-1' };
const WRITER = { kind: 'agent', agentId: 'writer-1', roleId: 'writer' };
const NOW = () => new Date('2026-11-03T00:00:00.000Z');

const ROLES = new Map([
  ['coordinator', { id: 'coordinator', handoffTo: ['writer'], autonomy: 'auto' }],
  ['writer', { id: 'writer', handoffTo: [], autonomy: 'auto' }],
]);
const roleSource = { getRole: (id) => ROLES.get(id) ?? null };

function fakeApprovalService() {
  return {
    async gateAction() {
      return { status: 'pending', approval: { id: 'a1' } };
    },
    async getApproval() {
      return null;
    },
    async markExecuted() {
      return null;
    },
  };
}

/** Read store that counts calls to listBookings, so a test can see whether a read tool ran. */
function countingReadStore() {
  const counts = { listBookings: 0 };
  return {
    counts,
    store: {
      async listBookings() {
        counts.listBookings += 1;
        return [];
      },
      async getBooking() {
        return null;
      },
      async listInvoices() {
        return [];
      },
      async getInvoice() {
        return null;
      },
      async listPayments() {
        return [];
      },
    },
  };
}

function fakeDeps(overrides = {}) {
  return {
    store: createMemoryRunStore(),
    catalogue: new Map([['writer', { id: 'writer' }]]),
    approvalService: fakeApprovalService(),
    readStore: countingReadStore().store,
    redact: (value) => value,
    companyScope: CO,
    now: NOW,
    ...overrides,
  };
}

/**
 * The composed engine refuses startRun (no model), so the run is moved to running directly in the store.
 * Only tool calls are tested here; the run's status path is covered by run-integration.test.mjs.
 */
async function startRun(runtime) {
  const team = createTeam(
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
  const created = await runtime.engine.createRun({ companyId: CO, team, budget: { maxTokens: 100, maxToolCalls: 10 } });
  assert.equal(created.ok, true, `createRun failed: ${created.reason}`);
  const running = await runtime.store.updateRun(CO, { ...created.run, status: 'running' }, created.run.version);
  return running.id;
}

// ---------- controls and budgets reach the engine ----------

test('compose passes controls into the engine: a paused agent tool call is refused', async () => {
  const reads = countingReadStore();
  const paused = pauseAgent(createControlState(), CO, WRITER.agentId, HUMAN, { now: NOW }).state;
  const controls = { state: () => paused };
  const runtime = composeWorkforceRuntime(fakeDeps({ readStore: reads.store, controls }));
  assert.equal(runtime.controls, controls);

  const runId = await startRun(runtime);
  const result = await runtime.engine.callTool(CO, runId, { toolId: 'booking_requests.list', params: {}, actor: WRITER });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'agent_paused');
  assert.equal(reads.counts.listBookings, 0, 'the read handler does not run while the agent is paused');
});

test('compose without controls runs no control check', async () => {
  const runtime = composeWorkforceRuntime(fakeDeps());
  assert.equal(runtime.controls, null);
  const runId = await startRun(runtime);
  const result = await runtime.engine.callTool(CO, runId, { toolId: 'booking_requests.list', params: {}, actor: WRITER });
  assert.notEqual(result.reason, 'agent_paused');
});

test('compose passes budgets into the engine: the second tool call over the limit ends the run', async () => {
  const budgets = createBudgetLedger({
    maxToolCallsPerRun: 1,
    maxTokensPerRun: 100,
    maxSpendCentsPerRun: 100,
    maxRunsPerCompanyPerDay: 10,
    maxSpendCentsPerCompanyPerDay: 100,
  });
  const runtime = composeWorkforceRuntime(fakeDeps({ budgets }));
  const runId = await startRun(runtime);
  const human = { kind: 'human', userId: 'owner-1' };

  const first = await runtime.engine.callTool(CO, runId, { toolId: 'booking_requests.list', params: {}, actor: human });
  assert.equal(first.ok, true);
  const second = await runtime.engine.callTool(CO, runId, { toolId: 'booking_requests.list', params: {}, actor: human });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'tool_call_limit');
});

test('compose passes company policy into the tool registry: a denied tool is refused for that company', async () => {
  const human = { kind: 'human', userId: 'owner-1' };
  const denied = composeWorkforceRuntime(fakeDeps({ companyPolicy: { deniedTools: ['booking_requests.list'] } }));
  const open = composeWorkforceRuntime(fakeDeps());

  const deniedRun = await startRun(denied);
  const refused = await denied.engine.callTool(CO, deniedRun, { toolId: 'booking_requests.list', params: {}, actor: human });
  assert.equal(refused.tool?.outcome, 'refused');
  assert.equal(refused.tool?.reason, 'authority_denied');

  const openRun = await startRun(open);
  const allowed = await open.engine.callTool(CO, openRun, { toolId: 'booking_requests.list', params: {}, actor: human });
  assert.notEqual(allowed.tool?.outcome, 'refused');
});

// ---------- company namespaces ----------

test('company B cannot block company A agent id through the composed controls', () => {
  const pausedByA = pauseAgent(createControlState(), CO, WRITER.agentId, HUMAN, { now: NOW }).state;
  assert.equal(canStartWork(pausedByA, CO, WRITER.agentId).allowed, false);
  assert.equal(canStartWork(pausedByA, OTHER, WRITER.agentId).allowed, true);

  const retiredByB = retireAgent(pausedByA, OTHER, WRITER.agentId, HUMAN, { now: NOW });
  assert.equal(retiredByB.ok, true);
  assert.equal(canStartWork(retiredByB.state, CO, WRITER.agentId).reason, 'agent_paused');
  assert.equal(canStartWork(retiredByB.state, OTHER, WRITER.agentId).reason, 'agent_retired');
});

test('company B cannot block company A run id', () => {
  const stoppedByB = stopRun(createControlState(), OTHER, 'run-1', HUMAN).state;
  assert.equal(isRunStopped(stoppedByB, 'run-1', CO), false);
  assert.equal(isRunStopped(stoppedByB, 'run-1', OTHER), true);
  assert.equal(isRunStopped(stoppedByB, 'run-2', OTHER), false);
});

test('without a company, a stop from any company still counts, so the check fails closed', () => {
  const stoppedByB = stopRun(createControlState(), OTHER, 'run-1', HUMAN).state;
  assert.equal(isRunStopped(stoppedByB, 'run-1'), true);
});

// ---------- seedControls ----------

test('seedControls sets retired and paused roster agents and leaves active ones active', () => {
  const roster = [
    { companyId: CO, agentId: 'a-active', status: 'active' },
    { companyId: CO, agentId: 'a-paused', status: 'paused' },
    { companyId: CO, agentId: 'a-retired', status: 'retired' },
  ];
  const seeded = seedControls(createControlState(), CO, roster, { now: NOW });
  assert.deepEqual(canStartWork(seeded, CO, 'a-active'), { allowed: true });
  assert.deepEqual(canStartWork(seeded, CO, 'a-paused'), { allowed: false, reason: 'agent_paused' });
  assert.deepEqual(canStartWork(seeded, CO, 'a-retired'), { allowed: false, reason: 'agent_retired' });
  assert.equal(seeded.agents.get(CO).get('a-paused').changed.by, 'roster:seed');
});

test('seedControls leaves agents of other companies untouched', () => {
  const roster = [
    { companyId: CO, agentId: 'shared-id', status: 'paused' },
    { companyId: OTHER, agentId: 'other-paused', status: 'paused' },
    { companyId: OTHER, agentId: 'other-retired', status: 'retired' },
  ];
  const seeded = seedControls(createControlState(), CO, roster, { now: NOW });
  assert.equal(seeded.agents.has(OTHER), false);
  assert.deepEqual(canStartWork(seeded, OTHER, 'other-paused'), { allowed: true });
  assert.deepEqual(canStartWork(seeded, OTHER, 'other-retired'), { allowed: true });
  assert.deepEqual(canStartWork(seeded, CO, 'shared-id'), { allowed: false, reason: 'agent_paused' });
});

test('seedControls never loosens an operator restriction', () => {
  const retired = retireAgent(createControlState(), CO, 'a-1', HUMAN, { now: NOW }).state;
  const kept = seedControls(retired, CO, [{ agentId: 'a-1', status: 'active' }], { now: NOW });
  assert.equal(canStartWork(kept, CO, 'a-1').reason, 'agent_retired');

  const paused = pauseAgent(createControlState(), CO, 'a-2', HUMAN, { now: NOW }).state;
  const stillPaused = seedControls(paused, CO, [{ agentId: 'a-2', status: 'active' }], { now: NOW });
  assert.equal(canStartWork(stillPaused, CO, 'a-2').reason, 'agent_paused');
});

test('seedControls returns the same state when there is nothing to seed, and does not mutate input', () => {
  const state = createControlState();
  assert.equal(seedControls(state, CO, [], { now: NOW }), state);
  assert.equal(seedControls(state, '', [{ agentId: 'x', status: 'paused' }]), state);
  const seeded = seedControls(state, CO, [{ agentId: 'x', status: 'paused' }], { now: NOW });
  assert.notEqual(seeded, state);
  assert.equal(state.agents.size, 0);
});

// ---------- compose seeds from a roster ----------

test('compose seeds controls from the roster for its company at compose time', () => {
  const roster = [
    { companyId: CO, agentId: 'writer-1', status: 'paused' },
    { companyId: OTHER, agentId: 'writer-2', status: 'retired' },
  ];
  const runtime = composeWorkforceRuntime(fakeDeps({ roster }));
  assert.ok(runtime.controls, 'a roster gives the runtime a controls source');
  assert.deepEqual(canStartWork(runtime.controls.state(), CO, 'writer-1'), { allowed: false, reason: 'agent_paused' });
  assert.deepEqual(canStartWork(runtime.controls.state(), OTHER, 'writer-2'), { allowed: true });
});

test('compose seeds a supplied controls source in place', () => {
  let current = createControlState();
  const controls = { state: () => current, replace: (next) => { current = next; } };
  composeWorkforceRuntime(fakeDeps({ controls, roster: [{ companyId: CO, agentId: 'writer-1', status: 'retired' }] }));
  assert.equal(canStartWork(current, CO, 'writer-1').reason, 'agent_retired');
});

test('compose refuses a roster without a valid company scope or without a replaceable controls source', () => {
  const roster = [{ companyId: CO, agentId: 'writer-1', status: 'paused' }];
  assert.throws(() => composeWorkforceRuntime(fakeDeps({ companyScope: undefined, roster })), /company scope/);
  const fixed = { state: () => createControlState() };
  assert.throws(() => composeWorkforceRuntime(fakeDeps({ controls: fixed, roster })), /replaceable/);
});

// ---------- handoff resolves the target role from the roster store ----------

const COORD = { kind: 'agent', agentId: 'coord-1', roleId: 'coordinator' };
const TEAM_INPUT = {
  id: 'team-1',
  name: 'Content',
  members: [
    { roleId: 'coordinator', coordinator: true },
    { roleId: 'writer', coordinator: false },
  ],
};

/** Creates a run through the composed engine and moves it to running directly in the store (no model). */
async function runningRunFor(runtime, companyId) {
  const created = await runtime.engine.createRun({
    companyId,
    team: createTeam(TEAM_INPUT, roleSource),
    budget: { maxTokens: 100, maxToolCalls: 10 },
  });
  assert.equal(created.ok, true, `createRun failed: ${created.reason}`);
  const running = await runtime.store.updateRun(companyId, { ...created.run, status: 'running' }, created.run.version);
  return running.id;
}

/**
 * A run left in 'running' the way a crash leaves it: created and started through the engine core, which has no
 * sweep gate, before any compose call for the company has been made in this process.
 */
async function crashedRunFor(store, companyId) {
  const registry = composeWorkforceRuntime(fakeDeps({ store, companyScope: undefined })).registry;
  const core = createRunEngine({ registry, store });
  const created = await core.createRun({
    companyId,
    team: createTeam(TEAM_INPUT, roleSource),
    budget: { maxTokens: 100, maxToolCalls: 10 },
  });
  assert.equal(created.ok, true, `createRun failed: ${created.reason}`);
  const running = await store.updateRun(companyId, { ...created.run, status: 'running' }, created.run.version);
  return running.id;
}

const rosterOf = (agents) => ({ listAgents: () => agents });

test('handoff without a roster store is refused as roster_missing, and the run is not changed', async () => {
  const store = createMemoryRunStore();
  const runtime = composeWorkforceRuntime(fakeDeps({ store }));
  const runId = await runningRunFor(runtime, CO);
  const result = await runtime.engine.handoff(CO, runId, { actor: COORD, toRole: 'writer' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'roster_missing');
  assert.equal((await store.getRun(CO, runId)).status, 'running');
});

test('handoff to a role with no roster agent is refused as roster_role_unstaffed', async () => {
  const runtime = composeWorkforceRuntime(fakeDeps({ rosterStore: rosterOf([{ agentId: 'c-1', roleId: 'coordinator' }]) }));
  const runId = await runningRunFor(runtime, CO);
  const result = await runtime.engine.handoff(CO, runId, { actor: COORD, toRole: 'writer' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'roster_role_unstaffed');
});

test('handoff uses the roster agent id, not a roleId-1 guess: a paused roster agent refuses the handoff', async () => {
  const paused = pauseAgent(createControlState(), CO, 'w-real', HUMAN, { now: NOW }).state;
  const runtime = composeWorkforceRuntime(
    fakeDeps({
      rosterStore: rosterOf([{ agentId: 'w-real', roleId: 'writer' }]),
      controls: { state: () => paused },
    }),
  );
  const runId = await runningRunFor(runtime, CO);
  const result = await runtime.engine.handoff(CO, runId, { actor: COORD, toRole: 'writer' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'agent_paused');
});

test('handoff ignores a paused id that only matches the old roleId-1 guess', async () => {
  const pausedGuess = pauseAgent(createControlState(), CO, 'writer-1', HUMAN, { now: NOW }).state;
  const runtime = composeWorkforceRuntime(
    fakeDeps({
      rosterStore: rosterOf([{ agentId: 'w-real', roleId: 'writer' }]),
      controls: { state: () => pausedGuess },
    }),
  );
  const runId = await runningRunFor(runtime, CO);
  const result = await runtime.engine.handoff(CO, runId, { actor: COORD, toRole: 'writer' });
  assert.equal(result.ok, true, `handoff refused: ${result.reason}`);
});

test('handoff to a roster-backed role succeeds when no control blocks it', async () => {
  const runtime = composeWorkforceRuntime(fakeDeps({ rosterStore: rosterOf([{ agentId: 'w-real', roleId: 'writer' }]) }));
  const runId = await runningRunFor(runtime, CO);
  const result = await runtime.engine.handoff(CO, runId, { actor: COORD, toRole: 'writer' });
  assert.equal(result.ok, true, `handoff refused: ${result.reason}`);
  assert.equal(result.run.path.at(-1), 'writer', 'the handoff moves the run to the writer role');
});

test('compose refuses a roster store without listAgents', () => {
  assert.throws(() => composeWorkforceRuntime(fakeDeps({ rosterStore: {} })), /roster store/);
});

// ---------- recovery sweep: once per process per company, before the first engine call ----------

test('the first engine call for a company sweeps its interrupted runs, and the sweep is not repeated', async () => {
  resetCompanySweepsForTests();
  const store = createMemoryRunStore();
  const crashedRunId = await crashedRunFor(store, CO);

  const first = composeWorkforceRuntime(fakeDeps({ store }));
  const swept = await first.engine.getRun(CO, crashedRunId);
  assert.equal(swept.status, 'failed', 'the call waits for the sweep, so the crashed run is already failed');
  assert.equal(swept.reason, INTERRUPTED_RUN_REASON);

  // A run that starts after the sweep is not touched by a later compose for the same company.
  const liveRunId = await runningRunFor(first, CO);
  const second = composeWorkforceRuntime(fakeDeps({ store }));
  assert.equal((await second.engine.getRun(CO, liveRunId)).status, 'running');
});

test('a company is swept on its own first call, not when another company is called', async () => {
  resetCompanySweepsForTests();
  const store = createMemoryRunStore();
  const runId = await crashedRunFor(store, CO);

  const runtime = composeWorkforceRuntime(fakeDeps({ store, companyScope: OTHER }));
  await runtime.engine.getRun(OTHER, 'none');
  assert.equal((await store.getRun(CO, runId)).status, 'running', 'OTHER was swept, CO was not');

  assert.equal((await runtime.engine.getRun(CO, runId)).status, 'failed', 'the first call for CO sweeps CO');
});

test('compose without a company scope still sweeps each company on its first call', async () => {
  resetCompanySweepsForTests();
  const store = createMemoryRunStore();
  const runId = await crashedRunFor(store, CO);
  const unscoped = composeWorkforceRuntime(fakeDeps({ store, companyScope: undefined }));
  assert.equal((await unscoped.engine.getRun(CO, runId)).status, 'failed');
});

test('onRunFinished is told about a run that completes, a failing hook leaves the result unchanged, and a refused finish is not reported', async () => {
  resetCompanySweepsForTests();
  const seen = [];
  const runtime = composeWorkforceRuntime(
    fakeDeps({
      onRunFinished: (companyId, runId) => {
        seen.push([companyId, runId]);
        throw new Error('hook down');
      },
    }),
  );
  const runId = await startRun(runtime);

  const done = await runtime.engine.complete(CO, runId, 'done');
  assert.equal(done.ok, true, 'the hook does not change the outcome');
  assert.equal(done.run.status, 'completed');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [[CO, runId]]);

  const refused = await runtime.engine.complete(CO, 'no-such-run');
  assert.equal(refused.ok, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen.length, 1, 'a refused finish is not reported');
});

/** Executor double that records every query and answers with no rows. */
function recordingExecutor() {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [], rowCount: 0 };
    },
  };
}

const READER = { kind: 'agent', agentId: 'reader-1', roleId: 'writer', autonomy: 'auto' };

test('compose passes a non-null executor to the group 00 to 04 read handlers', async () => {
  const { GROUP00_TOOL_IDS } = await import('../../server/workforce/tools/handlers/group-00.ts');
  const { GROUP01_TOOL_IDS } = await import('../../server/workforce/tools/handlers/group-01.ts');
  const { GROUP_02_TOOL_IDS } = await import('../../server/workforce/tools/handlers/group-02.ts');
  const { GROUP03_TOOL_IDS } = await import('../../server/workforce/tools/handlers/group-03.ts');
  const { GROUP04_IDS } = await import('../../server/workforce/tools/handlers/group-04.ts');
  const groups = {
    group00: GROUP00_TOOL_IDS,
    group01: GROUP01_TOOL_IDS,
    group02: GROUP_02_TOOL_IDS,
    group03: GROUP03_TOOL_IDS,
    group04: GROUP04_IDS,
  };
  const executor = recordingExecutor();
  const runtime = composeWorkforceRuntime(fakeDeps({ sqlExecutor: executor }));

  for (const [group, ids] of Object.entries(groups)) {
    const reached = [];
    for (const toolId of ids) {
      if (!runtime.registry.has(toolId)) continue;
      const before = executor.calls.length;
      await runtime.registry.invoke({ companyId: CO, toolId, params: {}, actor: READER });
      if (executor.calls.length > before) reached.push(toolId);
    }
    assert.ok(reached.length > 0, `${group} reads never reached the composed executor`);
  }
});

test('a group read with no company context is refused before any query runs', async () => {
  const { GROUP00_TOOL_IDS } = await import('../../server/workforce/tools/handlers/group-00.ts');
  const executor = recordingExecutor();
  const runtime = composeWorkforceRuntime(fakeDeps({ sqlExecutor: executor, companyScope: undefined }));
  const toolId = GROUP00_TOOL_IDS.find((id) => runtime.registry.has(id));

  const result = await runtime.registry.invoke({ companyId: undefined, toolId, params: {}, actor: READER });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'company_id_required');
  assert.equal(executor.calls.length, 0, 'no query runs without a company');
});

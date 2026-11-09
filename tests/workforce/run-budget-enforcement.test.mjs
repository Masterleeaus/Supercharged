/**
 * Budget enforcement inside the run engine (run.ts), and compare-and-set behaviour of run status writes.
 * Checklist section 7: "Budgets ... Still not enforced inside run.ts" and "Concurrency-safe run updates".
 *
 * Claims under test:
 * 1. The budget ledger (budgets.ts) is checked before each tool call and each model turn. A refusal ends the run as
 *    budget_exhausted, with the refusal reason on the run record.
 * 2. A ledger backend that is async (the Postgres store) behaves the same as the in-memory ledger.
 * 3. A stop or cancel that lands between a commit and the tool call stops the call. The reservation is given back.
 * 4. A stop or cancel that lands while a tool runs is not overwritten. The executed call is reported.
 *
 * In-memory store, fake registry, fixed clock. No network, no database, no real timers.
 * Run: node --test --experimental-transform-types tests/workforce/run-budget-enforcement.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// This file imports server code. Keep stdout clean so the test runner's IPC is not disturbed.
for (const method of ['log', 'info', 'warn']) console[method] = () => {};

import { createToolRegistry, createRunEngine, createTeam, createMemoryRunStore } from '../../server/workforce/runtime/index.ts';
import { createBudgetLedger, reserve, release, turnHeadroom } from '../../server/workforce/runtime/budgets.ts';
import { RunVersionConflictError } from '../../server/workforce/runtime/store.ts';

const CO = 'company-1';
const WRITER = { kind: 'agent', agentId: 'writer-1', roleId: 'writer' };
const NOW = new Date('2026-11-03T09:00:00Z');

const LIMITS = {
  maxToolCallsPerRun: 2,
  maxTokensPerRun: 1000,
  maxSpendCentsPerRun: 500,
  maxRunsPerCompanyPerDay: 3,
  maxSpendCentsPerCompanyPerDay: 1200,
};

const ROLES = new Map([
  ['coordinator', { id: 'coordinator', handoffTo: ['writer'], autonomy: 'auto' }],
  ['writer', { id: 'writer', handoffTo: [], autonomy: 'auto' }],
]);
const roleSource = { getRole: (id) => ROLES.get(id) ?? null };
const team = createTeam(
  { id: 'team-1', name: 'Content', members: [{ roleId: 'coordinator', coordinator: true }, { roleId: 'writer' }] },
  roleSource,
);

/** The ledger as an async backend, the same shape the Postgres store has. */
function asyncPort(ledger) {
  return {
    reserve: async (req) => reserve(ledger, req),
    release: async (req) => release(ledger, req),
    turnHeadroom: async (req) => turnHeadroom(ledger, req),
  };
}

const BACKENDS = [
  ['in-memory ledger', (ledger) => ledger],
  ['async backend', (ledger) => asyncPort(ledger)],
];

function makeEngine({ store = createMemoryRunStore(), ledger = createBudgetLedger(LIMITS), wrap = (l) => l, handler } = {}) {
  const registry = createToolRegistry({
    gate: { gateAction: async () => ({ status: 'pending', approval: { id: 'x' } }), readApproval: async () => null, claimApproval: async () => false },
    redact: (v) => v,
    audit: { record: (e) => store.appendAudit(e) },
    now: () => NOW,
  });
  let executions = 0;
  registry.register({
    id: 'send_note',
    risk: 'low',
    schema: {},
    handler: async (params) => {
      executions += 1;
      return handler ? handler(params) : { ok: true };
    },
  });
  const engine = createRunEngine({
    registry,
    store,
    audit: { record: (e) => store.appendAudit(e) },
    now: () => NOW,
    sleep: async () => {},
    budgets: wrap(ledger),
  });
  return { engine, store, ledger, executions: () => executions };
}

async function startedRun(engine, budget = { maxTokens: 1000, maxToolCalls: 10 }) {
  const created = await engine.createRun({ companyId: CO, team, budget });
  assert.equal(created.ok, true, created.reason);
  const started = await engine.startRun(CO, created.run.id);
  assert.equal(started.ok, true, started.reason);
  return started.run.id;
}

for (const [label, wrap] of BACKENDS) {
  test(`${label}: the tool-call quota stops the run before the call that would exceed it`, async () => {
    const { engine, store, executions } = makeEngine({ wrap });
    const runId = await startedRun(engine);
    const actor = WRITER;

    assert.equal((await engine.callTool(CO, runId, { toolId: 'send_note', identityVerified: true, actor })).ok, true);
    assert.equal((await engine.callTool(CO, runId, { toolId: 'send_note', identityVerified: true, actor })).ok, true);
    const third = await engine.callTool(CO, runId, { toolId: 'send_note', identityVerified: true, actor });

    assert.equal(third.ok, false);
    assert.equal(third.reason, 'tool_call_limit');
    assert.equal(executions(), 2, 'the refused call is not executed');
    const stored = await store.getRun(CO, runId);
    assert.equal(stored.status, 'budget_exhausted');
    assert.equal(stored.reason, 'tool_call_limit', 'the run records why it stopped');
  });

  test(`${label}: a turn that takes spend over the per-run cap ends the run with spend_limit`, async () => {
    const { engine, store } = makeEngine({ wrap });
    const runId = await startedRun(engine);

    assert.equal((await engine.recordTokens(CO, runId, 10, 300)).ok, true);
    const over = await engine.recordTokens(CO, runId, 10, 300);
    assert.equal(over.ok, false);
    assert.equal(over.reason, 'spend_limit');
    assert.equal(over.run.status, 'budget_exhausted');
    assert.equal((await store.getRun(CO, runId)).reason, 'spend_limit');
  });

  test(`${label}: the company's daily spend quota stops a turn in another run`, async () => {
    const { engine, store } = makeEngine({ wrap });
    const first = await startedRun(engine);
    const second = await startedRun(engine);
    const third = await startedRun(engine);

    // Each run is within its own 500 cap. Company spend for the day is 800 after the second turn, of 1200.
    assert.equal((await engine.recordTokens(CO, first, 10, 400)).ok, true);
    assert.equal((await engine.recordTokens(CO, second, 10, 400)).ok, true);
    const refused = await engine.recordTokens(CO, third, 10, 500);
    assert.equal(refused.reason, 'company_spend_quota');
    assert.equal((await store.getRun(CO, third)).status, 'budget_exhausted');
    assert.equal((await store.getRun(CO, first)).status, 'running', 'the other runs are not stopped by this refusal');
    assert.equal((await store.getRun(CO, second)).status, 'running');
  });

  test(`${label}: a run that starts a new run slot over the daily run quota is refused at its first turn`, async () => {
    const { engine, store } = makeEngine({ wrap, ledger: createBudgetLedger({ ...LIMITS, maxRunsPerCompanyPerDay: 1 }) });
    const first = await startedRun(engine);
    const second = await startedRun(engine);

    assert.equal((await engine.callTool(CO, first, { toolId: 'send_note', identityVerified: true, actor: WRITER })).ok, true);
    const turn = await engine.beginModelTurn(CO, second);
    assert.equal(turn.ok, false);
    assert.equal(turn.reason, 'run_quota');
    assert.equal((await store.getRun(CO, second)).status, 'budget_exhausted');
  });

  test(`${label}: beginModelTurn passes with headroom, writes nothing, and refuses at the token cap`, async () => {
    const { engine, store } = makeEngine({ wrap });
    const runId = await startedRun(engine, { maxTokens: 100, maxToolCalls: 5 });

    const before = (await store.getRun(CO, runId)).version;
    assert.equal((await engine.beginModelTurn(CO, runId)).ok, true);
    assert.equal((await store.getRun(CO, runId)).version, before, 'a passing check writes nothing');

    assert.equal((await engine.recordTokens(CO, runId, 100)).ok, true, 'exactly at the cap is allowed');
    const refused = await engine.beginModelTurn(CO, runId);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'budget_exhausted');
    const stored = await store.getRun(CO, runId);
    assert.equal(stored.status, 'budget_exhausted');
    assert.equal(stored.reason, 'token_cap');
  });
}

test('without a ledger, the run caps still stop the run before a call', async () => {
  const registry = createToolRegistry({
    gate: { gateAction: async () => ({ status: 'pending', approval: { id: 'x' } }), readApproval: async () => null, claimApproval: async () => false },
    redact: (v) => v,
    audit: { record: () => {} },
    now: () => NOW,
  });
  const store = createMemoryRunStore();
  registry.register({ id: 'send_note', risk: 'low', schema: {}, handler: async () => ({ ok: true }) });
  const engine = createRunEngine({ registry, store, now: () => NOW, sleep: async () => {} });
  const runId = await startedRun(engine, { maxTokens: 1000, maxToolCalls: 1 });
  assert.equal((await engine.callTool(CO, runId, { toolId: 'send_note', identityVerified: true, actor: WRITER })).ok, true);
  assert.equal((await engine.callTool(CO, runId, { toolId: 'send_note', identityVerified: true, actor: WRITER })).reason, 'budget_exhausted');
});

test('a negative or fractional spend is refused as invalid_amount, and nothing is recorded', async () => {
  const { engine, store } = makeEngine();
  const runId = await startedRun(engine);
  const before = (await store.getRun(CO, runId)).version;
  assert.equal((await engine.recordTokens(CO, runId, 1, -5)).reason, 'invalid_amount');
  assert.equal((await engine.recordTokens(CO, runId, 1, 2.5)).reason, 'invalid_amount');
  assert.equal((await store.getRun(CO, runId)).version, before);
});

test('a cancel that lands after the budget step but before the call stops the call, and returns the reservation', async () => {
  const inner = createMemoryRunStore();
  let fired = false;
  const store = {
    ...inner,
    updateRun: async (companyId, run, expectedVersion) => {
      const saved = await inner.updateRun(companyId, run, expectedVersion);
      if (!fired && run.budget.toolCalls === 1) {
        fired = true;
        // Another writer (an operator stop) commits between this call's budget step and its execution.
        const current = await inner.getRun(companyId, run.id);
        await inner.updateRun(companyId, { ...current, status: 'cancelled', reason: 'stop', updatedAt: NOW.toISOString() }, current.version);
      }
      return saved;
    },
  };
  const { engine, ledger, executions } = makeEngine({ store });
  const runId = await startedRun(engine);

  await assert.rejects(engine.callTool(CO, runId, { toolId: 'send_note', identityVerified: true, actor: WRITER }), RunVersionConflictError);
  assert.equal(executions(), 0, 'the tool is not invoked after the stop');
  const stored = await inner.getRun(CO, runId);
  assert.equal(stored.status, 'cancelled');
  assert.equal(stored.reason, 'stop', 'the stop is not overwritten');
  assert.deepEqual(reserve(ledger, { companyId: CO, runId, toolCalls: LIMITS.maxToolCallsPerRun, tokens: 0, spendCents: 0, now: NOW.getTime() }), { allowed: true }, 'the reservation was returned');
});

test('a cancel that lands while the tool runs is kept, and the executed call is reported', async () => {
  const store = createMemoryRunStore();
  let runId = null;
  const { engine, executions } = makeEngine({
    store,
    handler: async () => {
      const current = await store.getRun(CO, runId);
      await store.updateRun(CO, { ...current, status: 'cancelled', reason: 'stop', updatedAt: NOW.toISOString() }, current.version);
      return { ok: true };
    },
  });
  runId = await startedRun(engine);

  const result = await engine.callTool(CO, runId, { toolId: 'send_note', identityVerified: true, actor: WRITER });
  assert.equal(result.ok, true, 'the call ran, so it is reported as run');
  assert.equal(result.tool.outcome, 'executed');
  assert.equal(result.run.status, 'cancelled', 'the run as the store holds it');
  assert.equal(executions(), 1);
  assert.equal((await store.getRun(CO, runId)).status, 'cancelled', 'the cancel is not overwritten by the post-call write');
});

test('a stale status write is refused with a version conflict, and the newer copy is left as it is', async () => {
  const store = createMemoryRunStore();
  const { engine } = makeEngine({ store });
  const runId = await startedRun(engine);
  const stale = await store.getRun(CO, runId);
  await engine.cancel(CO, runId, 'operator stop');

  await assert.rejects(
    store.updateRun(CO, { ...stale, status: 'completed', reason: 'late', updatedAt: NOW.toISOString() }, stale.version),
    RunVersionConflictError,
  );
  const stored = await store.getRun(CO, runId);
  assert.equal(stored.status, 'cancelled');
  assert.equal(stored.reason, 'operator stop');
});

test('the in-memory and async backends refuse the same way for the same sequence', async () => {
  const outcomes = [];
  for (const [, wrap] of BACKENDS) {
    const { engine } = makeEngine({ wrap });
    const runId = await startedRun(engine, { maxTokens: 1000, maxToolCalls: 10 });
    const seq = [];
    seq.push((await engine.callTool(CO, runId, { toolId: 'send_note', identityVerified: true, actor: WRITER })).ok);
    seq.push((await engine.callTool(CO, runId, { toolId: 'send_note', identityVerified: true, actor: WRITER })).ok);
    seq.push((await engine.callTool(CO, runId, { toolId: 'send_note', identityVerified: true, actor: WRITER })).reason);
    outcomes.push(seq);
  }
  assert.deepEqual(outcomes[1], outcomes[0]);
});

// Licence: original TitanZero test code. No Mastra or VoltAgent source is copied.
import assert from 'node:assert/strict';
import test from 'node:test';
import { resumeFlowAutomationPilot, runFlowAutomationPilot } from '../../../server/integrations/voltagent/workflows/flow-automation-pilot.ts';

const ACTOR = { kind: 'agent', agentId: 'a1', roleId: 'r1' };
const RUN = 'run-9';

function memoryStore() {
  const rows = new Map();
  return {
    rows,
    async get(key) { return rows.has(key) ? { ...rows.get(key) } : null; },
    async compareAndSet(key, expected, next) {
      const cur = rows.get(key);
      if ((cur ? cur.version : 0) !== expected) return false;
      rows.set(key, { ...next });
      return true;
    },
  };
}

function tool(outcomes) {
  const calls = [];
  const queue = [...outcomes];
  return {
    calls,
    async execute(args) { calls.push(args); return queue.shift(); },
  };
}

function flowStep(name, t) {
  return { name, toolId: `${name}.tool`, params: { step: name }, tool: t };
}

const EXECUTED = { status: 'executed', output: { ok: true }, truncated: false };
const SUSPEND = { status: 'awaiting_approval', approvalId: 'ap-7' };
const APPROVED = { id: 'ap-7', companyId: '7', action: 'x', status: 'approved', decidedBy: 'u9', paramsSha256: 'h', executed: false };

function engine(result) {
  const calls = [];
  return { calls, async resumeAfterApproval(companyId, runId, call) { calls.push({ companyId, runId, call }); return result; } };
}

const RESUMED_OK = { ok: true, tool: { outcome: 'executed', output: { ok: true }, truncated: false } };

test('a flow with no approval waits runs every step in order', async () => {
  const a = tool([EXECUTED]);
  const b = tool([EXECUTED]);
  const res = await runFlowAutomationPilot([flowStep('a', a), flowStep('b', b)], { store: memoryStore(), companyId: 7, runId: RUN, actor: ACTOR });
  assert.deepEqual(res, { status: 'completed', completed: ['a', 'b'] });
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 1);
});

test('an approval wait suspends the flow and later steps do not run', async () => {
  const store = memoryStore();
  const a = tool([SUSPEND]);
  const b = tool([EXECUTED]);
  const res = await runFlowAutomationPilot([flowStep('a', a), flowStep('b', b)], { store, companyId: 7, runId: RUN, actor: ACTOR });
  assert.deepEqual(res, { status: 'suspended', completed: [], suspendedStep: 'a', approvalId: 'ap-7' });
  assert.equal(b.calls.length, 0);
  assert.equal(store.rows.get(`${RUN}:a`).status, 'suspended');
});

test('an approved suspended step resumes once, then the remaining steps run in order', async () => {
  const store = memoryStore();
  const a = tool([SUSPEND]);
  const b = tool([EXECUTED]);
  const c = tool([EXECUTED]);
  const steps = [flowStep('a', a), flowStep('b', b), flowStep('c', c)];
  const deps = { store, companyId: 7, runId: RUN, actor: ACTOR };
  await runFlowAutomationPilot(steps, deps);
  const eng = engine(RESUMED_OK);
  const res = await resumeFlowAutomationPilot(steps, 'a', { ...deps, approvals: { async readApproval() { return APPROVED; } }, engine: eng });
  assert.deepEqual(res, { status: 'completed', completed: ['a', 'b', 'c'] });
  assert.equal(eng.calls.length, 1);
  assert.equal(eng.calls[0].call.toolId, 'a.tool');
  assert.equal(b.calls.length, 1);
  assert.equal(c.calls.length, 1);
});

test('a pending approval keeps the flow suspended and runs no later step', async () => {
  const store = memoryStore();
  const steps = [flowStep('a', tool([SUSPEND])), flowStep('b', tool([EXECUTED]))];
  const deps = { store, companyId: 7, runId: RUN, actor: ACTOR };
  await runFlowAutomationPilot(steps, deps);
  const eng = engine(RESUMED_OK);
  const res = await resumeFlowAutomationPilot(steps, 'a', { ...deps, approvals: { async readApproval() { return { ...APPROVED, status: 'pending' }; } }, engine: eng });
  assert.deepEqual(res, { status: 'suspended', completed: [], suspendedStep: 'a', approvalId: 'ap-7' });
  assert.equal(eng.calls.length, 0);
  assert.equal(steps[1].tool.calls.length, 0);
});

test('a rejected approval ends the flow and runs no later step', async () => {
  const store = memoryStore();
  const steps = [flowStep('a', tool([SUSPEND])), flowStep('b', tool([EXECUTED]))];
  const deps = { store, companyId: 7, runId: RUN, actor: ACTOR };
  await runFlowAutomationPilot(steps, deps);
  const eng = engine(RESUMED_OK);
  const res = await resumeFlowAutomationPilot(steps, 'a', { ...deps, approvals: { async readApproval() { return { ...APPROVED, status: 'rejected' }; } }, engine: eng });
  assert.deepEqual(res, { status: 'refused', completed: [], failedStep: 'a', reason: 'approval_rejected' });
  assert.equal(eng.calls.length, 0);
  assert.equal(steps[1].tool.calls.length, 0);
});

test('a second resume of the same suspended step is refused and runs nothing again', async () => {
  const store = memoryStore();
  const b = tool([EXECUTED]);
  const steps = [flowStep('a', tool([SUSPEND])), flowStep('b', b)];
  const deps = { store, companyId: 7, runId: RUN, actor: ACTOR };
  await runFlowAutomationPilot(steps, deps);
  const eng = engine(RESUMED_OK);
  const rdeps = { ...deps, approvals: { async readApproval() { return APPROVED; } }, engine: eng };
  await resumeFlowAutomationPilot(steps, 'a', rdeps);
  const again = await resumeFlowAutomationPilot(steps, 'a', rdeps);
  assert.equal(again.status, 'refused');
  assert.equal(eng.calls.length, 1);
  assert.equal(b.calls.length, 1);
});

test('a failing step ends the flow and later steps do not run', async () => {
  const b = tool([EXECUTED]);
  const steps = [flowStep('a', tool([{ status: 'refused', reason: 'budget_exhausted' }])), flowStep('b', b)];
  const res = await runFlowAutomationPilot(steps, { store: memoryStore(), companyId: 7, runId: RUN, actor: ACTOR });
  assert.deepEqual(res, { status: 'refused', completed: [], failedStep: 'a', reason: 'budget_exhausted' });
  assert.equal(b.calls.length, 0);
});

test('a missing company refuses the flow before any step runs', async () => {
  const a = tool([EXECUTED]);
  await assert.rejects(() => runFlowAutomationPilot([flowStep('a', a)], { store: memoryStore(), companyId: '', runId: RUN, actor: ACTOR }));
  assert.equal(a.calls.length, 0);
});

test('resuming a step that is not in the flow is refused', async () => {
  const res = await resumeFlowAutomationPilot([flowStep('a', tool([]))], 'zz', {
    store: memoryStore(), companyId: 7, runId: RUN, actor: ACTOR,
    approvals: { async readApproval() { return APPROVED; } }, engine: engine(RESUMED_OK),
  });
  assert.deepEqual(res, { status: 'refused', completed: [], failedStep: 'zz', reason: 'step_not_in_flow' });
});

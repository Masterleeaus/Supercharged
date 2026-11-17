// Licence: original TitanZero test code. No Mastra or VoltAgent source is copied.
import assert from 'node:assert/strict';
import test from 'node:test';
import { resumeStep, runStep } from '../../../server/integrations/voltagent/workflows/approval-flow.ts';

const ACTOR = { kind: 'agent', agentId: 'a1', roleId: 'r1' };
const PARAMS = { jobId: 'j1' };

function memoryStore() {
  const rows = new Map();
  return {
    rows,
    async get(key) { return rows.has(key) ? { ...rows.get(key) } : null; },
    async compareAndSet(key, expected, next) {
      const cur = rows.get(key);
      const curVersion = cur ? cur.version : 0;
      if (curVersion !== expected) return false;
      rows.set(key, { ...next });
      return true;
    },
  };
}

function tool(outcome) {
  const calls = [];
  return {
    calls,
    async execute(args) { calls.push(args); return typeof outcome === 'function' ? outcome() : outcome; },
  };
}

function approvals(record) {
  return { async readApproval() { return record; } };
}

function engine(result) {
  const calls = [];
  return {
    calls,
    async resumeAfterApproval(companyId, runId, call) {
      calls.push({ companyId, runId, call });
      return typeof result === 'function' ? result() : result;
    },
  };
}

const SUSPEND = { status: 'awaiting_approval', approvalId: 'ap-1' };
const EXECUTED = { status: 'executed', output: { id: 'j1' }, truncated: false };
const APPROVED = { id: 'ap-1', companyId: '7', action: 'jobs.lookup', status: 'approved', decidedBy: 'u9', paramsSha256: 'h', executed: false };

async function suspendOne(store, t) {
  return runStep({ tool: t, key: 'step-1', store, companyId: 7, runId: 'run-1', toolId: 'jobs.lookup', params: PARAMS, actor: ACTOR });
}

test('a step that executes at once completes and saves no suspended state', async () => {
  const store = memoryStore();
  const t = tool(EXECUTED);
  const res = await suspendOne(store, t);
  assert.deepEqual(res, { status: 'completed', output: { id: 'j1' } });
  assert.equal(store.rows.size, 0);
});

test('an approval wait suspends the step and makes no further tool call', async () => {
  const store = memoryStore();
  const t = tool(SUSPEND);
  const res = await suspendOne(store, t);
  assert.deepEqual(res, { status: 'suspended', approvalId: 'ap-1' });
  assert.equal(t.calls.length, 1);
  assert.equal(store.rows.get('step-1').status, 'suspended');
});

test('an approved step resumes once through engine.resumeAfterApproval', async () => {
  const store = memoryStore();
  await suspendOne(store, tool(SUSPEND));
  const eng = engine({ ok: true, reason: undefined, tool: { outcome: 'executed', output: { id: 'j1' }, truncated: false } });
  const res = await resumeStep({ key: 'step-1', store, approvals: approvals(APPROVED), engine: eng, companyId: 7 });
  assert.deepEqual(res, { status: 'completed', output: { id: 'j1' } });
  assert.equal(eng.calls.length, 1);
  assert.deepEqual(eng.calls[0].call, { toolId: 'jobs.lookup', params: PARAMS, actor: ACTOR });
  assert.equal(eng.calls[0].runId, 'run-1');
});

test('a second resume of the same step is refused and never reaches the engine', async () => {
  const store = memoryStore();
  await suspendOne(store, tool(SUSPEND));
  const eng = engine({ ok: true, tool: { outcome: 'executed', output: {}, truncated: false } });
  const deps = { key: 'step-1', store, approvals: approvals(APPROVED), engine: eng, companyId: 7 };
  await resumeStep(deps);
  const again = await resumeStep(deps);
  assert.equal(again.status, 'refused');
  assert.equal(eng.calls.length, 1);
});

test('a pending approval keeps the step suspended and makes no engine call', async () => {
  const store = memoryStore();
  await suspendOne(store, tool(SUSPEND));
  const eng = engine({ ok: true, tool: { outcome: 'executed', output: {}, truncated: false } });
  const res = await resumeStep({ key: 'step-1', store, approvals: approvals({ ...APPROVED, status: 'pending' }), engine: eng, companyId: 7 });
  assert.deepEqual(res, { status: 'suspended', approvalId: 'ap-1' });
  assert.equal(eng.calls.length, 0);
  assert.equal(store.rows.get('step-1').status, 'suspended');
});

test('a rejected or expired approval ends the step and makes no engine call', async () => {
  for (const status of ['rejected', 'expired']) {
    const store = memoryStore();
    await suspendOne(store, tool(SUSPEND));
    const eng = engine({ ok: true, tool: { outcome: 'executed', output: {}, truncated: false } });
    const res = await resumeStep({ key: 'step-1', store, approvals: approvals({ ...APPROVED, status }), engine: eng, companyId: 7 });
    assert.deepEqual(res, { status: 'refused', reason: `approval_${status}` });
    assert.equal(eng.calls.length, 0);
    assert.equal(store.rows.get('step-1').status, status);
  }
});

test('an approval already executed, missing, or from another company is refused', async () => {
  const cases = [
    [{ ...APPROVED, executed: true }, 'approval_already_executed'],
    [null, 'approval_not_found'],
    [{ ...APPROVED, companyId: '8' }, 'approval_company_mismatch'],
  ];
  for (const [record, reason] of cases) {
    const store = memoryStore();
    await suspendOne(store, tool(SUSPEND));
    const eng = engine({ ok: true, tool: { outcome: 'executed', output: {}, truncated: false } });
    const res = await resumeStep({ key: 'step-1', store, approvals: approvals(record), engine: eng, companyId: 7 });
    assert.deepEqual(res, { status: 'refused', reason });
    assert.equal(eng.calls.length, 0);
  }
});

test('two concurrent resumes: only one reaches the engine', async () => {
  const store = memoryStore();
  await suspendOne(store, tool(SUSPEND));
  const eng = engine({ ok: true, tool: { outcome: 'executed', output: {}, truncated: false } });
  const deps = { key: 'step-1', store, approvals: approvals(APPROVED), engine: eng, companyId: 7 };
  const [a, b] = await Promise.all([resumeStep(deps), resumeStep(deps)]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, ['completed', 'refused']);
  assert.equal(eng.calls.length, 1);
});

test('an engine failure on resume ends the step as failed and does not retry', async () => {
  const store = memoryStore();
  await suspendOne(store, tool(SUSPEND));
  const eng = engine({ ok: false, reason: 'run_not_awaiting_approval', tool: null });
  const res = await resumeStep({ key: 'step-1', store, approvals: approvals(APPROVED), engine: eng, companyId: 7 });
  assert.deepEqual(res, { status: 'failed', reason: 'run_not_awaiting_approval' });
  assert.equal(store.rows.get('step-1').status, 'failed');
  const again = await resumeStep({ key: 'step-1', store, approvals: approvals(APPROVED), engine: eng, companyId: 7 });
  assert.equal(again.status, 'refused');
  assert.equal(eng.calls.length, 1);
});

test('a refused or failed tool result is passed through without saving a suspended step', async () => {
  const store = memoryStore();
  const res = await suspendOne(store, tool({ status: 'refused', reason: 'policy_denied' }));
  assert.deepEqual(res, { status: 'refused', reason: 'policy_denied' });
  assert.equal(store.rows.size, 0);
});

test('a missing company id throws before any step runs', async () => {
  const store = memoryStore();
  const t = tool(EXECUTED);
  await assert.rejects(
    () => runStep({ tool: t, key: 'k', store, companyId: undefined, runId: 'r', toolId: 'x', params: {}, actor: ACTOR }),
    /companyId is required/,
  );
  assert.equal(t.calls.length, 0);
});

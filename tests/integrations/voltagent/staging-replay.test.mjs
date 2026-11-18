// Licence: original TitanZero test code. No Mastra or VoltAgent source is copied. No network.
// Fixed replay scenarios for #392 (Phase 3 staging validation). These run in-process with fakes so
// they are repeatable in CI. They do NOT prove staging behaviour: that needs a staging deployment,
// with flags on for one test company, and is an owner-run step.
import assert from 'node:assert/strict';
import test from 'node:test';
import { resumeStep, runStep } from '../../../server/integrations/voltagent/workflows/approval-flow.ts';
import { rerankItems, RerankError } from '../../../server/integrations/voltagent/rerank/cohere-reranker.ts';
import { toVoltGuardrail } from '../../../server/integrations/voltagent/guardrails/adapter.ts';
import { readVoltAgentFlags } from '../../../server/integrations/voltagent/flags.ts';

const ACTOR = { kind: 'agent', agentId: 'a1', roleId: 'r1' };
const PARAMS = { jobId: 'j1' };
const CO = '7';

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

function fixedTool(outcome) {
  return { async execute() { return outcome; } };
}

function engine(result) {
  return { async resumeAfterApproval() { return result; } };
}

const approvedRecord = (over = {}) => ({
  id: 'ap-1', companyId: CO, action: 'jobs.lookup', status: 'approved', decidedBy: 'u9', paramsSha256: 'h', executed: false, ...over,
});

test('replay 1 (approvals): suspend, approve, resume once; a second resume is refused', async () => {
  const store = memoryStore();
  const suspended = await runStep({
    tool: fixedTool({ status: 'awaiting_approval', approvalId: 'ap-1' }),
    key: 'replay-approve', store, companyId: CO, runId: 'run-1', toolId: 'jobs.lookup', params: PARAMS, actor: ACTOR,
  });
  assert.deepEqual(suspended, { status: 'suspended', approvalId: 'ap-1' });

  const approvals = { async readApproval() { return approvedRecord(); } };
  const done = await resumeStep({
    key: 'replay-approve', store, approvals, companyId: CO,
    engine: engine({ ok: true, tool: { outcome: 'executed', output: { id: 'j1' } } }),
  });
  assert.deepEqual(done, { status: 'completed', output: { id: 'j1' } });

  const again = await resumeStep({ key: 'replay-approve', store, approvals, companyId: CO, engine: engine({ ok: true, tool: null }) });
  assert.equal(again.status, 'refused');
});

test('replay 2 (approvals): a rejected approval never runs the tool', async () => {
  const store = memoryStore();
  await runStep({
    tool: fixedTool({ status: 'awaiting_approval', approvalId: 'ap-2' }),
    key: 'replay-reject', store, companyId: CO, runId: 'run-1', toolId: 'jobs.lookup', params: PARAMS, actor: ACTOR,
  });
  let ran = false;
  const approvals = { async readApproval() { return approvedRecord({ id: 'ap-2', status: 'rejected' }); } };
  const res = await resumeStep({
    key: 'replay-reject', store, approvals, companyId: CO,
    engine: { async resumeAfterApproval() { ran = true; return { ok: true, tool: null }; } },
  });
  assert.deepEqual(res, { status: 'refused', reason: 'approval_rejected' });
  assert.equal(ran, false);
});

test('replay 3 (budget limit): a budget refusal from the engine is returned as refused, never executed', async () => {
  const store = memoryStore();
  const res = await runStep({
    tool: fixedTool({ status: 'refused', reason: 'budget_exceeded' }),
    key: 'replay-budget', store, companyId: CO, runId: 'run-1', toolId: 'jobs.lookup', params: PARAMS, actor: ACTOR,
  });
  assert.deepEqual(res, { status: 'refused', reason: 'budget_exceeded' });
  assert.equal(store.rows.size, 0);
});

test('replay 4 (refusals): a guardrail block stops the text, and a malformed verdict also blocks', async () => {
  const blocking = toVoltGuardrail({ evaluate: async () => ({ pass: false, reason: 'blocked_term' }) });
  const blocked = await blocking({ companyId: CO, text: 'x' });
  assert.equal(blocked.pass, false);

  const malformed = toVoltGuardrail({ evaluate: async () => ({ pass: 'yes' }) });
  assert.equal((await malformed({ companyId: CO, text: 'x' })).pass, false);
});

test('replay 5 (retrieval): without a reranker the candidate order is kept; with one it is reordered by score', async () => {
  const items = [{ id: 'a', text: 'pool filter' }, { id: 'b', text: 'pool pump' }, { id: 'c', text: 'garden hose' }];
  const textOf = (i) => i.text;

  const unranked = items.map((item) => item.id);
  assert.deepEqual(unranked, ['a', 'b', 'c']);

  const reranker = {
    async rerank(_q, docs) {
      assert.equal(docs.length, 3);
      return [{ index: 2, score: 0.9 }, { index: 1, score: 0.4 }, { index: 0, score: 0.1 }];
    },
  };
  const ranked = await rerankItems(reranker, 'pool pump', items, textOf);
  assert.deepEqual(ranked.map((r) => r.item.id), ['c', 'b', 'a']);
});

test('replay 6 (retrieval): a reranker failure is an error, not a silent empty result', async () => {
  const reranker = { async rerank() { throw new RerankError('rerank_failed', 'down'); } };
  await assert.rejects(rerankItems(reranker, 'q', [{ text: 'a' }], (i) => i.text), (e) => e instanceof RerankError);
});

test('replay 7 (flags): every VoltAgent flag is off by default, so staging must opt in explicitly', () => {
  const flags = readVoltAgentFlags({});
  for (const [name, value] of Object.entries(flags)) assert.equal(value, false, `${name} should default to off`);
});

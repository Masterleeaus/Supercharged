// Licence: original TitanZero test code. In-process staging replay for issue #392 (VoltAgent rollout).
// Replays fixed scenarios through the real modules, with fakes only at the edges (store, engine, fetch).
// It does not touch a live staging environment. The live steps are listed on the issue, not run here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { resumeStep, runStep } from '../../../server/integrations/voltagent/workflows/approval-flow.ts';
import { toVoltGuardrail } from '../../../server/integrations/voltagent/guardrails/adapter.ts';
import { createBlockedTermGuardrail } from '../../../server/services/ai-runtime/guardrail.ts';
import { createBudgetLedger, reserve, release } from '../../../server/workforce/runtime/budgets.ts';
import { createInMemoryVectorStoreForTests } from '../../../server/integrations/voltagent/rag/vector-store.ts';
import { createKnowledgeSearchPort } from '../../../server/integrations/voltagent/rag/knowledge-port.ts';
import { retrieveCompanyKnowledge } from '../../../server/workforce/runtime/knowledge-retrieval.ts';
import { createCohereReranker, RerankError, rerankItems } from '../../../server/integrations/voltagent/rerank/cohere-reranker.ts';

// The flagged test company. Every scenario below runs for this company only.
const TEST_COMPANY = '4242';
const NOW = new Date('2026-06-01T00:00:00Z');

// ---- approvals -------------------------------------------------------------------------------------------

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

function engine(result) {
  const calls = [];
  return { calls, async resumeAfterApproval(companyId, runId, call) { calls.push({ companyId, runId, call }); return result; } };
}

const ACTOR = { kind: 'agent', agentId: 'a1', roleId: 'r1' };
const PARAMS = { jobId: 'j1' };
const approvalFor = (status, over = {}) => ({
  id: 'ap-1', companyId: TEST_COMPANY, action: 'jobs.lookup', status, decidedBy: 'owner-1', paramsSha256: 'h', executed: false, ...over,
});

test('replay approvals: a wait suspends, an approval resumes once, a second resume is refused', async () => {
  const store = memoryStore();
  const suspendTool = { calls: 0, async execute() { this.calls += 1; return { status: 'awaiting_approval', approvalId: 'ap-1' }; } };
  const first = await runStep({ tool: suspendTool, key: 'step-1', store, companyId: Number(TEST_COMPANY), runId: 'run-1', toolId: 'jobs.lookup', params: PARAMS, actor: ACTOR });
  assert.deepEqual(first, { status: 'suspended', approvalId: 'ap-1' });
  assert.equal(suspendTool.calls, 1);

  const eng = engine({ ok: true, tool: { outcome: 'executed', output: { id: 'j1' }, truncated: false } });
  const approvals = { async readApproval() { return approvalFor('approved'); } };
  const resumed = await resumeStep({ key: 'step-1', store, approvals, engine: eng, companyId: Number(TEST_COMPANY) });
  assert.deepEqual(resumed, { status: 'completed', output: { id: 'j1' } });
  assert.equal(eng.calls.length, 1);

  const again = await resumeStep({ key: 'step-1', store, approvals, engine: eng, companyId: Number(TEST_COMPANY) });
  assert.notEqual(again.status, 'completed');
  assert.equal(eng.calls.length, 1, 'a second resume must not reach the engine');
});

test('replay approvals: a rejected approval ends the step and makes no engine call', async () => {
  const store = memoryStore();
  const tool = { async execute() { return { status: 'awaiting_approval', approvalId: 'ap-1' }; } };
  await runStep({ tool, key: 'step-2', store, companyId: Number(TEST_COMPANY), runId: 'run-2', toolId: 'jobs.lookup', params: PARAMS, actor: ACTOR });
  const eng = engine({ ok: true, tool: { outcome: 'executed', output: {}, truncated: false } });
  const approvals = { async readApproval() { return approvalFor('rejected'); } };
  await resumeStep({ key: 'step-2', store, approvals, engine: eng, companyId: Number(TEST_COMPANY) });
  assert.equal(eng.calls.length, 0);
});

// ---- budget limits ---------------------------------------------------------------------------------------

const LIMITS = { maxToolCallsPerRun: 2, maxTokensPerRun: 1000, maxSpendCentsPerRun: 500, maxRunsPerCompanyPerDay: 3, maxSpendCentsPerCompanyPerDay: 1000 };

test('replay budgets: the third tool call in a run is refused, and a release returns the headroom', () => {
  const ledger = createBudgetLedger(LIMITS);
  const req = (over = {}) => ({ companyId: TEST_COMPANY, runId: 'run-b', toolCalls: 1, tokens: 10, spendCents: 1, now: NOW.getTime(), ...over });
  assert.deepEqual(reserve(ledger, req()), { allowed: true });
  assert.deepEqual(reserve(ledger, req()), { allowed: true });
  assert.deepEqual(reserve(ledger, req()), { allowed: false, reason: 'tool_call_limit' });
  release(ledger, req());
  assert.deepEqual(reserve(ledger, req()), { allowed: true });
});

test('replay budgets: spend over the run cap is refused with spend_limit', () => {
  const ledger = createBudgetLedger(LIMITS);
  const out = reserve(ledger, { companyId: TEST_COMPANY, runId: 'run-s', toolCalls: 1, tokens: 1, spendCents: 501, now: NOW.getTime() });
  assert.deepEqual(out, { allowed: false, reason: 'spend_limit' });
});

// ---- refusals --------------------------------------------------------------------------------------------

test('replay refusals: a blocked term is refused with a reason, and clean text passes', async () => {
  const guard = toVoltGuardrail(createBlockedTermGuardrail({ blocked_terms: ['wire money'] }));
  const refused = await guard({ companyId: TEST_COMPANY, text: 'please wire money now' });
  assert.equal(refused.pass, false);
  assert.equal(typeof refused.reason, 'string');
  assert.deepEqual(await guard({ companyId: TEST_COMPANY, text: 'book a clean on Friday' }), { pass: true });
});

test('replay refusals: a guardrail that errors or returns a malformed verdict blocks (fail closed)', async () => {
  const broken = toVoltGuardrail({ evaluate: () => { throw new Error('boom'); } });
  await assert.rejects(broken({ companyId: TEST_COMPANY, text: 'hi' }));
  const malformed = toVoltGuardrail({ evaluate: () => ({ pass: 'yes' }) });
  assert.equal((await malformed({ companyId: TEST_COMPANY, text: 'hi' })).pass, false);
});

// ---- retrieval, with and without the reranker -----------------------------------------------------------

async function seededPort() {
  const store = createInMemoryVectorStoreForTests();
  const gov = (sourceId) => ({ sourceId, version: 1, approved: true, approvedBy: 'owner-1', approvedAt: '2026-01-01T00:00:00Z', expiresAt: null, language: 'en' });
  await store.upsert([
    { companyId: TEST_COMPANY, ownerUserId: 'u1', knowledgeBaseId: 'kb-1', chunkIndex: 0, chunkText: 'boiler service visit', vector: [1, 0], governance: gov('boiler') },
    { companyId: TEST_COMPANY, ownerUserId: 'u1', knowledgeBaseId: 'kb-1', chunkIndex: 1, chunkText: 'boiler warranty terms', vector: [0.9, 0.1], governance: gov('warranty') },
    { companyId: TEST_COMPANY, ownerUserId: 'u1', knowledgeBaseId: 'kb-1', chunkIndex: 2, chunkText: 'expired boiler promo', vector: [1, 0], governance: { ...gov('promo'), expiresAt: '2020-01-01T00:00:00Z' } },
  ]);
  return createKnowledgeSearchPort({ store, embed: async () => [[1, 0]], governance: { now: () => NOW, language: 'en' } });
}

const rerankerReturning = (order) => createCohereReranker({
  apiKey: 'fake-key-for-replay',
  fetchImpl: async () => ({
    ok: true, status: 200,
    json: async () => ({ results: order.map((index, i) => ({ index, relevance_score: 1 - i * 0.1 })) }),
  }),
});

test('replay retrieval without the reranker: governed hits only, best vector score first', async () => {
  const port = await seededPort();
  const out = await retrieveCompanyKnowledge(port, { companyId: TEST_COMPANY, userId: 'u1', query: 'boiler', maxResults: 5 });
  assert.equal(out.ok, true);
  assert.deepEqual(out.results.map((r) => r.snippet), ['boiler service visit', 'boiler warranty terms']);
});

test('replay retrieval with the reranker: the reranker reorders the governed hits', async () => {
  const port = await seededPort();
  const out = await retrieveCompanyKnowledge(port, { companyId: TEST_COMPANY, userId: 'u1', query: 'boiler', maxResults: 5 });
  const reranked = await rerankItems(rerankerReturning([1, 0]), 'boiler', out.results, (r) => r.snippet);
  assert.deepEqual(reranked.map((x) => x.item.snippet), ['boiler warranty terms', 'boiler service visit']);
});

test('replay retrieval when the reranker fails: the error is typed and the governed, unranked hits are still the answer', async () => {
  const port = await seededPort();
  const out = await retrieveCompanyKnowledge(port, { companyId: TEST_COMPANY, userId: 'u1', query: 'boiler', maxResults: 5 });
  const failing = createCohereReranker({ apiKey: 'fake-key-for-replay', fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  await assert.rejects(rerankItems(failing, 'boiler', out.results, (r) => r.snippet), (err) => err instanceof RerankError && err.code === 'rerank_failed');
  // Caller fallback: without a reranker the governed results are used as they are.
  assert.deepEqual(out.results.map((r) => r.snippet), ['boiler service visit', 'boiler warranty terms']);
});

test('replay retrieval: another company in the same store sees nothing', async () => {
  const port = await seededPort();
  const out = await retrieveCompanyKnowledge(port, { companyId: '9999', userId: 'u1', query: 'boiler', maxResults: 5 });
  assert.equal(out.ok, true);
  assert.deepEqual(out.results, []);
});

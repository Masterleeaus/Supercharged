/**
 * Tests for server/workforce/runtime/knowledge-retrieval.ts. Fakes only: no database, no embeddings, no network.
 * Run: node --test --experimental-transform-types tests/workforce/knowledge-retrieval.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const noop = () => {};
console.log = noop;
console.info = noop;
console.warn = noop;

const {
  retrieveCompanyKnowledge,
  createKnowledgeSearchTool,
  MAX_SNIPPET_LENGTH,
} = await import('../../server/workforce/runtime/knowledge-retrieval.ts');
const { isUsableRecordId } = await import('../../server/workforce/runtime/citations.ts');

const COMPANY_A = '11111111-1111-4111-8111-111111111111';
const COMPANY_B = '22222222-2222-4222-8222-222222222222';
const KB_1 = 'kb-price-list';

const hit = (overrides = {}) => ({
  knowledgeBaseId: KB_1,
  chunkIndex: 0,
  chunkText: 'Standard gutter clean is 120 dollars.',
  companyId: COMPANY_A,
  score: 0.9,
  ...overrides,
});

// Fake port: records each call and returns canned hits or throws.
const fakePort = (hits, { throws = null } = {}) => {
  const calls = [];
  return {
    calls,
    port: {
      async searchChunks(input) {
        calls.push(input);
        if (throws) throw throws;
        return hits;
      },
    },
  };
};

test('a missing or invalid company is refused and the search is never called', async () => {
  for (const companyId of [undefined, null, '', 'bad company!', {}, [], -1, 0, 1.5]) {
    const { port, calls } = fakePort([hit()]);
    const result = await retrieveCompanyKnowledge(port, { companyId, query: 'gutter price' });
    assert.deepEqual(result, { ok: false, error: 'company_required' }, `companyId ${String(companyId)}`);
    assert.equal(calls.length, 0);
  }
});

test('an empty or oversized query is refused before the search', async () => {
  const { port, calls } = fakePort([hit()]);
  assert.deepEqual(
    await retrieveCompanyKnowledge(port, { companyId: COMPANY_A, userId: 'user-a', query: '   ' }),
    { ok: false, error: 'invalid_query' },
  );
  assert.deepEqual(
    await retrieveCompanyKnowledge(port, { companyId: COMPANY_A, userId: 'user-a', query: 'x'.repeat(501) }),
    { ok: false, error: 'invalid_query' },
  );
  assert.equal(calls.length, 0);
});

test('hits from another company, or with no company, are dropped', async () => {
  const { port } = fakePort([
    hit({ chunkIndex: 0, companyId: COMPANY_A }),
    hit({ chunkIndex: 1, companyId: COMPANY_B, chunkText: 'Other tenant price.' }),
    hit({ chunkIndex: 2, companyId: null, chunkText: 'Legacy row with no company.' }),
    hit({ chunkIndex: 3, companyId: undefined }),
  ]);
  const result = await retrieveCompanyKnowledge(port, { companyId: COMPANY_A, userId: 'user-a', query: 'price' });
  assert.equal(result.ok, true);
  assert.equal(result.dropped, 3);
  assert.deepEqual(result.results.map((r) => r.sourceRef), [`kb:${KB_1}:0`]);
  assert.doesNotMatch(JSON.stringify(result), /Other tenant|Legacy/);
});

test('every result carries a source reference that citations.ts accepts as a record', async () => {
  const { port } = fakePort([hit({ chunkIndex: 4 })]);
  const result = await retrieveCompanyKnowledge(port, { companyId: COMPANY_A, userId: 'user-a', query: 'gutter' });
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 1);
  const [r] = result.results;
  assert.equal(r.sourceRef, `kb:${KB_1}:4`);
  assert.equal(r.kind, 'record');
  assert.equal(isUsableRecordId(r.sourceRef), true);
});

test('hits with an unusable knowledge base id or chunk index are dropped', async () => {
  const { port } = fakePort([
    hit({ knowledgeBaseId: 'has spaces#1', chunkIndex: 0 }),
    hit({ knowledgeBaseId: KB_1, chunkIndex: -1 }),
    hit({ knowledgeBaseId: KB_1, chunkIndex: 1.5 }),
    hit({ knowledgeBaseId: KB_1, chunkIndex: 2 }),
  ]);
  const result = await retrieveCompanyKnowledge(port, { companyId: COMPANY_A, userId: 'user-a', query: 'gutter' });
  assert.equal(result.dropped, 3);
  assert.deepEqual(result.results.map((r) => r.sourceRef), [`kb:${KB_1}:2`]);
});

test('results are ordered by score and the snippet is capped', async () => {
  const long = 'a'.repeat(MAX_SNIPPET_LENGTH + 300);
  const { port } = fakePort([
    hit({ chunkIndex: 0, score: 0.2 }),
    hit({ chunkIndex: 1, score: 0.8, chunkText: long }),
  ]);
  const result = await retrieveCompanyKnowledge(port, { companyId: COMPANY_A, userId: 'user-a', query: 'gutter' });
  assert.deepEqual(result.results.map((r) => r.sourceRef), [`kb:${KB_1}:1`, `kb:${KB_1}:0`]);
  assert.equal(result.results[0].snippet.length, MAX_SNIPPET_LENGTH);
});

test('maxResults is clamped between 1 and 10 and defaults to 5', async () => {
  const { port, calls } = fakePort([]);
  await retrieveCompanyKnowledge(port, { companyId: COMPANY_A, userId: 'user-a', query: 'q', maxResults: 999 });
  await retrieveCompanyKnowledge(port, { companyId: COMPANY_A, userId: 'user-a', query: 'q', maxResults: 0 });
  await retrieveCompanyKnowledge(port, { companyId: COMPANY_A, userId: 'user-a', query: 'q' });
  assert.deepEqual(calls.map((c) => c.limit), [10, 1, 5]);
  assert.equal(calls[0].companyId, COMPANY_A);
});

test('a port failure returns a generic error and never leaks its message', async () => {
  const { port } = fakePort([], { throws: new Error('connect ECONNREFUSED 10.0.0.5 api_key=sk-test-123') });
  const result = await retrieveCompanyKnowledge(port, { companyId: COMPANY_A, userId: 'user-a', query: 'q' });
  assert.deepEqual(result, { ok: false, error: 'retrieval_failed' });
  assert.doesNotMatch(JSON.stringify(result), /ECONNREFUSED|sk-test|10\.0\.0\.5/);
});

test('the tool takes its company from the handler context, not from the params', async () => {
  const { port, calls } = fakePort([hit({ companyId: COMPANY_A })]);
  const tool = createKnowledgeSearchTool(port);
  assert.equal(tool.id, 'knowledge.search');
  assert.equal(tool.access, 'read');

  const outcome = await tool.handler(
    { query: 'gutter', companyId: COMPANY_B },
    { companyId: COMPANY_A, userId: 'user-a', signal: new AbortController().signal },
  );
  assert.equal(outcome.ok, true);
  assert.equal(calls[0].companyId, COMPANY_A);
});

test('the tool fails closed when the context has no company', async () => {
  const { port, calls } = fakePort([hit()]);
  const tool = createKnowledgeSearchTool(port);
  const outcome = await tool.handler(
    { query: 'gutter', companyId: COMPANY_A },
    { companyId: undefined, signal: new AbortController().signal },
  );
  assert.deepEqual(outcome, { ok: false, error: 'company_required' });
  assert.equal(calls.length, 0);
});

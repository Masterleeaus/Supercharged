/**
 * Issue #49: the course_knowledge.search tool for the Skilled Manager and learner assistants.
 * Uses a fake search port. Checks identity comes only from the verified context, and that the shared
 * retrieval path drops other companies' hits and fails closed on errors.
 * Run: node --test --experimental-transform-types tests/workforce/course-search-tool.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

for (const method of ['log', 'info', 'warn', 'error']) console[method] = () => {};

const { createCourseKnowledgeSearchTool } = await import(
  '../../server/workforce/courses/knowledge/course-search-tool.ts'
);
const { COURSE_KNOWLEDGE_TOOL_ID } = await import('../../server/workforce/courses/course-agent.template.ts');

const COMPANY = 'company-a';
const LEARNER = 'learner-1';

function ctx(overrides = {}) {
  return { companyId: COMPANY, signal: new AbortController().signal, userId: LEARNER, ...overrides };
}

function fakePort(hits, calls = []) {
  return {
    async searchChunks(input) {
      calls.push(input);
      return hits;
    },
  };
}

test('the tool is read-only and carries the course tool id', () => {
  const tool = createCourseKnowledgeSearchTool({ port: fakePort([]) });
  assert.equal(tool.id, COURSE_KNOWLEDGE_TOOL_ID);
  assert.equal(tool.access, 'read');
  assert.equal(tool.risk, 'low');
});

test('the learner and company come from the verified context, not from params', async () => {
  const calls = [];
  const tool = createCourseKnowledgeSearchTool({ port: fakePort([], calls) });
  await tool.handler({ query: 'isolation valve', userId: 'someone-else', companyId: 'company-b' }, ctx());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userId, LEARNER);
  assert.equal(calls[0].companyId, COMPANY);
});

test('a call with no verified learner is refused before the port is asked', async () => {
  const calls = [];
  const tool = createCourseKnowledgeSearchTool({ port: fakePort([], calls) });
  const result = await tool.handler({ query: 'isolation valve', userId: 'someone-else' }, ctx({ userId: undefined }));
  assert.deepEqual(result, { ok: false, error: 'user_required' });
  assert.equal(calls.length, 0);
});

test('hits that belong to another company are dropped', async () => {
  const hits = [
    { knowledgeBaseId: 'rev-1', chunkIndex: 0, chunkText: 'Isolate the valve first.', companyId: COMPANY, score: 1 },
    { knowledgeBaseId: 'rev-2', chunkIndex: 0, chunkText: 'Other company text.', companyId: 'company-b', score: 1 },
  ];
  const tool = createCourseKnowledgeSearchTool({ port: fakePort(hits) });
  const result = await tool.handler({ query: 'valve' }, ctx());
  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((r) => r.sourceRef), ['kb:rev-1:0']);
  assert.equal(result.dropped, 1);
});

test('a port failure fails closed with retrieval_failed and does not throw', async () => {
  const tool = createCourseKnowledgeSearchTool({
    port: { async searchChunks() { throw new Error('database down'); } },
  });
  const result = await tool.handler({ query: 'valve' }, ctx());
  assert.deepEqual(result, { ok: false, error: 'retrieval_failed' });
});

test('an empty or over-long query is refused', async () => {
  const tool = createCourseKnowledgeSearchTool({ port: fakePort([]) });
  assert.deepEqual(await tool.handler({ query: '   ' }, ctx()), { ok: false, error: 'invalid_query' });
  assert.deepEqual(await tool.handler({ query: 'x'.repeat(501) }, ctx()), { ok: false, error: 'invalid_query' });
});

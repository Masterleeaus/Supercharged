// Course revision store and its knowledge search port (W2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CourseRevisionStore, CourseRevisionConflictError } from '../../server/workforce/courses/store/revision-store.ts';
import { createCourseKnowledgeSearchPort } from '../../server/workforce/courses/store/search-port.ts';
import { retrieveCompanyKnowledge } from '../../server/workforce/runtime/knowledge-retrieval.ts';

const FLAG = 'WORKFORCE_INTERNAL_DRAFT_COURSES';
const hash = (n) => String(n).padStart(64, '0');

const roleScope = {
  group: 'clean',
  tiers: {
    base: [],
    groupLessons: { clean: [] },
    courseLessons: { 'course-clean': ['L-1', 'L-2'] },
    courseGroup: { 'course-clean': 'clean' },
    courseFields: {},
  },
};

const baseCtx = () => ({
  companyId: 'co-1',
  learnerId: 'u-1',
  verticalId: 'cleaning',
  enrolments: [{ courseId: 'course-clean', companyId: 'co-1', status: 'ACTIVE' }],
  checkedLessonIds: [],
  bestScores: {},
  roleScope,
  openAssessments: [],
  clientPage: { kind: 'lesson' },
});

const revision = (overrides = {}) => ({
  id: 'rev-1',
  lessonId: 'L-1',
  status: 'PUBLISHED',
  contentHash: hash(1),
  courses: [{ courseId: 'course-clean', verticalId: 'cleaning' }],
  body: { title: 'Chemical handling', sections: [{ text: 'Store each chemical in a labelled container.' }] },
  ...overrides,
});

const makePort = (ctx, env = {}) => createCourseKnowledgeSearchPort({
  store: storeWith(revision()),
  getLearnerContext: async () => ctx,
  env,
});

function storeWith(...revisions) {
  const store = new CourseRevisionStore();
  store.upsert(revisions);
  return store;
}

const search = (port, overrides = {}) => port.searchChunks({
  companyId: 'co-1', userId: 'u-1', query: 'chemical container', limit: 5, ...overrides,
});

test('upsert is idempotent: the same batch twice inserts once and reports unchanged', () => {
  const store = new CourseRevisionStore();
  const batch = [revision()];
  assert.deepEqual(store.upsert(batch), { inserted: 1, updated: 0, unchanged: 0 });
  assert.deepEqual(store.upsert(batch), { inserted: 0, updated: 0, unchanged: 1 });
  assert.equal(store.listByLesson('L-1').length, 1);
});

test('a second revision with the same lessonId and contentHash but a different id is rejected', () => {
  const store = storeWith(revision());
  assert.throws(
    () => store.upsert([revision({ id: 'rev-2' })]),
    CourseRevisionConflictError,
  );
  assert.deepEqual(store.listByLesson('L-1').map((r) => r.id), ['rev-1']);
});

test('the same id with different content is rejected, and a failed batch writes nothing', () => {
  const store = storeWith(revision());
  assert.throws(
    () => store.upsert([revision({ lessonId: 'L-2' }), revision({ id: 'rev-3', lessonId: 'L-3', contentHash: hash(9) })]),
    CourseRevisionConflictError,
  );
  assert.equal(store.listByLesson('L-2').length, 0);
  assert.equal(store.listByLesson('L-3').length, 0);
});

test('reads hide DRAFT, REVIEW and RETIRED by default and show DRAFT only with the internal option', () => {
  const store = storeWith(
    revision({ id: 'rev-d', lessonId: 'L-1', status: 'DRAFT', contentHash: hash(2) }),
    revision({ id: 'rev-r', lessonId: 'L-1', status: 'REVIEW', contentHash: hash(3) }),
    revision({ id: 'rev-x', lessonId: 'L-1', status: 'RETIRED', contentHash: hash(4) }),
    revision({ id: 'rev-p', lessonId: 'L-1', status: 'PUBLISHED', contentHash: hash(5) }),
  );
  assert.deepEqual(store.listByLesson('L-1').map((r) => r.id), ['rev-p']);
  assert.deepEqual(store.listByLesson('L-1', { allowDraftRevisions: true }).map((r) => r.id), ['rev-d', 'rev-p']);
  assert.deepEqual(store.listPinnedToCourse('course-clean', { allowDraftRevisions: true }).map((r) => r.id), ['rev-d', 'rev-p']);
});

test('search returns nothing for a learner with no enrolment', async () => {
  const ctx = { ...baseCtx(), enrolments: [] };
  assert.deepEqual(await search(makePort(ctx)), []);
});

test('search returns nothing for REVIEW and RETIRED revisions, even with the flag on', async () => {
  const store = storeWith(
    revision({ id: 'rev-r', status: 'REVIEW', contentHash: hash(3) }),
    revision({ id: 'rev-x', status: 'RETIRED', contentHash: hash(4), lessonId: 'L-2' }),
  );
  const port = createCourseKnowledgeSearchPort({ store, getLearnerContext: async () => baseCtx(), env: { [FLAG]: '1' } });
  assert.deepEqual(await search(port), []);
});

test('search returns DRAFT only when WORKFORCE_INTERNAL_DRAFT_COURSES=1 is in the env passed in', async () => {
  const store = storeWith(revision({ status: 'DRAFT' }));
  const off = createCourseKnowledgeSearchPort({ store, getLearnerContext: async () => baseCtx(), env: {} });
  assert.deepEqual(await search(off), []);
  const on = createCourseKnowledgeSearchPort({ store, getLearnerContext: async () => baseCtx(), env: { [FLAG]: '1' } });
  const hits = await search(on);
  assert.ok(hits.length > 0);
  assert.deepEqual([...new Set(hits.map((h) => h.knowledgeBaseId))], ['rev-1']);
});

test('the limit is applied after filtering, so a matching revision last in the store is still returned', async () => {
  const many = Array.from({ length: 11 }, (_, i) => revision({
    id: `rev-n${i}`, lessonId: 'L-1', contentHash: hash(100 + i),
    body: { text: 'Routine floor checklist for the morning.' },
  }));
  const match = revision({ id: 'rev-m', lessonId: 'L-2', contentHash: hash(200) });
  const store = storeWith(...many, match);
  const port = createCourseKnowledgeSearchPort({ store, getLearnerContext: async () => baseCtx(), env: {} });
  const hits = await search(port, { query: 'chemical', limit: 1 });
  assert.deepEqual(hits.map((h) => h.knowledgeBaseId), ['rev-m']);
});

test('an empty companyId is rejected', async () => {
  const port = makePort(baseCtx());
  await assert.rejects(search(port, { companyId: '' }), { code: 'company_required' });
  await assert.rejects(search(port, { companyId: undefined }), { code: 'company_required' });
});

test('an empty userId is rejected', async () => {
  const port = makePort(baseCtx());
  await assert.rejects(search(port, { userId: '  ' }), { code: 'user_required' });
});

test('a learner from another company gets nothing, by context or by enrolment', async () => {
  const otherCompanyContext = { ...baseCtx(), companyId: 'co-2' };
  assert.deepEqual(await search(makePort(otherCompanyContext), { companyId: 'co-2' }), []);

  const enrolmentInOtherCompany = {
    ...baseCtx(),
    enrolments: [{ courseId: 'course-clean', companyId: 'co-2', status: 'ACTIVE' }],
  };
  assert.deepEqual(await search(makePort(enrolmentInOtherCompany)), []);

  const requestForOtherCompany = await search(makePort(baseCtx()), { companyId: 'co-2' });
  assert.deepEqual(requestForOtherCompany, []);
});

test('a course that is not ACTIVE gives nothing', async () => {
  const ctx = { ...baseCtx(), enrolments: [{ courseId: 'course-clean', companyId: 'co-1', status: 'COMPLETED' }] };
  assert.deepEqual(await search(makePort(ctx)), []);
});

test('revisions pinned only to a course in another vertical are not returned', async () => {
  const store = storeWith(revision({ courses: [{ courseId: 'course-clean', verticalId: 'plumbing' }] }));
  const port = createCourseKnowledgeSearchPort({ store, getLearnerContext: async () => baseCtx(), env: {} });
  assert.deepEqual(await search(port), []);
});

test('a lesson outside the learner unlocked tiers is not returned', async () => {
  const store = storeWith(revision({ lessonId: 'L-9', contentHash: hash(7) }));
  const port = createCourseKnowledgeSearchPort({ store, getLearnerContext: async () => baseCtx(), env: {} });
  assert.deepEqual(await search(port), []);
});

test('answer-key material and knowledge-check text are never searched or returned', async () => {
  const body = {
    text: 'Chemical storage guidance.',
    knowledgeChecks: [{ question: 'zebra question', options: ['zebra', 'lion'], correctIndex: 0, explanation: 'zebra' }],
  };
  const store = storeWith(revision({ body }));
  const port = createCourseKnowledgeSearchPort({ store, getLearnerContext: async () => baseCtx(), env: {} });
  assert.deepEqual(await search(port, { query: 'zebra' }), []);
  const hits = await search(port, { query: 'chemical' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].chunkText.includes('zebra'), false);
});

test('hits carry the requested company and work through retrieveCompanyKnowledge', async () => {
  const port = makePort(baseCtx());
  const outcome = await retrieveCompanyKnowledge(port, { companyId: 'co-1', userId: 'u-1', query: 'chemical container' });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.results.map((r) => r.sourceRef).sort(), ['kb:rev-1:0', 'kb:rev-1:1']);
  assert.equal(outcome.dropped, 0);
});

test('store refuses a revision id the search port would drop', () => {
  const store = new CourseRevisionStore();
  const bad = {
    id: 'lesson@abc123', lessonId: 'L-1', status: 'DRAFT', contentHash: 'h',
    courses: [{ courseId: 'c-1', verticalId: 'cleaning' }], body: {},
  };
  assert.throws(() => store.upsert([bad]), /must match/);
});

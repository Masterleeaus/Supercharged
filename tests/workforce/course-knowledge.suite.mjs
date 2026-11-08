import test from 'node:test';
import assert from 'node:assert/strict';

const policy = await import('../../server/workforce/courses/knowledge/policy.ts');
const {
  canRetrieve,
  guardCourseRequest,
  guardAssessmentPage,
  guardAssessmentQuestion,
  stripAssessmentData,
  screenPassageText,
  selectApprovedFieldValues,
  buildCitations,
  limitPassages,
  prepareRetrieval,
  answerMaterial,
  unlockedLessonIds,
  nextTierStep,
  tierPassed,
  unlockedBusinessFieldKeys,
  approvedBusinessValues,
  validateTierMap,
  lessonScoresFromChecks,
} = policy;
const { BASE_TIER_LESSON_COUNT } = await import('../../server/workforce/courses/knowledge/types.ts');
const generator = await import('../../server/workforce/courses/generate.ts');
const { TIER_MAP, LESSON_CHECK_IDS } = generator;

const CO = 'company-1';
const OTHER_CO = 'company-2';
const VERTICAL = 'cleaning';
const OTHER_VERTICAL = 'pool';
const LEARNER = 'learner-1';
const OTHER_LEARNER = 'learner-2';
const HASH = 'a'.repeat(64);

// The answer key used by the leak tests. Nothing below may appear in any output.
const SECRET_OPTION = 'Dilute to 1 in 4';
const SECRET_EXPLANATION = 'Label rate is 1:4 for this product';

const body = () => ({
  id: 'les-1',
  title: 'Dilution',
  summary: ['Mix the product at the label rate before use.'],
  knowledgeChecks: [{
    question: 'How do you dilute the concentrate?',
    options: ['Dilute to 1 in 2', SECRET_OPTION, 'Dilute to 1 in 8'],
    correctIndex: 1,
    explanation: SECRET_EXPLANATION,
  }],
  assessmentRubric: [{ criterion: 'Dilution', levels: { meets: 'Correct ratio', does_not_meet: 'Wrong ratio' } }],
  score: 80,
});

const revision = (over = {}) => ({
  id: 'rev-1',
  lessonId: 'les-1',
  status: 'PUBLISHED',
  contentHash: HASH,
  courses: [{ courseId: 'course-1', verticalId: VERTICAL }],
  body: body(),
  ...over,
});

const TIERS = {
  base: ['les-1', 'base-2'],
  groupLessons: { cleaning: ['grp-1', 'grp-2'] },
  courseLessons: { 'course-1': ['c1-1'] },
  courseGroup: { 'course-1': 'cleaning' },
  courseFields: { 'course-1': ['equipment.primary_tool', 'safety.required_ppe'] },
};
const PASSED = {
  checkedLessonIds: ['les-1', 'base-2', 'grp-1', 'grp-2'],
  bestScores: { 'les-1': 90, 'base-2': 90, 'grp-1': 90, 'grp-2': 90 },
};

const ctx = (over = {}) => ({
  companyId: CO,
  learnerId: LEARNER,
  verticalId: VERTICAL,
  enrolments: [{ courseId: 'course-1', companyId: CO, status: 'ACTIVE' }],
  ...PASSED,
  roleScope: { group: 'cleaning', tiers: TIERS },
  openAssessments: [],
  clientPage: { kind: 'lesson' },
  ...over,
});

const openCheck = (over = {}) => ({
  kind: 'knowledge_check',
  status: 'in_progress',
  learnerId: LEARNER,
  companyId: CO,
  revisionId: 'rev-1',
  lessonId: 'les-1',
  ...over,
});

const cleanPassage = { revisionId: 'rev-1', lessonId: 'les-1', snapshotId: 'snap-1', text: 'Mix the product at the label rate before use.' };

// ---------------- Rule 1: published revisions only ----------------

test('rule 1: a PUBLISHED revision can be retrieved', () => {
  assert.equal(canRetrieve(ctx(), revision()).allowed, true);
});

for (const status of ['DRAFT', 'REVIEW', 'RETIRED', '']) {
  test(`rule 1: a ${JSON.stringify(status)} revision is refused`, () => {
    const d = canRetrieve(ctx(), revision({ status }));
    assert.equal(d.allowed, false);
    assert.equal(d.code, 'REVISION_NOT_PUBLISHED');
  });
}

test('rule 1: a refused draft reaches the learner as a redirect, not an error', () => {
  const reply = prepareRetrieval(ctx(), revision({ status: 'DRAFT' }), [cleanPassage]);
  assert.equal(reply.kind, 'redirect');
  assert.equal(reply.code, 'REVISION_NOT_PUBLISHED');
  assert.equal(typeof reply.message, 'string');
});

// ---------------- Rule 2: active enrolment only ----------------

test('rule 2: an ACTIVE enrolment for the same company in a pinning course is allowed', () => {
  assert.equal(canRetrieve(ctx(), revision()).allowed, true);
});

for (const status of ['COMPLETED', 'CANCELLED']) {
  test(`rule 2: enrolment status ${status} is refused`, () => {
    const d = canRetrieve(ctx({ enrolments: [{ courseId: 'course-1', companyId: CO, status }] }), revision());
    assert.equal(d.allowed, false);
    assert.equal(d.code, 'NO_ACTIVE_ENROLMENT');
  });
}

test('rule 2: no enrolment is refused', () => {
  assert.equal(canRetrieve(ctx({ enrolments: [] }), revision()).code, 'NO_ACTIVE_ENROLMENT');
});

test('rule 2: an ACTIVE enrolment for another company is refused', () => {
  const d = canRetrieve(ctx({ enrolments: [{ courseId: 'course-1', companyId: OTHER_CO, status: 'ACTIVE' }] }), revision());
  assert.equal(d.code, 'NO_ACTIVE_ENROLMENT');
});

test('rule 2: an ACTIVE enrolment in a course that does not pin the revision is refused', () => {
  const d = canRetrieve(ctx({ enrolments: [{ courseId: 'course-9', companyId: CO, status: 'ACTIVE' }] }), revision());
  assert.equal(d.code, 'NO_ACTIVE_ENROLMENT');
});

test('rule 2: a revision not pinned by any course is refused', () => {
  assert.equal(canRetrieve(ctx(), revision({ courses: [] })).code, 'NOT_PLACED_IN_COURSE');
});

test('rule 2: a learner context without companyId is refused', () => {
  const d = canRetrieve(ctx({ companyId: '' }), revision());
  assert.equal(d.code, 'INVALID_CONTEXT');
});

test('rule 2: a learner context without learnerId is refused', () => {
  assert.equal(canRetrieve(ctx({ learnerId: '' }), revision()).code, 'INVALID_CONTEXT');
});

// ---------------- Vertical limit: each assistant retrieves only its own vertical ----------------

test('vertical: a course in the assistant\'s own vertical is allowed', () => {
  assert.deepEqual(guardCourseRequest(ctx(), { courseId: 'course-1', verticalId: VERTICAL }), { allowed: true });
});

test('vertical: a course in another vertical is refused and names that vertical', () => {
  const d = guardCourseRequest(ctx(), { courseId: 'course-7', verticalId: OTHER_VERTICAL });
  assert.equal(d.allowed, false);
  assert.equal(d.code, 'OUT_OF_VERTICAL');
  assert.equal(d.redirectVerticalId, OTHER_VERTICAL);
});

test('vertical: a published revision pinned only by another vertical is refused', () => {
  const r = revision({ courses: [{ courseId: 'course-7', verticalId: OTHER_VERTICAL }] });
  const c = ctx({ enrolments: [{ courseId: 'course-7', companyId: CO, status: 'ACTIVE' }] });
  const d = canRetrieve(c, r);
  assert.equal(d.code, 'OUT_OF_VERTICAL');
  assert.equal(d.redirectVerticalId, OTHER_VERTICAL);
});

test('vertical: an out-of-vertical request reaches the learner as a friendly redirect that names the other vertical', () => {
  const r = revision({ courses: [{ courseId: 'course-7', verticalId: OTHER_VERTICAL }] });
  const reply = prepareRetrieval(ctx({ enrolments: [{ courseId: 'course-7', companyId: CO, status: 'ACTIVE' }] }), r, [cleanPassage]);
  assert.equal(reply.kind, 'redirect');
  assert.equal(reply.code, 'OUT_OF_VERTICAL');
  assert.equal(reply.redirectVerticalId, OTHER_VERTICAL);
  assert.ok(reply.message.includes(OTHER_VERTICAL));
});

test('vertical: a revision pinned in both verticals is allowed when an active enrolment is in the assistant\'s vertical', () => {
  const r = revision({ courses: [{ courseId: 'course-7', verticalId: OTHER_VERTICAL }, { courseId: 'course-1', verticalId: VERTICAL }] });
  assert.equal(canRetrieve(ctx(), r).allowed, true);
});

test('vertical: an ACTIVE enrolment in a course of another vertical does not unlock this vertical', () => {
  const r = revision({ courses: [{ courseId: 'course-1', verticalId: VERTICAL }, { courseId: 'course-7', verticalId: OTHER_VERTICAL }] });
  const c = ctx({ enrolments: [{ courseId: 'course-7', companyId: CO, status: 'ACTIVE' }] });
  assert.equal(canRetrieve(c, r).code, 'NO_ACTIVE_ENROLMENT');
});

test('vertical: a learner context without verticalId is refused', () => {
  const d = canRetrieve(ctx({ verticalId: '' }), revision());
  assert.equal(d.code, 'INVALID_CONTEXT');
});

// ---------------- Rule 3: answer keys and scoring data never returned ----------------

test('rule 3: answer keys stay out of replies after the learner has finished the assessment (submitted)', () => {
  const finished = ctx({ openAssessments: [openCheck({ status: 'submitted' })] });
  const reply = prepareRetrieval(finished, revision(), [cleanPassage]);
  assert.equal(reply.kind, 'answer');
  const json = JSON.stringify(reply) + JSON.stringify(stripAssessmentData(body()));
  assert.equal(json.includes(SECRET_OPTION), false);
  assert.equal(json.includes(SECRET_EXPLANATION), false);
  assert.equal(json.includes('correctIndex'), false);
});

test('rule 3: answer keys stay out of replies after sign-off', () => {
  const signedOff = ctx({ openAssessments: [openCheck({ kind: 'practical', status: 'signed_off' })] });
  const reply = prepareRetrieval(signedOff, revision(), [cleanPassage]);
  assert.equal(reply.kind, 'answer');
  assert.equal(JSON.stringify(reply).includes(SECRET_OPTION), false);
  assert.equal(JSON.stringify(reply).includes(SECRET_EXPLANATION), false);
});

test('rule 3: a learner who has no open assessment still never receives the answer key', () => {
  const reply = prepareRetrieval(ctx(), revision(), [cleanPassage]);
  assert.equal(JSON.stringify(reply).includes(SECRET_OPTION), false);
});

test('rule 3: stripAssessmentData removes knowledge checks, answer keys, scores and rubrics at every depth', () => {
  const out = stripAssessmentData(body());
  const json = JSON.stringify(out);
  for (const banned of ['knowledgeChecks', 'correctIndex', 'explanation', 'assessmentRubric', '"score"', 'isCorrect']) {
    assert.equal(json.includes(banned), false, `stripped body still contains ${banned}`);
  }
  assert.deepEqual(out.summary, ['Mix the product at the label rate before use.']);
});

test('rule 3: stripAssessmentData removes nested answer keys', () => {
  const out = stripAssessmentData({ sections: [{ heading: 'x', items: [{ text: 'y', correctAnswer: 'z', rationale: 'r' }] }] });
  assert.deepEqual(out, { sections: [{ heading: 'x', items: [{ text: 'y' }] }] });
});

test('rule 3: answerMaterial finds the correct option text and explanation', () => {
  const material = answerMaterial(body());
  assert.ok(material.includes(SECRET_OPTION));
  assert.ok(material.includes(SECRET_EXPLANATION));
});

test('rule 3: screenPassageText refuses answer-key wording', () => {
  assert.equal(screenPassageText('The correct answer is listed on page 3.', []).allowed, false);
});

test('rule 3: screenPassageText refuses text that equals the correct answer', () => {
  assert.equal(screenPassageText(`Use ${SECRET_OPTION} for this product.`, [SECRET_OPTION]).allowed, false);
});

test('rule 3: screenPassageText allows ordinary lesson prose', () => {
  assert.equal(screenPassageText('Mix the product at the label rate before use.', [SECRET_OPTION]).allowed, true);
});

test('rule 3 leak test: no output of a reply contains the answer key', () => {
  const candidates = [
    cleanPassage,
    { revisionId: 'rev-1', lessonId: 'les-1', snapshotId: 'snap-1', text: `Use ${SECRET_OPTION} before spraying.` },
    { revisionId: 'rev-1', lessonId: 'les-1', snapshotId: 'snap-1', text: 'The correct answer is printed below.' },
  ];
  const reply = prepareRetrieval(ctx(), revision(), candidates);
  const outputs = [
    JSON.stringify(reply),
    JSON.stringify(stripAssessmentData(body())),
    JSON.stringify(buildCitations(candidates.map((c) => ({ ...c, contentHash: HASH })))),
  ].join('\n');
  for (const secret of [SECRET_OPTION, SECRET_EXPLANATION, 'correctIndex', 'knowledgeChecks', 'assessmentRubric', 'correct answer']) {
    assert.equal(outputs.includes(secret), false, `output leaked: ${secret}`);
  }
  assert.equal(reply.kind, 'answer');
  assert.equal(reply.passages.length, 1, 'only the clean passage survives');
});

// ---------------- Rule 4: no answers to live knowledge-check questions ----------------

const checkCtx = () => ctx({ openAssessments: [openCheck()] });

test('rule 4: a question that quotes the live check question is refused', () => {
  const d = guardAssessmentQuestion(checkCtx(), revision(), 'How do you dilute the concentrate?');
  assert.equal(d.code, 'LIVE_KNOWLEDGE_CHECK');
});

test('rule 4: a question that quotes a live check option is refused', () => {
  const d = guardAssessmentQuestion(checkCtx(), revision(), `Is it ${SECRET_OPTION}?`);
  assert.equal(d.code, 'LIVE_KNOWLEDGE_CHECK');
});

test('rule 4: a question that asks which option is correct is refused', () => {
  assert.equal(guardAssessmentQuestion(checkCtx(), revision(), 'Which option is correct for question 2?').code, 'LIVE_KNOWLEDGE_CHECK');
});

test('rule 4: a general lesson question during a live check gets general guidance', () => {
  assert.equal(guardAssessmentQuestion(checkCtx(), revision(), 'What is the label rate for mixing the product?').allowed, true);
});

test('rule 4: the same question is allowed once no check is open', () => {
  assert.equal(guardAssessmentQuestion(ctx(), revision(), 'How do you dilute the concentrate?').allowed, true);
});

test('rule 4: a submitted check does not block questions', () => {
  const c = ctx({ openAssessments: [openCheck({ status: 'submitted' })] });
  assert.equal(guardAssessmentQuestion(c, revision(), 'How do you dilute the concentrate?').allowed, true);
});

test('rule 4: another learner\'s live check does not block this learner', () => {
  const c = ctx({ openAssessments: [openCheck({ learnerId: OTHER_LEARNER })] });
  assert.equal(guardAssessmentQuestion(c, revision(), 'How do you dilute the concentrate?').allowed, true);
});

test('rule 4: a live check refusal reaches the learner as a redirect', () => {
  const reply = prepareRetrieval(checkCtx(), revision(), [cleanPassage], 'How do you dilute the concentrate?');
  assert.equal(reply.kind, 'redirect');
  assert.equal(reply.code, 'LIVE_KNOWLEDGE_CHECK');
});

// ---------------- Rule 5: approved organisation values only ----------------

const field = (over = {}) => ({ companyId: CO, fieldKey: 'equipment.primary_tool', value: 'Pressure washer', status: 'APPROVED', ...over });

test('rule 5: an APPROVED value for the company is selected', () => {
  const r = selectApprovedFieldValues(CO, [field()]);
  assert.deepEqual(r.values, { 'equipment.primary_tool': 'Pressure washer' });
});

for (const status of ['DRAFT', 'RETIRED']) {
  test(`rule 5: a ${status} value is never used`, () => {
    const r = selectApprovedFieldValues(CO, [field({ status })]);
    assert.deepEqual(r.values, {});
  });
}

test('rule 5: an approved value for another company is never used', () => {
  assert.deepEqual(selectApprovedFieldValues(CO, [field({ companyId: OTHER_CO })]).values, {});
});

test('rule 5: a key outside the approved registry is never used', () => {
  assert.deepEqual(selectApprovedFieldValues(CO, [field({ fieldKey: 'secret.api_key' })]).values, {});
});

test('rule 5: two approved rows for one key are excluded as ambiguous', () => {
  const r = selectApprovedFieldValues(CO, [field({ value: 'A' }), field({ value: 'B' })]);
  assert.deepEqual(r.values, {});
  assert.deepEqual(r.excludedKeys, ['equipment.primary_tool']);
});

test('rule 5: a non-displayable value type is excluded', () => {
  assert.deepEqual(selectApprovedFieldValues(CO, [field({ value: { raw: true } })]).values, {});
});

// ---------------- Rule 6: citations to revision and snapshot ----------------

test('rule 6: buildCitations returns revision, snapshot and content hash per passage', () => {
  const r = buildCitations([{ revisionId: 'rev-1', snapshotId: 'snap-1', contentHash: HASH, text: 't' }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, [{ revisionId: 'rev-1', snapshotId: 'snap-1', contentHash: HASH }]);
});

test('rule 6: buildCitations de-duplicates repeated revision and snapshot pairs', () => {
  const p = { revisionId: 'rev-1', snapshotId: 'snap-1', contentHash: HASH, text: 't' };
  assert.equal(buildCitations([p, p]).value.length, 1);
});

test('rule 6: a passage with no snapshot id is refused', () => {
  const r = buildCitations([{ revisionId: 'rev-1', snapshotId: '', contentHash: HASH, text: 't' }]);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CITATION_MISSING');
});

test('rule 6: a passage with a malformed content hash is refused', () => {
  assert.equal(buildCitations([{ revisionId: 'rev-1', snapshotId: 's', contentHash: 'xyz', text: 't' }]).ok, false);
});

test('rule 6: an answer carries citations naming the revision and snapshot it used', () => {
  const reply = prepareRetrieval(ctx(), revision(), [cleanPassage]);
  assert.equal(reply.kind, 'answer');
  assert.deepEqual(reply.citations, [{ revisionId: 'rev-1', snapshotId: 'snap-1', contentHash: HASH }]);
});

test('rule 6: a passage without a snapshot id yields a redirect, not an uncited answer', () => {
  const reply = prepareRetrieval(ctx(), revision(), [{ ...cleanPassage, snapshotId: '' }]);
  assert.equal(reply.kind, 'redirect');
  assert.equal(reply.code, 'CITATION_MISSING');
});

// ---------------- Rule 7: passage limits ----------------

test('rule 7: at most MAX_PASSAGES passages are kept', () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ revisionId: 'rev-1', snapshotId: 's', text: `Passage ${i}` }));
  const r = limitPassages(many);
  assert.equal(r.passages.length, 5);
  assert.equal(r.limited, true);
});

test('rule 7: a passage over MAX_PASSAGE_CHARS is cut at a word boundary and marked truncated', () => {
  const long = 'word '.repeat(400).trim();
  const r = limitPassages([{ revisionId: 'rev-1', snapshotId: 's', text: long }]);
  assert.equal(r.passages[0].truncated, true);
  assert.ok(r.passages[0].text.length <= 1200);
  assert.equal(r.passages[0].text.endsWith('word'), true);
});

test('rule 7: a short passage is kept whole', () => {
  const r = limitPassages([cleanPassage]);
  assert.equal(r.passages[0].truncated, false);
  assert.equal(r.passages[0].text, cleanPassage.text);
  assert.equal(r.limited, false);
});

// ---------------- Progressive tiers ----------------

const progressOf = (over = {}) => ({ companyId: CO, learnerId: LEARNER, enrolments: [{ courseId: 'course-1', companyId: CO, status: 'ACTIVE' }], checkedLessonIds: [], bestScores: {}, ...over });
const scope = { group: 'cleaning', tiers: TIERS_FIXTURE() };
function TIERS_FIXTURE() {
  return {
    base: ['les-1', 'base-2'],
    groupLessons: { cleaning: ['grp-1', 'grp-2'], pool: ['pool-1'] },
    courseLessons: { 'course-1': ['c1-1'], 'course-7': ['c7-1'] },
    courseGroup: { 'course-1': 'cleaning', 'course-7': 'pool' },
    courseFields: { 'course-1': ['equipment.primary_tool', 'safety.required_ppe'], 'course-7': ['pricing.minimum_charge'] },
  };
}
const baseOnlyPassed = { checkedLessonIds: ['les-1', 'base-2'], bestScores: { 'les-1': 85, 'base-2': 95 } };
const allPassed = { checkedLessonIds: ['les-1', 'base-2', 'grp-1', 'grp-2'], bestScores: { 'les-1': 85, 'base-2': 95, 'grp-1': 80, 'grp-2': 100 } };

test('tiers: tier 0 base lessons are available to every enrolled learner, with no checks passed', () => {
  const ids = unlockedLessonIds(progressOf(), scope);
  assert.deepEqual(ids, ['base-2', 'les-1']);
});

test('tiers: tier 0 is available to a learner enrolled in a course from another group', () => {
  const ids = unlockedLessonIds(progressOf({ enrolments: [{ courseId: 'course-7', companyId: CO, status: 'ACTIVE' }] }), scope);
  assert.ok(ids.includes('les-1'));
  assert.ok(ids.includes('base-2'));
});

test('tiers: no ACTIVE enrolment unlocks nothing', () => {
  assert.deepEqual(unlockedLessonIds(progressOf({ enrolments: [{ courseId: 'course-1', companyId: CO, status: 'COMPLETED' }] }), scope), []);
});

test('tiers: tier 1 stays locked until the base tier is passed', () => {
  const ids = unlockedLessonIds(progressOf({ checkedLessonIds: ['les-1', 'base-2'], bestScores: { 'les-1': 85, 'base-2': 79 } }), scope);
  assert.equal(ids.includes('grp-1'), false);
  assert.equal(ids.includes('grp-2'), false);
});

test('tiers: tier 1 unlocks once every base check is at or above 80%', () => {
  const ids = unlockedLessonIds(progressOf(baseOnlyPassed), scope);
  assert.ok(ids.includes('grp-1'));
  assert.ok(ids.includes('grp-2'));
});

test('tiers: a 79% base result keeps tier 1 locked even when the other base check is 100%', () => {
  const p = progressOf({ checkedLessonIds: ['les-1', 'base-2'], bestScores: { 'les-1': 79, 'base-2': 100 } });
  assert.equal(tierPassed(['les-1', 'base-2'], p), false);
  assert.equal(unlockedLessonIds(p, scope).includes('grp-1'), false);
});

test('tiers: a base check with no recorded score counts as not passed', () => {
  const p = progressOf({ checkedLessonIds: ['les-1', 'base-2'], bestScores: { 'les-1': 90 } });
  assert.equal(unlockedLessonIds(p, scope).includes('grp-1'), false);
});

test('tiers: a base tier with no knowledge checks cannot be passed (fail closed)', () => {
  assert.equal(tierPassed(['base-x'], progressOf({ checkedLessonIds: [], bestScores: {} })), false);
});

test('tiers: tier 2 stays locked until the group tier is passed', () => {
  const p = progressOf({ checkedLessonIds: ['les-1', 'base-2', 'grp-1', 'grp-2'], bestScores: { 'les-1': 90, 'base-2': 90, 'grp-1': 90, 'grp-2': 79 } });
  assert.equal(unlockedLessonIds(p, scope).includes('c1-1'), false);
});

test('tiers: a 79% group result keeps tier 2 locked', () => {
  const p = progressOf({ checkedLessonIds: ['les-1', 'base-2', 'grp-1', 'grp-2'], bestScores: { 'les-1': 90, 'base-2': 90, 'grp-1': 79, 'grp-2': 100 } });
  assert.equal(unlockedLessonIds(p, scope).includes('c1-1'), false);
});

test('tiers: tier 2 unlocks once the group tier is passed', () => {
  assert.ok(unlockedLessonIds(progressOf(allPassed), scope).includes('c1-1'));
});

test('tiers: a role never reads another group\'s tier 1 or tier 2, even when everything is passed', () => {
  const ids = unlockedLessonIds(progressOf({ ...allPassed, enrolments: [{ courseId: 'course-1', companyId: CO, status: 'ACTIVE' }, { courseId: 'course-7', companyId: CO, status: 'ACTIVE' }] }), scope);
  assert.equal(ids.includes('pool-1'), false);
  assert.equal(ids.includes('c7-1'), false);
});

test('tiers: tier 1 needs an ACTIVE enrolment in a course of the role\'s group', () => {
  const ids = unlockedLessonIds(progressOf({ ...baseOnlyPassed, enrolments: [{ courseId: 'course-7', companyId: CO, status: 'ACTIVE' }] }), scope);
  assert.equal(ids.includes('grp-1'), false);
});

test('tiers: a locked lesson revision is refused with a next-step message that does not name the locked lesson', () => {
  const reply = prepareRetrieval(progressOf({ ...ctx(), checkedLessonIds: ['les-1', 'base-2'], bestScores: { 'les-1': 79, 'base-2': 90 } }), revision({ lessonId: 'grp-1' }), []);
  assert.equal(reply.kind, 'redirect');
  assert.equal(reply.code, 'LESSON_LOCKED');
  assert.ok(reply.message.includes('base knowledge checks'));
  assert.equal(reply.message.includes('grp-1'), false);
});

test('tiers: nextTierStep names only the tier to pass', () => {
  assert.match(nextTierStep(progressOf(), scope), /base knowledge checks \(80% or more\)/);
  assert.match(nextTierStep(progressOf(baseOnlyPassed), scope), /service group knowledge checks/);
  assert.equal(nextTierStep(progressOf(allPassed), scope), '');
});

test('tiers: a locked lesson never appears in citations, even when a passage matches the query', () => {
  const locked = [
    { revisionId: 'rev-grp', lessonId: 'grp-1', snapshotId: 'snap-9', text: 'Group one procedure matches the question.' },
    { revisionId: 'rev-1', lessonId: 'grp-1', snapshotId: 'snap-9', text: 'Mislabelled passage from a locked lesson.' },
  ];
  // Base not passed (79%): vertical lessons such as grp-1 stay locked; base lessons remain available.
  const baseOnly = ctx({ checkedLessonIds: ['les-1', 'base-2'], bestScores: { 'les-1': 90, 'base-2': 79 } });
  const reply = prepareRetrieval(baseOnly, revision(), [cleanPassage, ...locked]);
  assert.equal(reply.kind, 'answer');
  assert.deepEqual(reply.citations.map((c) => c.revisionId), ['rev-1']);
  assert.equal(reply.passages.every((p) => p.lessonId === 'les-1'), true);
  assert.equal(JSON.stringify(reply).includes('Group one procedure'), false);
  assert.equal(JSON.stringify(reply).includes('Mislabelled'), false);
});

test('tiers: a passage with no lesson id is dropped, not cited', () => {
  const reply = prepareRetrieval(ctx(), revision(), [{ revisionId: 'rev-1', snapshotId: 'snap-1', text: 'No lesson id.' }]);
  assert.equal(reply.kind, 'answer');
  assert.equal(reply.passages.length, 0);
  assert.equal(reply.citations.length, 0);
});

test('tiers: the assessment-page block still holds when the lesson is unlocked', () => {
  const reply = prepareRetrieval(ctx({ clientPage: { kind: 'assessment' }, openAssessments: [openCheck()] }), revision(), [cleanPassage]);
  assert.equal(reply.kind, 'redirect');
  assert.equal(reply.code, 'PAGE_IN_ASSESSMENT');
});

test('tiers: tierPassed requires every checked lesson in the tier at or above 80', () => {
  assert.equal(tierPassed(['a', 'b'], { ...progressOf(), checkedLessonIds: ['a', 'b'], bestScores: { a: 80, b: 80 } }), true);
  assert.equal(tierPassed(['a', 'b'], { ...progressOf(), checkedLessonIds: ['a', 'b'], bestScores: { a: 80, b: 79.9 } }), false);
});

// ---------------- Tier 2 business values and tier-map checks ----------------

test('tier map: the base count constant is 184, from the owner level file (layer base)', () => {
  assert.equal(BASE_TIER_LESSON_COUNT, 184);
});

test('tier map: a base tier that is not 184 lessons is reported', () => {
  const problems = validateTierMap(TIERS_FIXTURE());
  assert.ok(problems.some((p) => p.includes('expected 184')));
});

test('tier map: a 184-lesson base tier with no duplicates passes the count check', () => {
  const base = Array.from({ length: 184 }, (_, i) => `shared-${i}`);
  const tiers = { ...TIERS_FIXTURE(), base };
  assert.deepEqual(validateTierMap(tiers).filter((p) => p.includes('base')), []);
});

test('tier map: duplicate base ids are reported', () => {
  const base = Array.from({ length: 184 }, () => 'same');
  assert.ok(validateTierMap({ ...TIERS_FIXTURE(), base }).some((p) => p.includes('duplicate')));
});

test('tier 2 business: keys stay locked until the vertical tier is passed', () => {
  assert.deepEqual(unlockedBusinessFieldKeys(progressOf(baseOnlyPassed), scope), []);
});

test('tier 2 business: keys unlock after the vertical tier, only for the learner\'s courses in that group', () => {
  const keys = unlockedBusinessFieldKeys(progressOf(allPassed), scope);
  assert.deepEqual(keys, ['equipment.primary_tool', 'safety.required_ppe']);
  assert.equal(keys.includes('pricing.minimum_charge'), false);
});

test('tier 2 business: a 79% vertical result keeps the business keys locked', () => {
  const p = progressOf({ checkedLessonIds: ['les-1', 'base-2', 'grp-1', 'grp-2'], bestScores: { 'les-1': 90, 'base-2': 90, 'grp-1': 79, 'grp-2': 100 } });
  assert.deepEqual(unlockedBusinessFieldKeys(p, scope), []);
});

test('tier 2 business: values are company-scoped, approved-only, and limited to unlocked keys', () => {
  const values = [
    { companyId: CO, fieldKey: 'equipment.primary_tool', value: 'Pressure washer', status: 'APPROVED' },
    { companyId: CO, fieldKey: 'safety.required_ppe', value: 'Gloves', status: 'DRAFT' },
    { companyId: OTHER_CO, fieldKey: 'safety.required_ppe', value: 'Goggles', status: 'APPROVED' },
    { companyId: CO, fieldKey: 'pricing.minimum_charge', value: 80, status: 'APPROVED' },
  ];
  assert.deepEqual(approvedBusinessValues(progressOf(allPassed), scope, values), { 'equipment.primary_tool': 'Pressure washer' });
});

test('tier 2 business: approved values stay hidden before the vertical tier is passed', () => {
  const values = [{ companyId: CO, fieldKey: 'equipment.primary_tool', value: 'Pressure washer', status: 'APPROVED' }];
  assert.deepEqual(approvedBusinessValues(progressOf(baseOnlyPassed), scope, values), {});
});

// ---------------- Real tier map from the course-role generator ----------------

test('real tier map: TIER_MAP has 184 base lessons and passes validateTierMap', () => {
  assert.equal(TIER_MAP.base.length, 184);
  assert.deepEqual(validateTierMap(TIER_MAP), []);
});

test('real tier map: a learner with no passes gets base lessons only, in a Cleaning & Hygiene course', () => {
  const group = 'Cleaning & Hygiene';
  const progress = progressOf({ enrolments: [{ courseId: 'residential', companyId: CO, status: 'ACTIVE' }] });
  assert.deepEqual(unlockedLessonIds(progress, { group, tiers: TIER_MAP }), [...TIER_MAP.base].sort());
});

test('real tier map: passing the base unlocks this group\'s lessons and no other group\'s', () => {
  const group = 'Cleaning & Hygiene';
  const checkedBase = TIER_MAP.base.filter((l) => (LESSON_CHECK_IDS[l] ?? []).length > 0);
  assert.ok(checkedBase.length > 0, 'base tier must have knowledge checks');
  const checkScores = Object.fromEntries(Object.values(LESSON_CHECK_IDS).flat().map((id) => [id, 90]));
  const progress = progressOf({
    enrolments: [{ courseId: 'residential', companyId: CO, status: 'ACTIVE' }],
    checkedLessonIds: checkedBase,
    bestScores: lessonScoresFromChecks(checkScores, LESSON_CHECK_IDS),
  });
  const ids = unlockedLessonIds(progress, { group, tiers: TIER_MAP });
  const own = TIER_MAP.groupLessons[group];
  assert.ok(own.length > 0);
  assert.ok(own.every((l) => ids.includes(l)), 'every lesson of the group is unlocked');
  // Some lessons sit in several groups' tiers (23 ids), so only lessons exclusive to the other group are a fair test.
  const other = TIER_MAP.groupLessons['Outdoor & garden'].filter((l) => !own.includes(l));
  assert.ok(other.length > 0, 'the other group has lessons this group does not share');
  assert.equal(other.some((l) => ids.includes(l)), false, 'another group\'s exclusive lessons stay locked');
});

test('unknown group: a role whose group is not in the map unlocks base lessons only', () => {
  const checkScores = Object.fromEntries(Object.values(LESSON_CHECK_IDS).flat().map((id) => [id, 90]));
  const progress = progressOf({ enrolments: [{ courseId: 'pool', companyId: CO, status: 'ACTIVE' }], checkedLessonIds: TIER_MAP.base.filter((l) => (LESSON_CHECK_IDS[l] ?? []).length > 0), bestScores: lessonScoresFromChecks(checkScores, LESSON_CHECK_IDS) });
  assert.deepEqual(unlockedLessonIds(progress, { group: 'Not a group', tiers: TIER_MAP }), [...TIER_MAP.base].sort());
});

test('empty tier: a tier with no lessons is passed (Aquatic, Specialist hygiene, Personal, fitness and pet)', () => {
  assert.equal(tierPassed([], progressOf()), true);
});

test('empty tier: a tier that has lessons but no checks is still locked', () => {
  assert.equal(tierPassed(['lesson-with-no-check'], progressOf({ checkedLessonIds: [], bestScores: {} })), false);
});

test('real tier map: an Aquatic course opens once base and the Aquatic tier pass', () => {
  const group = 'Aquatic';
  const checkedAll = Object.keys(LESSON_CHECK_IDS).filter((l) => (LESSON_CHECK_IDS[l] ?? []).length > 0);
  const checkScores = Object.fromEntries(Object.values(LESSON_CHECK_IDS).flat().map((id) => [id, 90]));
  const progress = progressOf({
    enrolments: [{ courseId: 'pool', companyId: CO, status: 'ACTIVE' }],
    checkedLessonIds: checkedAll,
    bestScores: lessonScoresFromChecks(checkScores, LESSON_CHECK_IDS),
  });
  const ids = unlockedLessonIds(progress, { group, tiers: TIER_MAP });
  assert.ok(TIER_MAP.courseLessons.pool.length > 0);
  assert.ok(TIER_MAP.courseLessons.pool.every((l) => ids.includes(l)));
});

test('lesson scores: a lesson passes only when every one of its checks is at or above 80', () => {
  const lessonCheckIds = { 'L-1': ['c-a', 'c-b'], 'L-2': ['c-c'], 'L-3': [] };
  const scores = lessonScoresFromChecks({ 'c-a': 90, 'c-b': 79, 'c-c': 100 }, lessonCheckIds);
  assert.equal(scores['L-1'], 79);
  assert.equal(scores['L-2'], 100);
  assert.equal(scores['L-3'], undefined);
});

test('lesson scores: a missing check score leaves the lesson unscored', () => {
  assert.equal(lessonScoresFromChecks({ 'c-a': 90 }, { 'L-1': ['c-a', 'c-b'] })['L-1'], undefined);
});

// ---------------- Wiring to the real map and parity with progression.ts ----------------

const real = await import('../../server/workforce/courses/knowledge/real-tiers.ts');
const progression = await import('../../server/workforce/courses/progression.ts');

test('wiring: the real map is valid (validateTierMap returns no problems)', () => {
  assert.deepEqual(real.REAL_TIER_PROBLEMS, []);
});

const CHECKED = Object.keys(LESSON_CHECK_IDS).filter((l) => (LESSON_CHECK_IDS[l] ?? []).length > 0);
const checkScoresFor = (lessons, score) => Object.fromEntries(lessons.flatMap((l) => (LESSON_CHECK_IDS[l] ?? []).map((id) => [id, score])));
const coursesOf = (group) => Object.keys(TIER_MAP.courseGroup).filter((c) => TIER_MAP.courseGroup[c] === group);

/** Scores for base and group: 'pass' is 90 on every check; 'fail' is 79 on the first checked lesson, 90 elsewhere. */
function scoresFor(lessons, mode) {
  const checked = lessons.filter((l) => (LESSON_CHECK_IDS[l] ?? []).length > 0);
  if (mode === 'pass') return checkScoresFor(checked, 90);
  const first = checked[0];
  return { ...checkScoresFor(checked, 90), ...(first ? checkScoresFor([first], 79) : {}) };
}

test('parity: with base passed and a course in the group enrolled, progression and the policy give the same lessons', () => {
  let compared = 0;
  for (const group of Object.keys(TIER_MAP.groupLessons)) {
    const enrolled = coursesOf(group)[0];
    if (!enrolled) continue;
    for (const groupMode of ['pass', 'fail']) {
      const checkScores = { ...scoresFor(TIER_MAP.base, 'pass'), ...scoresFor(TIER_MAP.groupLessons[group], groupMode) };
      const prog = progression.unlockedTiers(TIER_MAP, LESSON_CHECK_IDS, group, {
        companyId: CO, enrolledCourseSlugs: [enrolled], checkScores, businessValues: [],
      });
      const mine = real.realUnlockedLessonIds(progressOf({
        enrolments: [{ courseId: enrolled, companyId: CO, status: 'ACTIVE' }],
        checkedLessonIds: CHECKED,
        bestScores: lessonScoresFromChecks(checkScores, LESSON_CHECK_IDS),
      }), group);
      assert.deepEqual(mine, prog.lessonIds, `group ${group}, vertical ${groupMode}`);
      compared += 1;
    }
  }
  assert.ok(compared >= 10, `compared ${compared} scenarios`);
});

test('parity: base failed, both keep base lessons open (progression fixed at L108-110)', () => {
  const group = 'Cleaning & Hygiene';
  const enrolled = coursesOf(group)[0];
  const checkScores = scoresFor(TIER_MAP.base, 'fail');
  const prog = progression.unlockedTiers(TIER_MAP, LESSON_CHECK_IDS, group, {
    companyId: CO, enrolledCourseSlugs: [enrolled], checkScores, businessValues: [],
  });
  const mine = real.realUnlockedLessonIds(progressOf({
    enrolments: [{ courseId: enrolled, companyId: CO, status: 'ACTIVE' }],
    checkedLessonIds: CHECKED,
    bestScores: lessonScoresFromChecks(checkScores, LESSON_CHECK_IDS),
  }), group);
  for (const l of TIER_MAP.base) {
    assert.ok(prog.lessonIds.includes(l), `progression keeps base lesson ${l}`);
    assert.ok(mine.includes(l), `policy keeps base lesson ${l}`);
  }
});

test('parity difference: group not enrolled. progression opens group lessons, the policy does not', () => {
  const group = 'Cleaning & Hygiene';
  const checkScores = { ...scoresFor(TIER_MAP.base, 'pass') };
  const prog = progression.unlockedTiers(TIER_MAP, LESSON_CHECK_IDS, group, {
    companyId: CO, enrolledCourseSlugs: ['pool'], checkScores, businessValues: [],
  });
  const mine = real.realUnlockedLessonIds(progressOf({
    enrolments: [{ courseId: 'pool', companyId: CO, status: 'ACTIVE' }],
    checkedLessonIds: CHECKED,
    bestScores: lessonScoresFromChecks(checkScores, LESSON_CHECK_IDS),
  }), group);
  assert.ok(prog.lessonIds.includes(TIER_MAP.groupLessons[group][0]));
  assert.equal(mine.includes(TIER_MAP.groupLessons[group][0]), false);
});

test('parity difference: enrolment without a company match. progression counts it, the policy does not', () => {
  const group = 'Cleaning & Hygiene';
  const checkScores = scoresFor(TIER_MAP.base, 'pass');
  const enrolled = coursesOf(group)[0];
  const mine = real.realUnlockedLessonIds(progressOf({
    enrolments: [{ courseId: enrolled, companyId: OTHER_CO, status: 'ACTIVE' }],
    checkedLessonIds: CHECKED,
    bestScores: lessonScoresFromChecks(checkScores, LESSON_CHECK_IDS),
  }), group);
  assert.deepEqual(mine, [], 'another company\'s enrolment unlocks nothing');
});

test('parity: an unknown group throws in progression and unlocks base only in the policy', () => {
  assert.throws(() => progression.unlockedTiers(TIER_MAP, LESSON_CHECK_IDS, 'Not a group', {
    companyId: CO, enrolledCourseSlugs: ['residential'], checkScores: {}, businessValues: [],
  }));
  const mine = real.realUnlockedLessonIds(progressOf({
    enrolments: [{ courseId: 'residential', companyId: CO, status: 'ACTIVE' }],
  }), 'Not a group');
  assert.deepEqual(mine, [...TIER_MAP.base].sort());
});

test('parity: every group with no lessons opens its course tier after base, in both', () => {
  const emptyGroups = Object.keys(TIER_MAP.groupLessons).filter((g) => TIER_MAP.groupLessons[g].length === 0);
  assert.ok(emptyGroups.length > 0, 'the real map has at least one group with no lessons');
  for (const group of emptyGroups) {
    const enrolled = coursesOf(group)[0];
    const checkScores = scoresFor(TIER_MAP.base, 'pass');
    const prog = progression.unlockedTiers(TIER_MAP, LESSON_CHECK_IDS, group, {
      companyId: CO, enrolledCourseSlugs: [enrolled], checkScores, businessValues: [],
    });
    const mine = real.realUnlockedLessonIds(progressOf({
      enrolments: [{ courseId: enrolled, companyId: CO, status: 'ACTIVE' }],
      checkedLessonIds: CHECKED,
      bestScores: lessonScoresFromChecks(checkScores, LESSON_CHECK_IDS),
    }), group);
    assert.equal(prog.vertical, true, group);
    assert.deepEqual(mine, prog.lessonIds, group);
    for (const l of TIER_MAP.courseLessons[enrolled] ?? []) assert.ok(mine.includes(l), `${group}: course lesson ${l}`);
  }
});

test('progression tier names: progression reports nextTier base, vertical or null', () => {
  const prog = progression.unlockedTiers(TIER_MAP, LESSON_CHECK_IDS, 'Cleaning & Hygiene', {
    companyId: CO, enrolledCourseSlugs: ['residential'], checkScores: {}, businessValues: [],
  });
  assert.equal(prog.nextTier, 'base');
});

// ---------------- Page guard: server must confirm the assessment ----------------

const assessmentPage = (over = {}) => ctx({ clientPage: { kind: 'assessment' }, ...over });

test('page guard: a client on a non-assessment page is answered normally', () => {
  const d = guardAssessmentPage(ctx({ clientPage: { kind: 'lesson' } }));
  assert.deepEqual(d, { allowed: true, suppressAssessmentContent: false });
});

test('page guard: a server-confirmed in-progress knowledge check refuses the answer', () => {
  const d = guardAssessmentPage(assessmentPage({ openAssessments: [openCheck()] }));
  assert.equal(d.allowed, false);
  assert.equal(d.code, 'PAGE_IN_ASSESSMENT');
  assert.equal(typeof d.redirect, 'string');
});

test('page guard: a server-confirmed in-progress practical assessment refuses the answer', () => {
  const d = guardAssessmentPage(assessmentPage({ openAssessments: [openCheck({ kind: 'practical' })] }));
  assert.equal(d.allowed, false);
});

test('page guard: a client claim of assessment with no server-confirmed assessment answers normally and withholds assessment content', () => {
  const d = guardAssessmentPage(assessmentPage({ openAssessments: [] }));
  assert.deepEqual(d, { allowed: true, suppressAssessmentContent: true });
  const reply = prepareRetrieval(assessmentPage(), revision(), [cleanPassage]);
  assert.equal(reply.kind, 'answer');
  assert.equal(reply.assessmentContentWithheld, true);
  assert.equal(JSON.stringify(reply).includes(SECRET_OPTION), false);
  assert.equal(reply.passages.length, 1);
});

test('page guard: another learner\'s open assessment is not confirmed for this learner', () => {
  const d = guardAssessmentPage(assessmentPage({ openAssessments: [openCheck({ learnerId: OTHER_LEARNER })] }));
  assert.equal(d.allowed, true);
  assert.equal(d.suppressAssessmentContent, true);
});

test('page guard: a submitted assessment is not treated as open', () => {
  const d = guardAssessmentPage(assessmentPage({ openAssessments: [openCheck({ status: 'submitted' })] }));
  assert.equal(d.allowed, true);
});

test('page guard: a refused answer returns a friendly redirect and does not throw', () => {
  let reply;
  assert.doesNotThrow(() => {
    reply = prepareRetrieval(assessmentPage({ openAssessments: [openCheck()] }), revision(), [cleanPassage], 'What is the label rate?');
  });
  assert.equal(reply.kind, 'redirect');
  assert.equal(reply.code, 'PAGE_IN_ASSESSMENT');
  assert.equal(typeof reply.message, 'string');
  assert.ok(reply.message.length > 0);
  assert.equal('passages' in reply, false);
});

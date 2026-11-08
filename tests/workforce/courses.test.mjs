import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// zod is listed in package.json but may be missing from node_modules. When a plain
// import fails, route 'zod' to a copy outside the repo (override with ZOD_FALLBACK_ENTRY).
try {
  await import('zod');
} catch {
  const entry = process.env.ZOD_FALLBACK_ENTRY ?? '/opt/npm-tools/node_modules/zod/index.js';
  register('./zod-fallback.hooks.mjs', import.meta.url, { data: { entry } });
}

const catalogue = await import('../../server/workforce/catalogue/index.ts');
const gen = await import('../../server/workforce/courses/generate.ts');
const tpl = await import('../../server/workforce/courses/course-agent.template.ts');
const prog = await import('../../server/workforce/courses/progression.ts');

const ROOT = gen.resolveCurriculumRoot();
const roles = gen.generateAssistantRoles(ROOT);
const plans = gen.buildGroupPlans(ROOT);
const counts = gen.courseLessonCounts(ROOT);
const roleIds = new Set(roles.map((r) => r.id));
const WRITE_WORDS = /(create|update|delete|send|write|approve|set|publish|book|invoice|submit)/i;

const { TIER_MAP, LESSON_CHECK_IDS, TIER_BUILD } = gen;
const allCourses = Object.keys(TIER_MAP.courseGroup);
const groupNames = Object.keys(gen.SERVICE_GROUPS);
const groupOfRole = (roleId) => plans.find((p) => p.roleId === roleId).groupName;
const checksOf = (ids) => ids.flatMap((id) => LESSON_CHECK_IDS[id] ?? []);
const scoresFor = (ids, score) => Object.fromEntries(checksOf(ids).map((id) => [id, score]));
const progress = (overrides = {}) => ({
  companyId: 'co-a',
  enrolledCourseSlugs: [],
  checkScores: {},
  businessValues: [],
  ...overrides,
});
const groupCourses = (group) => allCourses.filter((c) => TIER_MAP.courseGroup[c] === group);

// ---- roles -----------------------------------------------------------------

test('generates one assistant per LMS service group with members', () => {
  assert.equal(roles.length, Object.keys(gen.SERVICE_GROUPS).length);
  assert.equal(roles.length, 7);
  assert.equal(plans.length, roles.length);
});

test('every course in the level file belongs to exactly one assistant (43 courses)', () => {
  const slugs = counts.map((c) => c.slug);
  assert.equal(slugs.length, 43, 'expected the 43 courses in the level file and COURSES-MODULES.json');
  assert.ok(!slugs.includes('high-risk'), 'high-risk is a layer, not a course');
  const covered = plans.flatMap((p) => p.courses.map((c) => c.slug));
  assert.deepEqual([...covered].sort(), [...slugs].sort());
  assert.equal(new Set(covered).size, covered.length);
});

test('construction has no lesson folder but is a course with lessons and a group', () => {
  const row = counts.find((c) => c.slug === 'construction');
  assert.ok(row, 'construction is missing');
  assert.equal(row.folder, '');
  assert.equal(TIER_MAP.courseGroup.construction, 'Cleaning & Hygiene');
  assert.ok(TIER_MAP.courseLessons.construction.length > 0);
});

test('each role id is assistant-<group slug>', () => {
  const expected = new Set(Object.values(gen.SERVICE_GROUPS).map((g) => `assistant-${g.slug}`));
  assert.deepEqual(new Set(roles.map((r) => r.id)), expected);
  for (const role of roles) assert.match(role.id, /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
});

test('every generated role passes validateRoleDefinition', () => {
  for (const role of roles) {
    const result = catalogue.validateRoleDefinition(role);
    assert.equal(result.ok, true, `${role.id}: ${JSON.stringify(result.ok ? null : result.errors)}`);
  }
});

test('the whole set passes validateCatalogue (ids unique, handoffs resolve)', () => {
  const result = catalogue.validateCatalogue(roles);
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.errors));
});

test('autonomy is suggest and sourceRef is new', () => {
  for (const role of roles) {
    assert.equal(role.autonomy, 'suggest', role.id);
    assert.equal(role.sourceRef, 'new', role.id);
  }
});

test('no role has a write tool; the only tool is the knowledge retrieval tool at low risk', () => {
  for (const role of roles) {
    assert.deepEqual(role.tools, [tpl.COURSE_KNOWLEDGE_TOOL_ID], role.id);
    assert.deepEqual(role.toolRisk, { [tpl.COURSE_KNOWLEDGE_TOOL_ID]: 'low' }, role.id);
    assert.doesNotMatch(tpl.COURSE_KNOWLEDGE_TOOL_ID, WRITE_WORDS);
  }
});

test('every guardrail list contains the answer-key, assessment, tier and vertical rules', () => {
  for (const role of roles) {
    const text = role.guardrails.join('\n');
    assert.match(text, /answer keys?/i, `${role.id} lacks answer-key rule`);
    assert.match(text, /assessment answers/i, `${role.id} lacks assessment-answer rule`);
    assert.match(text, /after the learner has finished the assessment/i, `${role.id} lacks post-assessment rule`);
    assert.match(text, /scored knowledge-check question during an assessment/i, role.id);
    assert.match(text, /assessment page/i, `${role.id} lacks assessment-page rule`);
    assert.match(text, /never describe locked content/i, `${role.id} lacks locked-content rule`);
    assert.match(text, /other verticals/i, `${role.id} lacks vertical-limit rule`);
  }
});

test('the system prompt states the three tiers and the locked-content rule', () => {
  for (const role of roles) {
    assert.match(role.systemPrompt, /Tier 0 \(base\)/, role.id);
    assert.match(role.systemPrompt, /Tier 1 \(vertical\)/, role.id);
    assert.match(role.systemPrompt, /Tier 2 \(course and business\)/, role.id);
    assert.match(role.systemPrompt, /80 percent or more/, role.id);
    assert.match(role.systemPrompt, /cannot describe locked content/, role.id);
  }
});

test('the prompt names only the role group courses', () => {
  for (const role of roles) {
    const plan = plans.find((p) => p.roleId === role.id);
    for (const course of plan.courses) assert.ok(role.systemPrompt.includes(`(${course.slug})`), `${role.id} misses ${course.slug}`);
    const named = counts.map((c) => c.slug).filter((slug) => role.systemPrompt.includes(`(${slug})`));
    assert.deepEqual(named.sort(), plan.courses.map((c) => c.slug).sort(), `${role.id} names courses outside its group`);
  }
});

test('no role contains a literal price, phone number or email', () => {
  for (const role of roles) {
    const json = JSON.stringify(role);
    assert.doesNotMatch(json, /\$\s?\d/, `${role.id} has a dollar amount`);
    assert.doesNotMatch(json, /\b(AUD|USD|NZD|GBP|EUR)\s?\d/i, `${role.id} has a currency amount`);
    assert.doesNotMatch(json, /\b\d+(\.\d{1,2})?\s?(dollars|cents)\b/i, `${role.id} has a price word`);
    assert.doesNotMatch(json, /@/, `${role.id} has an @ sign`);
    const labels = catalogue.findLiteralValues(json);
    assert.deepEqual(labels, [], `${role.id} has literal ${labels.join(', ')}`);
  }
});

test('handoffs never name the removed personal assistant and only target vertical assistants', () => {
  for (const role of roles) {
    assert.ok(!role.handoffTo.includes('zero-personal-assistant'), role.id);
    for (const target of role.handoffTo) {
      assert.ok(target.startsWith('assistant-'), `${role.id} -> ${target}`);
      assert.ok(roleIds.has(target), `${role.id} -> ${target} is not a generated role`);
      assert.notEqual(target, role.id);
    }
  }
});

test('handoffs follow the LMS: a lesson shared by two groups links them', () => {
  const byId = Object.fromEntries(roles.map((r) => [r.id, r]));
  assert.ok(byId['assistant-property-and-trades'].handoffTo.includes('assistant-outdoor-and-garden'));
  assert.ok(byId['assistant-outdoor-and-garden'].handoffTo.includes('assistant-property-and-trades'));
  assert.ok(byId['assistant-property-and-trades'].handoffTo.includes('assistant-cleaning-and-hygiene'));
});

test('every role has a persona name, description and kpis within schema bounds', () => {
  for (const role of roles) {
    assert.match(role.name, /^Learner Assistant: /);
    assert.ok(role.description.length >= 20 && role.description.length <= 400, role.id);
    assert.ok(role.kpis.length >= 1, role.id);
    assert.ok(role.systemPrompt.includes('{{company_name}}') && role.systemPrompt.includes('{{vertical}}'), role.id);
  }
});

// ---- tier map --------------------------------------------------------------

test('base tier is the level-file base layer and its size is the single constant', () => {
  assert.equal(TIER_MAP.base.length, prog.EXPECTED_BASE_LESSON_COUNT);
  assert.equal(prog.EXPECTED_BASE_LESSON_COUNT, 184);
  assert.equal(TIER_BUILD.idsPerLayer.base, 184);
});

test('the level file has one layer per lesson id, and every tier lesson has a file', () => {
  assert.equal(TIER_BUILD.layerConflicts.length, 0);
  assert.equal(TIER_BUILD.rowCount, 5472);
  assert.deepEqual(TIER_BUILD.missingFiles, []);
});

test('no lesson sits in two tiers', () => {
  const groupIds = Object.values(TIER_MAP.groupLessons).flat();
  const courseIds = Object.values(TIER_MAP.courseLessons).flat();
  const all = [...TIER_MAP.base, ...new Set(groupIds), ...new Set(courseIds)];
  const overlap = all.filter((id, i) => all.indexOf(id) !== i);
  assert.deepEqual([...new Set(overlap)], [], 'a lesson is in more than one tier');
  for (const id of TIER_MAP.base) {
    assert.ok(!groupIds.includes(id) && !courseIds.includes(id), `${id} is base and another tier`);
  }
});

test('the 23 lessons shared across service groups are in each of those groups tier 1 only', () => {
  assert.equal(TIER_BUILD.multiGroupLessons.length, 23);
  for (const id of TIER_BUILD.multiGroupLessons) {
    const groups = Object.keys(TIER_MAP.groupLessons).filter((g) => TIER_MAP.groupLessons[g].includes(id));
    assert.ok(groups.length > 1, id);
  }
});

test('tier map covers the LMS: 43 courses, 7 groups, no listed lesson without a file', () => {
  assert.equal(allCourses.length, 43);
  assert.deepEqual([...new Set(Object.values(TIER_MAP.courseGroup))].sort(), [...groupNames].sort());
  assert.deepEqual(TIER_BUILD.missingFiles, []);
  for (const id of [...TIER_MAP.base, ...Object.values(TIER_MAP.groupLessons).flat(), ...Object.values(TIER_MAP.courseLessons).flat()]) {
    assert.ok(Array.isArray(LESSON_CHECK_IDS[id]), `${id} has no check list`);
  }
});

test('course business keys are registered "group.field" keys', () => {
  for (const course of allCourses) {
    for (const key of TIER_MAP.courseFields[course]) assert.match(key, /^[a-z_]+\.[a-z_]+$/, `${course} ${key}`);
  }
});

test('tier 0 is shared by all roles: every role unlocks the same base lessons', () => {
  const enrolled = allCourses;
  const full = progress({ enrolledCourseSlugs: enrolled, checkScores: scoresFor(TIER_MAP.base, 100) });
  const baseSets = groupNames.map((g) => {
    const unlock = prog.unlockedTiers(TIER_MAP, LESSON_CHECK_IDS, g, full);
    return TIER_MAP.base.filter((id) => unlock.lessonIds.includes(id));
  });
  for (const set of baseSets) assert.deepEqual(set, [...TIER_MAP.base].sort());
});

test('tier 0 is open to any enrolled learner with no scores yet; tier 1 stays locked until base is passed', () => {
  const group = 'Cleaning & Hygiene';
  const course = groupCourses(group)[0];
  const unlock = prog.unlockedTiers(TIER_MAP, LESSON_CHECK_IDS, group, progress({ enrolledCourseSlugs: [course] }));
  assert.equal(unlock.base, false, 'base needs passing checks, not enrolment alone');
  assert.equal(unlock.vertical, false);
  assert.equal(unlock.nextTier, 'base');
  assert.deepEqual(unlock.courses, []);
  assert.deepEqual(unlock.lessonIds, [...TIER_MAP.base].sort(), 'base lessons are open to every enrolled learner');
});

test('tier 1 unlocks once base is passed, and not before', () => {
  const group = 'Cleaning & Hygiene';
  const course = groupCourses(group)[0];
  const baseOnly = progress({ enrolledCourseSlugs: [course], checkScores: scoresFor(TIER_MAP.base, 85) });
  const before = prog.unlockedTiers(TIER_MAP, LESSON_CHECK_IDS, group, baseOnly);
  assert.equal(before.base, true);
  assert.equal(before.vertical, false, 'tier 1 passes only when its own checks are passed');
  assert.equal(before.nextTier, 'vertical');
  for (const id of TIER_MAP.groupLessons[group]) assert.ok(before.lessonIds.includes(id), `${id} must open after base so its checks can be taken`);
  assert.deepEqual(before.courses, [], 'course tier waits for the vertical tier');

  const both = progress({
    enrolledCourseSlugs: [course],
    checkScores: { ...scoresFor(TIER_MAP.base, 85), ...scoresFor(TIER_MAP.groupLessons[group], 85) },
  });
  const after = prog.unlockedTiers(TIER_MAP, LESSON_CHECK_IDS, group, both);
  assert.equal(after.vertical, true);
  for (const id of TIER_MAP.groupLessons[group]) assert.ok(after.lessonIds.includes(id), id);
  assert.equal(after.nextTier, null);
});

test('a score of 79 keeps base locked: tier 1 and tier 2 stay locked', () => {
  const group = 'Cleaning & Hygiene';
  const course = groupCourses(group)[0];
  const scores = { ...scoresFor(TIER_MAP.base, 100) };
  scores[checksOf(TIER_MAP.base)[0]] = 79;
  const unlock = prog.unlockedTiers(TIER_MAP, LESSON_CHECK_IDS, group, progress({ enrolledCourseSlugs: [course], checkScores: scores }));
  assert.equal(unlock.base, false);
  assert.equal(unlock.vertical, false);
  assert.equal(unlock.nextTier, 'base');
  assert.deepEqual(unlock.courses, []);
  for (const id of TIER_MAP.groupLessons[group]) assert.ok(!unlock.lessonIds.includes(id), id);
});

test('a score of exactly 80 passes the tier', () => {
  const scores = scoresFor(TIER_MAP.base, 80);
  assert.equal(prog.tierPassed(checksOf(TIER_MAP.base), scores), true);
  assert.equal(prog.tierPassed(checksOf(TIER_MAP.base), { ...scores, [checksOf(TIER_MAP.base)[0]]: 79.9 }), false);
});

test('a missing score fails the tier', () => {
  assert.equal(prog.tierPassed(checksOf(TIER_MAP.base), {}), false);
});

test('tier 2 is locked until the vertical tier is passed', () => {
  const group = 'Cleaning & Hygiene';
  const course = groupCourses(group)[0];
  const scores = { ...scoresFor(TIER_MAP.base, 90), ...scoresFor(TIER_MAP.groupLessons[group], 79) };
  const unlock = prog.unlockedTiers(TIER_MAP, LESSON_CHECK_IDS, group, progress({ enrolledCourseSlugs: [course], checkScores: scores }));
  assert.equal(unlock.base, true);
  assert.equal(unlock.vertical, false);
  assert.deepEqual(unlock.courses, []);
  for (const id of TIER_MAP.courseLessons[course]) assert.ok(!unlock.lessonIds.includes(id), id);
  assert.equal(unlock.nextTier, 'vertical');
});

test('tier 2 unlocks only for the learner enrolled courses once the vertical tier is passed', () => {
  const group = 'Cleaning & Hygiene';
  const [enrolled, notEnrolled] = groupCourses(group);
  const scores = { ...scoresFor(TIER_MAP.base, 90), ...scoresFor(TIER_MAP.groupLessons[group], 90) };
  const unlock = prog.unlockedTiers(TIER_MAP, LESSON_CHECK_IDS, group, progress({ enrolledCourseSlugs: [enrolled], checkScores: scores }));
  assert.deepEqual(unlock.courses, [enrolled]);
  for (const id of TIER_MAP.courseLessons[enrolled]) assert.ok(unlock.lessonIds.includes(id), id);
  for (const id of TIER_MAP.courseLessons[notEnrolled] ?? []) {
    if (!TIER_MAP.courseLessons[enrolled].includes(id)) assert.ok(!unlock.lessonIds.includes(id), id);
  }
});

test('business values unlock with tier 2 only, are approved, same company, and for the course keys', () => {
  const group = 'Cleaning & Hygiene';
  const course = groupCourses(group).find((c) => TIER_MAP.courseFields[c].length > 0);
  assert.ok(course, 'a course with business keys is needed for this test');
  const key = TIER_MAP.courseFields[course][0];
  const values = [
    { companyId: 'co-a', fieldKey: key, value: 'ok', status: 'APPROVED' },
    { companyId: 'co-a', fieldKey: key, value: 'draft', status: 'DRAFT' },
    { companyId: 'co-b', fieldKey: key, value: 'other company', status: 'APPROVED' },
  ];
  const scores = { ...scoresFor(TIER_MAP.base, 90), ...scoresFor(TIER_MAP.groupLessons[group], 90) };
  const open = prog.unlockedTiers(TIER_MAP, LESSON_CHECK_IDS, group, progress({ enrolledCourseSlugs: [course], checkScores: scores, businessValues: values }));
  assert.deepEqual(open.businessValues.map((v) => v.value), ['ok']);

  const locked = prog.unlockedTiers(TIER_MAP, LESSON_CHECK_IDS, group, progress({ enrolledCourseSlugs: [course], checkScores: scoresFor(TIER_MAP.base, 90), businessValues: values }));
  assert.deepEqual(locked.businessValues, []);
});

test('no enrolment unlocks nothing, and an unknown group throws', () => {
  const none = prog.unlockedTiers(TIER_MAP, LESSON_CHECK_IDS, 'Cleaning & Hygiene', progress({ checkScores: scoresFor(TIER_MAP.base, 100) }));
  assert.equal(none.base, false);
  assert.deepEqual(none.lessonIds, []);
  assert.throws(() => prog.unlockedTiers(TIER_MAP, LESSON_CHECK_IDS, 'No such group', progress()), /unknown service group/);
});

test('unlockedTiers is pure: inputs are not mutated and repeat calls agree', () => {
  const group = 'Cleaning & Hygiene';
  const input = progress({ enrolledCourseSlugs: [groupCourses(group)[0]], checkScores: scoresFor(TIER_MAP.base, 90) });
  const before = JSON.stringify(input);
  const a = prog.unlockedTiers(TIER_MAP, LESSON_CHECK_IDS, group, input);
  const b = prog.unlockedTiers(TIER_MAP, LESSON_CHECK_IDS, group, input);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(a, b);
});

test('no role reads another group: with everything passed and enrolled, a role sees only its own tiers', () => {
  for (const group of groupNames) {
    const full = progress({
      enrolledCourseSlugs: allCourses,
      checkScores: Object.fromEntries(Object.keys(LESSON_CHECK_IDS).flatMap((id) => LESSON_CHECK_IDS[id]).map((id) => [id, 100])),
    });
    const unlock = prog.unlockedTiers(TIER_MAP, LESSON_CHECK_IDS, group, full);
    const own = new Set([
      ...TIER_MAP.base,
      ...TIER_MAP.groupLessons[group],
      ...groupCourses(group).flatMap((c) => TIER_MAP.courseLessons[c]),
    ]);
    for (const id of unlock.lessonIds) assert.ok(own.has(id), `${group} reads ${id} outside its tiers`);
    for (const c of unlock.courses) assert.equal(TIER_MAP.courseGroup[c], group, c);
  }
});

test('a role never sees another group vertical-tier lesson unless the lesson is in its own group too', () => {
  const pairs = groupNames.flatMap((a) => groupNames.filter((b) => b !== a).map((b) => [a, b]));
  for (const [mine, other] of pairs) {
    const full = progress({ enrolledCourseSlugs: allCourses, checkScores: Object.fromEntries(Object.keys(LESSON_CHECK_IDS).flatMap((id) => LESSON_CHECK_IDS[id]).map((id) => [id, 100])) });
    const unlock = prog.unlockedTiers(TIER_MAP, LESSON_CHECK_IDS, mine, full);
    for (const id of TIER_MAP.groupLessons[other]) {
      if (TIER_MAP.groupLessons[mine].includes(id) || TIER_MAP.base.includes(id)) continue;
      assert.ok(!unlock.lessonIds.includes(id), `${mine} reads ${other} vertical lesson ${id}`);
    }
  }
});

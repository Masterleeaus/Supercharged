import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// Same zod fallback as the other catalogue tests: zod is declared in
// package.json but may be missing from this checkout.
try {
  await import('zod');
} catch {
  const entry = process.env.ZOD_FALLBACK_ENTRY ?? '/opt/npm-tools/node_modules/zod/index.js';
  register('./zod-fallback.hooks.mjs', import.meta.url, { data: { entry } });
}

const {
  COURSE_ASSISTANTS_FLAG,
  courseAssistantRolesEnabled,
  buildCourseAssistantRoles,
  registerCourseAssistantRoles,
  courseAssistantToolIds,
} = await import('../../server/workforce/courses/register.ts');
const { buildGroupPlans } = await import('../../server/workforce/courses/generate.ts');
const { validateRoleDefinition } = await import('../../server/workforce/catalogue/validate.ts');
const { isAlwaysApproval } = await import('../../server/workforce/runtime/always-approval.ts');

const ON = { [COURSE_ASSISTANTS_FLAG]: 'on' };
const TOOL = 'course_knowledge.search';

/** A valid, unrelated role used as the existing catalogue. */
function baseInput(id) {
  return {
    id,
    name: 'Base test role',
    description: 'A test role used as the existing catalogue entry for registration checks.',
    verticals: ['cleaning'],
    category: 'operations',
    systemPrompt:
      'You are a test assistant for a {{company_name}} {{vertical}} business. Answer only from the role configuration supplied by the workforce runtime.',
    channels: ['web'],
    autonomy: 'assist',
    tools: ['calendar.read'],
    toolRisk: { 'calendar.read': 'low' },
    guardrails: ['Never send a message to a customer without approval.'],
    kpis: ['Share of answers that cite a source'],
    sourceRef: 'new',
    companyScope: 'required',
  };
}

function baseCatalogue(id = 'existing-test-role') {
  const result = validateRoleDefinition(baseInput(id));
  assert.equal(result.ok, true, 'base fixture must validate');
  return new Map([[result.role.id, result.role]]);
}

test('flag is read from WORKFORCE_COURSE_ASSISTANTS and defaults to off', () => {
  assert.equal(COURSE_ASSISTANTS_FLAG, 'WORKFORCE_COURSE_ASSISTANTS');
  assert.equal(courseAssistantRolesEnabled({}), false, 'unset is off');
  assert.equal(courseAssistantRolesEnabled({ [COURSE_ASSISTANTS_FLAG]: '' }), false, 'blank is off');
  assert.equal(courseAssistantRolesEnabled({ [COURSE_ASSISTANTS_FLAG]: 'off' }), false);
  assert.equal(courseAssistantRolesEnabled({ [COURSE_ASSISTANTS_FLAG]: 'garbage' }), false, 'unknown value keeps default off');
  assert.equal(courseAssistantRolesEnabled({ [COURSE_ASSISTANTS_FLAG]: '1' }), true);
  assert.equal(courseAssistantRolesEnabled({ [COURSE_ASSISTANTS_FLAG]: 'yes' }), true);
});

test('flag off returns the original catalogue object itself (same reference), unchanged', () => {
  const base = baseCatalogue();
  const before = [...base.entries()];
  for (const env of [{}, { [COURSE_ASSISTANTS_FLAG]: '0' }]) {
    const result = registerCourseAssistantRoles(base, env);
    assert.equal(result.catalogue, base, 'same reference as the input');
    assert.deepEqual(result.added, []);
    assert.deepEqual(result.problems, []);
  }
  assert.deepEqual([...base.entries()], before);
});

test('flag on adds exactly seven roles on the real curriculum and does not change the input', () => {
  const base = baseCatalogue();
  const before = [...base.entries()];
  const result = registerCourseAssistantRoles(base, ON);

  assert.deepEqual(result.problems, []);
  assert.equal(buildGroupPlans().length, 7, 'the real curriculum has seven service groups');
  assert.equal(result.added.length, 7);
  assert.equal(result.catalogue.size, base.size + 7);
  assert.notEqual(result.catalogue, base, 'a new catalogue object is returned');
  for (const id of result.added) {
    assert.match(id, /^assistant-/);
    assert.ok(result.catalogue.has(id));
  }
  assert.ok(result.catalogue.has('existing-test-role'), 'existing roles are kept');
  assert.deepEqual([...base.entries()], before, 'input catalogue is not mutated');
});

test('every generated course assistant role validates', () => {
  const { roles, problems } = buildCourseAssistantRoles();
  assert.deepEqual(problems, []);
  assert.equal(roles.length, 7);
  assert.equal(new Set(roles.map((role) => role.id)).size, 7, 'ids are unique');
  for (const role of roles) {
    const result = validateRoleDefinition(role);
    assert.equal(result.ok, true, `${role.id} must validate: ${JSON.stringify(result.ok ? [] : result.errors)}`);
  }
});

test('duplicate role id is reported and the existing role is not overwritten', () => {
  const existing = validateRoleDefinition(baseInput('assistant-cleaning-and-hygiene')).role;
  const base = new Map([[existing.id, existing]]);
  const result = registerCourseAssistantRoles(base, ON);

  assert.equal(result.catalogue.get('assistant-cleaning-and-hygiene'), existing, 'existing role object kept');
  assert.equal(result.added.includes('assistant-cleaning-and-hygiene'), false);
  assert.equal(result.added.length, 6);
  assert.equal(result.catalogue.size, 7);
  assert.ok(
    result.problems.some((p) => p.message.includes('duplicate role id "assistant-cleaning-and-hygiene"')),
    'duplicate is reported as a problem',
  );
});

test('each course assistant uses only course_knowledge.search at low tool risk', () => {
  const { roles } = buildCourseAssistantRoles();
  assert.equal(roles.length, 7);
  for (const role of roles) {
    assert.deepEqual(role.tools, [TOOL], `${role.id} tools`);
    assert.deepEqual(role.toolRisk, { [TOOL]: 'low' }, `${role.id} toolRisk`);
  }
});

test('each course assistant has suggest autonomy', () => {
  const { roles } = buildCourseAssistantRoles();
  assert.equal(roles.length, 7);
  for (const role of roles) assert.equal(role.autonomy, 'suggest', role.id);
});

test('no course assistant has write tools', () => {
  const { roles } = buildCourseAssistantRoles();
  assert.equal(roles.length, 7);
  for (const role of roles) {
    for (const tool of role.tools) {
      assert.equal(role.toolAccess[tool], 'read', `${role.id} must declare ${tool} as read`);
      assert.notEqual(role.toolRisk[tool], 'critical', `${role.id} ${tool}`);
      assert.equal(isAlwaysApproval(tool), false, `${role.id} ${tool} is not an owner-approval tool`);
    }
    assert.equal(Object.values(role.toolAccess).includes('write'), false, role.id);
  }
});

test('courseAssistantToolIds reports only course_knowledge.search and never throws', () => {
  const report = courseAssistantToolIds();
  assert.deepEqual(report.toolIds, [TOOL]);
  assert.deepEqual(report.problems, []);
});

test('a missing curriculum root is reported, not thrown', () => {
  const missing = '/nonexistent/curriculum-root-for-test';
  let build;
  assert.doesNotThrow(() => {
    build = buildCourseAssistantRoles(missing);
  });
  assert.deepEqual(build.roles, []);
  assert.equal(build.problems.length, 1);

  let report;
  assert.doesNotThrow(() => {
    report = courseAssistantToolIds(missing);
  });
  assert.deepEqual(report.toolIds, []);
  assert.equal(report.problems.length, 1);
});

/**
 * Issue #49: the named Skilled Manager and its wiring. Tests use synthetic learner assistants so they do not
 * need the LMS curriculum. They check:
 *   - the Skilled Manager is read-only and routes only to learner assistants;
 *   - it validates with the same catalogue rules, and the catalogue with it still validates;
 *   - the course flag is off by default, and startup adds nothing when it is off;
 *   - startup with the flag on and no curriculum keeps the base catalogue and adds no Skilled Manager.
 * Run: node --test --experimental-transform-types tests/workforce/skilled-manager.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

for (const method of ['log', 'info', 'warn', 'error']) console[method] = () => {};

const { loadRoleCatalogue } = await import('../../server/workforce/catalogue/loader.ts');
const { validateCatalogue } = await import('../../server/workforce/catalogue/validate.ts');
const { verticalAssistantRole } = await import('../../server/workforce/courses/course-agent.template.ts');
const { buildSkilledManagerRole, SKILLED_MANAGER_ID } = await import(
  '../../server/workforce/courses/skilled-manager.ts'
);
const { COURSE_ASSISTANTS_FLAG, courseAssistantRolesEnabled } = await import('../../server/workforce/courses/flag.ts');
const { loadCatalogueAtStartup } = await import('../../server/workforce/catalogue/startup.ts');

const ROLES_DIR = fileURLToPath(new URL('../../server/workforce/catalogue/roles', import.meta.url));
const baseRoles = await loadRoleCatalogue(ROLES_DIR);
const baseCount = baseRoles.size;

const assistantA = verticalAssistantRole({
  verticalSlug: 'pool-service',
  verticalTitle: 'Pool service',
  verticals: ['pool'],
  courses: [{ slug: 'pool-basics', title: 'Pool basics' }],
});
const assistantB = verticalAssistantRole({
  verticalSlug: 'cleaning-and-hygiene',
  verticalTitle: 'Cleaning and hygiene',
  verticals: ['cleaning'],
  courses: [{ slug: 'cleaning-basics', title: 'Cleaning basics' }],
});
const ASSISTANT_IDS = [`assistant-pool-service`, `assistant-cleaning-and-hygiene`];

test('the course flag is off unless explicitly set to an on value', () => {
  assert.equal(courseAssistantRolesEnabled({}), false);
  assert.equal(courseAssistantRolesEnabled({ [COURSE_ASSISTANTS_FLAG]: '' }), false);
  assert.equal(courseAssistantRolesEnabled({ [COURSE_ASSISTANTS_FLAG]: 'false' }), false);
  assert.equal(courseAssistantRolesEnabled({ [COURSE_ASSISTANTS_FLAG]: 'on' }), true);
});

test('the Skilled Manager needs at least one learner assistant to route to', () => {
  const result = buildSkilledManagerRole([]);
  assert.equal(result.ok, false);
});

test('the Skilled Manager is named, read-only and routes only to the given assistants', () => {
  const result = buildSkilledManagerRole(ASSISTANT_IDS);
  assert.equal(result.ok, true, result.ok ? '' : result.errors.join('; '));
  const { role } = result;
  assert.equal(role.id, SKILLED_MANAGER_ID);
  assert.equal(role.name, 'Skilled Manager');
  assert.deepEqual(role.tools, ['course_knowledge.search']);
  assert.equal(role.toolAccess['course_knowledge.search'], 'read');
  assert.deepEqual(role.handoffTo, ASSISTANT_IDS);
  assert.equal(role.companyScope, 'required');
});

test('the Skilled Manager carries the answer-key, assessment and locked-tier guardrails', () => {
  const { role } = buildSkilledManagerRole(ASSISTANT_IDS);
  const text = role.guardrails.join('\n').toLowerCase();
  assert.match(text, /answer keys/);
  assert.match(text, /assessment/);
  assert.match(text, /locked/);
  assert.match(text, /unlocked/);
});

test('the base catalogue plus the Skilled Manager and two learner assistants still validates', () => {
  const { role } = buildSkilledManagerRole(ASSISTANT_IDS);
  const raw = [...baseRoles.values(), assistantA, assistantB, role];
  const result = validateCatalogue(raw);
  assert.equal(result.ok, true, result.ok ? '' : result.errors.map((e) => `${e.path}: ${e.message}`).join('; '));
});

test('a Skilled Manager that routes to a missing assistant fails validation, so it cannot be added', () => {
  const { role } = buildSkilledManagerRole(['assistant-does-not-exist']);
  const result = validateCatalogue([...baseRoles.values(), role]);
  assert.equal(result.ok, false);
});

test('startup with the flag off loads the base catalogue and adds no Skilled Manager', async () => {
  const saved = process.env[COURSE_ASSISTANTS_FLAG];
  delete process.env[COURSE_ASSISTANTS_FLAG];
  try {
    const result = await loadCatalogueAtStartup(ROLES_DIR, { log() {}, error() {} });
    assert.equal(result.ok, true);
    assert.equal(result.catalogue.size, baseCount);
    assert.equal(result.catalogue.has(SKILLED_MANAGER_ID), false);
  } finally {
    if (saved === undefined) delete process.env[COURSE_ASSISTANTS_FLAG];
    else process.env[COURSE_ASSISTANTS_FLAG] = saved;
  }
});

test('startup with the flag on and no curriculum keeps the base catalogue and adds no Skilled Manager', async () => {
  const saved = process.env[COURSE_ASSISTANTS_FLAG];
  const savedRoot = process.env.ACADEMY_CURRICULUM_ROOT;
  const emptyRoot = mkdtempSync(path.join(tmpdir(), 'no-curriculum-'));
  process.env[COURSE_ASSISTANTS_FLAG] = 'on';
  process.env.ACADEMY_CURRICULUM_ROOT = path.join(emptyRoot, 'missing');
  const logged = [];
  try {
    const result = await loadCatalogueAtStartup(ROLES_DIR, {
      log: (line) => logged.push(line),
      error: (line) => logged.push(line),
    });
    assert.equal(result.ok, true);
    assert.equal(result.catalogue.has(SKILLED_MANAGER_ID), false);
    assert.ok(result.catalogue.size >= baseCount, 'base roles must still be present');
    for (const id of baseRoles.keys()) assert.ok(result.catalogue.has(id), `base role ${id} kept`);
  } finally {
    if (saved === undefined) delete process.env[COURSE_ASSISTANTS_FLAG];
    else process.env[COURSE_ASSISTANTS_FLAG] = saved;
    if (savedRoot === undefined) delete process.env.ACADEMY_CURRICULUM_ROOT;
    else process.env.ACADEMY_CURRICULUM_ROOT = savedRoot;
    rmSync(emptyRoot, { recursive: true, force: true });
  }
});

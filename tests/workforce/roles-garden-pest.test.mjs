import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

// zod is listed in package.json but may be missing from this checkout. Same
// fallback as tests/workforce/catalogue.test.mjs. Hooks are registered before
// the role modules are imported below.
try {
  await import('zod');
} catch {
  const entry = process.env.ZOD_FALLBACK_ENTRY ?? '/opt/npm-tools/node_modules/zod/index.js';
  register('./zod-fallback.hooks.mjs', import.meta.url, { data: { entry } });
}

const lib = await import('../../server/workforce/catalogue/index.ts');

const BATCH = [
  'garden-lawn-mowing-scheduler',
  'garden-maintenance-plan-enrolment',
  'garden-landscape-design-quote-intake',
  'garden-tree-lopping-quote-intake',
  'garden-irrigation-repair-scheduler',
  'garden-irrigation-fault-triage',
  'garden-weed-control-seasonal-campaign',
  'garden-mulch-seasonal-campaign',
  'garden-seasonal-reminder',
  'garden-job-dispatch-coordinator',
  'garden-crew-route-planner',
  'garden-quote-chaser',
  'garden-booking-change-handler',
  'garden-service-history-reviewer',
  'garden-after-hours-emergency-triage',
  'garden-customer-feedback-survey',
  'garden-job-completion-follow-up',
  'pest-inspection-booking',
  'pest-treatment-follow-up',
  'pest-post-treatment-feedback',
  'pest-reinspection-scheduler',
  'pest-wildlife-callout-intake',
  'pest-quote-follow-up',
  'pest-service-record-checker',
  'pest-seasonal-reminder',
];

const rolesDir = new URL('../../server/workforce/catalogue/roles/', import.meta.url);
const presetSource = fileURLToPath(new URL('../../server/seed-agent-templates.ts', import.meta.url));

const loaded = [];
for (const id of BATCH) {
  const file = new URL(`${id}.ts`, rolesDir);
  test(`${id}: file exists, exports only \`role\`, and validates`, async () => {
    assert.ok(existsSync(file), `missing ${id}.ts`);
    const mod = await import(file.href);
    assert.deepEqual(Object.keys(mod).sort(), ['role'], 'must export only `role`');
    const result = lib.validateRoleDefinition(mod.role);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.role.id, id, 'id must match the file name');
    loaded.push(result.role);
  });
}

test('the batch validates as a catalogue (unique ids, handoffs resolve inside the batch)', async () => {
  const modules = await Promise.all(BATCH.map((id) => import(new URL(`${id}.ts`, rolesDir).href)));
  const result = lib.validateCatalogue(modules.map((mod) => mod.role));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.roles.length, 25);
});

test('batch has 25 roles, all verticals garden or pest, and companyScope required', async () => {
  const modules = await Promise.all(BATCH.map((id) => import(new URL(`${id}.ts`, rolesDir).href)));
  assert.equal(new Set(BATCH).size, 25);
  for (const { role } of modules) {
    assert.ok(role.verticals.every((v) => v === 'garden' || v === 'pest'), role.id);
    assert.equal(role.companyScope, 'required');
  }
});

test('write-capable roles require auto; read-only roles are suggest', async () => {
  const modules = await Promise.all(BATCH.map((id) => import(new URL(`${id}.ts`, rolesDir).href)));
  for (const { role } of modules) {
    const risks = Object.values(role.toolRisk);
    const writes = risks.some((r) => r !== 'low');
    if (writes) {
      assert.equal(role.autonomy, 'auto', `${role.id} has a write tool`);
    } else {
      assert.equal(role.autonomy, 'suggest', `${role.id} is read-only`);
    }
    assert.notEqual(role.autonomy, 'predictive', role.id);
  }
});

test('pest roles route chemical, dose and re-entry questions to a licensed technician', async () => {
  const modules = await Promise.all(BATCH.map((id) => import(new URL(`${id}.ts`, rolesDir).href)));
  const pestRoles = modules.map((mod) => mod.role).filter((role) => role.verticals.includes('pest'));
  assert.equal(pestRoles.length, 8);
  for (const role of pestRoles) {
    const text = role.guardrails.join('\n');
    assert.match(text, /licensed technician/, `${role.id}: guardrails must name a licensed technician`);
    assert.match(text, /chemical/i, `${role.id}: guardrails must refuse chemical advice`);
    assert.match(text, /\bdoses?\b/i, `${role.id}: guardrails must refuse dose advice`);
  }
});

test('garden campaign roles refuse to name products or chemicals', async () => {
  const names = ['garden-weed-control-seasonal-campaign', 'garden-mulch-seasonal-campaign', 'garden-seasonal-reminder'];
  for (const id of names) {
    const { role } = await import(new URL(`${id}.ts`, rolesDir).href);
    const text = [role.systemPrompt, ...role.guardrails].join('\n');
    assert.match(text, /products?|chemicals?|fertilisers?|sprays?/i, id);
    assert.match(text, /do not|never/i, id);
  }
});

test('sourceRef reuses Desk presets where they cover the job, Field native ids and "new" elsewhere', async () => {
  const modules = await Promise.all(BATCH.map((id) => import(new URL(`${id}.ts`, rolesDir).href)));
  const counts = { preset: 0, field: 0, new: 0 };
  const source = (await import('node:fs')).readFileSync(presetSource, 'utf8');
  for (const { role } of modules) {
    if (role.sourceRef === 'new') counts.new += 1;
    else if (lib.FIELD_NATIVE_ROLE_IDS.includes(role.sourceRef)) counts.field += 1;
    else {
      counts.preset += 1;
      assert.ok(lib.DESK_PRESET_NAMES.includes(role.sourceRef), role.id);
      assert.ok(source.includes(`name: "${role.sourceRef}"`), `${role.sourceRef} missing from seed file`);
    }
  }
  assert.equal(counts.preset + counts.field + counts.new, 25);
  assert.ok(counts.preset >= 15, `expected most roles to reuse a preset, got ${counts.preset}`);
});

test('no role prompt contains a literal contact detail or unexpected placeholder', async () => {
  const modules = await Promise.all(BATCH.map((id) => import(new URL(`${id}.ts`, rolesDir).href)));
  for (const { role } of modules) {
    assert.deepEqual(lib.findLiteralValues(role.systemPrompt), [], role.id);
    assert.doesNotMatch(role.systemPrompt, /https?:\/\//, role.id);
    const placeholders = [...role.systemPrompt.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
    for (const p of placeholders) assert.ok(['company_name', 'vertical'].includes(p), `${role.id}: ${p}`);
  }
});

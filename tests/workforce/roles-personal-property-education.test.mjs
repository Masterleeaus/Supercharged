import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

// zod is listed in package.json but may be missing from node_modules. Route it
// to the fallback copy when a plain import fails (see catalogue.test.mjs).
try {
  await import('zod');
} catch {
  const entry = process.env.ZOD_FALLBACK_ENTRY ?? '/opt/npm-tools/node_modules/zod/index.js';
  register('./zod-fallback.hooks.mjs', import.meta.url, { data: { entry } });
}

const lib = await import('../../server/workforce/catalogue/index.ts');
const { VERTICALS } = await import('../../server/workforce/catalogue/role.schema.ts');

const rolesDir = fileURLToPath(new URL('../../server/workforce/catalogue/roles/', import.meta.url));

// Verticals 41 to 50 (issues #177 to #186). One desk role per vertical.
const NEW_VERTICALS = [
  'mobile_massage',
  'makeup_artistry',
  'mobile_nail_technology',
  'yoga_pilates',
  'personal_fitness_training',
  'nutrition_consultant',
  'tutoring',
  'real_estate_portfolio_management',
  'short_stay_host_management',
  'high_risk_cleaning',
];

const BATCH = [
  'mobile-massage-booking-desk',
  'makeup-artistry-booking-desk',
  'mobile-nail-technology-booking-desk',
  'yoga-pilates-class-booking-desk',
  'personal-fitness-training-booking-desk',
  'nutrition-consultant-desk',
  'tutoring-enquiry-desk',
  'real-estate-portfolio-desk',
  'short-stay-host-desk',
  'high-risk-cleaning-intake',
];

const roles = {};
for (const id of BATCH) {
  const path = `${rolesDir}${id}.ts`;
  test(`roles/${id}.ts exists, exports role, and its id equals the file name`, async () => {
    assert.ok(existsSync(path), `missing file roles/${id}.ts`);
    const mod = await import(path);
    assert.equal(mod.role.id, id);
    roles[id] = mod.role;
  });
}

test('the batch lists the ten new verticals in the schema enum', () => {
  for (const vertical of NEW_VERTICALS) {
    assert.ok(VERTICALS.includes(vertical), `${vertical} missing from VERTICALS`);
  }
});

test('every new vertical is served by at least one role in the batch', () => {
  for (const vertical of NEW_VERTICALS) {
    const served = BATCH.filter((id) => roles[id]?.verticals.includes(vertical));
    assert.ok(served.length >= 1, `${vertical} has no role`);
  }
});

test('every role in the batch passes validateRoleDefinition', () => {
  for (const id of BATCH) {
    const result = lib.validateRoleDefinition(structuredClone(roles[id]));
    assert.equal(result.ok, true, `${id}: ${JSON.stringify(result.ok ? null : result.errors)}`);
  }
});

test('the batch validates as a catalogue', () => {
  const result = lib.validateCatalogue(BATCH.map((id) => structuredClone(roles[id])));
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.errors));
  assert.equal(result.roles.length, BATCH.length);
});

test('the batch files are all on disk and no non-underscore role file is missing from the batch', () => {
  const onDisk = readdirSync(rolesDir)
    .filter((name) => name.endsWith('.ts') && !name.startsWith('_'))
    .map((name) => name.replace(/\.ts$/, ''));
  for (const id of BATCH) assert.ok(onDisk.includes(id), `roles/${id}.ts is not on disk`);
});

test('desk roles draft customer messages and never hold a send tool', () => {
  for (const id of BATCH) {
    const sends = roles[id].tools.filter((tool) => /\.send(_customer)?$/.test(tool));
    assert.deepEqual(sends, [], `${id} must not hold a send tool`);
  }
});

test('nutrition: every role marks advice as general information, not clinical advice', () => {
  const { role } = { role: roles['nutrition-consultant-desk'] };
  assert.match(role.systemPrompt, /general information, not clinical advice/i, 'system prompt notice');
  assert.match(role.guardrails.join('\n'), /general information, not clinical advice/i, 'guardrail notice');
  assert.match(role.systemPrompt, /registered dietitian/i, 'refers to a registered dietitian');
  assert.match(role.guardrails.join('\n'), /do not diagnose/i, 'refuses diagnosis');
  assert.match(role.guardrails.join('\n'), /supplements|medicines/i, 'refuses supplements or medicines');
  assert.match(role.guardrails.join('\n'), /eating disorder/i, 'refuses eating-disorder advice');
  assert.equal(role.autonomy, 'suggest', 'advice role stays at suggest');
});

test('nutrition: the role hands health questions to a doctor, never to a target', () => {
  const role = roles['nutrition-consultant-desk'];
  assert.match(role.systemPrompt, /pregnant or breastfeeding/i);
  assert.match(role.systemPrompt, /medication/i);
  assert.ok(
    role.guardrails.some((g) => /very low calorie/i.test(g) && /doctor/i.test(g)),
    'very low calorie diets must go to a doctor',
  );
});

test('high-risk cleaning: stops at the first hazard and never gives chemical advice', () => {
  const role = roles['high-risk-cleaning-intake'];
  const text = [role.systemPrompt, ...role.guardrails].join('\n');
  assert.match(text, /stop at the first hazard/i);
  assert.match(text, /biohazard/i);
  assert.match(text, /sharps/i);
  assert.match(text, /do not give chemical names/i);
  assert.match(text, /doses/i);
  assert.match(text, /do not estimate a price/i);
  assert.match(text, /do not say a site is safe/i);
});

test('tutoring: under-18 learners are contacted through a guardian and safeguarding goes to a person', () => {
  const role = roles['tutoring-enquiry-desk'];
  const text = [role.systemPrompt, ...role.guardrails].join('\n');
  assert.match(text, /under 18/i);
  assert.match(text, /guardian/i);
  assert.match(text, /safeguarding/i);
  assert.match(text, /do not guarantee exam results/i);
  assert.match(text, /do not write, mark or complete assessed work/i);
});

test('health-adjacent desks (massage, nails, makeup, fitness, yoga) refuse medical advice and send health answers to a person', () => {
  const healthDesks = [
    'mobile-massage-booking-desk',
    'mobile-nail-technology-booking-desk',
    'makeup-artistry-booking-desk',
    'personal-fitness-training-booking-desk',
    'yoga-pilates-class-booking-desk',
  ];
  for (const id of healthDesks) {
    const role = roles[id];
    const guardrails = role.guardrails.join('\n');
    assert.match(guardrails, /medical|diagnos/i, `${id}: must refuse medical or diagnostic advice`);
    assert.match(role.systemPrompt, /Hand|hand|check first|speak to their doctor|doctor/, `${id}: must route health answers`);
  }
});

test('no desk role quotes a price or takes card details in chat', () => {
  for (const id of BATCH) {
    const guardrails = roles[id].guardrails.join('\n');
    assert.match(guardrails, /Do not quote prices|Do not estimate a price|do not quote/i, `${id}: must not quote prices`);
  }
  const takesPayments = BATCH.filter((id) => roles[id].guardrails.some((g) => /card or bank details/i.test(g)));
  assert.ok(takesPayments.length >= 1, 'at least one desk states the card-details rule');
});

test('each new role is inside the vertical enum and has a placeholder-only system prompt', () => {
  for (const id of BATCH) {
    const role = roles[id];
    for (const vertical of role.verticals) {
      assert.ok(VERTICALS.includes(vertical), `${id}: unknown vertical ${vertical}`);
    }
    const placeholders = [...role.systemPrompt.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
    for (const name of placeholders) {
      assert.ok(['company_name', 'vertical'].includes(name), `${id}: unknown placeholder ${name}`);
    }
    assert.equal(role.companyScope, 'required', id);
    assert.equal(role.sourceRef, 'new', id);
  }
});

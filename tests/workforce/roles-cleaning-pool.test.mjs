import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// zod may be missing from node_modules; same fallback as catalogue.test.mjs.
try {
  await import('zod');
} catch {
  const entry = process.env.ZOD_FALLBACK_ENTRY ?? '/opt/npm-tools/node_modules/zod/index.js';
  register('./zod-fallback.hooks.mjs', import.meta.url, { data: { entry } });
}

const lib = await import('../../server/workforce/catalogue/index.ts');

const BATCH = [
  'cleaning-enquiry-reception',
  'cleaning-quote-intake',
  'cleaning-booking-coordinator',
  'cleaning-customer-care',
  'cleaning-feedback-survey',
  'commercial-cleaning-outbound-prospecting',
  'home-cleaning-recurring-scheduler',
  'commercial-cleaning-site-visit-scheduler',
  'end-of-lease-clean-coordinator',
  'window-cleaning-scheduler',
  'window-cleaning-quote-follow-up',
  'carpet-upholstery-quote-intake',
  'carpet-upholstery-job-scheduler',
  'carpet-upholstery-aftercare-follow-up',
  'cleaning-invoice-query-desk',
  'cleaning-crew-roster-coordinator',
  'cleaning-post-visit-quality-check',
  'pool-enquiry-reception',
  'pool-service-scheduler',
  'pool-water-testing-scheduler',
  'pool-water-quality-escalation',
  'pool-customer-care',
  'pool-equipment-fault-intake',
  'pool-equipment-parts-quote-prep',
  'pool-booking-coordinator',
];

const REQUIRED_KEYS = [
  'id', 'name', 'description', 'verticals', 'category', 'systemPrompt', 'channels',
  'tools', 'toolRisk', 'guardrails', 'kpis', 'sourceRef', 'companyScope',
];

const roles = {};
for (const id of BATCH) {
  const mod = await import(`../../server/workforce/catalogue/roles/${id}.ts`);
  roles[id] = mod;
}

test('batch has 25 role files', () => {
  assert.equal(BATCH.length, 25);
  assert.equal(new Set(BATCH).size, 25);
});

test('each file exports a role object with the required keys and matching id', () => {
  for (const id of BATCH) {
    const { role } = roles[id];
    assert.ok(role && typeof role === 'object', `${id}: missing role export`);
    for (const key of REQUIRED_KEYS) {
      assert.ok(key in role, `${id}: missing key ${key}`);
    }
    assert.equal(role.id, id, `${id}: id does not match file name`);
  }
});

test('each role passes validateRoleDefinition', () => {
  for (const id of BATCH) {
    const result = lib.validateRoleDefinition(roles[id].role);
    assert.equal(result.ok, true, `${id}: ${JSON.stringify(result.ok ? null : result.errors)}`);
  }
});

test('the batch passes validateCatalogue (unique ids, handoffs resolve inside the batch)', () => {
  const result = lib.validateCatalogue(BATCH.map((id) => roles[id].role));
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.errors));
  assert.equal(result.roles.length, 25);
});

test('autonomy is auto, or suggest for read-only roles', () => {
  for (const id of BATCH) {
    const { autonomy } = roles[id].role;
    assert.ok(
      autonomy === 'auto' || autonomy === 'suggest',
      `${id}: autonomy ${autonomy}`,
    );
  }
});

test('every role uses only the cleaning or pool vertical and a valid sourceRef', () => {
  for (const id of BATCH) {
    const { verticals, sourceRef } = roles[id].role;
    assert.ok(verticals.every((v) => v === 'cleaning' || v === 'pool'), `${id}: verticals`);
    assert.ok(
      sourceRef === 'new' || lib.DESK_PRESET_NAMES.includes(sourceRef),
      `${id}: sourceRef ${sourceRef}`,
    );
  }
});

test('roles that reuse a Desk preset are the expected ten', () => {
  const reused = BATCH.filter((id) => roles[id].role.sourceRef !== 'new').sort();
  assert.deepEqual(reused, [
    'carpet-upholstery-quote-intake',
    'cleaning-booking-coordinator',
    'cleaning-customer-care',
    'cleaning-enquiry-reception',
    'cleaning-feedback-survey',
    'cleaning-quote-intake',
    'commercial-cleaning-outbound-prospecting',
    'pool-booking-coordinator',
    'pool-customer-care',
    'pool-enquiry-reception',
  ]);
});

test('prompts use only the company_name and vertical placeholders', () => {
  for (const id of BATCH) {
    const { systemPrompt, description } = roles[id].role;
    const placeholders = [...`${systemPrompt}\n${description}`.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
    for (const p of placeholders) {
      assert.ok(['company_name', 'vertical'].includes(p), `${id}: placeholder ${p}`);
    }
    assert.ok(systemPrompt.includes('{{company_name}}'), `${id}: missing company_name`);
    assert.ok(systemPrompt.includes('{{vertical}}'), `${id}: missing vertical`);
  }
});

test('no literal phone numbers, emails, API keys or prices in prompts', () => {
  for (const id of BATCH) {
    const { systemPrompt } = roles[id].role;
    assert.deepEqual(lib.findLiteralValues(systemPrompt), [], `${id}: literal value found`);
    assert.ok(!/[$£€]\s?\d/.test(systemPrompt), `${id}: price-like text`);
  }
});

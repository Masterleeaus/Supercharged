import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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
const schema = await import('../../server/workforce/catalogue/role.schema.ts');
const rolesDir = fileURLToPath(new URL('../../server/workforce/catalogue/roles/', import.meta.url));

// Vertical 11 to 20 of the vertical work order. Each vertical maps to the intake
// role that serves it. Handyman (19) already exists and is checked separately.
const NEW_ROLE_FOR_VERTICAL = {
  roof_soft_washing: 'roof-soft-washing-quote-intake',
  solar_panel_cleaning: 'solar-panel-cleaning-booking-coordinator',
  healthcare_cleaning: 'healthcare-cleaning-quote-intake',
  medical_equipment_cleaning: 'medical-equipment-cleaning-quote-intake',
  short_stay_turnover: 'short-stay-turnover-scheduler',
  car_detailing: 'car-detailing-booking-intake',
  specialty_appliance_cleaning: 'specialty-appliance-cleaning-quote-intake',
  furniture_restoration: 'furniture-restoration-quote-intake',
  plastering: 'plastering-quote-intake',
};

const NEW_ROLE_IDS = Object.values(NEW_ROLE_FOR_VERTICAL);

// Each role must state its own key limit in a guardrail. These are the
// behaviour checks for each vertical, matched against the guardrail text.
const REQUIRED_GUARDRAIL = {
  'roof-soft-washing-quote-intake': [/asbestos/i, /access/i, /price|estimate/i],
  'solar-panel-cleaning-booking-coordinator': [/roof access/i, /wiring|electrical/i],
  'healthcare-cleaning-quote-intake': [/diagnos/i, /infection/i, /NDIS/],
  'medical-equipment-cleaning-quote-intake': [/internal/i, /sterilis/i, /external/i],
  'short-stay-turnover-scheduler': [/codes?/i, /check-out|check-in/i],
  'car-detailing-booking-intake': [/price/i, /VIN/, /approv/i],
  'specialty-appliance-cleaning-quote-intake': [/repair|electrical|gas/i, /burning|gas odour/i],
  'furniture-restoration-quote-intake': [/valuation|valuable/i, /lead|asbestos/i],
  'plastering-quote-intake': [/structural/i, /damp/i, /price|estimate/i],
};

const loaded = {};
for (const id of NEW_ROLE_IDS) {
  loaded[id] = (await import(`${rolesDir}${id}.ts`)).role;
}

test('each vertical 11 to 20 is in the workforce vertical list', () => {
  for (const vertical of Object.keys(NEW_ROLE_FOR_VERTICAL)) {
    assert.ok(schema.VERTICALS.includes(vertical), `${vertical} missing from VERTICALS`);
  }
  assert.ok(schema.VERTICALS.includes('handyman'), 'handyman must stay in VERTICALS');
  assert.ok(schema.VERTICALS.includes('plastering'), 'plastering must be in VERTICALS');
  assert.equal(new Set(schema.VERTICALS).size, schema.VERTICALS.length, 'VERTICALS has duplicates');
});

test('each new role file exists, exports a role, and its id matches the file name', () => {
  for (const id of NEW_ROLE_IDS) {
    assert.ok(existsSync(`${rolesDir}${id}.ts`), `missing roles/${id}.ts`);
    assert.equal(loaded[id].id, id, `${id}: id must equal the file name`);
  }
});

test('each new role passes validateRoleDefinition', () => {
  for (const id of NEW_ROLE_IDS) {
    const result = lib.validateRoleDefinition(structuredClone(loaded[id]));
    assert.equal(result.ok, true, `${id}: ${JSON.stringify(result.ok ? null : result.errors)}`);
  }
});

test('each new role serves exactly its own vertical', () => {
  for (const [vertical, id] of Object.entries(NEW_ROLE_FOR_VERTICAL)) {
    assert.deepEqual(loaded[id].verticals, [vertical], `${id}: verticals`);
  }
});

test('the real roles folder loads with zero problems and includes every new role', async () => {
  const catalogue = await lib.loadRoleCatalogue(rolesDir);
  for (const id of NEW_ROLE_IDS) {
    assert.ok(catalogue.has(id), `${id} not in loaded catalogue`);
  }
});

test('handyman (vertical 19) is served by roles that load and refuse licensed trade work', async () => {
  const catalogue = await lib.loadRoleCatalogue(rolesDir);
  const served = [...catalogue.values()].filter((role) => role.verticals.includes('handyman'));
  assert.ok(served.length >= 2, `expected at least 2 handyman roles, got ${served.length}`);
  const scoping = catalogue.get('handyman-job-scoping');
  assert.ok(scoping, 'handyman-job-scoping must load');
  assert.match(scoping.systemPrompt, /gas, live wiring, structural work, roofs/);
  assert.match(scoping.systemPrompt, /do not scope it yourself/);
});

test('plastering roles serve plastering only through the new intake role', async () => {
  const catalogue = await lib.loadRoleCatalogue(rolesDir);
  const served = [...catalogue.values()].filter((role) => role.verticals.includes('plastering'));
  assert.deepEqual(served.map((role) => role.id), ['plastering-quote-intake']);
});

test('each new role has the behaviour guardrails for its vertical', () => {
  for (const [id, patterns] of Object.entries(REQUIRED_GUARDRAIL)) {
    const text = loaded[id].guardrails.join('\n');
    for (const pattern of patterns) {
      assert.match(text, pattern, `${id}: guardrails must match ${pattern}`);
    }
  }
});

test('no new role holds a critical tool, uses predictive autonomy or reuses a Desk preset', () => {
  for (const id of NEW_ROLE_IDS) {
    const { toolRisk, autonomy, sourceRef } = loaded[id];
    assert.ok(!Object.values(toolRisk).includes('critical'), `${id}: critical tool`);
    assert.notEqual(autonomy, 'predictive', `${id}: predictive autonomy`);
    assert.equal(sourceRef, 'new', `${id}: sourceRef`);
  }
});

test('no new role prompt holds literal contact details, keys or prices', () => {
  for (const id of NEW_ROLE_IDS) {
    const { systemPrompt, description } = loaded[id];
    assert.deepEqual(schema.findLiteralValues(systemPrompt), [], `${id}: literal value`);
    assert.ok(!/[$£€]\s?\d/.test(`${systemPrompt}\n${description}`), `${id}: price-like text`);
  }
});

test('each new role uses only the company_name and vertical placeholders', () => {
  for (const id of NEW_ROLE_IDS) {
    const { systemPrompt, description } = loaded[id];
    const used = [...`${systemPrompt}\n${description}`.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
    for (const name of used) {
      assert.ok(['company_name', 'vertical'].includes(name), `${id}: placeholder ${name}`);
    }
    assert.ok(systemPrompt.includes('{{company_name}}'), `${id}: missing company_name`);
    assert.ok(systemPrompt.includes('{{vertical}}'), `${id}: missing vertical`);
  }
});

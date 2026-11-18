import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

// zod fallback, same as roles-personal-property-education.test.mjs.
try {
  await import('zod');
} catch {
  const entry = process.env.ZOD_FALLBACK_ENTRY ?? '/opt/npm-tools/node_modules/zod/index.js';
  register('./zod-fallback.hooks.mjs', import.meta.url, { data: { entry } });
}

const lib = await import('../../server/workforce/catalogue/index.ts');
const { VERTICALS } = await import('../../server/workforce/catalogue/role.schema.ts');
const { loadRoleCatalogue } = await import('../../server/workforce/catalogue/loader.ts');

const rolesDir = fileURLToPath(new URL('../../server/workforce/catalogue/roles/', import.meta.url));

// Verticals 32 (pond), 34 (aquarium), 35 (dog walking), 36 (pet sitting), 37 (pet grooming).
// Vertical 33 (pool and spa) and 38 (dog training) are already covered by the pool and dog_training roles.
const NEW_VERTICALS = ['pond_maintenance', 'aquarium_maintenance', 'dog_walking', 'pet_sitting', 'pet_grooming'];
const BATCH = [
  'pond-maintenance-booking-desk',
  'aquarium-maintenance-booking-desk',
  'dog-walking-booking-desk',
  'pet-sitting-booking-desk',
  'pet-grooming-booking-desk',
];

const roles = {};
for (const id of BATCH) {
  const path = `${rolesDir}${id}.ts`;
  test(`roles/${id}.ts exists, exports role, and its id equals the file name`, async () => {
    assert.ok(existsSync(path), `missing file roles/${id}.ts`);
    const mod = await import(path);
    assert.equal(mod.role.id, id);
    assert.equal(mod.default, undefined, `${id} must not default-export`);
    roles[id] = mod.role;
  });
}

test('all five new verticals are in the schema enum', () => {
  for (const vertical of NEW_VERTICALS) {
    assert.ok(VERTICALS.includes(vertical), `${vertical} missing from VERTICALS`);
  }
});

test('each new vertical is served by exactly its own desk role', () => {
  NEW_VERTICALS.forEach((vertical, i) => {
    assert.deepEqual(roles[BATCH[i]].verticals, [vertical]);
  });
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

test('the full role loader loads all five new roles', async () => {
  const catalogue = await loadRoleCatalogue(rolesDir);
  for (const id of BATCH) {
    assert.ok(catalogue.has(id), `${id} not loaded by loadRoleCatalogue`);
  }
});

test('desk roles never hold a send tool or a money tool', () => {
  for (const id of BATCH) {
    const sends = roles[id].tools.filter((tool) => /\.send(_customer)?$/.test(tool));
    assert.deepEqual(sends, [], `${id} must not hold a send tool`);
    const money = roles[id].tools.filter((tool) => /payment|invoice|refund/i.test(tool));
    assert.deepEqual(money, [], `${id} must not hold a money tool`);
  }
});

test('animal desks refuse veterinary advice and route health questions to a vet', () => {
  for (const id of ['dog-walking-booking-desk', 'pet-sitting-booking-desk', 'pet-grooming-booking-desk']) {
    const text = [roles[id].systemPrompt, ...roles[id].guardrails].join('\n');
    assert.match(text, /veterinary advice/i, `${id}: must refuse veterinary advice`);
    assert.match(text, /vet/i, `${id}: must route to a vet`);
  }
});

test('water desks refuse livestock or fish treatment advice and send it to a person or specialist', () => {
  for (const id of ['pond-maintenance-booking-desk', 'aquarium-maintenance-booking-desk']) {
    const guardrails = roles[id].guardrails.join('\n');
    assert.match(guardrails, /do not advise on/i, `${id}: must refuse treatment advice`);
    assert.match(guardrails, /qualified specialist/i, `${id}: must route to a specialist`);
  }
});

test('pond desk treats electrical, pump and child-hazard reports as urgent and hands them to a person', () => {
  const role = roles['pond-maintenance-booking-desk'];
  const guardrails = role.guardrails.join('\n');
  assert.match(guardrails, /leak with electrical equipment/i, 'must flag leaks near electrical equipment');
  assert.match(guardrails, /pump fault near water/i, 'must flag pump faults near water');
  assert.match(guardrails, /hazard to children/i, 'must flag child hazards');
  assert.match(guardrails, /urgent/i, 'must mark these as urgent');
  assert.match(guardrails, /hand it to a person at once/i, 'must hand urgent reports to a person at once');
  assert.match(role.systemPrompt, /pump that has stopped or a leak/i, 'must ask about pump stoppage or leaks');
});

test('no desk role quotes a price or takes card, key or alarm codes in chat', () => {
  for (const id of BATCH) {
    const guardrails = roles[id].guardrails.join('\n');
    assert.match(guardrails, /Do not quote prices/i, `${id}: must not quote prices`);
    assert.match(guardrails, /card or bank details/i, `${id}: must refuse card details`);
  }
});

test('each new role uses only allowed placeholders and the new-role source and scope', () => {
  for (const id of BATCH) {
    const role = roles[id];
    const placeholders = [...role.systemPrompt.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
    for (const name of placeholders) {
      assert.ok(['company_name', 'vertical'].includes(name), `${id}: unknown placeholder ${name}`);
    }
    assert.equal(role.companyScope, 'required', id);
    assert.equal(role.sourceRef, 'new', id);
  }
});

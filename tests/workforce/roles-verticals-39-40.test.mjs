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

// Verticals 39 (mobile hairdressing and barbering, #175) and 40 (mobile beauty, #176).
const NEW_VERTICALS = ['mobile_hairdressing', 'mobile_beauty'];
const BATCH = ['mobile-hairdressing-barbering-booking-desk', 'mobile-beauty-booking-desk'];

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

test('both new verticals are in the schema enum', () => {
  for (const vertical of NEW_VERTICALS) {
    assert.ok(VERTICALS.includes(vertical), `${vertical} missing from VERTICALS`);
  }
});

test('each new vertical is served by its own desk role', () => {
  for (const [vertical, id] of [['mobile_hairdressing', BATCH[0]], ['mobile_beauty', BATCH[1]]]) {
    assert.deepEqual(roles[id].verticals, [vertical]);
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

test('the full role loader loads both new roles', async () => {
  const catalogue = await loadRoleCatalogue(rolesDir);
  for (const id of BATCH) {
    assert.ok(catalogue.has(id), `${id} not loaded by loadRoleCatalogue`);
  }
  const served = [...catalogue.values()].filter((r) => r.verticals.some((v) => NEW_VERTICALS.includes(v)));
  assert.equal(served.length, BATCH.length);
});

test('desk roles never hold a send tool and never a write to money', () => {
  for (const id of BATCH) {
    const sends = roles[id].tools.filter((tool) => /\.send(_customer)?$/.test(tool));
    assert.deepEqual(sends, [], `${id} must not hold a send tool`);
    const money = roles[id].tools.filter((tool) => /payment|invoice|refund/i.test(tool));
    assert.deepEqual(money, [], `${id} must not hold a money tool`);
  }
});

test('health-adjacent desks refuse diagnosis and send skin or scalp symptoms to a doctor', () => {
  for (const id of BATCH) {
    const guardrails = roles[id].guardrails.join('\n');
    assert.match(guardrails, /diagnos/i, `${id}: must refuse diagnosis`);
    assert.match(guardrails, /doctor/i, `${id}: must route symptoms to a doctor`);
    assert.match(guardrails, /patch test/i, `${id}: must recommend a patch test where a sensitivity is reported`);
  }
});

test('no desk role quotes a price or takes card details in chat', () => {
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

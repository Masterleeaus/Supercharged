import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

// zod is listed in package.json but may be missing from this checkout. Same
// fallback as tests/workforce/roles-garden-pest.test.mjs.
try {
  await import('zod');
} catch {
  const entry = process.env.ZOD_FALLBACK_ENTRY ?? '/opt/npm-tools/node_modules/zod/index.js';
  register('./zod-fallback.hooks.mjs', import.meta.url, { data: { entry } });
}

const lib = await import('../../server/workforce/catalogue/index.ts');
const { loadRoleCatalogue } = await import('../../server/workforce/catalogue/loader.ts');
const { TOOL_ACCESS } = await import('../../server/workforce/catalogue/tool-access.ts');
const { ALWAYS_APPROVAL_BY_CATEGORY } = await import('../../server/workforce/runtime/always-approval.ts');

const BATCH = [
  'dog-training-enquiry-reception',
  'dog-training-class-booking-coordinator',
  'dog-training-progress-follow-up',
];

const rolesDir = new URL('../../server/workforce/catalogue/roles/', import.meta.url);

const modules = await Promise.all(
  BATCH.map(async (id) => {
    const file = new URL(`${id}.ts`, rolesDir);
    assert.ok(existsSync(file), `missing ${id}.ts`);
    return { id, mod: await import(file.href) };
  }),
);

test('dog training vertical is in the vertical enum', () => {
  assert.ok(lib.VERTICALS.includes('dog_training'));
});

for (const { id, mod } of modules) {
  test(`${id}: exports only \`role\`, validates, and is dog training only`, () => {
    assert.deepEqual(Object.keys(mod).sort(), ['role']);
    const result = lib.validateRoleDefinition(mod.role);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.role.id, id);
    assert.deepEqual(mod.role.verticals, ['dog_training']);
    assert.equal(mod.role.companyScope, 'required');
  });

  test(`${id}: every tool is classified and never declared read when always-approval`, () => {
    for (const tool of mod.role.tools) {
      assert.ok(tool in TOOL_ACCESS, `${id}: ${tool} has no TOOL_ACCESS entry`);
      const gated = Object.values(ALWAYS_APPROVAL_BY_CATEGORY).flat().includes(tool);
      if (gated) assert.equal(mod.role.toolRisk[tool], 'critical', `${id}: ${tool}`);
    }
  });
}

test('the three dog training roles load with the real catalogue and handoffs resolve', async () => {
  const catalogue = await loadRoleCatalogue(fileURLToPath(rolesDir));
  for (const id of BATCH) assert.ok(catalogue.has(id), id);
  const dogRoles = [...catalogue.values()].filter((r) => r.verticals.includes('dog_training'));
  assert.equal(dogRoles.length, 3);
});

test('bite, attack and aggression reports always go to a person, in the reception and follow-up roles', () => {
  for (const id of ['dog-training-enquiry-reception', 'dog-training-progress-follow-up']) {
    const role = modules.find((m) => m.id === id).mod.role;
    assert.match(role.systemPrompt, /bite|aggression/i, id);
    assert.match(role.guardrails.join('\n'), /bite|aggression/i, id);
  }
});

test('booking coordinator holds group-class proposals for dogs with an aggression flag', () => {
  const role = modules.find((m) => m.id === 'dog-training-class-booking-coordinator').mod.role;
  assert.match(role.guardrails.join('\n'), /group class.*aggression|aggression.*group class/i);
  assert.match(role.systemPrompt, /aggression/i);
});

test('no dog training role gives behaviour or medical advice or confirms a booking', () => {
  for (const { id, mod } of modules) {
    assert.match(mod.role.guardrails.join('\n'), /behaviour|medical|medication|booking|confirm/i, id);
    assert.deepEqual(lib.findLiteralValues(mod.role.systemPrompt), [], id);
    assert.doesNotMatch(mod.role.systemPrompt, /https?:\/\//, id);
  }
});

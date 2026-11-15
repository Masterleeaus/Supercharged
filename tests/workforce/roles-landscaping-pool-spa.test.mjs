import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

// zod fallback, same as tests/workforce/roles-garden-pest.test.mjs.
try {
  await import('zod');
} catch {
  const entry = process.env.ZOD_FALLBACK_ENTRY ?? '/opt/npm-tools/node_modules/zod/index.js';
  register('./zod-fallback.hooks.mjs', import.meta.url, { data: { entry } });
}

// Issue coverage for verticals 31 (Landscaping) and 33 (Pool and spa servicing).
// Landscaping is served by the existing "garden" vertical; pool and spa by the "pool" vertical.
// Ponds, aquariums, pet services and mobile beauty have no vertical enum value yet (see checklist).
const { loadRoleCatalogue } = await import('../../server/workforce/catalogue/loader.ts');
const { VERTICALS } = await import('../../server/workforce/catalogue/role.schema.ts');
const rolesDir = new URL('../../server/workforce/catalogue/roles/', import.meta.url);

const catalogue = await loadRoleCatalogue(fileURLToPath(rolesDir));
const byVertical = (v) => [...catalogue.values()].filter((r) => r.verticals.includes(v));

test('landscaping is served by garden roles, including landscape design intake', () => {
  assert.ok(VERTICALS.includes('garden'));
  const garden = byVertical('garden');
  assert.ok(garden.length >= 17, `expected at least 17 garden roles, got ${garden.length}`);
  assert.ok(catalogue.has('garden-landscape-design-quote-intake'));
});

test('pool and spa servicing is served by pool roles', () => {
  assert.ok(VERTICALS.includes('pool'));
  assert.equal(byVertical('pool').length, 8);
});

test('pool enquiry reception captures spa as a pool type', () => {
  const role = catalogue.get('pool-enquiry-reception');
  assert.ok(role, 'pool-enquiry-reception must exist');
  assert.match(role.systemPrompt, /spa/i);
});

// Per-vertical audit for the ten cleaning sub-verticals (issues #137 to #146).
// All of them sit under the "cleaning" value in VERTICALS. This file checks that
// each sub-vertical has roles, that the roles load through the catalogue loader,
// and that each role keeps the behaviour its issue asks for.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

// zod may be missing from node_modules; same fallback as the other workforce role tests.
try {
  await import('zod');
} catch {
  const entry = process.env.ZOD_FALLBACK_ENTRY ?? '/opt/npm-tools/node_modules/zod/index.js';
  register('./zod-fallback.hooks.mjs', import.meta.url, { data: { entry } });
}

const schema = await import('../../server/workforce/catalogue/role.schema.ts');
const { loadRoleCatalogue } = await import('../../server/workforce/catalogue/loader.ts');
const { validateCatalogue } = await import('../../server/workforce/catalogue/validate.ts');

const rolesDir = fileURLToPath(new URL('../../server/workforce/catalogue/roles/', import.meta.url));
const catalogue = await loadRoleCatalogue(rolesDir);

// Sub-vertical (issue) -> role ids that serve it.
const SUB_VERTICALS = {
  'residential cleaning (#137)': [
    'home-cleaning-recurring-scheduler',
    'cleaning-enquiry-reception',
    'cleaning-quote-intake',
    'cleaning-booking-coordinator',
  ],
  'commercial and office cleaning (#138)': [
    'commercial-cleaning-outbound-prospecting',
    'commercial-cleaning-site-visit-scheduler',
  ],
  'bond and end-of-lease cleaning (#139)': ['end-of-lease-clean-coordinator'],
  'post-construction clean (#140)': ['post-construction-clean-coordinator'],
  'construction-site clean-up (#141)': ['construction-site-cleanup-scheduler'],
  'strata and common-area cleaning (#142)': ['strata-common-area-scheduler'],
  'hard floor care (#143)': ['hard-floor-care-scheduler'],
  'carpet and upholstery cleaning (#144)': [
    'carpet-upholstery-quote-intake',
    'carpet-upholstery-job-scheduler',
    'carpet-upholstery-aftercare-follow-up',
  ],
  'window cleaning, all heights (#145)': ['window-cleaning-scheduler', 'window-cleaning-quote-follow-up'],
  'pressure cleaning, all heights (#146)': ['pressure-cleaning-scheduler'],
};

// Roles added or completed for the audit. Each must be new or on the vertical list.
const NEW_ROLE_IDS = [
  'post-construction-clean-coordinator',
  'construction-site-cleanup-scheduler',
  'strata-common-area-scheduler',
  'hard-floor-care-scheduler',
  'pressure-cleaning-scheduler',
];

const RISK_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

test('cleaning is in the vertical list, so the sub-verticals need no new enum value', () => {
  assert.ok(schema.VERTICALS.includes('cleaning'));
});

test('the full catalogue loads through the loader with the new roles', async () => {
  assert.ok(catalogue.size > 100, `expected the full catalogue, got ${catalogue.size}`);
  for (const id of NEW_ROLE_IDS) {
    assert.ok(catalogue.has(id), `${id} is not in the loaded catalogue`);
  }
});

test('every role in every sub-vertical exists and is valid on its own', () => {
  for (const [vertical, ids] of Object.entries(SUB_VERTICALS)) {
    assert.ok(ids.length > 0, `${vertical}: no roles`);
    for (const id of ids) {
      const role = catalogue.get(id);
      assert.ok(role, `${vertical}: ${id} is missing from the catalogue`);
      assert.ok(role.verticals.includes('cleaning'), `${vertical}: ${id} is not on the cleaning vertical`);
      const result = schema.RoleDefinitionSchema.safeParse(role);
      assert.equal(result.success, true, `${vertical}: ${id} fails the schema`);
    }
  }
});

test('the whole catalogue passes validateCatalogue, so every handoff resolves', () => {
  const result = validateCatalogue([...catalogue.values()]);
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.errors));
});

test('each new role is a new source, has a scheduling or booking category, and uses only the cleaning vertical', () => {
  for (const id of NEW_ROLE_IDS) {
    const role = catalogue.get(id);
    assert.equal(role.sourceRef, 'new', `${id}: sourceRef`);
    assert.ok(['scheduling', 'booking'].includes(role.category), `${id}: category ${role.category}`);
    assert.deepEqual(role.verticals, ['cleaning'], `${id}: verticals`);
    assert.equal(role.companyScope, 'required', `${id}: companyScope`);
  }
});

test('every write tool on a new role is at least medium risk', () => {
  for (const id of NEW_ROLE_IDS) {
    const role = catalogue.get(id);
    for (const tool of role.tools) {
      if (role.toolAccess[tool] !== 'write') continue;
      assert.ok(
        RISK_RANK[role.toolRisk[tool]] >= RISK_RANK.medium,
        `${id}: write tool ${tool} is ${role.toolRisk[tool]}`,
      );
    }
  }
});

test('every reschedule tool on a new role is high risk', () => {
  for (const id of NEW_ROLE_IDS) {
    const role = catalogue.get(id);
    for (const tool of role.tools.filter((t) => t.endsWith('.reschedule'))) {
      assert.equal(role.toolRisk[tool], 'high', `${id}: ${tool}`);
    }
  }
});

test('no role in a sub-vertical gives prices, and every role routes a decision to a person', () => {
  for (const [vertical, ids] of Object.entries(SUB_VERTICALS)) {
    for (const id of ids) {
      const role = catalogue.get(id);
      const text = `${role.systemPrompt}\n${role.guardrails.join('\n')}`;
      assert.ok(!/[$£€]\s?\d/.test(text), `${vertical}: ${id} has price-like text`);
      assert.ok(/person|approv|escalat|strata manager/i.test(text), `${vertical}: ${id} routes no decision to a person`);
    }
  }
});

// Behaviour each sub-vertical's issue needs. Each entry: role id, and the guardrail text it must carry.
const BEHAVIOUR = [
  ['home-cleaning-recurring-scheduler', /without approval/i, 'recurring visits move only with approval'],
  ['commercial-cleaning-site-visit-scheduler', /security codes|alarm|key holder/i, 'site security details are not recorded'],
  ['end-of-lease-clean-coordinator', /bond/i, 'no promise about bond return'],
  ['end-of-lease-clean-coordinator', /inspection/i, 'no promise about inspection'],
  ['post-construction-clean-coordinator', /cleared of active trades/i, 'site must be cleared before booking'],
  ['post-construction-clean-coordinator', /asbestos/i, 'asbestos goes to a person'],
  ['construction-site-cleanup-scheduler', /asbestos|silica/i, 'hazardous materials go to a person'],
  ['construction-site-cleanup-scheduler', /induction/i, 'site induction is confirmed before booking'],
  ['strata-common-area-scheduler', /strata manager/i, 'scope changes go to the strata manager'],
  ['strata-common-area-scheduler', /lot owners/i, 'individual units are not entered'],
  ['hard-floor-care-scheduler', /crack|lifting|damaged/i, 'damaged floors go to a person'],
  ['hard-floor-care-scheduler', /stains, etching/i, 'no promise on stain or etch removal'],
  ['carpet-upholstery-quote-intake', /delicate|antique/i, 'delicate items are flagged'],
  ['carpet-upholstery-job-scheduler', /mould|flood/i, 'mould or flood damage goes to a person'],
  ['window-cleaning-scheduler', /high-level|roof/i, 'high-level work is assessed first'],
  ['window-cleaning-scheduler', /weather/i, 'weather changes need a person'],
  ['pressure-cleaning-scheduler', /all heights/i, 'height work is assessed at all heights'],
  ['pressure-cleaning-scheduler', /power lines/i, 'power lines are escalated'],
  ['pressure-cleaning-scheduler', /weather/i, 'weather changes need approval'],
];

test('each sub-vertical keeps the behaviour its issue asks for', () => {
  for (const [id, pattern, label] of BEHAVIOUR) {
    const role = catalogue.get(id);
    assert.ok(role, `${id} is missing`);
    const text = `${role.systemPrompt}\n${role.guardrails.join('\n')}`;
    assert.ok(pattern.test(text), `${id}: ${label}`);
  }
});

test('the window and pressure roles hand high-level work to a person', () => {
  for (const id of ['window-cleaning-scheduler', 'pressure-cleaning-scheduler']) {
    const role = catalogue.get(id);
    assert.ok(
      role.guardrails.some((g) => /person/i.test(g) && /height|power|roof|fragile/i.test(g)),
      `${id}: no guardrail routes height or hazard work to a person`,
    );
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

// Same zod fallback as tests/workforce/catalogue.test.mjs: zod is declared in
// package.json but may be missing from this checkout.
try {
  await import('zod');
} catch {
  const entry = process.env.ZOD_FALLBACK_ENTRY ?? '/opt/npm-tools/node_modules/zod/index.js';
  register('./zod-fallback.hooks.mjs', import.meta.url, { data: { entry } });
}

const lib = await import('../../server/workforce/catalogue/index.ts');
const schema = await import('../../server/workforce/catalogue/role.schema.ts');
const rolesDir = new URL('../../server/workforce/catalogue/roles/', import.meta.url);
const rolesDirPath = fileURLToPath(rolesDir);

// Verticals 21 to 30 from issues #157 to #166, with the role files that serve each.
const VERTICAL_ROLES = {
  painting: ['painting-quote-follow-up', 'painting-site-prep-checklist'],
  tiling: ['tiling-quote-follow-up', 'tiling-site-prep-checklist'],
  flat_pack: ['flat-pack-booking-coordinator', 'flat-pack-quote-follow-up'],
  locksmith: [
    'locksmith-arrival-check',
    'locksmith-escalation-brief',
    'locksmith-identity-verification',
    'locksmith-lockout-intake',
    'locksmith-rekey-quote',
  ],
  deck_fence: ['deck-fence-quote-follow-up', 'deck-fence-inspection-scheduler'],
  timber_floor: ['timber-floor-quote-follow-up', 'timber-floor-site-prep-checklist'],
  stone_terrazzo: ['stone-terrazzo-quote-follow-up', 'stone-terrazzo-site-prep-checklist'],
  lawn_turf: ['garden-lawn-mowing-scheduler'],
  garden: ['garden-job-dispatch-coordinator', 'garden-quote-chaser', 'garden-seasonal-reminder'],
  irrigation: ['garden-irrigation-repair-scheduler', 'garden-irrigation-fault-triage'],
};

const NEW_IDS = [
  'tiling-quote-follow-up',
  'tiling-site-prep-checklist',
  'flat-pack-booking-coordinator',
  'flat-pack-quote-follow-up',
  'deck-fence-quote-follow-up',
  'deck-fence-inspection-scheduler',
  'timber-floor-quote-follow-up',
  'timber-floor-site-prep-checklist',
  'stone-terrazzo-quote-follow-up',
  'stone-terrazzo-site-prep-checklist',
];

const QUOTE_IDS = NEW_IDS.filter((id) => id.endsWith('quote-follow-up'));
const CHECKLIST_IDS = NEW_IDS.filter((id) => id.endsWith('site-prep-checklist'));

async function loadNew() {
  const out = [];
  for (const id of NEW_IDS) {
    const file = new URL(`${id}.ts`, rolesDir);
    assert.ok(existsSync(file), `missing role file ${id}`);
    const mod = await import(file.href);
    out.push({ id, role: mod.role });
  }
  return out;
}

test('verticals 21 to 30 are all in the workforce vertical list', () => {
  for (const vertical of Object.keys(VERTICAL_ROLES)) {
    assert.ok(schema.VERTICALS.includes(vertical), `${vertical} missing from VERTICALS`);
  }
});

test('the vertical list has no duplicates', () => {
  assert.equal(new Set(schema.VERTICALS).size, schema.VERTICALS.length);
});

test('the checked-in catalogue loads and every vertical 21 to 30 has its roles', async () => {
  const catalogue = await lib.loadRoleCatalogue(rolesDirPath);
  for (const [vertical, ids] of Object.entries(VERTICAL_ROLES)) {
    for (const id of ids) {
      const role = lib.getRole(catalogue, id);
      assert.ok(role, `${id} must be in the catalogue`);
      assert.ok(role.verticals.includes(vertical), `${id} must serve ${vertical}`);
    }
  }
});

test('every new role validates alone and as a batch', async () => {
  const loaded = await loadNew();
  for (const { id, role } of loaded) {
    const result = lib.validateRoleDefinition(role);
    assert.equal(result.ok, true, `${id}: ${JSON.stringify(result.ok ? [] : result.errors)}`);
    assert.equal(role.id, id, `${id}: id must match file name`);
    assert.equal(role.companyScope, 'required');
  }
  // Handoffs point at roles outside this batch, so the batch is checked inside the full folder.
  const catalogue = await lib.loadRoleCatalogue(rolesDirPath);
  for (const { id } of loaded) assert.ok(catalogue.has(id), `${id} must load in the full catalogue`);
});

test('each new vertical has a quote or booking role and a site or booking role', async () => {
  const loaded = await loadNew();
  for (const vertical of ['tiling', 'flat_pack', 'deck_fence', 'timber_floor', 'stone_terrazzo']) {
    const serving = loaded.filter((x) => x.role.verticals.includes(vertical));
    assert.equal(serving.length, 2, `${vertical} should have exactly two roles`);
  }
});

test('quote follow-up roles send to customers only as critical, at auto autonomy', async () => {
  const loaded = await loadNew();
  for (const { id, role } of loaded.filter((x) => QUOTE_IDS.includes(x.id))) {
    assert.equal(role.toolRisk['messages.send_customer'], 'critical', `${id} send must be critical`);
    assert.equal(role.autonomy, 'auto', `${id} must be auto`);
    assert.match(role.systemPrompt, /Stop after the agreed number of reminders/, `${id} must stop reminding`);
    assert.match(role.guardrails.join(' '), /opt-out/i, `${id} must respect opt-outs`);
  }
});

test('site prep checklists are read-only suggestions that never send or change records', async () => {
  const loaded = await loadNew();
  for (const { id, role } of loaded.filter((x) => CHECKLIST_IDS.includes(x.id))) {
    assert.equal(role.autonomy, 'suggest', `${id} must be suggest`);
    for (const tool of role.tools) {
      assert.equal(role.toolAccess[tool], 'read', `${id}: ${tool} must be read`);
      assert.ok(!/\.(send|create|update|draft)/.test(tool), `${id}: ${tool} is a write`);
    }
    assert.match(role.guardrails.join(' '), /Do not send the checklist to the customer/, id);
  }
});

test('no new role recommends brands, finishes or products', async () => {
  const loaded = await loadNew();
  for (const { id, role } of loaded) {
    const text = `${role.guardrails.join(' ')} ${role.systemPrompt}`;
    assert.match(text, /Do not recommend|Do not quote|hand the question/i, `${id} must refuse advice or pricing`);
  }
});

test('flat-pack booking sends wiring, gas and plumbing to a person, not to flat-pack work', async () => {
  const { role } = (await loadNew()).find((x) => x.id === 'flat-pack-booking-coordinator');
  assert.match(role.systemPrompt, /licensed trade/i);
  assert.match(role.guardrails.join(' '), /electrical, gas or plumbing/i);
  assert.equal(role.autonomy, 'auto');
  assert.equal(role.toolRisk['booking_requests.create'], 'medium');
});

test('deck and fence inspection never judges safety and escalates collapse risk', async () => {
  const { role } = (await loadNew()).find((x) => x.id === 'deck-fence-inspection-scheduler');
  assert.match(role.guardrails.join(' '), /Do not say a deck or fence is safe or unsafe/);
  assert.match(role.guardrails.join(' '), /sagging deck.*escalate|escalate.*sagging deck/i);
});

test('lawn and irrigation roles now also serve their own verticals', async () => {
  const catalogue = await lib.loadRoleCatalogue(rolesDirPath);
  for (const id of ['garden-lawn-mowing-scheduler']) {
    assert.ok(lib.getRole(catalogue, id).verticals.includes('lawn_turf'), id);
  }
  for (const id of ['garden-irrigation-repair-scheduler', 'garden-irrigation-fault-triage']) {
    assert.ok(lib.getRole(catalogue, id).verticals.includes('irrigation'), id);
  }
});

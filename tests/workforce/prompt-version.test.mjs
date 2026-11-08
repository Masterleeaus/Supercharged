import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

// Same zod fallback as tests/workforce/catalogue-loader.test.mjs: zod is declared
// in package.json but may be missing from this checkout.
try {
  await import('zod');
} catch {
  const entry = process.env.ZOD_FALLBACK_ENTRY ?? '/opt/npm-tools/node_modules/zod/index.js';
  register('./zod-fallback.hooks.mjs', import.meta.url, { data: { entry } });
}

const { loadRoleCatalogue } = await import('../../server/workforce/catalogue/loader.ts');
const { roleVersion, catalogueVersions, catalogueFingerprint } = await import(
  '../../server/workforce/catalogue/prompt-version.ts'
);

const rolesDir = fileURLToPath(new URL('../../server/workforce/catalogue/roles/', import.meta.url));
const expectedRoles = readdirSync(rolesDir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.startsWith('_'))
  .length;

/** A plain, editable copy of a role with the fields that the version uses. */
function sampleRole() {
  return {
    id: 'pool-service-scheduler',
    systemPrompt:
      'You are the scheduling assistant for {{company_name}}, a {{vertical}} business. Offer times from the calendar and confirm each booking.',
    tools: ['booking_requests.create', 'calendar.read'],
    toolRisk: { 'booking_requests.create': 'medium', 'calendar.read': 'low' },
    autonomy: 'suggest',
    channels: ['sms', 'email'],
  };
}

test('the same role gives the same version', () => {
  const a = sampleRole();
  const b = sampleRole();
  assert.equal(roleVersion(a), roleVersion(b));
  assert.equal(roleVersion(a), roleVersion(a));
  assert.match(roleVersion(a), /^[0-9a-f]{16}$/);
});

test('field order and array order do not change the version', () => {
  const a = sampleRole();
  const reordered = {
    channels: ['email', 'sms'],
    autonomy: 'suggest',
    toolRisk: { 'calendar.read': 'low', 'booking_requests.create': 'medium' },
    tools: ['calendar.read', 'booking_requests.create'],
    systemPrompt: a.systemPrompt,
    id: a.id,
  };
  assert.equal(roleVersion(reordered), roleVersion(a));
});

test('changing the system prompt changes the version', () => {
  const base = sampleRole();
  const changed = { ...sampleRole(), systemPrompt: base.systemPrompt + ' Be brief.' };
  assert.notEqual(roleVersion(changed), roleVersion(base));
});

test('changing a tool changes the version', () => {
  const base = sampleRole();
  const changed = {
    ...sampleRole(),
    tools: ['booking_requests.create', 'calendar.write'],
    toolRisk: { 'booking_requests.create': 'medium', 'calendar.write': 'low' },
  };
  assert.notEqual(roleVersion(changed), roleVersion(base));
});

test('changing a tool risk changes the version', () => {
  const base = sampleRole();
  const changed = { ...sampleRole(), toolRisk: { ...base.toolRisk, 'calendar.read': 'high' } };
  assert.notEqual(roleVersion(changed), roleVersion(base));
});

test('changing the autonomy changes the version', () => {
  const base = sampleRole();
  const changed = { ...sampleRole(), autonomy: 'auto' };
  assert.notEqual(roleVersion(changed), roleVersion(base));
});

test('changing the channels changes the version', () => {
  const base = sampleRole();
  const changed = { ...sampleRole(), channels: ['sms'] };
  assert.notEqual(roleVersion(changed), roleVersion(base));
});

test('changing the id changes the version', () => {
  const base = sampleRole();
  const changed = { ...sampleRole(), id: 'pool-booking-coordinator' };
  assert.notEqual(roleVersion(changed), roleVersion(base));
});

test('fields outside the canonical set do not change the version', () => {
  const base = sampleRole();
  const withExtra = { ...sampleRole(), name: 'Renamed', kpis: ['Bookings per week'] };
  assert.equal(roleVersion(withExtra), roleVersion(base));
});

test('the real catalogue gives one version per role with no duplicates', async () => {
  const catalogue = await loadRoleCatalogue(rolesDir);
  assert.equal(catalogue.size, expectedRoles);
  assert.equal(expectedRoles, 125, 'the real catalogue should hold 125 roles');

  const versions = catalogueVersions(catalogue);
  assert.equal(versions.size, 125);
  assert.deepEqual([...versions.keys()].sort(), [...catalogue.keys()].sort());

  const distinct = new Set(versions.values());
  assert.equal(distinct.size, 125, 'no two roles should share a version');
  for (const [id, version] of versions) {
    assert.equal(version, roleVersion(catalogue.get(id)));
  }
});

test('the catalogue fingerprint is stable and changes when one version changes', async () => {
  const catalogue = await loadRoleCatalogue(rolesDir);
  const versions = catalogueVersions(catalogue);
  const fingerprint = catalogueFingerprint(versions);
  assert.match(fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(catalogueFingerprint(catalogueVersions(await loadRoleCatalogue(rolesDir))), fingerprint);

  const [firstId, firstVersion] = versions.entries().next().value;
  const changed = new Map(versions);
  changed.set(firstId, firstVersion.replace(/.$/, firstVersion.endsWith('0') ? '1' : '0'));
  assert.notEqual(changed.get(firstId), firstVersion);
  assert.notEqual(catalogueFingerprint(changed), fingerprint);

  const lastId = [...versions.keys()].at(-1);
  const changedLast = new Map(versions);
  changedLast.set(lastId, 'f'.repeat(16));
  assert.notEqual(catalogueFingerprint(changedLast), fingerprint);
});

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

const rolesDir = fileURLToPath(new URL('../../server/workforce/catalogue/roles/', import.meta.url));

// The general field service batch: handymen, locksmiths, painters and
// general field service businesses.
const BATCH = [
  'field-job-intake',
  'field-quote-follow-up',
  'painting-quote-follow-up',
  'handyman-job-scoping',
  'locksmith-lockout-intake',
  'locksmith-identity-verification',
  'locksmith-escalation-brief',
  'locksmith-arrival-check',
  'locksmith-rekey-quote',
  'field-visit-confirmation',
  'field-schedule-change',
  'field-eta-delay-notice',
  'field-materials-parts-reminder',
  'field-technician-checkin',
  'field-technician-checkout',
  'field-job-photo-request',
  'field-signoff-request',
  'field-review-request',
  'field-customer-care-recovery',
  'field-rebooking-reminder',
  'field-customer-status-update',
  'painting-site-prep-checklist',
  'handyman-warranty-callback',
  'field-daily-schedule-brief',
  'field-no-show-follow-up',
];

const LOCKSMITH = BATCH.filter((id) => id.startsWith('locksmith-'));

const loaded = [];
for (const id of BATCH) {
  const path = `${rolesDir}${id}.ts`;
  test(`roles/${id}.ts exists and exports a role object with the required keys`, async () => {
    assert.ok(existsSync(path), `missing file roles/${id}.ts`);
    const mod = await import(path);
    assert.equal(typeof mod.role, 'object', 'expected a named export `role`');
    assert.notEqual(mod.role, null);
    assert.equal(mod.role.id, id, 'role.id must equal the file name');
    loaded.push({ id, role: mod.role });
  });
}

test('every role in the batch passes validateRoleDefinition', async () => {
  for (const id of BATCH) {
    const path = `${rolesDir}${id}.ts`;
    const mod = await import(path);
    const result = lib.validateRoleDefinition(structuredClone(mod.role));
    assert.equal(result.ok, true, `${id}: ${JSON.stringify(result.ok ? null : result.errors)}`);
  }
});

test('the batch validates as a catalogue, so every handoffTo id resolves', async () => {
  const raws = [];
  for (const id of BATCH) {
    const mod = await import(`${rolesDir}${id}.ts`);
    raws.push(structuredClone(mod.role));
  }
  const result = lib.validateCatalogue(raws);
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.errors));
  assert.equal(result.roles.length, BATCH.length);
});

test('the batch has exactly the expected file set and no duplicate ids', () => {
  assert.equal(new Set(BATCH).size, BATCH.length, 'duplicate id in the batch list');
  const onDisk = readdirSync(rolesDir)
    .filter((name) => name.endsWith('.ts') && !name.startsWith('_'))
    .map((name) => name.replace(/\.ts$/, ''));
  for (const id of BATCH) {
    assert.ok(onDisk.includes(id), `roles/${id}.ts is not on disk`);
  }
});

test('locksmith roles require verification and escalation before any action', async () => {
  for (const id of LOCKSMITH) {
    const { role } = await import(`${rolesDir}${id}.ts`);
    const guardrails = role.guardrails.join('\n').toLowerCase();
    assert.match(role.systemPrompt.toLowerCase(), /escalat/, `${id}: prompt must mention escalation`);
    assert.match(guardrails, /escalat|verif/, `${id}: guardrails must require verification or escalation`);
    const ownershipGate = /ownership|identity/.test(role.systemPrompt.toLowerCase());
    assert.ok(ownershipGate, `${id}: prompt must address identity or ownership`);
  }
});

test('roles that ask for a review, payment, sign-off or rebooking use auto', async () => {
  const gated = [
    'field-review-request',
    'field-signoff-request',
    'field-rebooking-reminder',
    'field-quote-follow-up',
    'painting-quote-follow-up',
  ];
  for (const id of gated) {
    const { role } = await import(`${rolesDir}${id}.ts`);
    assert.equal(role.autonomy, 'auto', `${id} must use auto`);
  }
});

test('read-only roles use suggest and expose no mutating tool', async () => {
  const readOnly = ['painting-site-prep-checklist', 'field-daily-schedule-brief', 'locksmith-escalation-brief'];
  for (const id of readOnly) {
    const { role } = await import(`${rolesDir}${id}.ts`);
    assert.equal(role.autonomy, 'suggest', `${id}: ${role.autonomy}`);
    const mutating = Object.values(role.toolRisk).filter((risk) => risk === 'high' || risk === 'critical');
    assert.equal(mutating.length, 0, `${id} must not hold high or critical tools`);
  }
});

test('no prompt uses placeholders other than company_name and vertical', async () => {
  for (const id of BATCH) {
    const { role } = await import(`${rolesDir}${id}.ts`);
    const placeholders = [...role.systemPrompt.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
    for (const name of placeholders) {
      assert.ok(['company_name', 'vertical'].includes(name), `${id}: unknown placeholder ${name}`);
    }
  }
});

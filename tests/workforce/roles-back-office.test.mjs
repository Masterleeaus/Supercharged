import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

// zod is listed in package.json but may be missing from node_modules. Route it
// to the fallback copy when a plain import fails, as catalogue.test.mjs does.
try {
  await import('zod');
} catch {
  const entry = process.env.ZOD_FALLBACK_ENTRY ?? '/opt/npm-tools/node_modules/zod/index.js';
  register('./zod-fallback.hooks.mjs', import.meta.url, { data: { entry } });
}

const lib = await import('../../server/workforce/catalogue/index.ts');
const rolesDir = fileURLToPath(new URL('../../server/workforce/catalogue/roles/', import.meta.url));

// The back-office batch written for this task. Each id is also the file name.
const BATCH = [
  'quote-follow-up',
  'invoice-reminder',
  'payment-reminder',
  'collections-follow-up',
  'refund-triage',
  'membership-renewal',
  'complaint-triage',
  'weekly-business-report',
  'staff-roster-suggestions',
  'timesheet-check',
  'review-monitor',
  'lapsed-customer-reactivation',
  'referral-request',
  'new-customer-onboarding',
  'dispute-intake',
  'payment-reconciliation-check',
  'supplier-bill-check',
  'compliance-expiry-tracker',
  'stock-reorder-suggestions',
  'customer-data-hygiene',
  'appointment-reminder',
  'no-show-follow-up',
  'service-due-reminder',
  'post-job-check-in',
  'warranty-callback-intake',
];

const MONEY_ROLES = [
  'invoice-reminder',
  'payment-reminder',
  'collections-follow-up',
  'dispute-intake',
  'membership-renewal',
];

const REPORTING_ROLES = [
  'weekly-business-report',
  'review-monitor',
  'timesheet-check',
  'staff-roster-suggestions',
  'compliance-expiry-tracker',
  'stock-reorder-suggestions',
  'customer-data-hygiene',
  'payment-reconciliation-check',
  'supplier-bill-check',
];

const loaded = new Map();

for (const id of BATCH) {
  loaded.set(id, await import(`../../server/workforce/catalogue/roles/${id}.ts`));
}

test('every batch file exists, is named after its id, and named-exports the role only', () => {
  for (const id of BATCH) {
    assert.ok(existsSync(`${rolesDir}${id}.ts`), `missing file for ${id}`);
    const mod = loaded.get(id);
    assert.ok(mod.role, `${id} has no named role export`);
    assert.equal(mod.default, undefined, `${id} must not default-export (SCHEMA.md: named only)`);
    assert.equal(mod.role.id, id, `${id}: file name and id differ`);
  }
});

test('every batch role passes validateRoleDefinition', () => {
  for (const id of BATCH) {
    const result = lib.validateRoleDefinition(structuredClone(loaded.get(id).role));
    assert.equal(result.ok, true, `${id}: ${JSON.stringify(result.ok ? null : result.errors)}`);
  }
});

test('the batch forms a valid catalogue, so every handoff resolves inside the batch', () => {
  const result = lib.validateCatalogue(BATCH.map((id) => structuredClone(loaded.get(id).role)));
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.errors));
  assert.equal(result.roles.length, BATCH.length);
});

test('every batch role is cross_vertical and company-scoped', () => {
  for (const id of BATCH) {
    const role = loaded.get(id).role;
    assert.deepEqual(role.verticals, ['cross_vertical'], id);
    assert.equal(role.companyScope, 'required', id);
  }
});

test('money-facing roles are approval-gated and hand disputes to dispute intake', () => {
  for (const id of MONEY_ROLES) {
    const role = loaded.get(id).role;
    assert.equal(role.autonomy, 'auto', `${id} must be auto`);
    if (id !== 'dispute-intake') {
      assert.ok(role.handoffTo.includes('dispute-intake'), `${id} must hand disputes to dispute-intake`);
    }
    assert.ok(
      role.guardrails.some((g) => /dispute/i.test(g)),
      `${id} must state a dispute hard stop in its guardrails`,
    );
  }
});

test('refund-triage suggests only and has no tool that issues or pays out a refund', () => {
  const role = loaded.get('refund-triage').role;
  assert.equal(role.autonomy, 'suggest');
  for (const tool of role.tools) {
    assert.doesNotMatch(tool, /issue|execute|payout|pay_out|transfer|credit\.apply/i, `refund-triage tool ${tool}`);
  }
  assert.ok(
    role.guardrails.some((g) => /never issue/i.test(g)),
    'refund-triage must state it never issues a refund',
  );
});

test('reporting and monitoring roles are suggest', () => {
  for (const id of REPORTING_ROLES) {
    assert.equal(loaded.get(id).role.autonomy, 'suggest', `${id} must be suggest`);
  }
});

test('the critical back-office tools are exactly the listed customer-send, refund, payment and merge actions, and collections sits under auto', () => {
  const critical = [];
  for (const id of BATCH) {
    const role = loaded.get(id).role;
    for (const [tool, risk] of Object.entries(role.toolRisk)) {
      if (risk === 'critical') critical.push(`${id}:${tool}`);
    }
  }
  assert.deepEqual(critical, [
    'quote-follow-up:customer_messages.send',
    'invoice-reminder:customer_messages.send',
    'payment-reminder:customer_messages.send',
    'collections-follow-up:payment_plans.propose',
    'collections-follow-up:customer_messages.send',
    'refund-triage:refund_requests.prepare',
    'membership-renewal:customer_messages.send',
    'lapsed-customer-reactivation:customer_messages.send',
    'referral-request:customer_messages.send',
    'new-customer-onboarding:customer_messages.send',
    'dispute-intake:customer_messages.send',
    'customer-data-hygiene:client_merge_suggestions.create',
    'appointment-reminder:customer_messages.send',
    'no-show-follow-up:customer_messages.send',
    'service-due-reminder:customer_messages.send',
    'post-job-check-in:customer_messages.send',
  ]);
  assert.equal(loaded.get('collections-follow-up').role.autonomy, 'auto');
});

test('no prompt uses a placeholder other than company_name and vertical', () => {
  for (const id of BATCH) {
    const found = [...loaded.get(id).role.systemPrompt.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map(
      (m) => m[1],
    );
    assert.ok(found.every((p) => p === 'company_name' || p === 'vertical'), `${id}: ${found.join(', ')}`);
    assert.ok(found.includes('company_name') && found.includes('vertical'), id);
  }
});

test('sourceRef values are Desk presets, Field native ids, or new', () => {
  const allowed = new Set([...lib.DESK_PRESET_NAMES, ...lib.FIELD_NATIVE_ROLE_IDS, 'new']);
  for (const id of BATCH) {
    assert.ok(allowed.has(loaded.get(id).role.sourceRef), `${id}: ${loaded.get(id).role.sourceRef}`);
  }
});

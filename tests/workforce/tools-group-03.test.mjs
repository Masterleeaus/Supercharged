/**
 * Tests for server/workforce/tools/handlers/group-03.ts. No network, no database.
 * Run: node --test --experimental-transform-types tests/workforce/tools-group-03.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

// zod may be missing from node_modules. Route it to the fallback copy when needed (same as tool-schema-coverage).
try {
  await import('zod');
} catch {
  const entry = process.env.ZOD_FALLBACK_ENTRY ?? '/opt/npm-tools/node_modules/zod/index.js';
  register('./zod-fallback.hooks.mjs', import.meta.url, { data: { entry } });
}

// Test files must not write to stdout (the runner uses IPC).
console.log = () => {};
console.info = () => {};
console.warn = () => {};

const { createGroup03ToolDefinitions, GROUP03_INPUT_SCHEMAS } = await import(
  '../../server/workforce/tools/handlers/group-03.ts'
);
const { createReadToolDefinitions } = await import('../../server/workforce/tools/read-handlers.ts');

const GROUP_IDS = [
  'property_issues.create',
  'property_issues.list',
  'property_issues.update',
  'purchase_orders.draft',
  'purchase_orders.list',
  'quote_requests.create',
  'quotes.list',
  'referral_requests.create',
  'refund_requests.create',
  'refund_requests.list',
  'refund_requests.prepare',
  'reports.weekly_summary',
  'review_alerts.create',
  'reviews.list',
  'reviews.request',
  'safety.escalate_to_human',
  'service_agreements.draft_renewal',
  'service_agreements.list',
];

// One valid input per tool id.
const VALID_INPUT = {
  'property_issues.create': { propertyId: 'p1', summary: 'Gate sticks' },
  'property_issues.list': { propertyId: 'p1', limit: 10 },
  'property_issues.update': { propertyId: 'p1', issueId: 'i1', status: 'resolved' },
  'purchase_orders.draft': { supplierName: 'Acme Parts', items: [{ description: 'Pump seal', quantity: 2 }] },
  'purchase_orders.list': { status: 'open' },
  'quote_requests.create': { clientName: 'Sam', summary: 'Rekey two doors' },
  'quotes.list': { limit: 5 },
  'referral_requests.create': { contactName: 'Lee', referralNote: 'Referred by Kim' },
  'refund_requests.create': { invoiceId: 'inv1', amount: '40.00', reason: 'Duplicate charge' },
  'refund_requests.list': { status: 'open' },
  'refund_requests.prepare': { invoiceId: 'inv1', reason: 'Late arrival' },
  'reports.weekly_summary': { weekStart: '2026-11-02' },
  'review_alerts.create': { reviewId: 'r1', summary: 'Two-star review' },
  'reviews.list': { limit: 20 },
  'reviews.request': { appointmentId: 'a1' },
  'safety.escalate_to_human': { summary: 'Gas smell reported', urgency: 'immediate' },
  'service_agreements.draft_renewal': { agreementId: 'sa1' },
  'service_agreements.list': { status: 'active', limit: 10 },
};

const definitions = new Map(createGroup03ToolDefinitions().map((def) => [def.id, def]));
const readDefinitions = new Map(createReadToolDefinitions({}).map((def) => [def.id, def]));

const ctx = (companyId) => ({ companyId });

test('every group 03 id has a definition in the group and in the read-tool list', () => {
  for (const id of GROUP_IDS) {
    assert.ok(definitions.has(id), `missing group definition: ${id}`);
    assert.ok(readDefinitions.has(id), `missing wired definition: ${id}`);
  }
  assert.equal(definitions.size, GROUP_IDS.length);
});

test('every group 03 definition has an object schema and a positive integer timeoutMs', () => {
  for (const id of GROUP_IDS) {
    const def = definitions.get(id);
    assert.equal(typeof def.schema, 'object', `${id} schema`);
    assert.ok(Number.isInteger(def.timeoutMs) && def.timeoutMs > 0, `${id} timeoutMs`);
  }
});

test('the zod input schema for each id parses a valid input', () => {
  for (const id of GROUP_IDS) {
    const result = GROUP03_INPUT_SCHEMAS[id].safeParse(VALID_INPUT[id]);
    assert.ok(result.success, `${id} rejected a valid input`);
  }
});

test('each zod input schema rejects a companyId key and an unknown key', () => {
  for (const id of GROUP_IDS) {
    const withCompany = GROUP03_INPUT_SCHEMAS[id].safeParse({ ...VALID_INPUT[id], companyId: 'company-b' });
    const withExtra = GROUP03_INPUT_SCHEMAS[id].safeParse({ ...VALID_INPUT[id], unexpected: true });
    assert.equal(withCompany.success, false, `${id} accepted companyId in input`);
    assert.equal(withExtra.success, false, `${id} accepted an unknown key`);
  }
});

test('handlers return not_implemented and never another company data, for either company', async () => {
  for (const id of GROUP_IDS) {
    const def = definitions.get(id);
    const forA = await def.handler(VALID_INPUT[id], ctx('company-a'));
    const forB = await def.handler(VALID_INPUT[id], ctx('company-b'));
    assert.equal(forA.status, 'not_implemented', `${id} status`);
    assert.equal(forA.tool, id);
    assert.ok(forA.reason.length > 0, `${id} needs a reason`);
    assert.deepEqual(forA, forB, `${id} result differs by company`);
  }
});

test('handlers refuse a call with no company and a companyId smuggled into input', async () => {
  for (const id of GROUP_IDS) {
    const def = definitions.get(id);
    await assert.rejects(async () => def.handler(VALID_INPUT[id], ctx('')), /company/i, `${id} accepted no company`);
    await assert.rejects(
      async () => def.handler({ ...VALID_INPUT[id], companyId: 'company-b' }, ctx('company-a')),
      /invalid input/,
      `${id} accepted companyId in input`,
    );
  }
});

test('side-effect tools carry the approval category or are drafts', () => {
  assert.equal(definitions.get('refund_requests.create').category, 'money');
  assert.equal(definitions.get('refund_requests.prepare').category, 'money');
  assert.equal(definitions.get('reviews.request').category, 'customer_send');
  assert.equal(definitions.get('referral_requests.create').category, 'customer_send');
  assert.equal(definitions.get('purchase_orders.draft').id.split('.').pop(), 'draft');
  assert.equal(definitions.get('service_agreements.draft_renewal').id.split('.').pop(), 'draft_renewal');
});

test('the group source file imports no provider or network client', () => {
  const source = readFileSync(new URL('../../server/workforce/tools/handlers/group-03.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"](node:)?(http|https|net|fetch)|twilio|sendgrid|stripe|fetch\(/i);
});

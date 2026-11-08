/**
 * Group 01 tool definitions (server/workforce/tools/handlers/group-01.ts).
 * For each of the 18 ids: a definition exists, its zod input parses a valid input, its timeoutMs is a positive integer,
 * and an unknown or company-scoped key in input is rejected. Only customer_messages.draft runs as code. The other 17
 * return not_implemented and read no company data, so the cross-company check covers what can be checked here:
 * companyId is taken from the caller context, and a companyId key in input is refused.
 * Run: node --test --experimental-transform-types tests/workforce/tools-group-01.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

try {
  await import('zod');
} catch {
  const entry = process.env.ZOD_FALLBACK_ENTRY ?? '/opt/npm-tools/node_modules/zod/index.js';
  register('./zod-fallback.hooks.mjs', import.meta.url, { data: { entry } });
}

// Test files must not write to stdout (the runner uses IPC). Silence console before importing server code.
for (const method of ['log', 'info', 'warn']) console[method] = () => {};

const { GROUP_01_TOOL_IDS, GROUP_01_INPUT_SCHEMAS, createGroup01ToolDefinitions } = await import(
  '../../server/workforce/tools/handlers/group-01.ts'
);

const EXPECTED_IDS = [
  'crew_rosters.update',
  'customer_messages.draft',
  'customer_messages.send',
  'disputes.create',
  'end_of_lease_checklists.create',
  'escalations.create',
  'estimates.create',
  'estimates.list',
  'feedback_responses.create',
  'feedback_surveys.send',
  'human_escalation.create',
  'identity.verify_request',
  'inventory.list',
  'invoice_disputes.create',
  'job_checklists.list',
  'job_notes.create',
  'job_photos.list',
  'job_photos.request_from_customer',
];

const definitions = new Map(createGroup01ToolDefinitions().map((def) => [def.id, def]));
const COMPANY_A = '11111111-1111-4111-8111-111111111111';
const COMPANY_B = '22222222-2222-4222-8222-222222222222';

const VALID_DRAFT = { body: 'Your clean is booked for Tuesday.', channel: 'sms', customerName: 'Sam' };

test('the group owns exactly the 18 assigned ids', () => {
  assert.deepEqual([...GROUP_01_TOOL_IDS].sort(), EXPECTED_IDS);
  assert.equal(definitions.size, 18);
});

test('every id has a definition with a schema object and a positive integer timeoutMs', () => {
  for (const id of EXPECTED_IDS) {
    const def = definitions.get(id);
    assert.ok(def, `missing definition: ${id}`);
    assert.equal(typeof def.schema, 'object', `schema for ${id}`);
    assert.ok(def.schema !== null, `schema for ${id} is null`);
    assert.ok(Number.isInteger(def.timeoutMs) && def.timeoutMs > 0, `timeoutMs for ${id}`);
  }
});

test('every id has a zod input schema that rejects a companyId key', () => {
  for (const id of EXPECTED_IDS) {
    const zodSchema = GROUP_01_INPUT_SCHEMAS[id];
    assert.ok(zodSchema, `missing zod input schema: ${id}`);
    assert.equal(zodSchema.safeParse({ companyId: COMPANY_B }).success, false, `${id} accepted companyId in input`);
  }
});

test('the draft tool parses a valid input and rejects an unknown key', () => {
  const schema = GROUP_01_INPUT_SCHEMAS['customer_messages.draft'];
  assert.equal(schema.safeParse(VALID_DRAFT).success, true);
  assert.equal(schema.safeParse({ body: 'hi', extra: 1 }).success, false);
  assert.equal(schema.safeParse({ body: '' }).success, false);
});

test('the not-implemented tools accept an empty input and reject any field', () => {
  for (const id of EXPECTED_IDS) {
    if (id === 'customer_messages.draft') continue;
    const schema = GROUP_01_INPUT_SCHEMAS[id];
    assert.equal(schema.safeParse({}).success, true, `${id} rejected empty input`);
    assert.equal(schema.safeParse({ id: 'x' }).success, false, `${id} accepted a field`);
  }
});

test('the draft handler uses the caller company and never returns data from another company', async () => {
  const def = definitions.get('customer_messages.draft');
  const result = await def.handler({ body: 'Reminder text' }, { companyId: COMPANY_A });
  assert.equal(result.status, 'draft');
  assert.equal(result.sent, false);
  assert.ok(!JSON.stringify(result).includes(COMPANY_B), 'result carried another company id');
  await assert.rejects(() => def.handler({ body: 'x' }, { companyId: '' }), /companyId/);
});

test('side-effect tools return not_implemented and never report a send', async () => {
  const sendIds = ['customer_messages.send', 'feedback_surveys.send', 'job_photos.request_from_customer', 'identity.verify_request'];
  for (const id of sendIds) {
    const result = await definitions.get(id).handler({}, { companyId: COMPANY_A });
    assert.equal(result.status, 'not_implemented', id);
    assert.equal(typeof result.reason, 'string', id);
  }
});

test('the list tools return not_implemented and no rows for any company', async () => {
  for (const id of ['estimates.list', 'inventory.list', 'job_checklists.list', 'job_photos.list']) {
    const result = await definitions.get(id).handler({}, { companyId: COMPANY_A });
    assert.equal(result.status, 'not_implemented', id);
    assert.equal(result.rows, undefined, `${id} returned rows`);
    assert.ok(!JSON.stringify(result).includes(COMPANY_B), `${id} carried another company id`);
  }
});

test('the approval gate is set on customer-send tools', () => {
  for (const id of ['customer_messages.send', 'feedback_surveys.send', 'job_photos.request_from_customer']) {
    assert.equal(definitions.get(id).category, 'customer_send', id);
  }
});

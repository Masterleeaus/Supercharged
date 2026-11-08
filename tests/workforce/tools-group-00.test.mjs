/**
 * Group 00 tools: each id has a definition, a schema that accepts a valid input, a positive timeoutMs, and a
 * handler that never returns data for a company other than the caller's. Every group 00 handler returns
 * `not_implemented` (no source table exists in this repo), so the company check is that the input cannot carry a
 * companyId and that the caller's company id is required.
 * Run: node --test --experimental-transform-types tests/workforce/tools-group-00.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Silence console output so the test runner's IPC is not broken by server imports.
for (const method of ['log', 'info', 'warn']) console[method] = () => {};

const { createGroup00ToolDefinitions, GROUP_00_INPUT_SCHEMAS } = await import(
  '../../server/workforce/tools/handlers/group-00.ts'
);

const GROUP_00_IDS = [
  'after_hours.page_on_call',
  'agreements.list',
  'agreements.renewal_draft',
  'availability.read',
  'booking_requests.create',
  'booking_requests.update',
  'campaign_messages.create',
  'client_duplicates.list',
  'client_merge_suggestions.create',
  'clients.create',
  'clients.get',
  'clients.list',
  'collection_notes.create',
  'complaints.create',
  'compliance_certificates.list',
  'compliance_documents.list',
  'compliance_reminders.send',
  'crew_rosters.list',
];

// One valid input per tool. Each must pass its zod schema.
const VALID_INPUTS = {
  'after_hours.page_on_call': { reason: 'Gas smell reported at site' },
  'agreements.list': { status: 'active', limit: 10 },
  'agreements.renewal_draft': { agreementId: 'agr-1' },
  'availability.read': { date: '2026-11-10', durationMinutes: 60 },
  'booking_requests.create': { name: 'Ana Lee', phone: '+61400000000', serviceName: 'Carpet clean' },
  'booking_requests.update': { requestId: 'req-1', status: 'reviewed' },
  'campaign_messages.create': { campaignId: 'cmp-1', channel: 'sms', body: 'Spring offer' },
  'client_duplicates.list': { limit: 5 },
  'client_merge_suggestions.create': { clientIds: ['c-1', 'c-2'] },
  'clients.create': { name: 'Ana Lee', email: 'ana@example.com' },
  'clients.get': { id: 'c-1' },
  'clients.list': { query: 'Lee', limit: 20 },
  'collection_notes.create': { invoiceId: 'inv-1', note: 'Called, promised payment Friday' },
  'complaints.create': { description: 'Missed a window' },
  'compliance_certificates.list': { status: 'expiring', limit: 10 },
  'compliance_documents.list': { limit: 10 },
  'compliance_reminders.send': { certificateId: 'cert-1', channel: 'email' },
  'crew_rosters.list': { fromDate: '2026-11-09', toDate: '2026-11-15' },
};

const definitions = new Map(createGroup00ToolDefinitions().map((def) => [def.id, def]));
const context = (companyId) => ({ companyId, signal: new AbortController().signal });

test('every group 00 id has a definition', () => {
  const missing = GROUP_00_IDS.filter((id) => !definitions.has(id));
  assert.deepEqual(missing, []);
  assert.equal(definitions.size, GROUP_00_IDS.length);
});

test('every group 00 id has an input schema that accepts a valid input and rejects a companyId key', () => {
  for (const id of GROUP_00_IDS) {
    const schema = GROUP_00_INPUT_SCHEMAS.get(id);
    assert.ok(schema, `no zod schema for ${id}`);
    assert.equal(schema.safeParse(VALID_INPUTS[id]).success, true, `valid input refused for ${id}`);
    const withTenant = schema.safeParse({ ...VALID_INPUTS[id], companyId: 'company-b' });
    assert.equal(withTenant.success, false, `companyId key accepted for ${id}`);
  }
});

test('every group 00 id has a positive integer timeoutMs and a field schema', () => {
  for (const id of GROUP_00_IDS) {
    const def = definitions.get(id);
    assert.ok(Number.isInteger(def.timeoutMs) && def.timeoutMs > 0, `bad timeoutMs for ${id}`);
    assert.equal(typeof def.schema, 'object', `no field schema for ${id}`);
  }
});

test('side-effect tools are held for approval before the handler runs', () => {
  for (const id of ['campaign_messages.create', 'compliance_reminders.send']) {
    assert.equal(definitions.get(id).category, 'customer_send', `${id} must carry the customer_send gate`);
  }
});

test('handlers return not_implemented with a reason and no data, for the caller company only', async () => {
  for (const id of GROUP_00_IDS) {
    const def = definitions.get(id);
    const ownResult = await def.handler(VALID_INPUTS[id], context('company-a'));
    assert.equal(ownResult.status, 'not_implemented', `${id} did not return not_implemented`);
    assert.equal(typeof ownResult.reason, 'string');
    assert.ok(ownResult.reason.length > 0);
    // The result carries no rows, so no other company's record can appear in it.
    assert.equal('rows' in ownResult, false, `${id} returned rows`);
    assert.equal(JSON.stringify(ownResult).includes('company-b'), false);
  }
});

test('handlers refuse a call with no company id and a body that carries a companyId', async () => {
  const id = 'clients.get';
  await assert.rejects(async () => definitions.get(id).handler({ id: 'c-1' }, context('')), /companyId is required/);
  await assert.rejects(
    async () => definitions.get(id).handler({ id: 'c-1', companyId: 'company-b' }, context('company-a')),
    /invalid input: companyId/,
  );
});

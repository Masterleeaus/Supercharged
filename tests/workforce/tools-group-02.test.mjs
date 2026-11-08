/**
 * Tests for server/workforce/tools/handlers/group-02.ts. No network, no database.
 * Run: node --test --experimental-transform-types tests/workforce/tools-group-02.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Silence console output so the test runner's IPC is not broken by server imports.
for (const method of ['log', 'info', 'warn']) console[method] = () => {};

const { createGroup02ToolDefinitions, GROUP_02_SPECS } = await import(
  '../../server/workforce/tools/handlers/group-02.ts'
);
const { createReadToolDefinitions } = await import('../../server/workforce/tools/read-handlers.ts');

const GROUP_IDS = [
  'job_signoff.record',
  'job_signoff.request',
  'maintenance_plans.create',
  'materials.check',
  'messages.draft_customer',
  'messages.send',
  'messages.send_customer',
  'opportunities.create',
  'ownership.verify',
  'parts_lists.list',
  'payment_plans.propose',
  'pool_equipment.list',
  'pool_equipment_faults.create',
  'pool_profiles.list',
  'project_visits.bulk',
  'project_visits.list',
  'projects.get',
  'projects.list',
  'properties.list',
  'property_contacts.list',
];

// One valid input per tool. Each must parse against that tool's schema.
const VALID_INPUT = {
  'job_signoff.record': { jobId: 'job-1', outcome: 'signed', signedByName: 'Pat Client' },
  'job_signoff.request': { jobId: 'job-1' },
  'maintenance_plans.create': {
    clientId: 'client-1',
    serviceName: 'Quarterly clean',
    frequency: 'quarterly',
    startDate: '2026-12-01',
  },
  'materials.check': { jobId: 'job-1' },
  'messages.draft_customer': { clientId: 'client-1', purpose: 'Confirm visit' },
  'messages.send': { clientId: 'client-1', channel: 'sms', body: 'See you Tuesday.' },
  'messages.send_customer': { clientId: 'client-1', channel: 'email', body: 'See you Tuesday.' },
  'opportunities.create': { title: 'Spring clean', valueCents: 25000 },
  'ownership.verify': { clientId: 'client-1', method: 'document' },
  'parts_lists.list': { jobId: 'job-1', limit: 10 },
  'payment_plans.propose': { invoiceId: 'inv-1', installments: 3, firstDueDate: '2026-12-15' },
  'pool_equipment.list': { poolId: 'pool-1' },
  'pool_equipment_faults.create': { poolId: 'pool-1', description: 'Pump is noisy', severity: 'medium' },
  'pool_profiles.list': { clientId: 'client-1' },
  'project_visits.bulk': {
    jobId: 'job-1',
    visits: [{ scheduledDate: '2026-12-02', startTime: '09:30', durationMinutes: 90 }],
  },
  'project_visits.list': { jobId: 'job-1' },
  'projects.get': { id: 'job-1' },
  'projects.list': { status: 'open', limit: 5 },
  'properties.list': { clientId: 'client-1' },
  'property_contacts.list': { propertyId: 'prop-1' },
};

const definitions = createGroup02ToolDefinitions();
const byId = new Map(definitions.map((def) => [def.id, def]));
const specById = new Map(GROUP_02_SPECS.map((spec) => [spec.id, spec]));

const stubStore = new Proxy({}, { get: () => async () => [] });
const wired = new Map(createReadToolDefinitions(stubStore).map((def) => [def.id, def]));

test('every group 02 id has a definition and is wired into createReadToolDefinitions', () => {
  assert.equal(definitions.length, GROUP_IDS.length);
  const missing = GROUP_IDS.filter((toolId) => !byId.has(toolId));
  assert.deepEqual(missing, [], `no definition for: ${missing.join(', ')}`);
  const unwired = GROUP_IDS.filter((toolId) => !wired.has(toolId));
  assert.deepEqual(unwired, [], `not wired into createReadToolDefinitions: ${unwired.join(', ')}`);
});

test('every group 02 id has a valid input sample', () => {
  for (const toolId of GROUP_IDS) assert.ok(VALID_INPUT[toolId], `no sample input for ${toolId}`);
});

test('each schema is an object and its zod schema parses a valid input', () => {
  for (const toolId of GROUP_IDS) {
    const def = byId.get(toolId);
    assert.equal(typeof def.schema, 'object', `${toolId} has no field schema`);
    const parsed = specById.get(toolId).input.safeParse(VALID_INPUT[toolId]);
    assert.ok(parsed.success, `${toolId} rejects a valid input`);
  }
});

test('each zod schema rejects an input that carries companyId', () => {
  for (const toolId of GROUP_IDS) {
    const withCompany = { ...VALID_INPUT[toolId], companyId: 'company-b' };
    assert.equal(specById.get(toolId).input.safeParse(withCompany).success, false, `${toolId} accepts companyId`);
  }
});

test('each definition has a positive integer timeoutMs and a valid risk', () => {
  for (const toolId of GROUP_IDS) {
    const def = byId.get(toolId);
    assert.ok(Number.isInteger(def.timeoutMs) && def.timeoutMs > 0, `${toolId} timeoutMs ${def.timeoutMs}`);
    assert.ok(['low', 'medium', 'high', 'critical'].includes(def.risk), `${toolId} risk ${def.risk}`);
  }
});

test('side-effect tools carry the category that routes them to approval', () => {
  assert.equal(byId.get('messages.send').category, 'customer_send');
  assert.equal(byId.get('messages.send_customer').category, 'customer_send');
  assert.equal(byId.get('job_signoff.request').category, 'customer_send');
  assert.equal(byId.get('payment_plans.propose').category, 'money');
});

test('every handler returns not_implemented with a reason and no records', async () => {
  for (const toolId of GROUP_IDS) {
    const result = await byId.get(toolId).handler(VALID_INPUT[toolId], { companyId: 'company-a' });
    assert.equal(result.status, 'not_implemented', toolId);
    assert.equal(result.toolId, toolId);
    assert.ok(result.reason.length > 0, `${toolId} has no reason`);
    assert.equal(Object.keys(result).length, 3, `${toolId} returns extra fields`);
  }
});

test('handlers do not return another company’s records', async () => {
  for (const toolId of GROUP_IDS) {
    const forA = await byId.get(toolId).handler(VALID_INPUT[toolId], { companyId: 'company-a' });
    const forB = await byId.get(toolId).handler(VALID_INPUT[toolId], { companyId: 'company-b' });
    assert.deepEqual(forA, forB, `${toolId} output depends on company`);
    assert.ok(
      Object.values(forA).every((value) => !Array.isArray(value)),
      `${toolId} returns a list of rows`,
    );
  }
});

test('handlers reject a missing or invalid company id', async () => {
  for (const toolId of GROUP_IDS) {
    await assert.rejects(
      byId.get(toolId).handler(VALID_INPUT[toolId], { companyId: undefined }),
      /companyId is required/,
      toolId,
    );
    await assert.rejects(
      byId.get(toolId).handler(VALID_INPUT[toolId], { companyId: 'bad id with spaces' }),
      /companyId must be/,
      toolId,
    );
  }
});

test('handlers reject unknown input keys without echoing values', async () => {
  await assert.rejects(
    byId.get('projects.get').handler({ id: 'job-1', companyId: 'company-b' }, { companyId: 'company-a' }),
    (error) => error.message === 'invalid input: companyId',
  );
});

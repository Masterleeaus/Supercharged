/**
 * Group 04 tool checks. Each id must have a definition, a strict input schema that parses a valid input, a positive
 * integer timeoutMs, and a handler that refuses a missing or tenant-override companyId. No group 04 handler reads a
 * table yet, so the company check is that the result carries no rows and no other company's data.
 * Run: node --test --experimental-transform-types tests/workforce/tools-group-04.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Silence console output so the test runner's IPC is not broken by server imports.
for (const method of ['log', 'info', 'warn']) console[method] = () => {};

const { createGroup04ToolDefinitions, GROUP_04_INPUT_SCHEMAS, GROUP_04_TOOL_IDS } = await import(
  '../../server/workforce/tools/handlers/group-04.ts'
);
const { createReadToolDefinitions } = await import('../../server/workforce/tools/read-handlers.ts');

const EXPECTED_IDS = [
  'service_schedules.list', 'service_visits.list', 'service_visits.reschedule', 'service_visits.schedule',
  'site_visits.schedule', 'sites.list', 'staff_tasks.create', 'supplier_bills.list', 'technician_tasks.create',
  'timesheet_flags.create', 'timesheets.list', 'users.list', 'visits.get', 'visits.transition', 'visits.update',
  'water_test_results.list', 'water_tests.schedule', 'work_notes.list', 'work_orders.list', 'work_orders.start_visit',
];

// One valid example input per id, matching its strict zod schema.
const VALID_INPUT = {
  'service_schedules.list': { limit: 10 },
  'service_visits.list': { status: 'open' },
  'service_visits.reschedule': { id: 'sv-1', startsAt: '2026-11-10T09:00:00Z' },
  'service_visits.schedule': { siteId: 'site-1', startsAt: '2026-11-10T09:00:00Z' },
  'site_visits.schedule': { siteId: 'site-1', startsAt: '2026-11-10T09:00:00Z' },
  'sites.list': { limit: 5 },
  'staff_tasks.create': { title: 'Call back client' },
  'supplier_bills.list': {},
  'technician_tasks.create': { title: 'Check access code', relatedId: 'v-1' },
  'timesheet_flags.create': { timesheetId: 'ts-1', reason: 'Missing break' },
  'timesheets.list': { status: 'open' },
  'users.list': { limit: 20 },
  'visits.get': { id: 'v-1' },
  'visits.transition': { id: 'v-1', toState: 'completed' },
  'visits.update': { id: 'v-1', startsAt: '2026-11-10T10:00:00Z' },
  'water_test_results.list': {},
  'water_tests.schedule': { poolId: 'pool-1', scheduledFor: '2026-11-11' },
  'work_notes.list': { limit: 10 },
  'work_orders.list': { status: 'open', limit: 10 },
  'work_orders.start_visit': { id: 'wo-1' },
};

const definitions = new Map(createGroup04ToolDefinitions().map((def) => [def.id, def]));
const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';

test('group 04 defines exactly the 20 assigned ids', () => {
  assert.deepEqual([...GROUP_04_TOOL_IDS].sort(), [...EXPECTED_IDS].sort());
  assert.equal(definitions.size, EXPECTED_IDS.length);
});

test('every group 04 id has a definition wired into the read tool definitions', () => {
  const wired = new Set(createReadToolDefinitions({}).map((def) => def.id));
  for (const id of EXPECTED_IDS) {
    assert.ok(definitions.has(id), `missing definition: ${id}`);
    assert.ok(wired.has(id), `not wired into createReadToolDefinitions: ${id}`);
  }
});

test('every group 04 id has a field schema and a positive integer timeoutMs', () => {
  for (const id of EXPECTED_IDS) {
    const def = definitions.get(id);
    assert.equal(typeof def.schema, 'object', `schema for ${id}`);
    assert.ok(Number.isInteger(def.timeoutMs) && def.timeoutMs > 0, `timeoutMs for ${id}`);
  }
});

test('each zod input schema parses a valid input and rejects an unknown companyId key', () => {
  for (const id of EXPECTED_IDS) {
    const schema = GROUP_04_INPUT_SCHEMAS[id];
    assert.ok(schema, `no input schema for ${id}`);
    assert.equal(schema.safeParse(VALID_INPUT[id]).success, true, `valid input rejected for ${id}`);
    assert.equal(schema.safeParse({ ...VALID_INPUT[id], companyId: COMPANY_B }).success, false, `companyId accepted for ${id}`);
  }
});

test('every handler returns not_implemented with a reason and no rows, for the caller company only', async () => {
  for (const id of EXPECTED_IDS) {
    const def = definitions.get(id);
    const result = await def.handler(VALID_INPUT[id], { companyId: COMPANY_A, signal: new AbortController().signal });
    assert.equal(result.status, 'not_implemented', id);
    assert.equal(result.tool, id);
    assert.ok(result.reason.length > 0, `reason for ${id}`);
    assert.equal('rows' in result, false, `unexpected rows for ${id}`);
    assert.equal(JSON.stringify(result).includes(COMPANY_B), false, `other company leaked for ${id}`);
  }
});

test('handlers refuse a missing companyId and a companyId smuggled in the input', async () => {
  const def = definitions.get('visits.get');
  await assert.rejects(async () => def.handler({ id: 'v-1' }, { companyId: '', signal: new AbortController().signal }));
  await assert.rejects(async () =>
    def.handler({ id: 'v-1', companyId: COMPANY_B }, { companyId: COMPANY_A, signal: new AbortController().signal }),
  );
});

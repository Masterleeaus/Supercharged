/**
 * Tests for the group 04 handlers (server/workforce/tools/handlers/group-04.ts). Fake SQL executor, no database.
 * Run: node --test --experimental-transform-types tests/workforce/tools-real-04.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Silence console output so the test runner's IPC is not broken by server imports.
for (const method of ['log', 'info', 'warn']) console[method] = () => {};

const {
  createGroup04ToolDefinitions,
  GROUP04_IDS,
  GROUP04_INPUT_SCHEMAS,
  GROUP04_NOT_IMPLEMENTED,
} = await import('../../server/workforce/tools/handlers/group-04.ts');
const { createReadToolDefinitions } = await import('../../server/workforce/tools/read-handlers.ts');
const { createToolRegistry } = await import('../../server/workforce/runtime/index.ts');

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const V_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const V_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const W_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const P_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const T_A = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const C_A = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const EXPECTED_IDS = [
  'service_schedules.list',
  'service_visits.list',
  'service_visits.reschedule',
  'service_visits.schedule',
  'site_visits.schedule',
  'sites.list',
  'staff_tasks.create',
  'supplier_bills.list',
  'technician_tasks.create',
  'timesheet_flags.create',
  'timesheets.list',
  'users.list',
  'visits.get',
  'visits.transition',
  'visits.update',
  'water_test_results.list',
  'water_tests.schedule',
  'work_notes.list',
  'work_orders.list',
  'work_orders.start_visit',
];

const READ_IDS = EXPECTED_IDS.filter((id) => ['list', 'get'].includes(id.split('.').pop()));

/** Rows for two companies, one table per FROM name the handlers use. */
function tableRows() {
  const both = (make) => [make(CO_A, 'a'), make(CO_B, 'b')];
  return {
    maintenance_plans: both((company_id, n) => ({ company_id, id: `plan-${n}`, client_id: C_A, property_id: null, name: `Plan ${n}`, frequency: 'monthly', status: 'active', next_scheduled_date: null })),
    visits: [
      { company_id: CO_A, id: V_A, work_order_id: W_A, assigned_user_id: null, status: 'scheduled', scheduled_start: new Date('2026-11-10T09:00:00Z'), scheduled_end: new Date('2026-11-10T10:00:00Z'), arrived_at: null, completed_at: null, tech_notes: 'secret note' },
      { company_id: CO_B, id: V_B, work_order_id: W_A, assigned_user_id: null, status: 'scheduled', scheduled_start: new Date('2026-11-10T09:00:00Z'), scheduled_end: new Date('2026-11-10T10:00:00Z'), arrived_at: null, completed_at: null, tech_notes: 'other company' },
    ],
    properties: both((company_id, n) => ({ company_id, id: `site-${n}`, client_id: C_A, name: null, address: `${n} Street`, city: null, state: null, zip: null, notes: 'gate code 1234' })),
    supplier_bills: both((company_id, n) => ({ company_id, id: `bill-${n}`, purchase_order_id: null, supplier_name: `Supplier ${n}`, bill_number: `B${n}`, amount_cents: 1000, due_date: null, status: 'received', received_at: new Date('2026-11-01T00:00:00Z') })),
    timesheets: both((company_id, n) => ({ company_id, id: `ts-${n}`, user_id: C_A, work_date: new Date(2026, 10, 2), started_at: null, ended_at: null, hours: '7.50', status: 'open' })),
    water_test_results: both((company_id, n) => ({ company_id, id: `wtr-${n}`, water_test_id: null, pool_profile_id: P_A, tested_at: new Date('2026-11-02T00:00:00Z'), free_chlorine: '2.1', ph: '7.4', total_alkalinity_ppm: 90, notes: null })),
    job_notes: both((company_id, n) => ({ company_id, id: `note-${n}`, work_order_id: W_A, visit_id: null, body: `Note ${n}`, author_user_id: null, created_at: new Date('2026-11-02T00:00:00Z') })),
    work_orders: both((company_id, n) => ({ company_id, id: `wo-${n}`, client_id: C_A, property_id: null, title: `Job ${n}`, status: 'scheduled', total_cents: 0, completed_at: null, scope: 'internal scope', safety_notes: 'hazard' })),
    users: both((company_id, n) => ({ company_id, id: `user-${n}`, name: `Worker ${n}`, is_active: true, email: `w${n}@example.test`, password: 'hash' })),
  };
}

/**
 * Fake SQL executor. It reads the table from the first FROM clause. With honourScope it applies `company_id = $1`
 * the way Postgres would, using the first bound value. Without it, it returns every row (a leaking query).
 */
function fakeDb({ honourScope = true, respond } = {}) {
  const tables = tableRows();
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      if (respond) {
        const custom = respond(text, values);
        if (custom !== undefined) return { rows: custom, rowCount: custom.length };
      }
      const match = /FROM\s+(\w+)/.exec(text);
      let rows = match && tables[match[1]] ? tables[match[1]] : [];
      if (honourScope && /company_id = \$1/.test(text)) rows = rows.filter((row) => row.company_id === values[0]);
      return { rows: rows.slice(), rowCount: rows.length };
    },
  };
}

const defs = (db) => Object.fromEntries(createGroup04ToolDefinitions({ db }).map((d) => [d.id, d]));
const ctx = (companyId, extra = {}) => ({ companyId, signal: new AbortController().signal, ...extra });

const VALID = {
  'service_schedules.list': {},
  'service_visits.list': { limit: 5 },
  'service_visits.schedule': { workOrderId: W_A, scheduledStart: '2026-11-10T09:00:00Z', scheduledEnd: '2026-11-10T10:00:00Z' },
  'service_visits.reschedule': { visitId: V_A, scheduledStart: '2026-11-11T09:00:00Z', scheduledEnd: '2026-11-11T10:00:00Z' },
  'site_visits.schedule': {},
  'sites.list': { clientId: C_A },
  'staff_tasks.create': { title: 'Check gate' },
  'supplier_bills.list': { status: 'paid' },
  'technician_tasks.create': { title: 'Fit lock', visitId: V_A },
  'timesheet_flags.create': { timesheetId: T_A, reason: 'Hours look high' },
  'timesheets.list': { fromDate: '2026-11-01' },
  'users.list': { limit: 10 },
  'visits.get': { id: V_A },
  'visits.transition': { id: V_A, to: 'completed' },
  'visits.update': { id: V_A, techNotes: 'Done' },
  'water_test_results.list': { poolProfileId: P_A },
  'water_tests.schedule': { poolProfileId: P_A, scheduledFor: '2026-11-12T08:00:00Z' },
  'work_notes.list': { visitId: V_A },
  'work_orders.list': { status: 'scheduled' },
  'work_orders.start_visit': { workOrderId: W_A, visitId: V_A },
};

const INVALID = {
  'service_schedules.list': { status: 'bogus' },
  'service_visits.list': { limit: 500 },
  'service_visits.schedule': { workOrderId: W_A, scheduledStart: '2026-11-10T10:00:00Z', scheduledEnd: '2026-11-10T09:00:00Z' },
  'service_visits.reschedule': { visitId: 'not-a-uuid', scheduledStart: '2026-11-11T09:00:00Z', scheduledEnd: '2026-11-11T10:00:00Z' },
  'site_visits.schedule': { propertyId: 'x' },
  'sites.list': { clientId: 'x' },
  'staff_tasks.create': { title: '' },
  'supplier_bills.list': { status: 'void' },
  'technician_tasks.create': { title: 'x', visitId: 'nope' },
  'timesheet_flags.create': { timesheetId: T_A },
  'timesheets.list': { fromDate: '01/11/2026' },
  'users.list': { limit: 0 },
  'visits.get': { id: '' },
  'visits.transition': { id: V_A, to: 'deleted' },
  'visits.update': { id: V_A },
  'water_test_results.list': { poolProfileId: 'p' },
  'water_tests.schedule': { poolProfileId: P_A, scheduledFor: 'tomorrow' },
  'work_notes.list': {},
  'work_orders.list': { status: 'deleted' },
  'work_orders.start_visit': { workOrderId: W_A },
};

test('the group declares exactly the 20 tool ids', () => {
  assert.deepEqual([...GROUP04_IDS].sort(), EXPECTED_IDS);
  assert.deepEqual(createGroup04ToolDefinitions().map((d) => d.id).sort(), EXPECTED_IDS);
});

test('every id has a definition with a handler, a schema and a risk tier', () => {
  for (const def of createGroup04ToolDefinitions()) {
    assert.equal(typeof def.handler, 'function', `${def.id} handler`);
    assert.equal(typeof def.schema, 'object', `${def.id} schema`);
    assert.ok(['low', 'medium', 'high', 'critical'].includes(def.risk), `${def.id} risk`);
  }
});

test('each id has a zod input schema that accepts a valid input and refuses an invalid one', () => {
  for (const id of EXPECTED_IDS) {
    const schema = GROUP04_INPUT_SCHEMAS[id];
    assert.ok(schema, `${id} has a zod schema`);
    assert.equal(schema.safeParse(VALID[id]).success, true, `${id} accepts a valid input`);
    assert.equal(schema.safeParse(INVALID[id]).success, false, `${id} refuses an invalid input`);
  }
});

test('no input schema accepts a companyId or tenant key', () => {
  for (const id of EXPECTED_IDS) {
    for (const key of ['companyId', 'company_id']) {
      const result = GROUP04_INPUT_SCHEMAS[id].safeParse({ ...VALID[id], [key]: CO_B });
      assert.equal(result.success, false, `${id} must refuse ${key}`);
    }
  }
});

test('every definition has a positive integer timeoutMs: 10000 for reads, 20000 for writes', () => {
  for (const def of createGroup04ToolDefinitions()) {
    assert.ok(Number.isInteger(def.timeoutMs) && def.timeoutMs > 0, `${def.id} timeoutMs`);
    assert.equal(def.timeoutMs, def.access === 'read' ? 10_000 : 20_000, `${def.id} timeoutMs by access`);
  }
});

test('reads are declared read and writes are declared write', () => {
  const byId = Object.fromEntries(createGroup04ToolDefinitions().map((d) => [d.id, d]));
  for (const id of READ_IDS) assert.equal(byId[id].access, 'read', `${id} access`);
  for (const id of EXPECTED_IDS.filter((x) => !READ_IDS.includes(x))) assert.equal(byId[id].access, 'write', `${id} access`);
});

test('only site_visits.schedule is not_implemented, and it says why', async () => {
  assert.deepEqual([...GROUP04_NOT_IMPLEMENTED], ['site_visits.schedule']);
  const result = await defs(undefined)['site_visits.schedule'].handler({}, ctx(CO_A));
  assert.equal(result.status, 'not_implemented');
  assert.match(result.reason, /work order/);
});

test('company-scoped reads send the caller company as $1 and return no other company rows', async () => {
  const scopedIds = READ_IDS.filter((id) => id !== 'visits.get');
  for (const id of [...scopedIds, 'visits.get']) {
    const db = fakeDb();
    const params = id === 'visits.get' ? { id: V_B } : id === 'work_notes.list' ? { workOrderId: W_A } : {};
    const out = await defs(db)[id].handler(params, ctx(CO_A));
    assert.ok(db.calls.length >= 1, `${id} queries the db`);
    for (const call of db.calls) {
      assert.match(call.text, /company_id = \$1/, `${id} filters by company_id = $1`);
      assert.equal(call.values[0], CO_A, `${id} binds the caller company first`);
    }
    const serialised = JSON.stringify(out);
    assert.ok(!serialised.includes(CO_B), `${id} output has no company B id`);
    assert.ok(!serialised.includes('other company'), `${id} output has no company B note`);
    assert.ok(!serialised.includes('company_id'), `${id} output has no company_id field`);
  }
});

test('a query that ignores company scope still returns no other company rows (handler filters again)', async () => {
  for (const id of READ_IDS.filter((x) => x !== 'visits.get')) {
    const db = fakeDb({ honourScope: false });
    const params = id === 'work_notes.list' ? { workOrderId: W_A } : {};
    const out = await defs(db)[id].handler(params, ctx(CO_A));
    assert.ok(!JSON.stringify(out).includes(CO_B), `${id} must drop company B rows`);
  }
  const leaky = fakeDb({ honourScope: false });
  const got = await defs(leaky)['visits.get'].handler({ id: V_B }, ctx(CO_A));
  assert.deepEqual(got, { found: false, row: null }, 'visits.get does not return another company visit');
});

test('list reads report truncation and never exceed 50 rows', async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ company_id: CO_A, id: `u-${i}`, name: `W${i}`, is_active: true }));
  const db = fakeDb({ respond: (text) => (/FROM users/.test(text) ? many : undefined) });
  const out = await defs(db)['users.list'].handler({}, ctx(CO_A));
  assert.equal(out.count, 50);
  assert.equal(out.truncated, true);
  assert.equal(out.maxRows, 50);
});

test('users.list returns only id, name and active state', async () => {
  const out = await defs(fakeDb())['users.list'].handler({}, ctx(CO_A));
  for (const row of out.rows) assert.deepEqual(Object.keys(row).sort(), ['id', 'isActive', 'name']);
});

test('site and work order lists leave out free-text access and safety notes', async () => {
  const sites = await defs(fakeDb())['sites.list'].handler({}, ctx(CO_A));
  const orders = await defs(fakeDb())['work_orders.list'].handler({}, ctx(CO_A));
  assert.ok(!JSON.stringify(sites).includes('gate code'));
  assert.ok(!JSON.stringify(orders).includes('hazard'));
});

test('staff_tasks.create inserts a staff task for the caller company', async () => {
  const db = fakeDb();
  const out = await defs(db)['staff_tasks.create'].handler({ title: 'Check gate', priority: 'high' }, ctx(CO_A));
  assert.equal(out.created, true);
  const call = db.calls[0];
  assert.match(call.text, /^INSERT INTO staff_tasks/);
  assert.equal(call.values[0], CO_A);
  assert.equal(call.values[1], 'staff');
  assert.equal(call.values[2], 'Check gate');
  assert.equal(call.values[7], 'high');
});

test('technician_tasks.create inserts a technician task', async () => {
  const db = fakeDb();
  await defs(db)['technician_tasks.create'].handler({ title: 'Fit lock', visitId: V_A }, ctx(CO_A));
  assert.equal(db.calls[0].values[1], 'technician');
  assert.equal(db.calls[0].values[6], V_A);
});

test('a journal executor on the context is used for the write instead of the fallback db', async () => {
  const fallback = fakeDb();
  const journal = fakeDb();
  await defs(fallback)['staff_tasks.create'].handler({ title: 'Check gate' }, ctx(CO_A, { db: journal }));
  assert.equal(journal.calls.length, 1);
  assert.equal(fallback.calls.length, 0);
});

test('a tool with no executor bound fails closed', async () => {
  const noDb = Object.fromEntries(createGroup04ToolDefinitions().map((d) => [d.id, d]));
  await assert.rejects(() => noDb['visits.get'].handler({ id: V_A }, ctx(CO_A)), /no database executor is bound/);
  await assert.rejects(() => noDb['staff_tasks.create'].handler({ title: 'x' }, ctx(CO_A)), /no database executor is bound/);
});

test('invalid input is refused by field name before any query runs', async () => {
  const db = fakeDb();
  const d = defs(db);
  await assert.rejects(() => d['visits.update'].handler({ id: V_A }, ctx(CO_A)), /invalid input: id/);
  await assert.rejects(
    () => d['service_visits.schedule'].handler({ ...VALID['service_visits.schedule'], scheduledEnd: '2026-11-10T08:00:00Z' }, ctx(CO_A)),
    /invalid input: scheduledEnd/,
  );
  await assert.rejects(() => d['work_notes.list'].handler({}, ctx(CO_A)), /invalid input: workOrderId/);
  await assert.rejects(
    () => d['visits.get'].handler({ id: V_A, companyId: CO_B }, ctx(CO_A)),
    (error) => /invalid input: companyId/.test(error.message) && !error.message.includes(CO_B),
  );
  assert.equal(db.calls.length, 0, 'no query after a refused input');
});

test('visits.transition only moves a visit from a state that may come before the target', async () => {
  const db = fakeDb();
  await defs(db)['visits.transition'].handler({ id: V_A, to: 'completed' }, ctx(CO_A));
  assert.deepEqual(db.calls[0].values, [CO_A, V_A, 'completed', ['in_progress']]);
  assert.match(db.calls[0].text, /status = ANY\(\$4::text\[\]\)/);
});

test('visits.transition reports a refusal when no row changed', async () => {
  const out = await defs(fakeDb({ respond: () => [] }))['visits.transition'].handler({ id: V_A, to: 'arrived' }, ctx(CO_A));
  assert.deepEqual(out, { updated: false, reason: 'not_found_or_invalid_transition' });
});

test('visits.update keeps unchanged fields and leaves closed visits alone', async () => {
  const db = fakeDb({ respond: () => [] });
  const out = await defs(db)['visits.update'].handler({ id: V_A, techNotes: 'Done' }, ctx(CO_A));
  assert.equal(out.updated, false);
  const [companyId, id, start, end, assignee, notes] = db.calls[0].values;
  assert.deepEqual([companyId, id, start, end, assignee, notes], [CO_A, V_A, null, null, null, 'Done']);
  assert.match(db.calls[0].text, /status IN \('scheduled', 'arrived', 'in_progress'\)/);
});

test('service_visits.schedule only inserts under an open work order of the caller company', async () => {
  const db = fakeDb({ respond: (text) => (/^INSERT INTO visits/.test(text.trim()) ? [{ id: V_A, status: 'scheduled' }] : undefined) });
  const out = await defs(db)['service_visits.schedule'].handler(VALID['service_visits.schedule'], ctx(CO_A));
  assert.deepEqual(out, { created: true, id: V_A, status: 'scheduled' });
  assert.equal(db.calls[0].values[0], CO_A);
  assert.match(db.calls[0].text, /FROM work_orders WHERE company_id = \$1/);
});

test('work_orders.start_visit moves the visit and the work order in one statement', async () => {
  const db = fakeDb({ respond: (text) => (/visit_started/.test(text) ? [{ visit_started: true, order_started: true }] : undefined) });
  const out = await defs(db)['work_orders.start_visit'].handler({ workOrderId: W_A, visitId: V_A }, ctx(CO_A));
  assert.deepEqual(out, { started: true, workOrderStarted: true });
  assert.equal(db.calls.length, 1, 'one statement');
  assert.deepEqual(db.calls[0].values, [CO_A, V_A, W_A]);
  assert.match(db.calls[0].text, /UPDATE visits[\s\S]*UPDATE work_orders/);
});

test('timesheet_flags.create and water_tests.schedule insert with the caller company', async () => {
  const flagDb = fakeDb();
  await defs(flagDb)['timesheet_flags.create'].handler({ timesheetId: T_A, reason: 'Hours look high' }, ctx(CO_A));
  assert.equal(flagDb.calls[0].values[0], CO_A);
  assert.equal(flagDb.calls[0].values[1], T_A);

  const waterDb = fakeDb({ respond: (text) => (/INSERT INTO water_tests/.test(text) ? [{ id: 'wt', status: 'scheduled' }] : undefined) });
  const out = await defs(waterDb)['water_tests.schedule'].handler(VALID['water_tests.schedule'], ctx(CO_A));
  assert.deepEqual(out, { created: true, id: 'wt', status: 'scheduled' });
  assert.equal(waterDb.calls[0].values[0], CO_A);
});

test('the registry runs a group 04 read for the caller company and refuses a companyId in params', async () => {
  const audited = [];
  const registry = createToolRegistry({
    gate: {
      gateAction: async () => ({ status: 'approved', approval: { id: 'x' } }),
      readApproval: async () => null,
      claimApproval: async () => false,
    },
    redact: (value) => value,
    audit: { record: async (event) => { audited.push(event); } },
  });
  for (const def of createGroup04ToolDefinitions({ db: fakeDb() })) registry.register(def);
  const actor = { kind: 'agent', agentId: 'agent-1', roleId: 'pool-service-scheduler', autonomy: 'auto' };

  const ok = await registry.invoke({ companyId: CO_A, toolId: 'users.list', params: {}, identityVerified: true, actor });
  assert.equal(ok.outcome, 'executed');
  assert.ok(ok.output.rows.length > 0);
  assert.ok(!JSON.stringify(ok.output).includes(CO_B));

  const refused = await registry.invoke({ companyId: CO_A, toolId: 'users.list', params: { companyId: CO_B }, identityVerified: true, actor });
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.reason, 'tenant_override');
});

test('the registry refuses a per-tool timeoutMs that is not a positive integer', () => {
  const registry = createToolRegistry({
    gate: { gateAction: async () => ({ status: 'approved' }), readApproval: async () => null, claimApproval: async () => false },
    redact: (value) => value,
    audit: { record: async () => {} },
  });
  const base = createGroup04ToolDefinitions()[0];
  assert.throws(() => registry.register({ ...base, timeoutMs: 0 }), /timeoutMs must be a positive integer/);
  assert.throws(() => registry.register({ ...base, timeoutMs: 1.5 }), /timeoutMs must be a positive integer/);
});

test('an assignee is refused on every group 04 write that sets one, before any SQL runs', async () => {
  const cases = [
    ['service_visits.schedule', { workOrderId: W_A, scheduledStart: '2026-11-10T09:00:00Z', scheduledEnd: '2026-11-10T10:00:00Z', assignedUserId: V_A }],
    ['service_visits.reschedule', { visitId: V_A, scheduledStart: '2026-11-11T09:00:00Z', scheduledEnd: '2026-11-11T10:00:00Z', assignedUserId: V_A }],
    ['visits.update', { id: V_A, assignedUserId: V_A }],
    ['staff_tasks.create', { title: 'Check gate', assigneeUserId: V_A }],
    ['technician_tasks.create', { title: 'Fit lock', visitId: V_A, assigneeUserId: V_A }],
  ];
  for (const [id, input] of cases) {
    const db = fakeDb();
    await assert.rejects(defs(db)[id].handler(input, ctx(CO_A, { db })), /assignee cannot be verified/, id);
    assert.equal(db.calls.length, 0, `${id} ran SQL for an unverified assignee`);
  }
});

test('group 04 writes without an assignee are not affected by the assignee refusal', async () => {
  const db = fakeDb();
  await defs(db)['visits.update'].handler({ id: V_A, techNotes: 'Done' }, ctx(CO_A, { db }));
  assert.equal(db.calls.length, 1, 'visits.update without an assignee should still run its query');
});

test('read-handlers binds the group 04 definitions alongside the five read tools', () => {
  const ids = createReadToolDefinitions(new Proxy({}, { get: () => async () => [] })).map((d) => d.id);
  for (const id of EXPECTED_IDS) assert.ok(ids.includes(id), `${id} is bound through read-handlers`);
});

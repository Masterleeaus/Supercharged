/**
 * Tests for workforce tool group 02 (server/workforce/tools/handlers/group-02.ts). Fake executors only, no network, no database.
 * Run: node --test --experimental-transform-types tests/workforce/tools-real-02.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Silence console output so the test runner's IPC is not broken by server imports.
for (const method of ['log', 'info', 'warn']) console[method] = () => {};

const {
  createGroup02ToolDefinitions,
  GROUP_02_TOOL_IDS,
  GROUP_02_NOT_IMPLEMENTED_IDS,
  GROUP_02_INPUT_SCHEMAS,
} = await import('../../server/workforce/tools/handlers/group-02.ts');

const CO_A = '00000000-0000-4000-8000-00000000000a';
const CO_B = '00000000-0000-4000-8000-00000000000b';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

// Seed rows. Company A rows have ids starting '10000000', company B rows '20000000'.
const row = (company, n, extra) => ({ company_id: company, id: `${company === CO_A ? '10' : '20'}000000-0000-4000-8000-00000000000${n}`, ...extra });
const WO_A = row(CO_A, 1).id;
const WO_B = row(CO_B, 1).id;
const PROP_A = row(CO_A, 2).id;
const PROP_B = row(CO_B, 2).id;
const CL_A = row(CO_A, 3).id;
const CL_B = row(CO_B, 3).id;

const SEEDS = {
  work_orders: [
    row(CO_A, 1, { client_id: CL_A, property_id: PROP_A, title: 'Fence A', status: 'scheduled', total_cents: 100, completed_at: null, created_at: new Date('2026-11-01T00:00:00Z'), scope: 'A scope', site_notes: null, safety_notes: null }),
    row(CO_B, 1, { client_id: CL_B, property_id: PROP_B, title: 'Fence B', status: 'scheduled', total_cents: 900, completed_at: null, created_at: new Date('2026-11-01T00:00:00Z'), scope: 'B scope', site_notes: 'B secret', safety_notes: null }),
  ],
  visits: [
    row(CO_A, 4, { work_order_id: WO_A, assigned_user_id: null, status: 'scheduled', scheduled_start: new Date('2026-11-10T09:00:00Z'), scheduled_end: new Date('2026-11-10T11:00:00Z'), arrived_at: null, completed_at: null }),
    row(CO_B, 4, { work_order_id: WO_B, assigned_user_id: null, status: 'scheduled', scheduled_start: new Date('2026-11-10T09:00:00Z'), scheduled_end: new Date('2026-11-10T11:00:00Z'), arrived_at: null, completed_at: null }),
  ],
  properties: [
    row(CO_A, 2, { client_id: CL_A, name: 'Home A', address: '1 A St', city: 'Town', state: 'NS', zip: '1000' }),
    row(CO_B, 2, { client_id: CL_B, name: 'Home B', address: '2 B St', city: 'Town', state: 'NS', zip: '2000' }),
  ],
  property_contacts: [
    row(CO_A, 5, { property_id: PROP_A, client_id: null, external_name: 'Pat A', external_phone: '555-A', external_email: 'a@example.test', role: 'tenant', notes: 'x' }),
    row(CO_B, 5, { property_id: PROP_B, client_id: null, external_name: 'Pat B', external_phone: '555-B', external_email: 'b@example.test', role: 'owner', notes: 'x' }),
  ],
  pool_profiles: [
    row(CO_A, 6, { property_id: PROP_A, name: 'Pool A', volume_litres: 40000, sanitiser: 'salt' }),
    row(CO_B, 6, { property_id: PROP_B, name: 'Pool B', volume_litres: 50000, sanitiser: 'chlorine' }),
  ],
  pool_equipment: [
    row(CO_A, 7, { pool_profile_id: row(CO_A, 6).id, kind: 'pump', make: 'M', model: 'P1', serial: 'S-A', installed_on: null, status: 'ok' }),
    row(CO_B, 7, { pool_profile_id: row(CO_B, 6).id, kind: 'pump', make: 'M', model: 'P1', serial: 'S-B', installed_on: null, status: 'ok' }),
  ],
  job_material_lines: [
    row(CO_A, 8, { work_order_id: WO_A, name: 'Post', quantity: '4.000', unit_label: 'ea', store_section: null, status: 'needed', source: 'manual', sku: null, sort_order: 0 }),
    row(CO_A, 9, { work_order_id: WO_A, name: 'Rail', quantity: '2.000', unit_label: 'ea', store_section: null, status: 'on_truck', source: 'manual', sku: null, sort_order: 1 }),
    row(CO_B, 8, { work_order_id: WO_B, name: 'Post B', quantity: '1.000', unit_label: 'ea', store_section: null, status: 'needed', source: 'manual', sku: null, sort_order: 0 }),
  ],
  clients: [row(CO_A, 3, { name: 'Client A' }), row(CO_B, 3, { name: 'Client B' })],
};

/**
 * Fake read executor. It applies `col = $n` and `col = 'literal'` filters from WHERE, `LIMIT $n`, and GROUP BY for
 * counts. With scoped: false it ignores the company filter, so the handler's own JS filter is what keeps B out.
 */
function fakeDb(seeds, { scoped = true } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      const table = /FROM (\w+)/.exec(text)[1];
      const where = (text.split(' WHERE ')[1] ?? '').split(/ ORDER BY | LIMIT | GROUP BY /)[0];
      let rows = (seeds[table] ?? []).filter((r) => !scoped || r.company_id === values[0]);
      for (const m of where.matchAll(/([a-z_]+) = \$(\d+)/g)) rows = rows.filter((r) => r[m[1]] === values[Number(m[2]) - 1]);
      for (const m of where.matchAll(/([a-z_]+) = '([a-z_]+)'/g)) rows = rows.filter((r) => r[m[1]] === m[2]);
      if (/count\(\*\)/.test(text)) {
        const groups = [...new Set(rows.map((r) => r.company_id))];
        return { rows: groups.map((c) => ({ company_id: c, needed: rows.filter((r) => r.company_id === c).length })), rowCount: groups.length };
      }
      const limit = /LIMIT \$(\d+)/.exec(text);
      if (limit) rows = rows.slice(0, values[Number(limit[1]) - 1]);
      return { rows, rowCount: rows.length };
    },
  };
}

/** Fake write executor: records every statement and returns the rows it is given. */
function recordingDb(rows = []) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      return { rows, rowCount: rows.length };
    },
  };
}

const ctx = (db, companyId = CO_A) => ({ companyId, signal: new AbortController().signal, db });
const defs = (db) => new Map(createGroup02ToolDefinitions({ db }).map((d) => [d.id, d]));

const READ_IDS = [
  'projects.list',
  'projects.get',
  'project_visits.list',
  'properties.list',
  'property_contacts.list',
  'pool_profiles.list',
  'pool_equipment.list',
  'parts_lists.list',
  'materials.check',
];
const WRITE_IDS = ['job_signoff.record', 'maintenance_plans.create', 'opportunities.create', 'pool_equipment_faults.create', 'project_visits.bulk'];

// ---- Definitions and schemas --------------------------------------------------------------------------------------------

test('every group 02 id has a definition, and the set is exactly the 20 ids', () => {
  const definitions = createGroup02ToolDefinitions();
  assert.equal(GROUP_02_TOOL_IDS.length, 20);
  assert.equal(new Set(GROUP_02_TOOL_IDS).size, 20, 'ids are unique');
  assert.deepEqual(definitions.map((d) => d.id).sort(), [...GROUP_02_TOOL_IDS].sort());
  for (const d of definitions) assert.equal(typeof d.handler, 'function', `${d.id} has a handler`);
});

test('timeoutMs is a positive integer: 10000 for reads, 20000 for writes', () => {
  for (const d of createGroup02ToolDefinitions()) {
    assert.ok(Number.isInteger(d.timeoutMs) && d.timeoutMs > 0, `${d.id} timeoutMs`);
    assert.equal(d.timeoutMs, d.access === 'read' ? 10000 : 20000, `${d.id} timeoutMs by access`);
  }
});

const SAMPLES = {
  'projects.list': [{ status: 'scheduled', limit: 5 }, { status: 'bogus' }],
  'projects.get': [{ id: A }, { id: 'not-a-uuid' }],
  'project_visits.list': [{ projectId: A, fromDate: '2026-11-01' }, { fromDate: '11/01/2026' }],
  'properties.list': [{ clientId: A }, { clientId: 'x' }],
  'property_contacts.list': [{ propertyId: A }, {}],
  'pool_profiles.list': [{}, { propertyId: 'x' }],
  'pool_equipment.list': [{ status: 'ok' }, { status: 'broken' }],
  'parts_lists.list': [{ workOrderId: A }, { workOrderId: A, companyId: B }],
  'materials.check': [{ workOrderId: A }, { workOrderId: A, companyId: B }],
  'job_signoff.record': [{ visitId: A, signerName: 'Sam' }, { visitId: A }],
  'maintenance_plans.create': [{ clientId: A, name: 'Gutters', frequency: 'annual' }, { clientId: A, name: 'Gutters', frequency: 'weekly' }],
  'opportunities.create': [{ title: 'Deck repaint' }, { title: '' }],
  'pool_equipment_faults.create': [{ poolEquipmentId: A, summary: 'Pump noise' }, { poolEquipmentId: A, summary: 'x', severity: 'extreme' }],
  'project_visits.bulk': [
    { projectId: A, visits: [{ scheduledStart: '2026-11-10T09:00:00Z', scheduledEnd: '2026-11-10T11:00:00Z' }] },
    { projectId: A, visits: [{ scheduledStart: '2026-11-10T11:00:00Z', scheduledEnd: '2026-11-10T09:00:00Z' }] },
  ],
  'messages.draft_customer': [{ clientId: A, purpose: 'general', body: 'Hello' }, { clientId: A, purpose: 'spam', body: 'x' }],
  'messages.send': [{ clientId: A, body: 'Hi' }, { clientId: A, body: 'Hi', extra: 1 }],
  'messages.send_customer': [{ clientId: A, body: 'Hi' }, { clientId: A, body: 'Hi', extra: 1 }],
  'job_signoff.request': [{ visitId: A, signerName: 'Sam' }, { visitId: 'nope', signerName: 'Sam' }],
  'payment_plans.propose': [{ clientId: A, summary: 'Two instalments' }, { clientId: A }],
  'ownership.verify': [{ propertyId: A, claimantName: 'Lee' }, { propertyId: A }],
};

test('each id has a zod schema that parses a valid input and rejects an invalid one', () => {
  for (const id of GROUP_02_TOOL_IDS) {
    const [valid, invalid] = SAMPLES[id] ?? [];
    assert.ok(valid && invalid, `${id} has sample inputs`);
    assert.equal(GROUP_02_INPUT_SCHEMAS[id].safeParse(valid).success, true, `${id} accepts valid input`);
    assert.equal(GROUP_02_INPUT_SCHEMAS[id].safeParse(invalid).success, false, `${id} rejects invalid input`);
  }
});

test('the registry field schema is present and well formed for each id', () => {
  for (const d of createGroup02ToolDefinitions()) {
    assert.equal(typeof d.schema, 'object', `${d.id} schema`);
    for (const field of Object.values(d.schema)) assert.ok(['string', 'number', 'boolean', 'object', 'array'].includes(field.type));
  }
});

test('side-effect tools route to the approval categories, and drafts keep the draft id', () => {
  const byId = new Map(createGroup02ToolDefinitions().map((d) => [d.id, d]));
  for (const id of ['messages.send', 'messages.send_customer', 'job_signoff.request']) {
    assert.equal(byId.get(id).category, 'customer_send', `${id} is customer_send`);
    assert.equal(byId.get(id).access, 'write');
  }
  assert.equal(byId.get('payment_plans.propose').category, 'money');
  assert.equal(byId.get('messages.draft_customer').id.split('.').pop().startsWith('draft_'), true);
});

test('not_implemented ids are exactly the side-effect and no-table tools', () => {
  assert.deepEqual(
    [...GROUP_02_NOT_IMPLEMENTED_IDS].sort(),
    ['job_signoff.request', 'messages.send', 'messages.send_customer', 'ownership.verify', 'payment_plans.propose'],
  );
});

// ---- Reads: company scope -----------------------------------------------------------------------------------------------

const READ_CASES = [
  ['projects.list', {}, /10000000/],
  ['projects.get', { id: WO_A }, /10000000/],
  ['project_visits.list', {}, /10000000/],
  ['properties.list', {}, /10000000/],
  ['property_contacts.list', { propertyId: PROP_A }, /10000000/],
  ['pool_profiles.list', {}, /10000000/],
  ['pool_equipment.list', {}, /10000000/],
  ['parts_lists.list', { workOrderId: WO_A }, /10000000/],
  ['materials.check', { workOrderId: WO_A }, /10000000/],
];

for (const [id, params, ownPattern] of READ_CASES) {
  test(`${id} returns only the caller's company rows (SQL-scoped and JS-filtered)`, async () => {
    for (const scoped of [true, false]) {
      const db = fakeDb(SEEDS, { scoped });
      const result = await defs(db).get(id).handler(params, ctx(db, CO_A));
      const text = JSON.stringify(result);
      assert.doesNotMatch(text, /20000000|B secret|Pat B|Fence B|Pool B|Post B|Home B/, `${id} leaks company B (scoped=${scoped})`);
      assert.match(text, ownPattern, `${id} returns company A data (scoped=${scoped})`);
      for (const call of db.calls) {
        assert.match(call.text, /company_id = \$1/, `${id} query is company-scoped`);
        assert.equal(call.values[0], CO_A, `${id} binds the caller's company as $1`);
      }
    }
  });
}

test('a company id in the input is refused for every read tool', async () => {
  const db = fakeDb(SEEDS);
  for (const id of READ_IDS) {
    const params = { ...SAMPLES[id][0], companyId: CO_B };
    await assert.rejects(() => defs(db).get(id).handler(params, ctx(db, CO_A)), /invalid input: companyId$/, id);
  }
  assert.equal(db.calls.length, 0, 'no query runs for a refused input');
});

test('projects.get refuses another company\'s project id', async () => {
  const db = fakeDb(SEEDS);
  const result = await defs(db).get('projects.get').handler({ id: WO_B }, ctx(db, CO_A));
  assert.deepEqual(result, { found: false, row: null });
});

test('materials.check counts only the caller\'s needed lines', async () => {
  const db = fakeDb(SEEDS);
  const result = await defs(db).get('materials.check').handler({ workOrderId: WO_A }, ctx(db, CO_A));
  assert.equal(result.neededCount, 1);
  assert.equal(result.ready, false);
});

test('read tools refuse to run without a database executor', async () => {
  const d = createGroup02ToolDefinitions().find((x) => x.id === 'projects.list');
  await assert.rejects(() => d.handler({}, ctx(undefined, CO_A)), /database executor/);
});

test('a read tool bounds its page to the requested limit and reports truncation', async () => {
  const many = Array.from({ length: 60 }, (_, i) => row(CO_A, 1, { id: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`, client_id: CL_A, property_id: null, title: `T${i}`, status: 'draft', total_cents: 0, completed_at: null, created_at: new Date(0) }));
  const db = fakeDb({ work_orders: many });
  const out = await defs(db).get('projects.list').handler({ limit: 3 }, ctx(db, CO_A));
  assert.equal(out.rows.length, 3);
  assert.equal(out.truncated, true);
  const all = await defs(db).get('projects.list').handler({}, ctx(db, CO_A));
  assert.equal(all.rows.length, 50);
  assert.equal(all.truncated, true);
});

// ---- Draft --------------------------------------------------------------------------------------------------------------

test('messages.draft_customer returns a draft for its own client and sends nothing', async () => {
  const db = fakeDb(SEEDS);
  const d = defs(db).get('messages.draft_customer');
  const ok = await d.handler({ clientId: CL_A, purpose: 'general', body: 'Hello' }, ctx(db, CO_A));
  assert.equal(ok.status, 'draft');
  assert.equal(ok.sent, false);
  const other = await d.handler({ clientId: CL_B, purpose: 'general', body: 'Hello' }, ctx(db, CO_A));
  assert.deepEqual(other, { status: 'not_found', found: false });
});

// ---- Writes: journal executor only --------------------------------------------------------------------------------------

test('write tools refuse to run without the journal executor, and write nothing', async () => {
  const d = defs(undefined);
  for (const id of WRITE_IDS) {
    const params = SAMPLES[id][0];
    await assert.rejects(() => d.get(id).handler(params, ctx(undefined, CO_A)), /journal executor/, id);
  }
});

test('job_signoff.record inserts into job_signoffs with the caller company', async () => {
  const journal = recordingDb([{ id: 'so-1', visit_id: A, signer_name: 'Sam', signed_at: new Date(0), notes: null }]);
  const out = await defs(undefined).get('job_signoff.record').handler({ visitId: A, signerName: 'Sam' }, ctx(journal, CO_A));
  assert.match(journal.calls[0].text, /INSERT INTO job_signoffs/);
  assert.equal(journal.calls[0].values[0], CO_A);
  assert.equal(out.id, 'so-1');
});

test('maintenance_plans.create and opportunities.create insert with the caller company', async () => {
  const journal = recordingDb([{ id: 'x-1' }]);
  await defs(undefined).get('maintenance_plans.create').handler({ clientId: A, name: 'Gutters', frequency: 'annual' }, ctx(journal, CO_A));
  await defs(undefined).get('opportunities.create').handler({ title: 'Deck' }, ctx(journal, CO_A));
  assert.match(journal.calls[0].text, /INSERT INTO maintenance_plans/);
  assert.match(journal.calls[1].text, /INSERT INTO opportunities/);
  assert.equal(journal.calls[0].values[0], CO_A);
  assert.equal(journal.calls[1].values[0], CO_A);
});

test('pool_equipment_faults.create inserts a fault with the default minor severity', async () => {
  const journal = recordingDb([{ id: 'f-1', pool_equipment_id: A, summary: 'Pump noise', severity: 'minor', status: 'open', reported_at: new Date(0) }]);
  await defs(undefined).get('pool_equipment_faults.create').handler({ poolEquipmentId: A, summary: 'Pump noise' }, ctx(journal, CO_A));
  assert.match(journal.calls[0].text, /INSERT INTO pool_equipment_faults/);
  assert.equal(journal.calls[0].values[0], CO_A);
  assert.equal(journal.calls[0].values[3], 'minor');
});

test('project_visits.bulk creates new visits and fails the whole batch when a revised visit is not on the project', async () => {
  const journal = recordingDb([{ id: 'v-new' }]);
  const created = await defs(undefined).get('project_visits.bulk').handler(
    { projectId: A, visits: [{ scheduledStart: '2026-11-10T09:00:00Z', scheduledEnd: '2026-11-10T11:00:00Z' }] },
    ctx(journal, CO_A),
  );
  assert.match(journal.calls[0].text, /INSERT INTO visits/);
  assert.equal(journal.calls[0].values[0], CO_A);
  assert.deepEqual(created.created, ['v-new']);

  const miss = recordingDb([]);
  await assert.rejects(
    () => defs(undefined).get('project_visits.bulk').handler(
      { projectId: A, visits: [{ id: B, scheduledStart: '2026-11-10T09:00:00Z', scheduledEnd: '2026-11-10T11:00:00Z' }] },
      ctx(miss, CO_A),
    ),
    /visit not found on this project; batch rolled back/,
  );
  assert.match(miss.calls[0].text, /UPDATE visits/);
  assert.equal(miss.calls[0].values[4], CO_A, 'update is company-scoped');
  assert.equal(miss.calls[0].values[5], A, 'update is scoped to the project');
});

test('project_visits.bulk rejects a visit that ends before it starts', async () => {
  const d = defs(undefined).get('project_visits.bulk');
  await assert.rejects(() => d.handler(SAMPLES['project_visits.bulk'][1], ctx(recordingDb([]), CO_A)), /invalid input/);
});

// ---- Not implemented --------------------------------------------------------------------------------------------------

test('side-effect and no-table tools return not_implemented with a reason and touch no database', async () => {
  const db = recordingDb([]);
  const d = defs(db);
  for (const id of GROUP_02_NOT_IMPLEMENTED_IDS) {
    const out = await d.get(id).handler(SAMPLES[id][0], ctx(db, CO_A));
    assert.equal(out.status, 'not_implemented', id);
    assert.equal(out.executed, false, id);
    assert.ok(out.reason.length > 20, `${id} has a reason`);
  }
  assert.equal(db.calls.length, 0, 'no SQL for not_implemented tools');
});

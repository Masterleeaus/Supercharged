/**
 * Tests for the group 01 tool handlers (server/workforce/tools/handlers/group-01.ts). Fake SqlExecutor, no database,
 * no network.
 * Run: node --test --experimental-transform-types tests/workforce/tools-real-01.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Silence console output so the test runner's IPC is not broken by server imports.
for (const method of ['log', 'info', 'warn']) console[method] = () => {};

const {
  createGroup01ToolDefinitions,
  GROUP01_TOOL_IDS,
  GROUP01_INPUT_SCHEMAS,
  GROUP01_READ_TIMEOUT_MS,
  GROUP01_WRITE_TIMEOUT_MS,
  Group01UnavailableError,
  Group01InputError,
} = await import('../../server/workforce/tools/handlers/group-01.ts');

const CO_A = 'company-a';
const CO_B = 'company-b';
const V1 = '6f1c2a0e-8d4b-4c1a-9b2e-1a2b3c4d5e6f';

// A valid and an invalid input for every id.
const CASES = {
  'estimates.list': [{ status: 'sent', limit: 10 }, { status: 'paid' }],
  'inventory.list': [{ belowReorderOnly: true }, { limit: 51 }],
  'job_checklists.list': [{ visitId: V1 }, { visitId: 'not-a-uuid' }],
  'job_photos.list': [{ visitId: V1, category: 'before' }, { visitId: V1, category: 'video' }],
  'estimates.create': [{ clientId: V1, subtotalCents: 1000, taxCents: 100 }, { clientId: V1, subtotalCents: -1 }],
  'crew_rosters.update': [{ id: V1, status: 'published' }, { id: V1 }],
  'disputes.create': [{ summary: 'Late payment query' }, { summary: '   ' }],
  'invoice_disputes.create': [{ invoiceRef: 'INV-1001', summary: 'Wrong amount' }, { summary: 'Wrong amount' }],
  'end_of_lease_checklists.create': [{ title: 'Oven clean', items: [{ label: 'Oven' }] }, { title: 'Oven', items: [{ label: '' }] }],
  'feedback_responses.create': [{ rating: 5 }, { rating: 6 }],
  'job_notes.create': [{ visitId: V1, body: 'Left keys in box' }, { body: 'Left keys in box' }],
  'customer_messages.draft': [{ clientId: V1, channel: 'email', body: 'Hello' }, { clientId: V1, channel: 'fax', body: 'Hello' }],
  'customer_messages.send': [{ clientId: V1, channel: 'sms', body: 'Hello' }, { clientId: V1, channel: 'sms', body: '' }],
  'feedback_surveys.send': [{ clientId: V1 }, {}],
  'job_photos.request_from_customer': [{ visitId: V1 }, { visitId: V1, category: 'x' }],
  'escalations.create': [{ reason: 'Gas smell' }, { reason: '' }],
  'human_escalation.create': [{ reason: 'Gas smell' }, {}],
  'identity.verify_request': [{ clientId: V1 }, { clientId: 'x' }],
};

const READS = ['estimates.list', 'inventory.list', 'job_checklists.list', 'job_photos.list'];
const DRAFT_OR_SIDE_EFFECT = [
  'customer_messages.draft',
  'customer_messages.send',
  'feedback_surveys.send',
  'job_photos.request_from_customer',
  'escalations.create',
  'human_escalation.create',
  'identity.verify_request',
];

/**
 * Fake SqlExecutor. A SELECT returns every seeded row of its table, from every company, so a handler that leaves out
 * the company filter would leak rows. An INSERT or UPDATE returns the rows the test gives it. Every call is recorded.
 */
function fakeDb(tables = {}, writeRows = null) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      if (/^\s*(INSERT|UPDATE)\b/i.test(text)) {
        const rows = writeRows ?? [{ id: 'new-id', company_id: values[0], status: 'open', total_cents: 0 }];
        return { rows, rowCount: rows.length };
      }
      const table = /FROM\s+(\w+)/i.exec(text)?.[1];
      const rows = tables[table] ?? [];
      return { rows, rowCount: rows.length };
    },
  };
}

const ctx = (companyId, db) => ({
  companyId,
  signal: new AbortController().signal,
  ...(db !== undefined ? { db } : {}),
});

const defsById = (options) => Object.fromEntries(createGroup01ToolDefinitions(options).map((d) => [d.id, d]));

const SEED = {
  estimates: [
    { company_id: CO_A, id: 'e-a', client_id: V1, status: 'sent', total_cents: 1100, notes: 'Patch wall', internal_notes: 'margin low', created_at: new Date('2026-11-01T00:00:00Z') },
    { company_id: CO_B, id: 'e-b', client_id: V1, status: 'sent', total_cents: 900, notes: null, internal_notes: 'other company', created_at: new Date('2026-11-01T00:00:00Z') },
  ],
  inventory_items: [
    { company_id: CO_A, id: 'i-a', name: 'Filler', sku: null, unit_label: 'tube', store_section: 'A1', quantity: '2.000', reorder_level: '5.000' },
    { company_id: CO_B, id: 'i-b', name: 'Filler', sku: null, unit_label: 'tube', store_section: 'B1', quantity: '0.000', reorder_level: '5.000' },
  ],
  visit_checklist_items: [
    { company_id: CO_A, id: 'c-a', visit_id: V1, section: 'Safety', item_key: 'smoke', label: 'Smoke alarm', disposition: 'ok', note: null, sort_order: 1 },
    { company_id: CO_B, id: 'c-b', visit_id: V1, section: 'Safety', item_key: 'smoke', label: 'Smoke alarm', disposition: 'ok', note: null, sort_order: 1 },
  ],
  visit_media: [
    { company_id: CO_A, id: 'm-a', visit_id: V1, category: 'before', filename: 'storage/key/a.jpg', original_name: 'a.jpg', mime_type: 'image/jpeg', size_bytes: 2048, created_at: new Date('2026-11-02T00:00:00Z') },
    { company_id: CO_B, id: 'm-b', visit_id: V1, category: 'before', filename: 'storage/key/b.jpg', original_name: 'b.jpg', mime_type: 'image/jpeg', size_bytes: 2048, created_at: new Date('2026-11-02T00:00:00Z') },
  ],
};

test('the group has 18 distinct ids, each with exactly one definition', () => {
  assert.equal(GROUP01_TOOL_IDS.length, 18);
  assert.equal(new Set(GROUP01_TOOL_IDS).size, 18);
  const ids = createGroup01ToolDefinitions().map((d) => d.id).sort();
  assert.deepEqual(ids, [...GROUP01_TOOL_IDS].sort());
});

test('each definition has a field schema, a handler, a risk tier and an access class', () => {
  const risks = new Set(['low', 'medium', 'high', 'critical']);
  for (const def of createGroup01ToolDefinitions()) {
    assert.equal(typeof def.schema, 'object', `${def.id} schema`);
    assert.equal(typeof def.handler, 'function', `${def.id} handler`);
    assert.ok(risks.has(def.risk), `${def.id} risk ${String(def.risk)}`);
    assert.ok(def.access === 'read' || def.access === 'write', `${def.id} access ${String(def.access)}`);
  }
});

test('timeoutMs is a positive integer: 10000 for reads, 20000 for writes', () => {
  assert.equal(GROUP01_READ_TIMEOUT_MS, 10000);
  assert.equal(GROUP01_WRITE_TIMEOUT_MS, 20000);
  for (const def of createGroup01ToolDefinitions()) {
    assert.ok(Number.isInteger(def.timeoutMs) && def.timeoutMs > 0, `${def.id} timeoutMs`);
    const expected = def.access === 'read' ? GROUP01_READ_TIMEOUT_MS : GROUP01_WRITE_TIMEOUT_MS;
    assert.equal(def.timeoutMs, expected, `${def.id} timeoutMs`);
  }
});

test('the access class matches the tool: reads are read, writes and side effects are write', () => {
  const defs = defsById();
  for (const id of READS) assert.equal(defs[id].access, 'read', id);
  for (const id of GROUP01_TOOL_IDS.filter((x) => !READS.includes(x))) assert.equal(defs[id].access, 'write', id);
});

test('customer contact and identity tools carry the customer_send category', () => {
  const defs = defsById();
  for (const id of ['customer_messages.send', 'feedback_surveys.send', 'job_photos.request_from_customer', 'identity.verify_request']) {
    assert.equal(defs[id].category, 'customer_send', id);
    assert.equal(defs[id].risk, 'critical', id);
  }
});

test('every id has an input schema that accepts a valid input and rejects an invalid one', () => {
  for (const id of GROUP01_TOOL_IDS) {
    const [valid, invalid] = CASES[id];
    const schema = GROUP01_INPUT_SCHEMAS[id];
    assert.ok(schema, `${id} has no input schema`);
    assert.equal(schema.safeParse(valid).success, true, `${id} should accept ${JSON.stringify(valid)}`);
    assert.equal(schema.safeParse(invalid).success, false, `${id} should reject ${JSON.stringify(invalid)}`);
  }
});

test('every input schema rejects a companyId key, so the tenant never comes from the body', () => {
  for (const id of GROUP01_TOOL_IDS) {
    const [valid] = CASES[id];
    for (const key of ['companyId', 'company_id']) {
      assert.equal(GROUP01_INPUT_SCHEMAS[id].safeParse({ ...valid, [key]: CO_B }).success, false, `${id} ${key}`);
    }
  }
});

test('company-scoped reads return only the caller company rows, even when the store returns another company', async () => {
  const db = fakeDb(SEED);
  const defs = defsById({ db });
  const expectedIds = { 'estimates.list': ['e-a'], 'inventory.list': ['i-a'], 'job_checklists.list': ['c-a'], 'job_photos.list': ['m-a'] };
  for (const id of READS) {
    const before = db.calls.length;
    const out = await defs[id].handler(CASES[id][0], ctx(CO_A));
    const ids = out.rows.map((row) => row.id);
    assert.deepEqual(ids, expectedIds[id], `${id} must return only company A rows`);
    assert.ok(!ids.some((rowId) => rowId.endsWith('-b')), `${id} leaked a company B row`);
    const sql = db.calls[before];
    assert.match(sql.text, /company_id = \$1/, `${id} SQL must filter on company_id`);
    assert.equal(sql.values[0], CO_A, `${id} must bind the caller company first`);
  }
});

test('read output leaves out internal and storage fields', async () => {
  const db = fakeDb(SEED);
  const defs = defsById({ db });
  const estimates = await defs['estimates.list'].handler({}, ctx(CO_A));
  assert.ok(!('internal_notes' in estimates.rows[0]) && !('internalNotes' in estimates.rows[0]));
  const photos = await defs['job_photos.list'].handler({ visitId: V1 }, ctx(CO_A));
  assert.ok(!JSON.stringify(photos).includes('storage/key'), 'photo output must not carry the storage key');
});

test('a read with no executor throws before any SQL runs', async () => {
  const defs = defsById({});
  await assert.rejects(() => defs['estimates.list'].handler({}, ctx(CO_A)), Group01UnavailableError);
});

test('companyId in the input is refused for every id, before any database call', async () => {
  const db = fakeDb(SEED);
  const defs = defsById({ db });
  for (const id of GROUP01_TOOL_IDS) {
    const [valid] = CASES[id];
    await assert.rejects(
      () => defs[id].handler({ ...valid, companyId: CO_B }, ctx(CO_A, db)),
      Group01InputError,
      `${id} must refuse companyId in input`,
    );
  }
  assert.equal(db.calls.length, 0, 'no SQL may run for a refused input');
});

test('writes bind the context company first and use the journal executor when one is set', async () => {
  const optionsDb = fakeDb(SEED);
  const journalDb = fakeDb({}, [{ id: 'est-1', company_id: CO_A, status: 'draft', total_cents: 1100 }]);
  const defs = defsById({ db: optionsDb });
  const out = await defs['estimates.create'].handler({ clientId: V1, subtotalCents: 1000, taxCents: 100 }, ctx(CO_A, journalDb));
  assert.deepEqual(out, { created: true, id: 'est-1', status: 'draft', totalCents: 1100 });
  assert.equal(journalDb.calls.length, 1, 'the journal executor must run the insert');
  assert.equal(optionsDb.calls.length, 0, 'the options executor must not run when a journal executor is set');
  assert.equal(journalDb.calls[0].values[0], CO_A);
  assert.match(journalDb.calls[0].text, /^\s*INSERT INTO estimates/i);
});

test('every write that reaches the database binds the context company first', async () => {
  const cases = [
    ['estimates.create', { clientId: V1, subtotalCents: 1000 }],
    ['crew_rosters.update', { id: V1, teamName: 'North' }],
    ['disputes.create', { summary: 'Query' }],
    ['invoice_disputes.create', { invoiceRef: 'INV-1', summary: 'Query' }],
    ['end_of_lease_checklists.create', { title: 'Oven clean' }],
    ['feedback_responses.create', { rating: 4 }],
    ['job_notes.create', { visitId: V1, body: 'Done' }],
  ];
  for (const [id, input] of cases) {
    const db = fakeDb({}, [{ id: 'row-1', company_id: CO_A, status: 'open', total_cents: 0, team_name: 'North' }]);
    const out = await defsById({})[id].handler(input, ctx(CO_A, db));
    assert.equal(db.calls.length, 1, `${id} runs one statement`);
    assert.equal(db.calls[0].values[0], CO_A, `${id} must bind company first`);
    assert.ok(out && typeof out === 'object', `${id} returns an object`);
  }
});

test('crew_rosters.update reports updated false when the only matching row belongs to another company', async () => {
  const db = fakeDb({}, [{ id: V1, company_id: CO_B, team_name: 'Other', status: 'draft' }]);
  const out = await defsById({})['crew_rosters.update'].handler({ id: V1, status: 'published' }, ctx(CO_A, db));
  assert.deepEqual(out, { updated: false });
});

test('crew_rosters.update reports updated true for the caller company row', async () => {
  const db = fakeDb({}, [{ id: V1, company_id: CO_A, team_name: 'North', status: 'published' }]);
  const out = await defsById({})['crew_rosters.update'].handler({ id: V1, status: 'published' }, ctx(CO_A, db));
  assert.deepEqual(out, { updated: true, id: V1, teamName: 'North', status: 'published' });
});

test('a draft returns the text for review and sends nothing; sends and escalations return not_implemented', async () => {
  const db = fakeDb(SEED);
  const defs = defsById({ db });
  const draft = await defs['customer_messages.draft'].handler(CASES['customer_messages.draft'][0], ctx(CO_A, db));
  assert.equal(draft.status, 'draft');
  assert.equal(draft.sent, false);
  for (const id of DRAFT_OR_SIDE_EFFECT.filter((x) => x !== 'customer_messages.draft')) {
    const out = await defs[id].handler(CASES[id][0], ctx(CO_A, db));
    assert.equal(out.status, 'not_implemented', id);
    assert.equal(typeof out.reason, 'string', id);
    assert.match(out.reason, /Nothing was (sent|recorded)/, id);
  }
  assert.equal(db.calls.length, 0, 'drafts and side-effect tools never touch the database');
});

test('the registry gate covers the customer contact tools: they are on the always-approval list', async () => {
  const { isAlwaysApproval } = await import('../../server/workforce/runtime/always-approval.ts');
  for (const id of ['customer_messages.send', 'feedback_surveys.send', 'job_photos.request_from_customer']) {
    assert.equal(isAlwaysApproval(id), true, `${id} must need owner approval`);
  }
});

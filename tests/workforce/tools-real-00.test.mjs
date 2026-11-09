/**
 * Tests for the group 00 tool handlers (server/workforce/tools/handlers/group-00.ts). Fake SQL executors, no database.
 * Run: node --test --experimental-transform-types tests/workforce/tools-real-00.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Silence console output so the test runner's IPC is not broken by server imports.
for (const method of ['log', 'info', 'warn']) console[method] = () => {};

const {
  createGroup00ToolDefinitions,
  GROUP00_TOOL_IDS,
  GROUP00_NOT_IMPLEMENTED_IDS,
  GROUP00_INPUT_SCHEMAS,
} = await import('../../server/workforce/tools/handlers/group-00.ts');

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const ID1 = '33333333-3333-4333-8333-333333333333';
const ID2 = '44444444-4444-4444-8444-444444444444';

const EXPECTED_IDS = [
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

const READS = [
  'agreements.list',
  'availability.read',
  'client_duplicates.list',
  'clients.get',
  'clients.list',
  'compliance_certificates.list',
  'compliance_documents.list',
  'crew_rosters.list',
];
const WRITES = [
  'client_merge_suggestions.create',
  'clients.create',
  'collection_notes.create',
  'complaints.create',
];
const NOT_IMPLEMENTED = [
  'after_hours.page_on_call',
  'agreements.renewal_draft',
  'booking_requests.create',
  'booking_requests.update',
  'campaign_messages.create',
  'compliance_reminders.send',
];

/** One valid input per id. */
const VALID = {
  'after_hours.page_on_call': { reason: 'Burst pipe' },
  'agreements.list': { limit: 5 },
  'agreements.renewal_draft': { agreementId: ID1 },
  'availability.read': { date: '2026-11-10' },
  'booking_requests.create': { contactName: 'Sam', appointmentDate: '2026-11-10', appointmentTime: '09:00', duration: 60 },
  'booking_requests.update': { id: 'appt-1', status: 'confirmed' },
  'campaign_messages.create': { subject: 'Spring', body: 'Hello' },
  'client_duplicates.list': {},
  'client_merge_suggestions.create': { clientId: ID1, duplicateClientId: ID2 },
  'clients.create': { name: 'New Client', email: 'new@example.test' },
  'clients.get': { id: ID1 },
  'clients.list': { q: 'own' },
  'collection_notes.create': { invoiceRef: 'INV-1', body: 'Called' },
  'complaints.create': { summary: 'Late arrival' },
  'compliance_certificates.list': {},
  'compliance_documents.list': {},
  'compliance_reminders.send': { certificateId: ID1 },
  'crew_rosters.list': { rosterDate: '2026-11-10' },
};

/** Rows for both companies. The fake ignores the SQL's WHERE clause, so the handler itself must drop company B's rows. */
const OTHER_ROW = {
  id: 'other-b-row',
  companyId: CO_B,
  name: 'Other Co Customer',
  email: 'other@example.test',
  phone: '0400000002',
  notes: 'other notes',
  clientId: ID2,
  propertyId: ID2,
  status: 'active',
  priceCents: 99,
  startsOn: '2026-01-01',
  endsOn: '2026-12-31',
  title: 'other doc',
  documentType: 'cert',
  expiresOn: '2027-01-01',
  certificateType: 'gas',
  reference: 'other-ref',
  issuedOn: '2026-01-01',
  rosterDate: '2026-11-10',
  teamName: 'Other team',
  members: [],
  opensAt: '08:00',
  closesAt: '17:00',
  capacity: 1,
  storageRef: 'secret-location',
  workOrderId: null,
  createdAt: null,
};
const OWN_ROW = { ...OTHER_ROW, id: ID1, companyId: CO_A, name: 'Own Customer', email: 'own@example.test', storageRef: 'own-location' };

function recordingDb(rows = [OWN_ROW, OTHER_ROW], calls = []) {
  return {
    calls,
    query: async (text, values) => {
      calls.push({ text, values });
      return { rows, rowCount: rows.length };
    },
  };
}

/** A write executor that fails the test if it is called, for paths that must not write. */
function forbiddenDb(calls = []) {
  return {
    query: async (text, values) => {
      calls.push({ text, values });
      throw new Error('no query expected');
    },
  };
}

function context(companyId, db) {
  return { companyId, signal: new AbortController().signal, ...(db ? { db } : {}) };
}

/** Definitions built with the given read executor. Reads query that executor, so each test passes its own. */
function defsFor(db) {
  return new Map(createGroup00ToolDefinitions(db).map((def) => [def.id, def]));
}
const defById = defsFor(recordingDb([]));

test('every group 00 id has a definition, and the list matches the expected 18', () => {
  assert.deepEqual([...GROUP00_TOOL_IDS].sort(), EXPECTED_IDS);
  assert.deepEqual([...defById.keys()].sort(), EXPECTED_IDS);
});

test('the not_implemented set is exactly the six ids with no table, no company scope, or no safe path', () => {
  assert.deepEqual([...GROUP00_NOT_IMPLEMENTED_IDS].sort(), [...NOT_IMPLEMENTED].sort());
});

test('each id has a zod schema that parses a valid input and rejects a companyId key', () => {
  for (const id of EXPECTED_IDS) {
    const schema = GROUP00_INPUT_SCHEMAS[id];
    assert.ok(schema, `${id} has no zod schema`);
    assert.equal(schema.safeParse(VALID[id]).success, true, `${id} rejected its valid input`);
    assert.equal(schema.safeParse({ ...VALID[id], companyId: CO_B }).success, false, `${id} accepted a companyId key`);
    assert.equal(schema.safeParse({ ...VALID[id], unknownField: 1 }).success, false, `${id} accepted an unknown key`);
  }
});

test('each zod schema rejects a clearly invalid value', () => {
  const bad = {
    'agreements.list': { status: 'unknown' },
    'availability.read': { date: '2026-02-30' },
    'booking_requests.update': { id: 'appt-1' },
    'client_merge_suggestions.create': { clientId: ID1, duplicateClientId: ID1 },
    'clients.get': { id: 'not-a-uuid' },
    'clients.create': { name: '' },
    'compliance_certificates.list': { limit: 500 },
    'crew_rosters.list': { rosterDate: '10/11/2026' },
  };
  for (const [id, input] of Object.entries(bad)) {
    assert.equal(GROUP00_INPUT_SCHEMAS[id].safeParse(input).success, false, `${id} accepted ${JSON.stringify(input)}`);
  }
});

test('the registry field schema names every field of a valid input', () => {
  for (const id of EXPECTED_IDS) {
    const schema = defById.get(id).schema;
    for (const key of Object.keys(VALID[id])) {
      assert.ok(key in schema, `${id} registry schema is missing field ${key}`);
    }
  }
});

test('timeoutMs is a positive integer: 10000 for reads, 20000 for writes', () => {
  for (const id of EXPECTED_IDS) {
    const def = defById.get(id);
    assert.ok(Number.isInteger(def.timeoutMs) && def.timeoutMs > 0, `${id} timeoutMs ${def.timeoutMs}`);
    const expected = READS.includes(id) ? 10_000 : 20_000;
    assert.equal(def.timeoutMs, expected, `${id} timeoutMs`);
  }
});

test('access and risk are declared on every definition', () => {
  for (const id of READS) assert.equal(defById.get(id).access, 'read', id);
  for (const id of [...WRITES, ...NOT_IMPLEMENTED]) assert.equal(defById.get(id).access, 'write', id);
  for (const id of EXPECTED_IDS) assert.ok(['low', 'medium', 'high', 'critical'].includes(defById.get(id).risk), id);
});

test('the two customer-facing side effects are routed to approval by category', () => {
  assert.equal(defById.get('campaign_messages.create').category, 'customer_send');
  assert.equal(defById.get('compliance_reminders.send').category, 'customer_send');
});

test('not_implemented ids return a reason and touch no database', async () => {
  const calls = [];
  const db = forbiddenDb(calls);
  for (const id of NOT_IMPLEMENTED) {
    const result = await defById.get(id).handler(VALID[id], context(CO_A, db));
    assert.equal(result.status, 'not_implemented', id);
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0, `${id} has no reason`);
  }
  assert.equal(calls.length, 0);
});

test('each company-scoped read queries with company_id = $1 and returns only the caller company rows', async () => {
  for (const id of READS) {
    const calls = [];
    const db = recordingDb([OWN_ROW, OTHER_ROW], calls);
    const result = await defsFor(db).get(id).handler(VALID[id], context(CO_A, db));
    const serialised = JSON.stringify(result);
    assert.equal(calls.length, 1, `${id} ran ${calls.length} queries`);
    assert.match(calls[0].text, /company_id = \$1/, `${id} query is not company-scoped`);
    assert.equal(calls[0].values[0], CO_A, `${id} did not pass the caller company`);
    assert.ok(!serialised.includes('other-b-row'), `${id} returned another company's row`);
    assert.ok(!serialised.includes('secret-location'), `${id} returned a storage location`);
  }
});

test('booking_requests.update is refused as not_implemented because appointments has no live company_id', async () => {
  const calls = [];
  const db = forbiddenDb(calls);
  const result = await defsFor(db).get('booking_requests.update').handler({ id: 'appt-1', status: 'confirmed' }, context(CO_A, db));
  assert.equal(result.status, 'not_implemented');
  assert.match(result.reason, /company_id/);
  assert.equal(calls.length, 0, 'booking_requests.update ran a query');
});

test('clients.get does not return another company row', async () => {
  const db = recordingDb([OTHER_ROW]);
  const result = await defsFor(db).get('clients.get').handler({ id: ID1 }, context(CO_A, db));
  assert.deepEqual(result, { found: false, row: null });
  // Same id, caller's own company: found.
  const own = recordingDb([OWN_ROW]);
  const found = await defsFor(own).get('clients.get').handler({ id: ID1 }, context(CO_A, own));
  assert.equal(found.found, true);
  assert.equal(found.row.name, 'Own Customer');
});

test('a companyId in the input is refused for every id, and no query runs', async () => {
  for (const id of EXPECTED_IDS) {
    const calls = [];
    const db = recordingDb([OWN_ROW], calls);
    const ctx = context(CO_A, db);
    await assert.rejects(
      defsFor(db).get(id).handler({ ...VALID[id], companyId: CO_B }, ctx),
      /invalid input/,
      `${id} accepted companyId from input`,
    );
    assert.equal(calls.length, 0, `${id} ran a query for a refused input`);
  }
});

test('writes insert or update with the caller company from the context', async () => {
  for (const id of WRITES) {
    const calls = [];
    const journal = recordingDb([{ id: 'new-id', status: 'open', companyId: CO_A }], calls);
    const result = await defById.get(id).handler(VALID[id], context(CO_A, journal));
    assert.equal(calls.length, 1, `${id} ran ${calls.length} queries`);
    assert.equal(calls[0].values[0], CO_A, `${id} did not write under the caller company`);
    assert.match(calls[0].text, /company_id/, `${id} write does not name company_id`);
    assert.equal(typeof result, 'object', id);
  }
});

test('clients.create writes the expected columns and returns the new id', async () => {
  const calls = [];
  const journal = recordingDb([{ id: 'new-id' }], calls);
  const result = await defById.get('clients.create').handler(VALID['clients.create'], context(CO_A, journal));
  assert.match(calls[0].text, /^\s*INSERT INTO clients \(company_id, name, email, phone, notes\)/);
  assert.deepEqual(calls[0].values, [CO_A, 'New Client', 'new@example.test', null, null]);
  assert.deepEqual(result, { created: true, id: 'new-id' });
});

test('writes refuse to run without the journal executor, and reads refuse without a database', async () => {
  for (const id of WRITES) {
    await assert.rejects(
      defById.get(id).handler(VALID[id], context(CO_A)),
      /journal transaction/,
      `${id} ran without the journal executor`,
    );
  }
  const noDb = createGroup00ToolDefinitions();
  for (const id of READS) {
    await assert.rejects(
      noDb.find((def) => def.id === id).handler(VALID[id], context(CO_A)),
      /database executor/,
      `${id} ran without a database`,
    );
  }
});

test('the registry accepts every group 00 definition and runs a company-scoped read through it', async () => {
  const { createToolRegistry } = await import('../../server/workforce/runtime/index.ts');
  const registry = createToolRegistry({
    gate: {
      gateAction: async () => ({ status: 'approved', approval: { id: 'x' } }),
      readApproval: async () => null,
      claimApproval: async () => false,
    },
    redact: (value) => value,
    audit: { record: async () => {} },
  });
  const db = recordingDb([OWN_ROW, OTHER_ROW]);
  for (const def of createGroup00ToolDefinitions(db)) registry.register(def);
  for (const id of EXPECTED_IDS) assert.equal(registry.has(id), true, `${id} not registered`);

  const actor = { kind: 'agent', agentId: 'agent-1', roleId: 'cleaning-customer-care', autonomy: 'auto' };
  const ok = await registry.invoke({ companyId: CO_A, toolId: 'clients.list', params: {}, actor });
  assert.equal(ok.outcome, 'executed');
  assert.ok(!JSON.stringify(ok.output).includes('other-b-row'), 'registry returned another company row');
  assert.equal(db.calls[0].values[0], CO_A);
});

test('client_duplicates.list groups matches inside the caller company and returns no contact values', async () => {
  const rows = [
    { id: ID1, companyId: CO_A, name: 'A1', email: 'Same@x.test', phone: '0400 000 001' },
    { id: ID2, companyId: CO_A, name: 'A2', email: 'same@x.test', phone: '0400-000-001' },
    { id: 'b-row', companyId: CO_B, name: 'B1', email: 'same@x.test', phone: '0400 000 001' },
  ];
  const db = recordingDb(rows);
  const result = await defsFor(db).get('client_duplicates.list').handler({}, context(CO_A, db));
  const serialised = JSON.stringify(result);
  assert.ok(!serialised.includes('b-row'), 'matched another company');
  assert.ok(!serialised.includes('x.test'), 'returned an email');
  assert.ok(!serialised.includes('0400'), 'returned a phone');
  assert.deepEqual(
    result.rows.map((group) => group.matchOn).sort(),
    ['email', 'phone'],
  );
  for (const group of result.rows) {
    assert.deepEqual(group.clients.map((c) => c.id).sort(), [ID1, ID2].sort());
  }
});

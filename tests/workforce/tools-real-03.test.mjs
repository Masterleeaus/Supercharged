/**
 * Tests for tool group 03 (server/workforce/tools/handlers/group-03.ts). Fakes only: a fake SQL executor that scopes by
 * the company id it is given, and an in-memory approval gate. No network, no database.
 * Run: node --test --experimental-transform-types tests/workforce/tools-real-03.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Silence console output so the test runner's IPC is not broken by server imports.
for (const method of ['log', 'info', 'warn']) console[method] = () => {};

const { createGroup03ToolDefinitions, GROUP03_INPUT_SCHEMAS, GROUP03_TOOL_IDS } = await import(
  '../../server/workforce/tools/handlers/group-03.ts'
);
const { createToolRegistry } = await import('../../server/workforce/runtime/index.ts');

const CO_A = 'company-a';
const CO_B = 'company-b';
const U1 = '11111111-1111-4111-8111-111111111111';
const P_A = '44444444-4444-4444-8444-444444444444';
const EXPECTED_IDS = [
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
const COMPANY_SCOPED_READS = [
  'property_issues.list',
  'purchase_orders.list',
  'quotes.list',
  'reviews.list',
  'service_agreements.list',
  'reports.weekly_summary',
];

/** Rows for two companies. Ids carry a/b so a leak is easy to see in output. */
function seedRows() {
  return {
    property_issues: [
      { company_id: CO_A, id: 'a-issue', property_id: P_A, area: 'kitchen', item_key: 'tap', title: 'Drip', severity: 'minor', status: 'open', occurrence_count: 1 },
      { company_id: CO_B, id: 'b-issue', property_id: P_A, area: 'hall', item_key: 'door', title: 'Squeak', severity: 'minor', status: 'open', occurrence_count: 1 },
    ],
    purchase_orders: [
      { company_id: CO_A, id: 'a-po', supplier_name: 'A Supply', status: 'sent', total_cents: 900 },
      { company_id: CO_B, id: 'b-po', supplier_name: 'B Supply', status: 'sent', total_cents: 100 },
    ],
    estimates: [
      { company_id: CO_A, id: 'a-est', client_id: U1, status: 'sent', total_cents: 1 },
      { company_id: CO_B, id: 'b-est', client_id: U1, status: 'sent', total_cents: 2 },
    ],
    reviews: [
      { company_id: CO_A, id: 'a-rev', client_id: U1, rating: 5 },
      { company_id: CO_B, id: 'b-rev', client_id: U1, rating: 2 },
    ],
    service_agreements: [
      { company_id: CO_A, id: 'a-sa', client_id: U1, name: 'A plan', status: 'active', price_cents: 1 },
      { company_id: CO_B, id: 'b-sa', client_id: U1, name: 'B plan', status: 'active', price_cents: 2 },
    ],
    complaints: [{ company_id: CO_A, id: 'a-complaint', status: 'open' }],
    staff_tasks: [{ company_id: CO_B, id: 'b-task', status: 'open' }],
  };
}

/**
 * Fake SQL executor. It scopes every read by the first value (the company id), as the real query does with company_id = $1,
 * and it records every query so tests can check the text and the values.
 */
function fakeDb(seed = seedRows()) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values: [...values] });
      const companyId = values[0];
      const ownRows = (table) => (seed[table] ?? []).filter((row) => row.company_id === companyId);
      if (text.includes('AS estimates_sent')) {
        return {
          rows: [
            {
              estimates_sent: ownRows('estimates').length,
              estimates_open: ownRows('estimates').length,
              new_reviews: ownRows('reviews').length,
              average_rating: null,
              open_complaints: ownRows('complaints').length,
              open_property_issues: ownRows('property_issues').length,
              open_staff_tasks: ownRows('staff_tasks').length,
              open_purchase_orders: ownRows('purchase_orders').length,
            },
          ],
          rowCount: 1,
        };
      }
      if (/^\s*INSERT/.test(text)) {
        return { rows: [{ id: 'new-1', company_id: companyId, status: 'open', kind: 'staff', priority: 'urgent' }], rowCount: 1 };
      }
      const table = /(?:FROM|UPDATE) (\w+)/.exec(text)?.[1];
      let rows = ownRows(table);
      const idRef = /\bid = \$(\d+)/.exec(text);
      if (idRef) rows = rows.filter((row) => row.id === values[Number(idRef[1]) - 1]);
      return { rows, rowCount: rows.length };
    },
  };
}

const ctx = (companyId, extra = {}) => ({ companyId, signal: new AbortController().signal, ...extra });

function definitionsFor(db) {
  return Object.fromEntries(createGroup03ToolDefinitions({ sql: db }).map((def) => [def.id, def]));
}

/** Valid and invalid inputs for each tool. The invalid one fails the zod schema. */
const SAMPLES = {
  'property_issues.list': { valid: { propertyId: U1 }, invalid: { propertyId: 'not-a-uuid' } },
  'property_issues.create': { valid: { propertyId: U1, area: 'kitchen', title: 'Leak' }, invalid: { propertyId: U1, area: '', title: 'Leak' } },
  'property_issues.update': { valid: { issueId: U1, status: 'resolved' }, invalid: { issueId: U1 } },
  'purchase_orders.list': { valid: { status: 'sent' }, invalid: { status: 'shipped' } },
  'purchase_orders.draft': { valid: { supplierName: 'Acme' }, invalid: {} },
  'quote_requests.create': { valid: { clientName: 'Jo', summary: 'Gutter clean' }, invalid: { clientName: 'Jo' } },
  'quotes.list': { valid: { limit: 10 }, invalid: { limit: 51 } },
  'referral_requests.create': { valid: { clientId: U1 }, invalid: { clientId: 'x' } },
  'refund_requests.create': { valid: { transactionId: 't1', amountCents: 500, reason: 'duplicate' }, invalid: { transactionId: 't1', amountCents: 0, reason: 'x' } },
  'refund_requests.list': { valid: { status: 'pending' }, invalid: { status: 'paid' } },
  'refund_requests.prepare': { valid: { transactionId: 't1', amountCents: 500, reason: 'duplicate' }, invalid: { transactionId: 't1' } },
  'reports.weekly_summary': { valid: { days: 7 }, invalid: { days: 0 } },
  'review_alerts.create': { valid: { reviewId: U1, summary: 'Rude' }, invalid: { reviewId: U1, summary: '' } },
  'reviews.list': { valid: { rating: 5 }, invalid: { rating: 6 } },
  'reviews.request': { valid: { clientId: U1 }, invalid: { clientId: 'x' } },
  'safety.escalate_to_human': { valid: { title: 'Gas smell', description: 'Smell at meter' }, invalid: { title: 'Gas smell' } },
  'service_agreements.draft_renewal': { valid: { agreementId: U1, endsOn: '2027-01-01' }, invalid: { agreementId: U1, endsOn: '01/01/2027' } },
  'service_agreements.list': { valid: { status: 'active' }, invalid: { status: 'paused' } },
};

test('group 03 lists the 18 tool ids, each with a definition', () => {
  assert.deepEqual([...GROUP03_TOOL_IDS].sort(), EXPECTED_IDS);
  const defs = createGroup03ToolDefinitions({ sql: fakeDb() });
  assert.deepEqual(defs.map((d) => d.id).sort(), EXPECTED_IDS);
  for (const def of defs) {
    assert.equal(typeof def.handler, 'function', `${def.id} has a handler`);
    assert.equal(typeof def.schema, 'object', `${def.id} has a schema`);
    assert.ok(['low', 'medium', 'high', 'critical'].includes(def.risk), `${def.id} has a risk tier`);
    assert.ok(['read', 'write'].includes(def.access), `${def.id} declares access`);
  }
});

test('each tool has a zod schema that accepts a valid input and rejects an invalid one', () => {
  for (const id of EXPECTED_IDS) {
    const schema = GROUP03_INPUT_SCHEMAS[id];
    const { valid, invalid } = SAMPLES[id];
    assert.equal(schema.safeParse(valid).success, true, `${id} accepts a valid input`);
    assert.equal(schema.safeParse(invalid).success, false, `${id} rejects an invalid input`);
  }
});

test('every schema rejects a companyId in the input', () => {
  for (const id of EXPECTED_IDS) {
    const { valid } = SAMPLES[id];
    assert.equal(GROUP03_INPUT_SCHEMAS[id].safeParse({ ...valid, companyId: CO_B }).success, false, `${id} rejects companyId`);
  }
});

test('every timeoutMs is a positive integer: 10000 for reads, 20000 for writes', () => {
  for (const def of createGroup03ToolDefinitions({ sql: fakeDb() })) {
    assert.ok(Number.isInteger(def.timeoutMs) && def.timeoutMs > 0, `${def.id} has a positive integer timeoutMs`);
    assert.equal(def.timeoutMs, def.access === 'read' ? 10000 : 20000, `${def.id} timeout`);
  }
});

test('the side-effect tools carry the category or risk that sends them to approval', () => {
  const defs = definitionsFor(fakeDb());
  for (const id of ['referral_requests.create', 'reviews.request']) {
    assert.equal(defs[id].category, 'customer_send', `${id} is a customer contact`);
    assert.equal(defs[id].risk, 'critical', `${id} is critical`);
  }
  for (const id of ['refund_requests.create', 'refund_requests.prepare']) {
    assert.equal(defs[id].category, 'money', `${id} is money`);
    assert.equal(defs[id].risk, 'critical', `${id} is critical`);
  }
  assert.equal(defs['safety.escalate_to_human'].risk, 'high', 'escalation waits for the owner under auto');
});

test('each company-scoped read returns only the caller company rows, and every query is scoped by company_id = $1', async () => {
  for (const id of COMPANY_SCOPED_READS) {
    const db = fakeDb();
    const defs = definitionsFor(db);
    const params = id === 'property_issues.list' ? { propertyId: P_A } : {};
    const forB = JSON.stringify(await defs[id].handler(params, ctx(CO_B)));
    assert.equal(forB.includes('"a-'), false, `${id} returns no company A row to company B`);
    const forA = JSON.stringify(await defs[id].handler(params, ctx(CO_A)));
    assert.equal(forA.includes('"b-'), false, `${id} returns no company B row to company A`);
    assert.ok(db.calls.length >= 2, `${id} ran queries`);
    for (const call of db.calls) {
      assert.ok(call.text.includes('company_id = $1'), `${id} query is scoped by company_id = $1`);
    }
    assert.equal(db.calls[0].values[0], CO_B, `${id} takes the company from the context, not the input`);
  }
});

test('an update cannot reach another company\'s row through its id', async () => {
  const db = fakeDb();
  const defs = definitionsFor(db);
  // Company B asks to update company A's issue id. The UPDATE is scoped by company, so nothing matches.
  const result = await defs['property_issues.update'].handler({ issueId: U1, status: 'resolved' }, ctx(CO_B, { db }));
  assert.deepEqual(result, { found: false, issue: null });
  assert.equal(db.calls[0].values[0], CO_B);
});

test('weekly summary counts only the caller company', async () => {
  const defs = definitionsFor(fakeDb());
  const a = await defs['reports.weekly_summary'].handler({}, ctx(CO_A));
  const b = await defs['reports.weekly_summary'].handler({}, ctx(CO_B));
  assert.equal(a.openComplaints, 1);
  assert.equal(a.openStaffTasks, 0);
  assert.equal(b.openComplaints, 0);
  assert.equal(b.openStaffTasks, 1);
  assert.equal(a.newReviews, 1);
});

test('list reads are bounded: a page holds at most the cap and reports truncation', async () => {
  const seed = seedRows();
  seed.purchase_orders = Array.from({ length: 60 }, (_, i) => ({ company_id: CO_A, id: `a-po-${i}`, supplier_name: 'A', status: 'sent', total_cents: i }));
  const defs = definitionsFor(fakeDb(seed));
  const out = await defs['purchase_orders.list'].handler({}, ctx(CO_A));
  assert.equal(out.rows.length, 50);
  assert.equal(out.truncated, true);
  assert.equal(out.maxRows, 50);
});

test('not_implemented tools return a reason and run no query', async () => {
  const db = fakeDb();
  const defs = definitionsFor(db);
  const cases = [
    ['referral_requests.create', { clientId: U1 }],
    ['refund_requests.create', { transactionId: 't1', amountCents: 500, reason: 'duplicate' }],
    ['refund_requests.list', {}],
    ['refund_requests.prepare', { transactionId: 't1', amountCents: 500, reason: 'duplicate' }],
    ['reviews.request', { clientId: U1 }],
  ];
  for (const [id, params] of cases) {
    const out = await defs[id].handler(params, ctx(CO_A, { db }));
    assert.equal(out.status, 'not_implemented', `${id} is not implemented`);
    assert.ok(out.reason.length > 0, `${id} gives a reason`);
  }
  assert.equal(db.calls.length, 0, 'no query ran for the not_implemented tools');
});

test('a write without the action journal executor refuses and writes nothing, even with a read executor configured', async () => {
  const db = fakeDb();
  const defs = definitionsFor(db);
  await assert.rejects(
    () => defs['property_issues.create'].handler({ propertyId: U1, area: 'kitchen', title: 'Leak' }, ctx(CO_A)),
    /action journal executor/,
  );
  await assert.rejects(
    () => defs['safety.escalate_to_human'].handler({ title: 'Gas', description: 'Smell' }, ctx(CO_A)),
    /action journal executor/,
  );
  assert.equal(db.calls.length, 0, 'the read executor is never used for a write');
});

test('a write with the journal executor inserts for the context company, not the input', async () => {
  const journal = fakeDb();
  const defs = definitionsFor(fakeDb());
  const out = await defs['property_issues.create'].handler({ propertyId: U1, area: 'kitchen', title: 'Leak' }, ctx(CO_A, { db: journal }));
  assert.equal(journal.calls.length, 1);
  assert.match(journal.calls[0].text, /^\s*INSERT INTO property_issues/);
  assert.equal(journal.calls[0].values[0], CO_A);
  assert.equal(out.created.id, 'new-1');
});

test('escalation writes a staff task for the context company', async () => {
  const journal = fakeDb();
  const defs = definitionsFor(fakeDb());
  await defs['safety.escalate_to_human'].handler({ title: 'Gas smell', description: 'Smell at meter' }, ctx(CO_B, { db: journal }));
  assert.match(journal.calls[0].text, /INSERT INTO staff_tasks/);
  assert.equal(journal.calls[0].values[0], CO_B);
  assert.equal(journal.calls[0].values[3], 'urgent', 'default priority is urgent');
});

test('draft tools build a proposal without writing', async () => {
  const db = fakeDb();
  const defs = definitionsFor(db);
  const po = await defs['purchase_orders.draft'].handler({ supplierName: 'Acme', totalCents: 500 }, ctx(CO_A, { db }));
  assert.equal(po.persisted, false);
  assert.equal(po.proposal.status, 'draft');
  const sa = await defs['service_agreements.draft_renewal'].handler({ agreementId: U1 }, ctx(CO_A, { db }));
  assert.equal(sa.persisted, false);
  assert.equal(db.calls.length, 0);
});

/**
 * A registry with an in-memory approval gate. Every call that needs approval gets a record in the status given: 'pending'
 * (waits for the owner) or 'approved' (decided by a human, claimable once).
 */
function registryWith(db, gateStatus) {
  const records = new Map();
  const gate = {
    calls: 0,
    async gateAction(request) {
      gate.calls += 1;
      const id = `ap-${gate.calls}`;
      records.set(id, {
        id,
        companyId: request.companyId,
        action: request.action,
        paramsSha256: request.context.paramsSha256,
        status: gateStatus,
        decidedBy: gateStatus === 'approved' ? 'dashboard:user-1' : null,
        executed: false,
      });
      return { status: gateStatus, approval: { id } };
    },
    async readApproval(companyId, approvalId) {
      return records.get(approvalId) ?? null;
    },
    async claimApproval(companyId, approvalId) {
      const record = records.get(approvalId);
      if (!record || record.status !== 'approved' || record.executed) return false;
      record.executed = true;
      return true;
    },
  };
  const registry = createToolRegistry({ gate, redact: (value) => value, audit: { record: async () => {} } });
  for (const def of createGroup03ToolDefinitions({ sql: db })) registry.register(def);
  return { registry, gate };
}

const agent = { kind: 'agent', agentId: 'agent-1', roleId: 'role-1', autonomy: 'auto' };

test('through the registry, a draft is staged and its handler never runs', async () => {
  const db = fakeDb();
  // A draft still needs the approval the policy asks for; once a human approves it, it is staged, not executed.
  const { registry } = registryWith(db, 'approved');
  const out = await registry.invoke({ companyId: CO_A, toolId: 'purchase_orders.draft', params: { supplierName: 'Acme' }, actor: agent });
  assert.equal(out.outcome, 'staged');
  assert.equal(db.calls.length, 0);
});

test('through the registry, a customer contact waits for owner approval and does not execute', async () => {
  const db = fakeDb();
  const { registry, gate } = registryWith(db, 'pending');
  const out = await registry.invoke({ companyId: CO_A, toolId: 'referral_requests.create', params: { clientId: U1 }, actor: agent });
  assert.equal(out.outcome, 'awaiting_approval');
  assert.equal(gate.calls, 1);
});

test('through the registry, an escalation waits for owner approval under auto', async () => {
  const db = fakeDb();
  const { registry, gate } = registryWith(db, 'pending');
  const out = await registry.invoke({
    companyId: CO_A,
    toolId: 'safety.escalate_to_human',
    params: { title: 'Gas smell', description: 'Smell at meter' },
    actor: agent,
  });
  assert.equal(out.outcome, 'awaiting_approval');
  assert.equal(gate.calls, 1);
  assert.equal(db.calls.length, 0);
});

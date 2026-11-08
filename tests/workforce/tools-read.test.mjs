/**
 * Tests for server/workforce/tools/read-handlers.ts. In-memory store double, no network, no database.
 * Run: node --test --experimental-transform-types tests/workforce/tools-read.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createReadToolDefinitions,
  createReadToolSpecs,
  registerReadTools,
  MAX_READ_ROWS,
} from '../../server/workforce/tools/read-handlers.ts';
import { createToolRegistry } from '../../server/workforce/runtime/index.ts';
import { GROUP01_TOOL_IDS } from '../../server/workforce/tools/handlers/group-01.ts';

const CO_A = 'company-a';
const CO_B = 'company-b';

function bookingRow(companyId, n, extra = {}) {
  return {
    companyId,
    id: `${companyId}-b${n}`,
    contactName: `Customer ${n}`,
    contactPhone: '+61400000000',
    contactEmail: `c${n}@example.test`,
    appointmentDate: '2026-11-10',
    appointmentTime: '09:00',
    duration: 60,
    serviceName: 'Clean',
    status: 'scheduled',
    ...extra,
  };
}

function invoiceRow(companyId, n, extra = {}) {
  return {
    companyId,
    id: `${companyId}-i${n}`,
    invoiceNumber: `INV-${n}`,
    customerName: `Customer ${n}`,
    customerEmail: `c${n}@example.test`,
    customerAddress: '1 Secret St',
    lineItems: [{ description: 'x', quantity: 1, unitPrice: 10, total: 10 }],
    total: '110.00',
    currency: 'AUD',
    status: 'sent',
    issuedAt: '2026-11-01T00:00:00Z',
    dueAt: '2026-11-15T00:00:00Z',
    paidAt: null,
    ...extra,
  };
}

function paymentRow(companyId, n, extra = {}) {
  return {
    companyId,
    id: `${companyId}-p${n}`,
    type: 'credits',
    amount: '20.00',
    currency: 'AUD',
    status: 'completed',
    description: `Payment ${n}`,
    createdAt: '2026-11-01T00:00:00Z',
    completedAt: '2026-11-01T00:01:00Z',
    gatewayTransactionId: 'pi_secret_123',
    metadata: { token: 'secret' },
    ...extra,
  };
}

/** In-memory store double. It scopes every read by companyId, the same way a real adapter must. */
function memoryStore(seed) {
  const calls = [];
  const scoped = (table, companyId) => table.filter((row) => row.companyId === companyId);
  const cut = (rows, limit) => rows.slice(0, limit);
  return {
    calls,
    async listBookings(companyId, query) {
      calls.push(['listBookings', companyId, query]);
      let rows = scoped(seed.bookings, companyId);
      if (query.status) rows = rows.filter((r) => r.status === query.status);
      return cut(rows, query.limit);
    },
    async getBooking(companyId, id) {
      calls.push(['getBooking', companyId, id]);
      return scoped(seed.bookings, companyId).find((r) => r.id === id) ?? null;
    },
    async listInvoices(companyId, query) {
      calls.push(['listInvoices', companyId, query]);
      let rows = scoped(seed.invoices, companyId);
      if (query.status) rows = rows.filter((r) => r.status === query.status);
      return cut(rows, query.limit);
    },
    async getInvoice(companyId, id) {
      calls.push(['getInvoice', companyId, id]);
      return scoped(seed.invoices, companyId).find((r) => r.id === id) ?? null;
    },
    async listPayments(companyId, query) {
      calls.push(['listPayments', companyId, query]);
      let rows = scoped(seed.payments, companyId);
      if (query.status) rows = rows.filter((r) => r.status === query.status);
      return cut(rows, query.limit);
    },
  };
}

function seededStore() {
  return memoryStore({
    bookings: [bookingRow(CO_A, 1), bookingRow(CO_A, 2, { status: 'cancelled' }), bookingRow(CO_B, 1)],
    invoices: [invoiceRow(CO_A, 1), invoiceRow(CO_B, 1, { status: 'paid' })],
    payments: [paymentRow(CO_A, 1), paymentRow(CO_B, 1)],
  });
}

function specById(store) {
  return Object.fromEntries(createReadToolSpecs(store).map((spec) => [spec.id, spec]));
}

test('every bound read tool rejects companyId in its input', async () => {
  const specs = specById(seededStore());
  const cases = [
    ['booking_requests.list', {}],
    ['booking_requests.get', { id: `${CO_A}-b1` }],
    ['invoices.list', {}],
    ['invoices.get', { id: `${CO_A}-i1` }],
    ['payments.list', {}],
  ];
  for (const [id, base] of cases) {
    await assert.rejects(
      () => specs[id].run(CO_A, { ...base, companyId: CO_B }),
      /invalid input: companyId/,
      `${id} must reject companyId`,
    );
    await assert.rejects(
      () => specs[id].run(CO_A, { ...base, company_id: CO_B }),
      /invalid input/,
      `${id} must reject company_id`,
    );
  }
});

test('the companyId argument is the only tenant source, and an invalid one is refused', async () => {
  const store = seededStore();
  const specs = specById(store);
  await assert.rejects(() => specs['invoices.list'].run('', {}), /companyId is required/);
  await assert.rejects(() => specs['invoices.list'].run('bad id with spaces', {}), /companyId must be/);
  assert.equal(store.calls.length, 0, 'no store call when companyId is invalid');
});

test('list tools return only rows for the given company', async () => {
  const specs = specById(seededStore());
  const bookings = await specs['booking_requests.list'].run(CO_A, {});
  assert.deepEqual(bookings.rows.map((r) => r.id), [`${CO_A}-b1`, `${CO_A}-b2`]);
  const otherBookings = await specs['booking_requests.list'].run(CO_B, {});
  assert.deepEqual(otherBookings.rows.map((r) => r.id), [`${CO_B}-b1`]);

  const invoices = await specs['invoices.list'].run(CO_A, {});
  assert.deepEqual(invoices.rows.map((r) => r.id), [`${CO_A}-i1`]);
  const payments = await specs['payments.list'].run(CO_B, {});
  assert.deepEqual(payments.rows.map((r) => r.id), [`${CO_B}-p1`]);
});

test('get tools return not-found for another company row', async () => {
  const specs = specById(seededStore());
  const own = await specs['invoices.get'].run(CO_A, { id: `${CO_A}-i1` });
  assert.equal(own.found, true);
  const foreign = await specs['invoices.get'].run(CO_A, { id: `${CO_B}-i1` });
  assert.deepEqual(foreign, { found: false, row: null });
  const foreignBooking = await specs['booking_requests.get'].run(CO_A, { id: `${CO_B}-b1` });
  assert.deepEqual(foreignBooking, { found: false, row: null });
});

test('a store that leaks another company row is filtered again by the handler', async () => {
  const leaky = {
    async listBookings() { return [bookingRow(CO_B, 9), bookingRow(CO_A, 1)]; },
    async getBooking() { return bookingRow(CO_B, 9); },
    async listInvoices() { return []; },
    async getInvoice() { return invoiceRow(CO_B, 1); },
    async listPayments() { return []; },
  };
  const specs = specById(leaky);
  const out = await specs['booking_requests.list'].run(CO_A, {});
  assert.deepEqual(out.rows.map((r) => r.id), [`${CO_A}-b1`]);
  assert.deepEqual(await specs['booking_requests.get'].run(CO_A, { id: 'x' }), { found: false, row: null });
});

test('results are bounded at 50 rows and report truncation', async () => {
  const many = Array.from({ length: 120 }, (_, i) => bookingRow(CO_A, i));
  const store = memoryStore({ bookings: many, invoices: [], payments: [] });
  const specs = specById(store);

  const out = await specs['booking_requests.list'].run(CO_A, {});
  assert.equal(MAX_READ_ROWS, 50);
  assert.equal(out.rows.length, 50);
  assert.equal(out.count, 50);
  assert.equal(out.truncated, true);
  assert.equal(out.maxRows, 50);
  // The store is asked for one more row than the cap, so truncation can be seen.
  assert.equal(store.calls.at(-1)[2].limit, 51);

  const asked = await specs['booking_requests.list'].run(CO_A, { limit: 5 });
  assert.equal(asked.rows.length, 5);
  assert.equal(asked.truncated, true);
  assert.equal(store.calls.at(-1)[2].limit, 6);

  await assert.rejects(() => specs['booking_requests.list'].run(CO_A, { limit: 51 }), /invalid input: limit/);
  await assert.rejects(() => specs['booking_requests.list'].run(CO_A, { limit: 0 }), /invalid input: limit/);
});

test('output has no secrets, gateway ids or personal contact fields', async () => {
  const specs = specById(seededStore());
  const payments = JSON.stringify(await specs['payments.list'].run(CO_A, {}));
  assert.ok(!payments.includes('pi_secret_123'));
  assert.ok(!payments.includes('metadata'));
  const invoices = JSON.stringify(await specs['invoices.list'].run(CO_A, {}));
  assert.ok(!invoices.includes('c1@example.test'));
  assert.ok(!invoices.includes('1 Secret St'));
  assert.ok(!invoices.includes('lineItems'));
  const bookings = JSON.stringify(await specs['booking_requests.list'].run(CO_A, {}));
  assert.ok(!bookings.includes('+61400000000'));
  assert.ok(!bookings.includes('c1@example.test'));
});

test('input validation rejects unknown keys and bad values, naming fields only', async () => {
  const specs = specById(seededStore());
  await assert.rejects(() => specs['invoices.list'].run(CO_A, { status: 'overdue' }), /invalid input: status/);
  await assert.rejects(() => specs['booking_requests.list'].run(CO_A, { fromDate: '10/11/2026' }), /invalid input: fromDate/);
  await assert.rejects(() => specs['invoices.get'].run(CO_A, { id: '' }), /invalid input: id/);
  await assert.rejects(() => specs['payments.list'].run(CO_A, { sneaky: true }), /invalid input: sneaky/);
});

test('registerReadTools registers each bound tool as a read tool with the registry', () => {
  // The group 01 handler set (handlers/group-01.ts) is registered too. Its writes and side-effect tools declare their own
  // access. The five read tools below must still be access 'read' and risk 'low'.
  const registered = [];
  registerReadTools({ register: (def) => registered.push(def) }, seededStore());
  assert.deepEqual(
    registered.map((d) => d.id).sort(),
    [
      'booking_requests.get',
      'booking_requests.list',
      'invoices.get',
      'invoices.list',
      'payments.list',
      ...GROUP01_TOOL_IDS,
    ].sort(),
  );
  const readOnly = registered.filter((d) => !GROUP01_TOOL_IDS.includes(d.id));
  assert.equal(readOnly.length, 5);
  for (const def of readOnly) {
    assert.equal(def.access, 'read');
    assert.equal(def.risk, 'low');
    assert.equal(typeof def.handler, 'function');
  }
  for (const def of registered.filter((d) => GROUP01_TOOL_IDS.includes(d.id))) {
    assert.ok(['read', 'write'].includes(def.access), `${def.id} must declare access`);
    assert.equal(typeof def.handler, 'function');
  }
});

test('read tools run through the tool registry and refuse companyId in params', async () => {
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
  registerReadTools(registry, seededStore());
  const actor = { kind: 'agent', agentId: 'agent-1', roleId: 'cleaning-invoice-query-desk', autonomy: 'auto' };

  const ok = await registry.invoke({ companyId: CO_A, toolId: 'invoices.list', params: {}, actor });
  assert.equal(ok.outcome, 'executed');
  assert.deepEqual(ok.output.rows.map((r) => r.id), [`${CO_A}-i1`]);

  const refused = await registry.invoke({ companyId: CO_A, toolId: 'invoices.list', params: { companyId: CO_B }, actor });
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.reason, 'tenant_override');
});

test('definitions expose the same ids as the specs, plus the group 01 handler set', () => {
  const store = seededStore();
  const groupIds = new Set(GROUP01_TOOL_IDS);
  const defIds = createReadToolDefinitions(store).map((d) => d.id).filter((id) => !groupIds.has(id)).sort();
  const specIds = createReadToolSpecs(store).map((s) => s.id).sort();
  assert.deepEqual(defIds, specIds);
  const groupDefIds = createReadToolDefinitions(store).map((d) => d.id).filter((id) => groupIds.has(id)).sort();
  assert.deepEqual(groupDefIds, [...GROUP01_TOOL_IDS].sort());
});

/**
 * Tests for inventory.stock.list (server/workforce/tools/handlers/group-missing.ts). Fake SQL executor, no database.
 * Run: node --test --experimental-transform-types tests/workforce/tools-stock-list.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Silence console output so the test runner's IPC is not broken by server imports.
for (const method of ['log', 'info', 'warn']) console[method] = () => {};

const { createGroupMissingToolDefinitions, GROUP_MISSING_TOOL_IDS, MISSING_MAX_ROWS } = await import(
  '../../server/workforce/tools/handlers/group-missing.ts'
);

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';

const ownRow = {
  id: 'item-a1',
  companyId: CO_A,
  name: 'Mop heads',
  sku: 'MOP-01',
  unitLabel: 'each',
  storeSection: 'secret-shelf',
  quantity: '4.000',
  reorderLevel: '10.000',
};
const otherRow = { ...ownRow, id: 'item-b1', companyId: CO_B, name: 'Other stock' };

function fakeDb(rows, calls = []) {
  return {
    calls,
    query: async (text, values) => {
      calls.push({ text, values });
      return { rows, rowCount: rows.length };
    },
  };
}

const def = (db) => createGroupMissingToolDefinitions(db).find((d) => d.id === 'inventory.stock.list');
const ctx = (companyId) => ({ companyId, signal: new AbortController().signal });

test('the module lists inventory.stock.list as its only id, read access, low risk', () => {
  assert.deepEqual([...GROUP_MISSING_TOOL_IDS], ['inventory.stock.list']);
  const d = def(fakeDb([]));
  assert.equal(d.access, 'read');
  assert.equal(d.risk, 'low');
  assert.equal(typeof d.timeoutMs, 'number');
  assert.deepEqual(d.schema, { limit: { type: 'number' } });
});

test('returns only the caller company rows, with an explicit allow-list (no storeSection)', async () => {
  const calls = [];
  const out = await def(fakeDb([ownRow, otherRow], calls)).handler({}, ctx(CO_A));
  assert.equal(out.count, 1);
  assert.deepEqual(out.rows, [
    { id: 'item-a1', name: 'Mop heads', sku: 'MOP-01', unitLabel: 'each', quantity: 4, reorderLevel: 10 },
  ]);
  assert.equal(out.truncated, false);
  assert.equal(out.maxRows, MISSING_MAX_ROWS);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /WHERE company_id = \$1/);
  assert.deepEqual(calls[0].values, [CO_A, MISSING_MAX_ROWS + 1]);
});

test('caps the rows at the caller limit and reports truncation', async () => {
  const rows = [1, 2, 3].map((n) => ({ ...ownRow, id: `i${n}`, name: `Item ${n}` }));
  const out = await def(fakeDb(rows)).handler({ limit: 2 }, ctx(CO_A));
  assert.equal(out.count, 2);
  assert.equal(out.truncated, true);
});

test('refuses a companyId key in the input, and never runs the query', async () => {
  const calls = [];
  await assert.rejects(def(fakeDb([], calls)).handler({ companyId: CO_B }, ctx(CO_A)), /invalid input: companyId/);
  assert.equal(calls.length, 0);
});

test('refuses an out-of-range limit', async () => {
  await assert.rejects(def(fakeDb([])).handler({ limit: 500 }, ctx(CO_A)), /invalid input: limit/);
});

test('refuses when no company id is in the context', async () => {
  await assert.rejects(def(fakeDb([])).handler({}, ctx('')), /companyId is required/);
});

test('refuses without a database executor rather than guessing', async () => {
  await assert.rejects(def(undefined).handler({}, ctx(CO_A)), /needs a database executor/);
});

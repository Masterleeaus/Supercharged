/**
 * Tests for server/workforce/runtime/retention.ts. Injected clock and an in-memory fake store only. No database, no network.
 * Run: node --test --experimental-transform-types tests/workforce/retention.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pruneRetention, RETENTION_DAYS } from '../../server/workforce/runtime/retention.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(Date.UTC(2026, 10, 3, 12, 0, 0));
const ago = (days) => new Date(NOW.getTime() - days * DAY).toISOString();

/** Fake store. Keeps rows per company and table, and records every delete call. */
function fakeStore(initial = {}) {
  const data = {
    runs: [],
    tool_calls: [],
    tasks: [],
    budget_usage: [],
    ...structuredClone(initial),
  };
  const deletes = [];
  const listed = [];
  return {
    data,
    deletes,
    listed,
    async listRetentionRows(companyId, table) {
      listed.push(table);
      return data[table].filter((r) => r.companyId === companyId).map((r) => ({ ...r }));
    },
    async deleteRetentionRows(companyId, table, ids) {
      deletes.push({ companyId, table, ids: [...ids] });
      const before = data[table].length;
      data[table] = data[table].filter((r) => !(r.companyId === companyId && ids.includes(r.id)));
      return before - data[table].length;
    },
  };
}

function run(id, companyId, daysAgoEnded, status = 'completed') {
  return { id, companyId, status, at: daysAgoEnded === null ? null : ago(daysAgoEnded) };
}
function row(id, companyId, daysAgo) {
  return { id, companyId, at: ago(daysAgo) };
}

test('retention periods are 365 days for runs, 180 for tool calls and tasks, 90 for budget usage', () => {
  assert.deepEqual(RETENTION_DAYS, { runs: 365, tool_calls: 180, tasks: 180, budget_usage: 90 });
});

test('finished run older than 365 days is expired, one at 364 days is kept', async () => {
  const store = fakeStore({
    runs: [run('old', 'co-1', 366), run('recent', 'co-1', 364)],
  });
  const result = await pruneRetention({ store, now: NOW, dryRun: true }, 'co-1');
  assert.equal(result.counts.runs, 1);
});

test('unfinished run is kept whatever its age', async () => {
  const store = fakeStore({
    runs: [run('running', 'co-1', 900, 'running'), run('waiting', 'co-1', 900, 'awaiting_approval')],
  });
  const result = await pruneRetention({ store, now: NOW, dryRun: false }, 'co-1');
  assert.equal(result.counts.runs, 0);
  assert.equal(store.data.runs.length, 2);
});

test('tool calls and tasks expire after 180 days, not before', async () => {
  const store = fakeStore({
    tool_calls: [row('tc-old', 'co-1', 181), row('tc-new', 'co-1', 179)],
    tasks: [row('task-old', 'co-1', 181), row('task-new', 'co-1', 179)],
  });
  const result = await pruneRetention({ store, now: NOW, dryRun: true }, 'co-1');
  assert.equal(result.counts.tool_calls, 1);
  assert.equal(result.counts.tasks, 1);
});

test('budget usage expires after 90 days, not before', async () => {
  const store = fakeStore({
    budget_usage: [row('b-old', 'co-1', 91), row('b-new', 'co-1', 89)],
  });
  const result = await pruneRetention({ store, now: NOW, dryRun: true }, 'co-1');
  assert.equal(result.counts.budget_usage, 1);
});

test('audit is never pruned: no audit table is listed or deleted, even when audit rows exist', async () => {
  const store = fakeStore({
    audit: [row('audit-old', 'co-1', 4000)],
  });
  const result = await pruneRetention({ store, now: NOW, dryRun: false }, 'co-1');
  assert.equal(store.listed.includes('audit'), false);
  assert.equal(store.deletes.some((d) => d.table === 'audit'), false);
  assert.equal(Object.hasOwn(result.counts, 'audit'), false);
  assert.equal(store.data.audit.length, 1);
});

test('dry run reports counts and deletes nothing', async () => {
  const store = fakeStore({
    runs: [run('r-old', 'co-1', 400)],
    tool_calls: [row('tc-old', 'co-1', 200)],
    tasks: [row('t-old', 'co-1', 200)],
    budget_usage: [row('b-old', 'co-1', 100)],
  });
  const before = structuredClone(store.data);
  const result = await pruneRetention({ store, now: NOW, dryRun: true }, 'co-1');
  assert.deepEqual(result.counts, { runs: 1, tool_calls: 1, tasks: 1, budget_usage: 1 });
  assert.equal(result.dryRun, true);
  assert.equal(store.deletes.length, 0);
  assert.deepEqual(store.data, before);
});

test('dryRun not exactly false is treated as a dry run', async () => {
  const store = fakeStore({ budget_usage: [row('b-old', 'co-1', 100)] });
  const result = await pruneRetention({ store, now: NOW }, 'co-1');
  assert.equal(result.dryRun, true);
  assert.equal(store.deletes.length, 0);
  assert.equal(store.data.budget_usage.length, 1);
});

test('non dry run removes only expired rows and returns the removed counts', async () => {
  const store = fakeStore({
    runs: [run('r-old', 'co-1', 400), run('r-new', 'co-1', 10)],
    budget_usage: [row('b-old', 'co-1', 100), row('b-new', 'co-1', 1)],
  });
  const result = await pruneRetention({ store, now: NOW, dryRun: false }, 'co-1');
  assert.equal(result.dryRun, false);
  assert.equal(result.counts.runs, 1);
  assert.equal(result.counts.budget_usage, 1);
  assert.deepEqual(store.data.runs.map((r) => r.id), ['r-new']);
  assert.deepEqual(store.data.budget_usage.map((r) => r.id), ['b-new']);
});

test('pruning is company scoped: another company rows are never listed for deletion', async () => {
  const store = fakeStore({
    runs: [run('a-old', 'co-1', 400), run('b-old', 'co-2', 400)],
    tool_calls: [row('b-tc', 'co-2', 400)],
  });
  const result = await pruneRetention({ store, now: NOW, dryRun: false }, 'co-1');
  assert.equal(result.companyId, 'co-1');
  assert.ok(store.deletes.every((d) => d.companyId === 'co-1'));
  assert.deepEqual(store.data.runs.map((r) => r.id), ['b-old']);
  assert.equal(store.data.tool_calls.length, 1);
});

test('numeric company id is normalised and used for store calls', async () => {
  const store = fakeStore({ runs: [run('x', '7', 400)] });
  const result = await pruneRetention({ store, now: NOW, dryRun: false }, 7);
  assert.equal(result.companyId, '7');
  assert.equal(store.data.runs.length, 0);
});

test('missing or invalid company id is refused before any store call', async () => {
  const store = fakeStore({ runs: [run('x', 'co-1', 400)] });
  await assert.rejects(pruneRetention({ store, now: NOW, dryRun: false }, ''), /company/);
  await assert.rejects(pruneRetention({ store, now: NOW, dryRun: false }, undefined), /company/);
  assert.equal(store.listed.length, 0);
  assert.equal(store.deletes.length, 0);
});

test('a row returned for another company makes the run fail without deleting', async () => {
  const store = fakeStore({ runs: [run('x', 'co-1', 400)] });
  store.listRetentionRows = async () => [{ id: 'leak', companyId: 'co-2', at: ago(400), status: 'completed' }];
  await assert.rejects(pruneRetention({ store, now: NOW, dryRun: false }, 'co-1'), /another company/);
  assert.equal(store.deletes.length, 0);
});

test('rows without a timestamp or with a bad one are kept', async () => {
  const store = fakeStore({
    runs: [{ id: 'no-end', companyId: 'co-1', status: 'completed', at: null }],
    tool_calls: [{ id: 'bad', companyId: 'co-1', at: 'not-a-date' }],
  });
  const result = await pruneRetention({ store, now: NOW, dryRun: false }, 'co-1');
  assert.equal(result.counts.runs, 0);
  assert.equal(result.counts.tool_calls, 0);
  assert.equal(store.data.runs.length, 1);
  assert.equal(store.data.tool_calls.length, 1);
});

test('an invalid now is refused', async () => {
  const store = fakeStore();
  await assert.rejects(pruneRetention({ store, now: new Date('nope'), dryRun: true }, 'co-1'), TypeError);
});

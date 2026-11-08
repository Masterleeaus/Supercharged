/**
 * Tests for the scheduled retention job and the PG retention store in server/workforce/runtime/retention.ts.
 * Injected clock, in-memory fake store, fake SQL executor. No database, no network, no real timers.
 * Run: cd /home/claude/desk-review && node --test --experimental-transform-types tests/workforce/retention-job.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RETENTION_JOB_ID,
  RETENTION_HOUR_UTC,
  createPgRetentionStore,
  scheduleRetentionPruning,
} from '../../server/workforce/runtime/retention.ts';
import { createScheduler } from '../../server/workforce/runtime/scheduler.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(Date.UTC(2026, 10, 3, 12, 0, 0));
const ago = (days) => new Date(NOW.getTime() - days * DAY).toISOString();
const RETRY = { baseMs: 1000, maxMs: 1000, maxAttempts: 1 };

/** Fake store over several companies. Records every list and delete call. */
function fakeStore(initial) {
  const data = { runs: [], tool_calls: [], tasks: [], budget_usage: [], audit: [], ...structuredClone(initial) };
  const listed = [];
  const deletes = [];
  return {
    data,
    listed,
    deletes,
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

const finishedRun = (id, companyId, days) => ({ id, companyId, status: 'completed', at: ago(days) });
const row = (id, companyId, days) => ({ id, companyId, at: ago(days) });

/** A scheduler with the retention job registered, and a clock the test can move. */
function harness(store, { companies = ['co-1'], dryRun } = {}) {
  const clock = { t: NOW };
  const scheduler = createScheduler({ now: () => clock.t.getTime(), retry: RETRY });
  const job = scheduleRetentionPruning({
    schedule: scheduler.schedule,
    store,
    listCompanyIds: async () => companies,
    now: () => clock.t,
    dryRun,
  });
  return { clock, scheduler, job };
}

/** Moves the clock to the job's first slot and ticks once. */
async function runNightly(h) {
  const [view] = h.scheduler.list('workforce-system');
  h.clock.t = new Date(view.runAt);
  return h.scheduler.tick();
}

test('the nightly job is registered daily at the retention hour, after midnight UTC', () => {
  const h = harness(fakeStore());
  const [view] = h.scheduler.list('workforce-system');
  assert.equal(view.id, RETENTION_JOB_ID);
  assert.equal(view.kind, 'recurring');
  assert.equal(view.intervalMs, DAY);
  // NOW is 12:00 UTC on 3 November, so the next 02:00 slot is on 4 November.
  assert.equal(view.runAt, Date.UTC(2026, 10, 4, RETENTION_HOUR_UTC));
});

test('the scheduled job is a dry run by default and deletes nothing', async () => {
  const store = fakeStore({
    runs: [finishedRun('old-run', 'co-1', 400)],
    tool_calls: [row('tc', 'co-1', 200)],
    budget_usage: [row('bu', 'co-1', 100)],
  });
  const h = harness(store);
  await runNightly(h);
  assert.equal(store.deletes.length, 0);
  assert.equal(store.data.runs.length, 1);
  const attempt = h.scheduler.attempts('workforce-system').at(-1);
  assert.equal(attempt.ok, true, attempt.error);
});

test('dryRun exactly false is the only setting that deletes', async () => {
  const store = fakeStore({
    runs: [finishedRun('old-run', 'co-1', 400)],
    tool_calls: [row('tc', 'co-1', 200)],
    budget_usage: [row('bu', 'co-1', 100)],
  });
  const h = harness(store, { dryRun: false });
  await runNightly(h);
  assert.equal(store.data.runs.length, 0);
  assert.equal(store.data.tool_calls.length, 0);
  assert.equal(store.data.budget_usage.length, 0);
});

test('dryRun given as anything but false keeps the job a dry run', async () => {
  for (const value of [true, 0, '', 'false', null]) {
    const store = fakeStore({ budget_usage: [row('bu', 'co-1', 100)] });
    const h = harness(store, { dryRun: value });
    await runNightly(h);
    assert.equal(store.deletes.length, 0, `dryRun=${String(value)} must not delete`);
  }
});

test('audit is never listed or deleted by the scheduled job, even with dryRun false and old audit rows', async () => {
  const store = fakeStore({
    runs: [finishedRun('old-run', 'co-1', 400)],
    audit: [row('audit-old', 'co-1', 3000)],
  });
  const h = harness(store, { dryRun: false });
  await runNightly(h);
  assert.equal(store.listed.includes('audit'), false);
  assert.equal(store.deletes.some((d) => d.table === 'audit'), false);
  assert.equal(store.data.audit.length, 1);
});

test('the job prunes every listed company and leaves other companies alone', async () => {
  const store = fakeStore({
    runs: [finishedRun('a-old', 'co-1', 400), finishedRun('b-old', 'co-2', 400), finishedRun('c-old', 'co-3', 400)],
  });
  const h = harness(store, { companies: ['co-1', 'co-2'], dryRun: false });
  await runNightly(h);
  assert.deepEqual(store.data.runs.map((r) => r.id), ['c-old']);
});

test('runNow returns one result per company, in order', async () => {
  const store = fakeStore({ budget_usage: [row('bu', 'co-1', 100)] });
  const job = harness(store, { companies: ['co-1', 'co-2'] }).job;
  const results = await job.runNow();
  assert.deepEqual(results.map((r) => r.companyId), ['co-1', 'co-2']);
  assert.equal(results[0].counts.budget_usage, 1);
});

test('a failed company list fails the attempt, so the scheduler records it for retry', async () => {
  const store = fakeStore();
  const clock = { t: NOW };
  const scheduler = createScheduler({ now: () => clock.t.getTime(), retry: { baseMs: 1000, maxMs: 1000, maxAttempts: 2 } });
  scheduleRetentionPruning({
    schedule: scheduler.schedule,
    store,
    listCompanyIds: async () => {
      throw new Error('database unreachable');
    },
    now: () => clock.t,
  });
  await runNightly({ clock, scheduler });
  const [attempt] = scheduler.attempts('workforce-system');
  assert.equal(attempt.ok, false);
  assert.match(attempt.error, /database unreachable/);
});

test('scheduleRetentionPruning rejects a missing schedule function and a missing company list', () => {
  const store = fakeStore();
  assert.throws(() => scheduleRetentionPruning({ store, listCompanyIds: async () => [], now: () => NOW }), /schedule/);
  assert.throws(() => scheduleRetentionPruning({ schedule: () => {}, store, now: () => NOW }), /listCompanyIds/);
});

// ---------- PG retention store ----------

/** Fake SQL executor. Records each statement and returns the given rows for SELECTs. */
function fakeSql(rowsFor = () => []) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values: [...values] });
      if (/^\s*DELETE/i.test(text)) return { rows: [], rowCount: 2 };
      const rows = rowsFor(text);
      return { rows, rowCount: rows.length };
    },
  };
}

test('the PG store never names the audit table in any statement', async () => {
  const sql = fakeSql();
  const store = createPgRetentionStore(sql);
  for (const table of ['runs', 'tool_calls', 'tasks', 'budget_usage']) {
    await store.listRetentionRows('11111111-1111-4111-8111-111111111111', table);
    await store.deleteRetentionRows('11111111-1111-4111-8111-111111111111', table, ['x']);
  }
  await store.listCompanyIds();
  for (const call of sql.calls) {
    assert.doesNotMatch(call.text, /audit/i, call.text);
  }
});

test('every PG list and delete is scoped to the company named by the caller', async () => {
  const sql = fakeSql();
  const store = createPgRetentionStore(sql);
  await store.listRetentionRows('co-A', 'tasks');
  await store.deleteRetentionRows('co-A', 'tool_calls', ['id-1']);
  for (const call of sql.calls) {
    assert.match(call.text, /company_id = \$1/);
    assert.equal(call.values[0], 'co-A');
  }
});

test('the PG run delete also requires a terminal status', async () => {
  const sql = fakeSql();
  const store = createPgRetentionStore(sql);
  const deleted = await store.deleteRetentionRows('co-A', 'runs', ['run-1']);
  assert.equal(deleted, 2);
  const [call] = sql.calls;
  assert.match(call.text, /DELETE FROM workforce_runs/);
  assert.match(call.text, /status = ANY/);
  assert.ok(call.values[2].includes('completed'));
  assert.ok(!call.values[2].includes('running'));
});

test('the PG store reads budget usage by its day and keys its rows on the composite key', async () => {
  const sql = fakeSql(() => [{ id: 'run\u001fkey\u001f2026-01-01', company_id: 'co-A', at: '2026-01-01', status: null }]);
  const store = createPgRetentionStore(sql);
  const rows = await store.listRetentionRows('co-A', 'budget_usage');
  assert.match(sql.calls[0].text, /FROM workforce_budget_usage/);
  assert.match(sql.calls[0].text, /day::text AS at/);
  assert.deepEqual(rows, [{ id: 'run\u001fkey\u001f2026-01-01', companyId: 'co-A', at: '2026-01-01', status: null }]);
  await store.deleteRetentionRows('co-A', 'budget_usage', rows.map((r) => r.id));
  assert.match(sql.calls[1].text, /chr\(31\)/);
});

test('an empty id list makes no delete call', async () => {
  const sql = fakeSql();
  const store = createPgRetentionStore(sql);
  assert.equal(await store.deleteRetentionRows('co-A', 'runs', []), 0);
  assert.equal(sql.calls.length, 0);
});

test('a PG run timestamp that is a Date is read as an ISO string', async () => {
  const when = new Date(Date.UTC(2025, 0, 1));
  const sql = fakeSql(() => [{ id: 'r1', company_id: 'co-A', at: when, status: 'failed' }]);
  const [row1] = await createPgRetentionStore(sql).listRetentionRows('co-A', 'runs');
  assert.equal(row1.at, when.toISOString());
  assert.equal(row1.status, 'failed');
});

/**
 * Tests for server/workforce/runtime/pg-budgets.ts. No database: a fake SqlExecutor models the conditional
 * statements in BUDGET_SQL on an in-memory table. Each statement is applied in one step after a yield, so two
 * reservations started together interleave at statement boundaries, as concurrent callers would.
 * Run: node --test --experimental-transform-types tests/workforce/pg-budgets.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { createPgBudgetStore, BUDGET_SQL } = await import('../../server/workforce/runtime/pg-budgets.ts');
const { createBudgetLedger, reserve, release, turnHeadroom } = await import('../../server/workforce/runtime/budgets.ts');

const COMPANY_A = '6f1c2e3a-1111-4a5b-8c9d-00000000000a';
const COMPANY_B = '6f1c2e3a-2222-4a5b-8c9d-00000000000b';
const RUN_DAY = '1970-01-01';

const DAY1 = Date.UTC(2026, 10, 3, 9, 0, 0);
const DAY1_LATE = Date.UTC(2026, 10, 3, 23, 59, 59, 999);
const DAY2 = Date.UTC(2026, 10, 4, 0, 0, 0, 0);

const LIMITS = {
  maxToolCallsPerRun: 5,
  maxTokensPerRun: 1000,
  maxSpendCentsPerRun: 500,
  maxRunsPerCompanyPerDay: 3,
  maxSpendCentsPerCompanyPerDay: 1200,
};

const req = (overrides = {}) => ({
  companyId: COMPANY_A,
  runId: 'run-1',
  toolCalls: 0,
  tokens: 0,
  spendCents: 0,
  now: DAY1,
  ...overrides,
});

/** In-memory table keyed by company, scope, scope key and day. Models each conditional statement in BUDGET_SQL. */
function createFakeDb() {
  const rows = new Map();
  const calls = [];
  const key = (company, scope, scopeKey, day) => [company, scope, scopeKey, day].join('|');
  const ok = (list) => ({ rows: list, rowCount: list.length });
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  function apply(text, v) {
    if (text === BUDGET_SQL.reserveRunUsage) {
      const [company, runId, tc, tk, sp, maxTc, maxTk, maxSp] = v;
      const k = key(company, 'run', runId, RUN_DAY);
      const row = rows.get(k);
      if (!row) {
        if (tc > maxTc || tk > maxTk || sp > maxSp) return ok([]);
        rows.set(k, { toolCalls: tc, tokens: tk, spend: sp, runs: 0 });
        return ok([{ runs: 0 }]);
      }
      if (row.toolCalls + tc > maxTc || row.tokens + tk > maxTk || row.spend + sp > maxSp) return ok([]);
      row.toolCalls += tc;
      row.tokens += tk;
      row.spend += sp;
      return ok([{ runs: row.runs }]);
    }

    if (text === BUDGET_SQL.claimRunStart) {
      const [company, runId] = v;
      const row = rows.get(key(company, 'run', runId, RUN_DAY));
      if (!row || row.runs !== 0) return ok([]);
      row.runs = 1;
      return ok([{ runs: 1 }]);
    }

    if (text === BUDGET_SQL.reserveCompanyNewRun) {
      const [company, day, sp, maxSp, maxRuns] = v;
      if (sp > maxSp || 1 > maxRuns) return ok([]);
      const k = key(company, 'company', '', day);
      const row = rows.get(k);
      if (!row) {
        rows.set(k, { spend: sp, runs: 1 });
        return ok([{ runs: 1 }]);
      }
      if (row.runs + 1 > maxRuns || row.spend + sp > maxSp) return ok([]);
      row.runs += 1;
      row.spend += sp;
      return ok([{ runs: row.runs }]);
    }

    if (text === BUDGET_SQL.reserveCompanySpend) {
      const [company, day, sp, maxSp] = v;
      if (sp > maxSp) return ok([]);
      const k = key(company, 'company', '', day);
      const row = rows.get(k);
      if (!row) {
        rows.set(k, { spend: sp, runs: 0 });
        return ok([{ runs: 0 }]);
      }
      if (row.spend + sp > maxSp) return ok([]);
      row.spend += sp;
      return ok([{ runs: row.runs }]);
    }

    if (text === BUDGET_SQL.readRunUsage) {
      const [company, runId] = v;
      const row = rows.get(key(company, 'run', runId, RUN_DAY));
      return ok(row ? [{ tool_calls: row.toolCalls, tokens: row.tokens, spend_cents: row.spend }] : []);
    }

    if (text === BUDGET_SQL.readCompanyDay) {
      const [company, day] = v;
      const row = rows.get(key(company, 'company', '', day));
      return ok(row ? [{ runs: row.runs, spend_cents: row.spend }] : []);
    }

    if (text === BUDGET_SQL.readRunClaimed) {
      const [company, runId] = v;
      const row = rows.get(key(company, 'run', runId, RUN_DAY));
      return ok(row ? [{ runs: row.runs }] : []);
    }

    if (text === BUDGET_SQL.releaseRunUsage) {
      const [company, runId, tc, tk, sp] = v;
      const row = rows.get(key(company, 'run', runId, RUN_DAY));
      if (row) {
        row.toolCalls = Math.max(0, row.toolCalls - tc);
        row.tokens = Math.max(0, row.tokens - tk);
        row.spend = Math.max(0, row.spend - sp);
      }
      return ok([]);
    }

    if (text === BUDGET_SQL.releaseCompanySpend) {
      const [company, day, sp] = v;
      const row = rows.get(key(company, 'company', '', day));
      if (row) row.spend = Math.max(0, row.spend - sp);
      return ok([]);
    }

    if (text === BUDGET_SQL.unclaimRunStart) {
      const [company, runId] = v;
      const row = rows.get(key(company, 'run', runId, RUN_DAY));
      if (row && row.runs === 1) row.runs = 0;
      return ok([]);
    }

    if (text === BUDGET_SQL.dropEmptyRunUsage) {
      const [company, runId] = v;
      const k = key(company, 'run', runId, RUN_DAY);
      const row = rows.get(k);
      if (row && row.runs === 0 && row.toolCalls === 0 && row.tokens === 0 && row.spend === 0) rows.delete(k);
      return ok([]);
    }

    throw new Error(`fake db does not know this statement: ${text.slice(0, 60)}`);
  }

  return {
    calls,
    async query(text, values) {
      calls.push({ text, values: [...values] });
      await tick();
      return apply(text, values);
    },
    /** Stable copy of the table, for "writes nothing" checks. */
    snapshot() {
      return JSON.stringify([...rows.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
    },
    companyDay(company, day) {
      return rows.get(key(company, 'company', '', day)) ?? null;
    },
    runRow(company, runId) {
      return rows.get(key(company, 'run', runId, RUN_DAY)) ?? null;
    },
  };
}

test('two concurrent reservations for the last company spend unit: only one passes', async () => {
  const db = createFakeDb();
  const store = createPgBudgetStore(db, { ...LIMITS, maxSpendCentsPerCompanyPerDay: 10 });

  const [a, b] = await Promise.all([
    store.reserve(req({ runId: 'r1', spendCents: 10 })),
    store.reserve(req({ runId: 'r2', spendCents: 10 })),
  ]);

  const allowed = [a, b].filter((r) => r.allowed);
  const refused = [a, b].filter((r) => !r.allowed);
  assert.equal(allowed.length, 1);
  assert.deepEqual(refused, [{ allowed: false, reason: 'company_spend_quota' }]);
  assert.equal(db.companyDay(COMPANY_A, '2026-11-03').spend, 10);
});

test('two concurrent reservations for the last run-quota slot: only one passes', async () => {
  const db = createFakeDb();
  const store = createPgBudgetStore(db, { ...LIMITS, maxRunsPerCompanyPerDay: 1 });

  const [a, b] = await Promise.all([store.reserve(req({ runId: 'r1' })), store.reserve(req({ runId: 'r2' }))]);

  assert.equal([a, b].filter((r) => r.allowed).length, 1);
  assert.deepEqual([a, b].find((r) => !r.allowed), { allowed: false, reason: 'run_quota' });
  assert.equal(db.companyDay(COMPANY_A, '2026-11-03').runs, 1);
});

test('two concurrent reservations for the same run at its last tool call: only one passes', async () => {
  const db = createFakeDb();
  const store = createPgBudgetStore(db, LIMITS);

  const [a, b] = await Promise.all([
    store.reserve(req({ runId: 'same', toolCalls: 3 })),
    store.reserve(req({ runId: 'same', toolCalls: 3 })),
  ]);

  assert.equal([a, b].filter((r) => r.allowed).length, 1);
  assert.deepEqual([a, b].find((r) => !r.allowed), { allowed: false, reason: 'tool_call_limit' });
  assert.equal(db.runRow(COMPANY_A, 'same').toolCalls, 3);
});

test('a run-level refusal writes nothing', async () => {
  const db = createFakeDb();
  const store = createPgBudgetStore(db, LIMITS);
  await store.reserve(req({ runId: 'r1', toolCalls: 4 }));
  const before = db.snapshot();

  const result = await store.reserve(req({ runId: 'r1', toolCalls: 2 }));

  assert.deepEqual(result, { allowed: false, reason: 'tool_call_limit' });
  assert.equal(db.snapshot(), before);
});

test('a company-level refusal leaves no run usage, run start or run row behind', async () => {
  const db = createFakeDb();
  const store = createPgBudgetStore(db, { ...LIMITS, maxSpendCentsPerCompanyPerDay: 10 });
  await store.reserve(req({ runId: 'r0', spendCents: 10 }));
  const before = db.snapshot();

  const result = await store.reserve(req({ runId: 'r1', toolCalls: 2, tokens: 50, spendCents: 20 }));

  assert.deepEqual(result, { allowed: false, reason: 'company_spend_quota' });
  assert.equal(db.snapshot(), before);
  assert.equal(db.runRow(COMPANY_A, 'r1'), null);
});

test('the daily keys change at UTC midnight; run usage carries across it', async () => {
  const db = createFakeDb();
  const store = createPgBudgetStore(db, { ...LIMITS, maxRunsPerCompanyPerDay: 1, maxSpendCentsPerCompanyPerDay: 10 });

  assert.deepEqual(await store.reserve(req({ runId: 'a', spendCents: 10, now: DAY1_LATE })), { allowed: true });
  assert.deepEqual(await store.reserve(req({ runId: 'b', now: DAY1_LATE })), { allowed: false, reason: 'run_quota' });
  // One millisecond after UTC midnight: the new day has fresh runs and spend.
  assert.deepEqual(await store.reserve(req({ runId: 'b', spendCents: 10, now: DAY2 })), { allowed: true });

  // Run usage is not day-scoped: 'a' already used 3 of 5 tool calls yesterday.
  assert.deepEqual(await store.reserve(req({ runId: 'a', toolCalls: 3, now: DAY1_LATE })), { allowed: true });
  assert.deepEqual(await store.reserve(req({ runId: 'a', toolCalls: 3, now: DAY2 })), {
    allowed: false,
    reason: 'tool_call_limit',
  });

  // Releasing yesterday's spend after rollover does not touch today's counter.
  await store.release(req({ runId: 'b', spendCents: 10, now: DAY2 }));
  assert.equal(db.companyDay(COMPANY_A, '2026-11-04').spend, 0);
  assert.equal(db.companyDay(COMPANY_A, '2026-11-04').runs, 1);
});

test('reservations match budgets.ts results for the same sequence, and every statement is company-scoped', async () => {
  const ops = [
    ['reserve', req({ runId: 'r1', toolCalls: 2, tokens: 100, spendCents: 100 })],
    ['reserve', req({ runId: 'r1', toolCalls: 4 })],
    ['reserve', req({ runId: 'r2', tokens: 950 })],
    ['reserve', req({ runId: 'r2', tokens: 60 })],
    ['reserve', req({ runId: 'r3', spendCents: 500 })],
    ['reserve', req({ runId: 'r4' })],
    ['reserve', req({ runId: 'r1', spendCents: 400 })],
    ['reserve', req({ runId: 'r1', spendCents: 1 })],
    ['release', req({ runId: 'r3', spendCents: 500 })],
    ['reserve', req({ runId: 'r4' })],
    ['reserve', req({ runId: 'r2', spendCents: 700 })],
    ['reserve', req({ runId: 'r2', spendCents: 300 })],
    ['reserve', req({ runId: 'r2', spendCents: 1, now: DAY2 })],
    ['reserve', req({ runId: 'r9', spendCents: 1, now: DAY2 })],
  ];

  const ledger = createBudgetLedger(LIMITS);
  const db = createFakeDb();
  const store = createPgBudgetStore(db, LIMITS);

  for (const [kind, r] of ops) {
    if (kind === 'release') {
      release(ledger, r);
      await store.release(r);
      continue;
    }
    const expected = reserve(ledger, r);
    const actual = await store.reserve(r);
    assert.deepEqual(actual, expected, `runId ${r.runId} spend ${r.spendCents} tokens ${r.tokens}`);
  }

  assert.ok(db.calls.length > 0);
  for (const call of db.calls) {
    assert.match(call.text, /company_id/, 'statement must filter on company_id');
    assert.equal(call.values[0], COMPANY_A, 'first parameter is the caller company');
  }
});

test('one company never consumes another company budget', async () => {
  const db = createFakeDb();
  const store = createPgBudgetStore(db, { ...LIMITS, maxSpendCentsPerCompanyPerDay: 10 });

  assert.deepEqual(await store.reserve(req({ companyId: COMPANY_A, spendCents: 10 })), { allowed: true });
  assert.deepEqual(await store.reserve(req({ companyId: COMPANY_B, runId: 'run-1', spendCents: 10 })), { allowed: true });
  assert.deepEqual(await store.reserve(req({ companyId: COMPANY_A, runId: 'run-2', spendCents: 1 })), {
    allowed: false,
    reason: 'company_spend_quota',
  });
});

test('limits and request validation throw the same TypeErrors as budgets.ts', async () => {
  const db = createFakeDb();
  const bad = { ...LIMITS, maxRunsPerCompanyPerDay: 0 };
  const budgetsError = (() => {
    try {
      createBudgetLedger(bad);
    } catch (err) {
      return err;
    }
    return null;
  })();
  assert.ok(budgetsError instanceof TypeError);
  assert.throws(() => createPgBudgetStore(db, bad), { name: 'TypeError', message: budgetsError.message });

  const store = createPgBudgetStore(db, LIMITS);
  const cases = [
    [req({ companyId: '' }), 'companyId is required'],
    [req({ runId: '' }), 'runId is required'],
    [req({ toolCalls: -1 }), 'toolCalls must be a non-negative integer'],
    [req({ tokens: 1.5 }), 'tokens must be a non-negative integer'],
    [req({ spendCents: -1 }), 'spendCents must be a non-negative integer'],
    [req({ now: Number.NaN }), 'now must be a finite epoch-milliseconds number'],
  ];
  for (const [bad2, message] of cases) {
    await assert.rejects(store.reserve(bad2), { name: 'TypeError', message });
    assert.throws(() => reserve(createBudgetLedger(LIMITS), bad2), { name: 'TypeError', message });
  }
  assert.equal(db.calls.length, 0, 'invalid requests never reach the database');
});

test('turnHeadroom refuses a turn once the run has no token or spend headroom, and writes nothing', async () => {
  const db = createFakeDb();
  const store = createPgBudgetStore(db, LIMITS);
  assert.deepEqual(await store.turnHeadroom(req()), { allowed: true }, 'a fresh run may start a turn');

  assert.equal((await store.reserve(req({ tokens: 1000 }))).allowed, true);
  const before = db.snapshot();
  assert.deepEqual(await store.turnHeadroom(req()), { allowed: false, reason: 'token_limit' });
  assert.equal(db.snapshot(), before, 'the check is read-only');
});

test('turnHeadroom reports the company quotas for a new run, and not for a run that already has its slot', async () => {
  const db = createFakeDb();
  const store = createPgBudgetStore(db, { ...LIMITS, maxRunsPerCompanyPerDay: 1 });
  assert.equal((await store.reserve(req({ runId: 'run-1' }))).allowed, true);

  assert.deepEqual(await store.turnHeadroom(req({ runId: 'run-2' })), { allowed: false, reason: 'run_quota' });
  assert.deepEqual(await store.turnHeadroom(req({ runId: 'run-1' })), { allowed: true });
});

test('turnHeadroom matches budgets.ts turnHeadroom for the same sequence', async () => {
  const db = createFakeDb();
  const store = createPgBudgetStore(db, LIMITS);
  const ledger = createBudgetLedger(LIMITS);
  const steps = [
    ['reserve', req({ runId: 'a', spendCents: 300 })],
    ['reserve', req({ runId: 'b', spendCents: 500 })],
    ['reserve', req({ runId: 'a', spendCents: 200, tokens: 400 })],
  ];
  for (const [, step] of steps) {
    assert.deepEqual(await store.reserve(step), reserve(ledger, step));
  }
  for (const runId of ['a', 'b', 'c']) {
    const probe = req({ runId });
    assert.deepEqual(await store.turnHeadroom(probe), turnHeadroom(ledger, probe), runId);
  }
});

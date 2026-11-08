/**
 * Tests for server/workforce/runtime/budgets.ts. Injected clock only, no real timers, no network, no database.
 * Run: node --test --experimental-transform-types tests/workforce/budgets.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBudgetLedger,
  reserve,
  release,
  nextRetryDelayMs,
} from '../../server/workforce/runtime/budgets.ts';

const DAY1 = Date.UTC(2026, 10, 3, 9, 0, 0);
const DAY1_LATE = Date.UTC(2026, 10, 3, 23, 59, 59);
const DAY2 = Date.UTC(2026, 10, 4, 0, 0, 1);

const LIMITS = {
  maxToolCallsPerRun: 5,
  maxTokensPerRun: 1000,
  maxSpendCentsPerRun: 500,
  maxRunsPerCompanyPerDay: 3,
  maxSpendCentsPerCompanyPerDay: 1200,
};

function runKey(companyId, runId) {
  return `${companyId}\u0000${runId}`;
}

function req(overrides = {}) {
  return { companyId: 'co-1', runId: 'run-1', toolCalls: 0, tokens: 0, spendCents: 0, now: DAY1, ...overrides };
}

// ---------- limits validation ----------

test('createBudgetLedger accepts a complete set of positive integer limits', () => {
  const ledger = createBudgetLedger(LIMITS);
  assert.deepEqual(ledger.limits, LIMITS);
  assert.ok(Object.isFrozen(ledger.limits));
});

test('createBudgetLedger throws when any limit is missing', () => {
  for (const key of Object.keys(LIMITS)) {
    const bad = { ...LIMITS };
    delete bad[key];
    assert.throws(() => createBudgetLedger(bad), TypeError, key);
  }
});

test('createBudgetLedger throws on zero, negative, fractional, NaN and non-number limits', () => {
  for (const value of [0, -1, 1.5, Number.NaN, Infinity, '10', null, undefined]) {
    assert.throws(() => createBudgetLedger({ ...LIMITS, maxTokensPerRun: value }), TypeError, String(value));
  }
});

test('createBudgetLedger throws when limits is not an object', () => {
  assert.throws(() => createBudgetLedger(null), TypeError);
  assert.throws(() => createBudgetLedger(42), TypeError);
});

// ---------- refusal reasons ----------

test('reserve allows usage inside every limit and returns { allowed: true }', () => {
  const ledger = createBudgetLedger(LIMITS);
  assert.deepEqual(reserve(ledger, req({ toolCalls: 2, tokens: 300, spendCents: 100 })), { allowed: true });
});

test('reserve refuses with tool_call_limit when the per-run tool-call cap would be exceeded', () => {
  const ledger = createBudgetLedger(LIMITS);
  assert.deepEqual(reserve(ledger, req({ toolCalls: 5 })), { allowed: true });
  assert.deepEqual(reserve(ledger, req({ toolCalls: 1 })), { allowed: false, reason: 'tool_call_limit' });
});

test('reserve refuses with token_limit when the per-run token cap would be exceeded', () => {
  const ledger = createBudgetLedger(LIMITS);
  assert.deepEqual(reserve(ledger, req({ tokens: 900 })), { allowed: true });
  assert.deepEqual(reserve(ledger, req({ tokens: 101 })), { allowed: false, reason: 'token_limit' });
});

test('reserve refuses with spend_limit when the per-run spend cap would be exceeded', () => {
  const ledger = createBudgetLedger(LIMITS);
  assert.deepEqual(reserve(ledger, req({ spendCents: 400 })), { allowed: true });
  assert.deepEqual(reserve(ledger, req({ spendCents: 101 })), { allowed: false, reason: 'spend_limit' });
});

test('reserve refuses with run_quota when a company starts more runs than allowed today', () => {
  const ledger = createBudgetLedger(LIMITS);
  for (const runId of ['r1', 'r2', 'r3']) {
    assert.deepEqual(reserve(ledger, req({ runId, toolCalls: 1 })), { allowed: true });
  }
  assert.deepEqual(reserve(ledger, req({ runId: 'r4', toolCalls: 1 })), { allowed: false, reason: 'run_quota' });
});

test('reserve refuses with company_spend_quota when company spend for the day would be exceeded', () => {
  const ledger = createBudgetLedger(LIMITS);
  assert.deepEqual(reserve(ledger, req({ runId: 'a', spendCents: 500 })), { allowed: true });
  assert.deepEqual(reserve(ledger, req({ runId: 'b', spendCents: 500 })), { allowed: true });
  assert.deepEqual(reserve(ledger, req({ runId: 'c', spendCents: 201 })), {
    allowed: false,
    reason: 'company_spend_quota',
  });
});

test('reserve reports the per-run reason before the company reason when both apply', () => {
  const ledger = createBudgetLedger({ ...LIMITS, maxSpendCentsPerRun: 100, maxSpendCentsPerCompanyPerDay: 50 });
  assert.deepEqual(reserve(ledger, req({ spendCents: 101 })), { allowed: false, reason: 'spend_limit' });
});

test('reserve accepts a reservation that lands exactly on a limit', () => {
  const ledger = createBudgetLedger(LIMITS);
  assert.deepEqual(
    reserve(ledger, req({ toolCalls: 5, tokens: 1000, spendCents: 500 })),
    { allowed: true },
  );
});

test('reserve rejects malformed requests with a TypeError', () => {
  const ledger = createBudgetLedger(LIMITS);
  assert.throws(() => reserve(ledger, req({ toolCalls: -1 })), TypeError);
  assert.throws(() => reserve(ledger, req({ tokens: 1.5 })), TypeError);
  assert.throws(() => reserve(ledger, req({ spendCents: Number.NaN })), TypeError);
  assert.throws(() => reserve(ledger, req({ companyId: '' })), TypeError);
  assert.throws(() => reserve(ledger, req({ runId: '' })), TypeError);
  assert.throws(() => reserve(ledger, req({ now: 'today' })), TypeError);
});

// ---------- refused reservations record nothing ----------

test('a refused reservation records no usage, so later reservations see the earlier totals only', () => {
  const ledger = createBudgetLedger(LIMITS);
  assert.deepEqual(reserve(ledger, req({ toolCalls: 4, spendCents: 100 })), { allowed: true });
  assert.deepEqual(reserve(ledger, req({ toolCalls: 2, spendCents: 300 })), { allowed: false, reason: 'tool_call_limit' });
  // Had the refusal recorded spend, this 400c reservation would fail the 500c run cap.
  assert.deepEqual(reserve(ledger, req({ toolCalls: 1, spendCents: 400 })), { allowed: true });
  assert.equal(ledger.runs.get(runKey('co-1', 'run-1')).spendCents, 500);
  assert.equal(ledger.runs.get(runKey('co-1', 'run-1')).toolCalls, 5);
});

test('a refused run_quota reservation does not use a run slot or company spend', () => {
  const ledger = createBudgetLedger(LIMITS);
  for (const runId of ['r1', 'r2', 'r3']) reserve(ledger, req({ runId, spendCents: 10 }));
  assert.deepEqual(reserve(ledger, req({ runId: 'r4', spendCents: 100 })), { allowed: false, reason: 'run_quota' });
  assert.equal(ledger.companies.get('co-1').spendCents, 30);
  assert.equal(ledger.runs.has(runKey('co-1', 'r4')), false);
});

test('a refused company_spend_quota reservation does not count the run or its spend', () => {
  const ledger = createBudgetLedger({ ...LIMITS, maxRunsPerCompanyPerDay: 10 });
  reserve(ledger, req({ runId: 'a', spendCents: 500 }));
  reserve(ledger, req({ runId: 'c', spendCents: 500 }));
  reserve(ledger, req({ runId: 'd', spendCents: 200 }));
  assert.deepEqual(reserve(ledger, req({ runId: 'b', spendCents: 1 })), { allowed: false, reason: 'company_spend_quota' });
  assert.equal(ledger.runs.has(runKey('co-1', 'b')), false);
  assert.equal(ledger.companies.get('co-1').runIds.has('b'), false);
});

// ---------- companies are independent ----------

test('per-company quotas do not affect another company', () => {
  const ledger = createBudgetLedger(LIMITS);
  reserve(ledger, req({ companyId: 'co-1', runId: 'a', spendCents: 500 }));
  reserve(ledger, req({ companyId: 'co-1', runId: 'b', spendCents: 500 }));
  reserve(ledger, req({ companyId: 'co-1', runId: 'c', spendCents: 200 }));
  assert.deepEqual(reserve(ledger, req({ companyId: 'co-2', runId: 'b', spendCents: 500 })), { allowed: true });
});

// ---------- release ----------

test('release returns unused usage so later reservations can use it', () => {
  const ledger = createBudgetLedger(LIMITS);
  assert.deepEqual(reserve(ledger, req({ toolCalls: 5, tokens: 500, spendCents: 500 })), { allowed: true });
  assert.deepEqual(reserve(ledger, req({ toolCalls: 1 })), { allowed: false, reason: 'tool_call_limit' });
  release(ledger, req({ toolCalls: 2, tokens: 200, spendCents: 200 }));
  assert.deepEqual(reserve(ledger, req({ toolCalls: 2, tokens: 200, spendCents: 200 })), { allowed: true });
});

test('release never takes a counter below zero', () => {
  const ledger = createBudgetLedger(LIMITS);
  reserve(ledger, req({ toolCalls: 1, spendCents: 10 }));
  release(ledger, req({ toolCalls: 9, spendCents: 999 }));
  assert.equal(ledger.runs.get(runKey('co-1', 'run-1')).toolCalls, 0);
  assert.equal(ledger.runs.get(runKey('co-1', 'run-1')).spendCents, 0);
  assert.equal(ledger.companies.get('co-1').spendCents, 0);
});

test('release on the next UTC day does not reduce that day\'s company spend', () => {
  const ledger = createBudgetLedger(LIMITS);
  reserve(ledger, req({ spendCents: 300, now: DAY1 }));
  release(ledger, req({ spendCents: 300, now: DAY2 }));
  // The day-1 record is untouched; the day-2 release found no day-2 record to reduce.
  assert.equal(ledger.companies.get('co-1').day, '2026-11-03');
  assert.equal(ledger.companies.get('co-1').spendCents, 300);
});

test('release for an unknown run and company is a no-op', () => {
  const ledger = createBudgetLedger(LIMITS);
  release(ledger, req({ companyId: 'nobody', runId: 'ghost', spendCents: 50 }));
  assert.equal(ledger.runs.size, 0);
  assert.equal(ledger.companies.size, 0);
});

// ---------- daily reset ----------

test('company daily counters persist within one UTC day', () => {
  const ledger = createBudgetLedger(LIMITS);
  reserve(ledger, req({ runId: 'a', spendCents: 500, now: DAY1 }));
  reserve(ledger, req({ runId: 'b', spendCents: 500, now: DAY1 }));
  assert.deepEqual(reserve(ledger, req({ runId: 'c', spendCents: 201, now: DAY1_LATE })), {
    allowed: false,
    reason: 'company_spend_quota',
  });
});

test('company daily spend and run count reset when the UTC day changes', () => {
  const ledger = createBudgetLedger(LIMITS);
  for (const runId of ['r1', 'r2', 'r3']) reserve(ledger, req({ runId, spendCents: 400, now: DAY1 }));
  assert.deepEqual(reserve(ledger, req({ runId: 'r4', now: DAY1 })), { allowed: false, reason: 'run_quota' });

  assert.deepEqual(reserve(ledger, req({ runId: 'r4', spendCents: 400, now: DAY2 })), { allowed: true });
  assert.equal(ledger.companies.get('co-1').spendCents, 400);
  assert.equal(ledger.companies.get('co-1').runIds.size, 1);
});

test('a run continuing across the day change keeps its per-run usage', () => {
  const ledger = createBudgetLedger(LIMITS);
  reserve(ledger, req({ toolCalls: 4, spendCents: 400, now: DAY1 }));
  assert.deepEqual(reserve(ledger, req({ toolCalls: 2, now: DAY2 })), { allowed: false, reason: 'tool_call_limit' });
  assert.deepEqual(reserve(ledger, req({ spendCents: 200, now: DAY2 })), { allowed: false, reason: 'spend_limit' });
});

test('the daily reset uses UTC, so the day changes at 00:00 UTC', () => {
  const ledger = createBudgetLedger(LIMITS);
  reserve(ledger, req({ runId: 'a', spendCents: 1200, now: Date.UTC(2026, 10, 3, 23, 59, 59, 999) }));
  assert.deepEqual(
    reserve(ledger, req({ runId: 'b', spendCents: 1, now: Date.UTC(2026, 10, 4, 0, 0, 0, 0) })),
    { allowed: true },
  );
});

// ---------- retry delay ----------

const RETRY = { baseMs: 100, maxMs: 1000, deadlineAt: DAY1 + 60_000, now: DAY1, maxAttempts: 10 };

test('nextRetryDelayMs doubles the delay on each attempt', () => {
  assert.equal(nextRetryDelayMs(1, RETRY), 100);
  assert.equal(nextRetryDelayMs(2, RETRY), 200);
  assert.equal(nextRetryDelayMs(3, RETRY), 400);
  assert.equal(nextRetryDelayMs(4, RETRY), 800);
});

test('nextRetryDelayMs caps the delay at maxMs', () => {
  assert.equal(nextRetryDelayMs(5, RETRY), 1000);
  assert.equal(nextRetryDelayMs(10, RETRY), 1000);
});

test('nextRetryDelayMs stays finite for a very large attempt number', () => {
  assert.equal(nextRetryDelayMs(5000, { ...RETRY, maxAttempts: 5000 }), 1000);
});

test('nextRetryDelayMs returns null when attempt exceeds maxAttempts', () => {
  assert.equal(nextRetryDelayMs(10, RETRY), 1000);
  assert.equal(nextRetryDelayMs(11, RETRY), null);
});

test('nextRetryDelayMs returns null when the retry would start after the deadline', () => {
  const tight = { ...RETRY, deadlineAt: DAY1 + 150 };
  assert.equal(nextRetryDelayMs(1, tight), 100);
  assert.equal(nextRetryDelayMs(2, tight), null);
});

test('nextRetryDelayMs allows a retry that ends exactly at the deadline', () => {
  assert.equal(nextRetryDelayMs(1, { ...RETRY, deadlineAt: DAY1 + 100 }), 100);
});

test('nextRetryDelayMs returns null once now is past the deadline', () => {
  assert.equal(nextRetryDelayMs(1, { ...RETRY, now: DAY1 + 60_001 }), null);
});

test('nextRetryDelayMs rejects an attempt below 1 or non-integer with a TypeError', () => {
  assert.throws(() => nextRetryDelayMs(0, RETRY), TypeError);
  assert.throws(() => nextRetryDelayMs(1.5, RETRY), TypeError);
});

test('nextRetryDelayMs rejects invalid options with a TypeError', () => {
  assert.throws(() => nextRetryDelayMs(1, { ...RETRY, baseMs: 0 }), TypeError);
  assert.throws(() => nextRetryDelayMs(1, { ...RETRY, maxMs: 50 }), TypeError);
  assert.throws(() => nextRetryDelayMs(1, { ...RETRY, maxAttempts: 0 }), TypeError);
  assert.throws(() => nextRetryDelayMs(1, { ...RETRY, deadlineAt: Number.NaN }), TypeError);
  assert.throws(() => nextRetryDelayMs(1, { ...RETRY, now: undefined }), TypeError);
});

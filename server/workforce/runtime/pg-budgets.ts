/**
 * Postgres-backed budget ledger for the workforce runtime. Same rules, check order and refusal reasons as
 * budgets.ts, but the counters survive a restart. They live in workforce_budget_usage
 * (migrations/DRAFT_workforce_budgets.sql, not applied, not in shared/schema.ts). The database is reached only
 * through the injected SqlExecutor, as in pg-store.ts, so this file never imports a driver.
 *
 * Row layout: a 'company' row per company per UTC day (runs started, company spend), and a 'run' row per run
 * under the sentinel day 1970-01-01, because budgets.ts does not day-scope run usage.
 *
 * Atomicity. A reservation touches two rows, and SqlExecutor has no transaction, so it is not one statement.
 * Each step is one conditional statement, run in this order (the same order as budgets.ts):
 *   1. Run limits. INSERT ... ON CONFLICT DO UPDATE with a WHERE on the run limits. Writes only if they all fit.
 *   2. Run start claim, only for a run with no start yet. UPDATE ... WHERE runs = 0 RETURNING. Exactly one
 *      concurrent caller gets the row back, so a run is counted once.
 *   3. Company day. INSERT ... ON CONFLICT DO UPDATE with a WHERE on the run quota (new runs only) and the
 *      company spend. The conditional update locks the company-day row, so two callers cannot both take the
 *      last unit.
 * If step 3 refuses, the caller reverses steps 1 and 2 exactly and removes the run row when it is empty, so a
 * refused reservation leaves the table as it was. Residual window: while steps 2 and 3 of one reservation for a
 * run are in flight, a second reservation for that same run reads it as already started and skips the run
 * quota check. If the first is then refused, the second can be allowed without a run slot.
 *
 * Every statement filters on company_id. Time is passed in as `now` (epoch milliseconds), as in budgets.ts.
 */
import { requireCompanyId } from '../../services/ai-runtime/company.ts';
import { createBudgetLedger, type BudgetLimits, type BudgetRefusalReason, type BudgetRequest, type ReserveResult } from './budgets.ts';
import type { SqlExecutor } from './pg-store.ts';

/**
 * Run usage is not day-scoped (see budgets.ts), so run rows use the fixed day 1970-01-01 written into the SQL
 * below (DATE '1970-01-01').
 */
/** Exported so the test fake can recognise each statement. Every statement takes company_id as $1. */
export const BUDGET_SQL = {
  reserveRunUsage: `INSERT INTO workforce_budget_usage (company_id, scope, scope_key, day, tool_calls, tokens, spend_cents, runs)
SELECT $1::uuid, 'run', $2::text, DATE '1970-01-01', $3::integer, $4::integer, $5::integer, 0
WHERE $3::integer <= $6::integer AND $4::integer <= $7::integer AND $5::integer <= $8::integer
ON CONFLICT (company_id, scope, scope_key, day) DO UPDATE
SET tool_calls = workforce_budget_usage.tool_calls + EXCLUDED.tool_calls,
    tokens = workforce_budget_usage.tokens + EXCLUDED.tokens,
    spend_cents = workforce_budget_usage.spend_cents + EXCLUDED.spend_cents
WHERE workforce_budget_usage.company_id = $1::uuid
  AND workforce_budget_usage.tool_calls + EXCLUDED.tool_calls <= $6::integer
  AND workforce_budget_usage.tokens + EXCLUDED.tokens <= $7::integer
  AND workforce_budget_usage.spend_cents + EXCLUDED.spend_cents <= $8::integer
RETURNING runs`,

  claimRunStart: `UPDATE workforce_budget_usage SET runs = 1
WHERE company_id = $1::uuid AND scope = 'run' AND scope_key = $2::text AND day = DATE '1970-01-01' AND runs = 0
RETURNING runs`,

  reserveCompanyNewRun: `INSERT INTO workforce_budget_usage (company_id, scope, scope_key, day, tool_calls, tokens, spend_cents, runs)
SELECT $1::uuid, 'company', ''::text, $2::date, 0, 0, $3::integer, 1
WHERE $3::integer <= $4::integer AND 1 <= $5::integer
ON CONFLICT (company_id, scope, scope_key, day) DO UPDATE
SET spend_cents = workforce_budget_usage.spend_cents + EXCLUDED.spend_cents,
    runs = workforce_budget_usage.runs + 1
WHERE workforce_budget_usage.company_id = $1::uuid
  AND workforce_budget_usage.runs + 1 <= $5::integer
  AND workforce_budget_usage.spend_cents + EXCLUDED.spend_cents <= $4::integer
RETURNING runs`,

  reserveCompanySpend: `INSERT INTO workforce_budget_usage (company_id, scope, scope_key, day, tool_calls, tokens, spend_cents, runs)
SELECT $1::uuid, 'company', ''::text, $2::date, 0, 0, $3::integer, 0
WHERE $3::integer <= $4::integer
ON CONFLICT (company_id, scope, scope_key, day) DO UPDATE
SET spend_cents = workforce_budget_usage.spend_cents + EXCLUDED.spend_cents
WHERE workforce_budget_usage.company_id = $1::uuid
  AND workforce_budget_usage.spend_cents + EXCLUDED.spend_cents <= $4::integer
RETURNING runs`,

  readRunUsage: `SELECT tool_calls, tokens, spend_cents FROM workforce_budget_usage
WHERE company_id = $1::uuid AND scope = 'run' AND scope_key = $2::text AND day = DATE '1970-01-01'`,

  readCompanyDay: `SELECT runs, spend_cents FROM workforce_budget_usage
WHERE company_id = $1::uuid AND scope = 'company' AND scope_key = '' AND day = $2::date`,

  readRunClaimed: `SELECT runs FROM workforce_budget_usage
WHERE company_id = $1::uuid AND scope = 'run' AND scope_key = $2::text AND day = DATE '1970-01-01'`,

  releaseRunUsage: `UPDATE workforce_budget_usage
SET tool_calls = GREATEST(0, tool_calls - $3::integer),
    tokens = GREATEST(0, tokens - $4::integer),
    spend_cents = GREATEST(0, spend_cents - $5::integer)
WHERE company_id = $1::uuid AND scope = 'run' AND scope_key = $2::text AND day = DATE '1970-01-01'`,

  releaseCompanySpend: `UPDATE workforce_budget_usage SET spend_cents = GREATEST(0, spend_cents - $3::integer)
WHERE company_id = $1::uuid AND scope = 'company' AND scope_key = '' AND day = $2::date`,

  unclaimRunStart: `UPDATE workforce_budget_usage SET runs = 0
WHERE company_id = $1::uuid AND scope = 'run' AND scope_key = $2::text AND day = DATE '1970-01-01' AND runs = 1`,

  dropEmptyRunUsage: `DELETE FROM workforce_budget_usage
WHERE company_id = $1::uuid AND scope = 'run' AND scope_key = $2::text AND day = DATE '1970-01-01'
  AND runs = 0 AND tool_calls = 0 AND tokens = 0 AND spend_cents = 0`,
} as const;

export interface PgBudgetStore {
  readonly limits: Readonly<BudgetLimits>;
  reserve(req: BudgetRequest): Promise<ReserveResult>;
  release(req: BudgetRequest): Promise<void>;
  /** Read-only pre-turn check, the same rules as budgets.ts turnHeadroom. Writes nothing. */
  turnHeadroom(req: Pick<BudgetRequest, 'companyId' | 'runId' | 'now'>): Promise<ReserveResult>;
}

// Same messages as budgets.ts validateRequest, so callers see one set of errors.
function validateRequest(req: BudgetRequest): void {
  if (req === null || typeof req !== 'object') throw new TypeError('budget request must be an object');
  if (typeof req.companyId !== 'string' || req.companyId === '') throw new TypeError('companyId is required');
  if (typeof req.runId !== 'string' || req.runId === '') throw new TypeError('runId is required');
  if (!isNonNegativeInteger(req.toolCalls)) throw new TypeError('toolCalls must be a non-negative integer');
  if (!isNonNegativeInteger(req.tokens)) throw new TypeError('tokens must be a non-negative integer');
  if (!isNonNegativeInteger(req.spendCents)) throw new TypeError('spendCents must be a non-negative integer');
  if (typeof req.now !== 'number' || !Number.isFinite(req.now)) {
    throw new TypeError('now must be a finite epoch-milliseconds number');
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Same as budgets.ts utcDay: the UTC calendar day of `now`. */
function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function refuse(reason: BudgetRefusalReason): ReserveResult {
  return { allowed: false, reason };
}

function num(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

async function readRunUsage(db: SqlExecutor, companyId: string, runId: string) {
  const result = await db.query(BUDGET_SQL.readRunUsage, [companyId, runId]);
  const row = result.rows[0];
  return {
    toolCalls: num(row?.tool_calls),
    tokens: num(row?.tokens),
    spendCents: num(row?.spend_cents),
  };
}

async function readCompanyDay(db: SqlExecutor, companyId: string, day: string) {
  const result = await db.query(BUDGET_SQL.readCompanyDay, [companyId, day]);
  const row = result.rows[0];
  return { runs: num(row?.runs), spendCents: num(row?.spend_cents) };
}

/**
 * Creates a Postgres-backed budget store. The limits go through createBudgetLedger, so an invalid limit throws
 * the same TypeError as budgets.ts.
 */
export function createPgBudgetStore(db: SqlExecutor, limits: BudgetLimits): PgBudgetStore {
  const frozen = createBudgetLedger(limits).limits;

  return {
    limits: frozen,

    async reserve(req) {
      validateRequest(req);
      const companyId = requireCompanyId(req.companyId);
      const day = utcDay(req.now);

      // 1. Run limits: tool calls, tokens, run spend. A refusal here writes nothing.
      const runWrite = await db.query(BUDGET_SQL.reserveRunUsage, [
        companyId,
        req.runId,
        req.toolCalls,
        req.tokens,
        req.spendCents,
        frozen.maxToolCallsPerRun,
        frozen.maxTokensPerRun,
        frozen.maxSpendCentsPerRun,
      ]);
      if (runWrite.rows.length === 0) {
        const usage = await readRunUsage(db, companyId, req.runId);
        if (usage.toolCalls + req.toolCalls > frozen.maxToolCallsPerRun) return refuse('tool_call_limit');
        if (usage.tokens + req.tokens > frozen.maxTokensPerRun) return refuse('token_limit');
        if (usage.spendCents + req.spendCents > frozen.maxSpendCentsPerRun) return refuse('spend_limit');
        // The conditional write refused but the read fits: a release landed in between. Do not guess a reason.
        throw new Error(`budget reservation could not be decided for run ${req.runId}; retry`);
      }

      // 2. Claim the run's start, once. Only a claimed run takes a company run slot.
      const claimed = await db.query(BUDGET_SQL.claimRunStart, [companyId, req.runId]);
      const isNewRun = claimed.rows.length === 1;

      // 3. Company day: run quota (new runs only) and company spend, in one conditional write.
      const companyWrite = isNewRun
        ? await db.query(BUDGET_SQL.reserveCompanyNewRun, [
            companyId,
            day,
            req.spendCents,
            frozen.maxSpendCentsPerCompanyPerDay,
            frozen.maxRunsPerCompanyPerDay,
          ])
        : await db.query(BUDGET_SQL.reserveCompanySpend, [
            companyId,
            day,
            req.spendCents,
            frozen.maxSpendCentsPerCompanyPerDay,
          ]);
      if (companyWrite.rows.length === 1) return { allowed: true };

      // Refused at company level: reverse steps 1 and 2 so nothing is left behind.
      await db.query(BUDGET_SQL.releaseRunUsage, [companyId, req.runId, req.toolCalls, req.tokens, req.spendCents]);
      if (isNewRun) await db.query(BUDGET_SQL.unclaimRunStart, [companyId, req.runId]);
      await db.query(BUDGET_SQL.dropEmptyRunUsage, [companyId, req.runId]);

      // budgets.ts checks the run quota before company spend, so the same order is used for the reason.
      const company = await readCompanyDay(db, companyId, day);
      if (isNewRun && company.runs + 1 > frozen.maxRunsPerCompanyPerDay) return refuse('run_quota');
      return refuse('company_spend_quota');
    },

    async release(req) {
      validateRequest(req);
      const companyId = requireCompanyId(req.companyId);
      await db.query(BUDGET_SQL.releaseRunUsage, [companyId, req.runId, req.toolCalls, req.tokens, req.spendCents]);
      // Only the current UTC day's row is touched, as in budgets.ts. A rolled-over spend is not returned.
      await db.query(BUDGET_SQL.releaseCompanySpend, [companyId, utcDay(req.now), req.spendCents]);
    },

    async turnHeadroom(req) {
      validateRequest({ ...req, toolCalls: 0, tokens: 0, spendCents: 0 });
      const companyId = requireCompanyId(req.companyId);
      const day = utcDay(req.now);
      const usage = await readRunUsage(db, companyId, req.runId);
      const claimed = await db.query(BUDGET_SQL.readRunClaimed, [companyId, req.runId]);
      const isNewRun = (claimed.rows[0] === undefined ? 0 : num(claimed.rows[0].runs)) === 0;
      const company = await readCompanyDay(db, companyId, day);

      // Same order as budgets.ts turnHeadroom: tokens, run spend, run quota (new runs), company spend.
      if (usage.tokens >= frozen.maxTokensPerRun) return refuse('token_limit');
      if (usage.spendCents >= frozen.maxSpendCentsPerRun) return refuse('spend_limit');
      if (isNewRun && company.runs >= frozen.maxRunsPerCompanyPerDay) return refuse('run_quota');
      if (company.spendCents >= frozen.maxSpendCentsPerCompanyPerDay) return refuse('company_spend_quota');
      return { allowed: true };
    },
  };
}

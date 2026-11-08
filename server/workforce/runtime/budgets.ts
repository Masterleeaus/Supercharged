/**
 * Budget enforcement for the workforce runtime, in one place. A ledger holds per-run usage (tool calls, tokens,
 * spend) and per-company daily counters (runs started, spend). Callers reserve before using a resource and
 * release what they did not use. A refused reservation records nothing.
 *
 * Also a retry-delay helper: exponential backoff capped at maxMs, stopped by an attempt limit and a deadline.
 *
 * Pure: no timers, no database, no network. Time is always passed in as `now` (epoch milliseconds), so the
 * caller controls the clock. Daily counters are keyed by the UTC calendar day of `now`.
 */

export interface BudgetLimits {
  maxToolCallsPerRun: number;
  maxTokensPerRun: number;
  maxSpendCentsPerRun: number;
  maxRunsPerCompanyPerDay: number;
  maxSpendCentsPerCompanyPerDay: number;
}

export type BudgetRefusalReason =
  | 'tool_call_limit'
  | 'token_limit'
  | 'spend_limit'
  | 'run_quota'
  | 'company_spend_quota';

export interface BudgetRequest {
  companyId: string;
  runId: string;
  toolCalls: number;
  tokens: number;
  spendCents: number;
  now: number;
}

export type ReserveResult = { allowed: true } | { allowed: false; reason: BudgetRefusalReason };

interface RunUsage {
  toolCalls: number;
  tokens: number;
  spendCents: number;
}

interface CompanyDay {
  day: string;
  spendCents: number;
  runIds: Set<string>;
}

export interface BudgetLedger {
  readonly limits: Readonly<BudgetLimits>;
  /** Keyed by company and run id (see runKey). */
  readonly runs: Map<string, RunUsage>;
  readonly companies: Map<string, CompanyDay>;
}

const LIMIT_KEYS: readonly (keyof BudgetLimits)[] = [
  'maxToolCallsPerRun',
  'maxTokensPerRun',
  'maxSpendCentsPerRun',
  'maxRunsPerCompanyPerDay',
  'maxSpendCentsPerCompanyPerDay',
];

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Runs are scoped to their company, so the same runId under two companies never shares a budget. */
function runKey(companyId: string, runId: string): string {
  return `${companyId}\u0000${runId}`;
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Creates a ledger. Throws a TypeError when any limit is missing or not a positive integer. */
export function createBudgetLedger(limits: BudgetLimits): BudgetLedger {
  if (limits === null || typeof limits !== 'object') {
    throw new TypeError('budget limits must be an object');
  }
  for (const key of LIMIT_KEYS) {
    if (!isPositiveInteger(limits[key])) {
      throw new TypeError(`budget limit ${key} must be a positive integer`);
    }
  }
  return {
    limits: Object.freeze({
      maxToolCallsPerRun: limits.maxToolCallsPerRun,
      maxTokensPerRun: limits.maxTokensPerRun,
      maxSpendCentsPerRun: limits.maxSpendCentsPerRun,
      maxRunsPerCompanyPerDay: limits.maxRunsPerCompanyPerDay,
      maxSpendCentsPerCompanyPerDay: limits.maxSpendCentsPerCompanyPerDay,
    }),
    runs: new Map(),
    companies: new Map(),
  };
}

function validateRequest(req: BudgetRequest): void {
  if (req === null || typeof req !== 'object') throw new TypeError('budget request must be an object');
  if (typeof req.companyId !== 'string' || req.companyId === '') throw new TypeError('companyId is required');
  if (typeof req.runId !== 'string' || req.runId === '') throw new TypeError('runId is required');
  if (!isNonNegativeInteger(req.toolCalls)) throw new TypeError('toolCalls must be a non-negative integer');
  if (!isNonNegativeInteger(req.tokens)) throw new TypeError('tokens must be a non-negative integer');
  if (!isNonNegativeInteger(req.spendCents)) throw new TypeError('spendCents must be a non-negative integer');
  if (!isFiniteNumber(req.now)) throw new TypeError('now must be a finite epoch-milliseconds number');
}

/** The current day record for a company. Replaced (counters reset) when the UTC day has changed. */
function dayRecord(ledger: BudgetLedger, companyId: string, day: string): CompanyDay {
  const existing = ledger.companies.get(companyId);
  if (existing && existing.day === day) return existing;
  const fresh: CompanyDay = { day, spendCents: 0, runIds: new Set() };
  ledger.companies.set(companyId, fresh);
  return fresh;
}

/**
 * Reserves usage for a run. Checks run before company limits, in this order: tool calls, tokens, run spend,
 * run quota, company spend. On refusal nothing is recorded. On success the usage is recorded.
 */
export function reserve(ledger: BudgetLedger, req: BudgetRequest): ReserveResult {
  validateRequest(req);
  const { limits } = ledger;
  const key = runKey(req.companyId, req.runId);
  const usage = ledger.runs.get(key) ?? { toolCalls: 0, tokens: 0, spendCents: 0 };
  const day = dayRecord(ledger, req.companyId, utcDay(req.now));
  const isNewRun = !ledger.runs.has(key) && !day.runIds.has(req.runId);

  if (usage.toolCalls + req.toolCalls > limits.maxToolCallsPerRun) {
    return { allowed: false, reason: 'tool_call_limit' };
  }
  if (usage.tokens + req.tokens > limits.maxTokensPerRun) {
    return { allowed: false, reason: 'token_limit' };
  }
  if (usage.spendCents + req.spendCents > limits.maxSpendCentsPerRun) {
    return { allowed: false, reason: 'spend_limit' };
  }
  if (isNewRun && day.runIds.size + 1 > limits.maxRunsPerCompanyPerDay) {
    return { allowed: false, reason: 'run_quota' };
  }
  if (day.spendCents + req.spendCents > limits.maxSpendCentsPerCompanyPerDay) {
    return { allowed: false, reason: 'company_spend_quota' };
  }

  usage.toolCalls += req.toolCalls;
  usage.tokens += req.tokens;
  usage.spendCents += req.spendCents;
  ledger.runs.set(key, usage);
  day.spendCents += req.spendCents;
  if (isNewRun) day.runIds.add(req.runId);
  return { allowed: true };
}

/**
 * Read-only check before a model turn. Writes nothing. Refuses when the run has no headroom left for the
 * resources a turn consumes: tokens, run spend, a new run slot, and company spend for the day. Unlike reserve,
 * a counter that has reached its cap is a refusal here, because a turn cannot be known to fit under it.
 * Tool calls are not checked: a turn does not call a tool by itself.
 */
export function turnHeadroom(ledger: BudgetLedger, req: Pick<BudgetRequest, 'companyId' | 'runId' | 'now'>): ReserveResult {
  validateRequest({ companyId: req.companyId, runId: req.runId, toolCalls: 0, tokens: 0, spendCents: 0, now: req.now });
  const { limits } = ledger;
  const key = runKey(req.companyId, req.runId);
  const usage = ledger.runs.get(key) ?? { toolCalls: 0, tokens: 0, spendCents: 0 };
  const today = utcDay(req.now);
  const existing = ledger.companies.get(req.companyId);
  const day = existing && existing.day === today ? existing : null;
  const isNewRun = !ledger.runs.has(key) && !(day?.runIds.has(req.runId) ?? false);

  if (usage.tokens >= limits.maxTokensPerRun) return { allowed: false, reason: 'token_limit' };
  if (usage.spendCents >= limits.maxSpendCentsPerRun) return { allowed: false, reason: 'spend_limit' };
  if (isNewRun && (day?.runIds.size ?? 0) >= limits.maxRunsPerCompanyPerDay) return { allowed: false, reason: 'run_quota' };
  if ((day?.spendCents ?? 0) >= limits.maxSpendCentsPerCompanyPerDay) return { allowed: false, reason: 'company_spend_quota' };
  return { allowed: true };
}

/**
 * Returns an unused reservation. Counters never go below zero. Company spend is returned only when the
 * reservation's day is still the current UTC day of `now`; a spend already rolled over is not touched.
 * Runs started are not uncounted, so a run that was started keeps its quota slot.
 */
export function release(ledger: BudgetLedger, req: BudgetRequest): void {
  validateRequest(req);
  const usage = ledger.runs.get(runKey(req.companyId, req.runId));
  if (usage) {
    usage.toolCalls = Math.max(0, usage.toolCalls - req.toolCalls);
    usage.tokens = Math.max(0, usage.tokens - req.tokens);
    usage.spendCents = Math.max(0, usage.spendCents - req.spendCents);
  }
  const day = ledger.companies.get(req.companyId);
  if (day && day.day === utcDay(req.now)) {
    day.spendCents = Math.max(0, day.spendCents - req.spendCents);
  }
}

export interface RetryDelayOptions {
  /** Delay before the first retry, in milliseconds. Positive integer. */
  baseMs: number;
  /** Upper bound on any single delay, in milliseconds. Positive integer, at least baseMs. */
  maxMs: number;
  /** Retries are not allowed to start after this epoch-milliseconds instant. */
  deadlineAt: number;
  /** Current epoch milliseconds. */
  now: number;
  /** Highest retry number allowed. Positive integer. */
  maxAttempts: number;
}

/**
 * Delay before retry number `attempt` (1-based: 1 is the first retry). The delay is baseMs * 2^(attempt - 1),
 * capped at maxMs. Returns null when attempt is below 1 or above maxAttempts, when now is past deadlineAt, or
 * when the retry would start after deadlineAt. Throws on invalid options.
 */
export function nextRetryDelayMs(attempt: number, options: RetryDelayOptions): number | null {
  if (!isPositiveInteger(attempt)) throw new TypeError('attempt must be a positive integer');
  if (options === null || typeof options !== 'object') throw new TypeError('retry options must be an object');
  const { baseMs, maxMs, deadlineAt, now, maxAttempts } = options;
  if (!isPositiveInteger(baseMs)) throw new TypeError('baseMs must be a positive integer');
  if (!isPositiveInteger(maxMs) || maxMs < baseMs) throw new TypeError('maxMs must be a positive integer >= baseMs');
  if (!isFiniteNumber(deadlineAt)) throw new TypeError('deadlineAt must be a finite number');
  if (!isFiniteNumber(now)) throw new TypeError('now must be a finite number');
  if (!isPositiveInteger(maxAttempts)) throw new TypeError('maxAttempts must be a positive integer');

  if (attempt > maxAttempts) return null;
  if (now > deadlineAt) return null;
  const delay = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  if (now + delay > deadlineAt) return null;
  return delay;
}

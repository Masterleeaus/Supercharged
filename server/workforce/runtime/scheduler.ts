/**
 * In-memory scheduler and worker queue for the workforce runtime. Holds once and recurring jobs per company, runs
 * the ones that are due, and retries failures with the backoff rules in budgets.ts (nextRetryDelayMs).
 *
 * The work kind ('scheduled' | 'predictive' | 'delayed' | 'retryable') is a label only. The scheduler does not
 * decide what to prepare and does no forecasting: it runs the work it was given, when it was given.
 *
 * No timers and no database. The caller supplies `now` and calls tick(). Work runs one job at a time, in runAt
 * order, and a tick that starts while another tick is running returns at once without running anything, so a
 * job never runs twice concurrently.
 *
 * Retry rule: a failed attempt number n (1-based count of failures in the current run) is followed by a retry
 * delay from nextRetryDelayMs(n). So maxAttempts counts retries, and a job makes at most maxAttempts + 1 attempts.
 * When no delay is allowed, the job is removed and written to the dead-letter list.
 */

import { nextRetryDelayMs } from './budgets.ts';

export type JobKind = 'once' | 'recurring';
export type WorkKind = 'scheduled' | 'predictive' | 'delayed' | 'retryable';

export interface JobContext {
  companyId: string;
  jobId: string;
  agentId: string;
  /** 1-based attempt number within the current run of this job. */
  attempt: number;
}

export interface JobSpec {
  id: string;
  companyId: string;
  agentId: string;
  /** Epoch milliseconds. The job is not run before this instant. */
  runAt: number;
  kind: JobKind;
  /** Required for recurring jobs: the next slot is the previous slot plus intervalMs. */
  intervalMs?: number;
  workKind: WorkKind;
  /** Optional: no retry may start after this epoch-milliseconds instant. Defaults to no deadline. */
  deadlineAt?: number;
  work: (ctx: JobContext) => unknown;
}

export interface RetryPolicy {
  baseMs: number;
  maxMs: number;
  maxAttempts: number;
}

export interface SchedulerOptions {
  now: () => number;
  retry: RetryPolicy;
}

export interface JobView {
  id: string;
  companyId: string;
  agentId: string;
  kind: JobKind;
  workKind: WorkKind;
  runAt: number;
  intervalMs?: number;
  /** Failed attempts in the current run. Zero after a success. */
  failures: number;
}

export interface AttemptRecord {
  companyId: string;
  jobId: string;
  agentId: string;
  workKind: WorkKind;
  attempt: number;
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  /** Error text when ok is false. */
  error?: string;
}

export interface DeadLetter {
  companyId: string;
  jobId: string;
  agentId: string;
  workKind: WorkKind;
  kind: JobKind;
  /** Failed attempts made before the job was dead-lettered. */
  attempts: number;
  /** Error text of the last failure. */
  error: string;
  deadAt: number;
}

export interface TickResult {
  /** Attempts made by this call. Zero when the call was re-entrant. */
  attempts: number;
}

export interface Scheduler {
  schedule(spec: JobSpec): void;
  tick(): Promise<TickResult>;
  list(companyId: string): JobView[];
  attempts(companyId: string): AttemptRecord[];
  deadLetters(companyId: string): DeadLetter[];
}

interface Job {
  seq: number;
  id: string;
  companyId: string;
  agentId: string;
  kind: JobKind;
  workKind: WorkKind;
  intervalMs?: number;
  deadlineAt: number;
  work: (ctx: JobContext) => unknown;
  /** Next due time. Moves on retry (now plus backoff) and on success (slot plus interval). */
  runAt: number;
  /** The scheduled slot of the current occurrence. Recurring jobs advance from it, not from a retry time. */
  slotAt: number;
  failures: number;
}

const WORK_KINDS: readonly WorkKind[] = ['scheduled', 'predictive', 'delayed', 'retryable'];
const NO_DEADLINE = Number.MAX_SAFE_INTEGER;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new TypeError(`${name} is required`);
  return value;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function validateRetry(retry: RetryPolicy): void {
  if (retry === null || typeof retry !== 'object') throw new TypeError('retry policy must be an object');
  if (!isPositiveInteger(retry.baseMs)) throw new TypeError('retry.baseMs must be a positive integer');
  if (!isPositiveInteger(retry.maxMs) || retry.maxMs < retry.baseMs) {
    throw new TypeError('retry.maxMs must be a positive integer >= retry.baseMs');
  }
  if (!isPositiveInteger(retry.maxAttempts)) throw new TypeError('retry.maxAttempts must be a positive integer');
}

function validateSpec(spec: JobSpec): void {
  if (spec === null || typeof spec !== 'object') throw new TypeError('job must be an object');
  nonEmptyString(spec.id, 'job id');
  nonEmptyString(spec.companyId, 'companyId');
  nonEmptyString(spec.agentId, 'agentId');
  if (!isFiniteNumber(spec.runAt)) throw new TypeError('runAt must be a finite epoch-milliseconds number');
  if (spec.kind !== 'once' && spec.kind !== 'recurring') throw new TypeError("kind must be 'once' or 'recurring'");
  if (spec.kind === 'recurring' && !isPositiveInteger(spec.intervalMs)) {
    throw new TypeError('recurring jobs need a positive integer intervalMs');
  }
  if (!WORK_KINDS.includes(spec.workKind)) {
    throw new TypeError("workKind must be 'scheduled', 'predictive', 'delayed' or 'retryable'");
  }
  if (spec.deadlineAt !== undefined && !isFiniteNumber(spec.deadlineAt)) {
    throw new TypeError('deadlineAt must be a finite epoch-milliseconds number');
  }
  if (typeof spec.work !== 'function') throw new TypeError('work must be a function');
}

/** Creates an in-memory scheduler. Throws a TypeError when the retry policy is invalid. */
export function createScheduler(options: SchedulerOptions): Scheduler {
  if (options === null || typeof options !== 'object') throw new TypeError('scheduler options must be an object');
  if (typeof options.now !== 'function') throw new TypeError('now must be a function returning epoch milliseconds');
  validateRetry(options.retry);
  const now = options.now;
  const retry = { ...options.retry };

  /** Jobs keyed by company id, then job id. */
  const jobs = new Map<string, Map<string, Job>>();
  const attemptLog: AttemptRecord[] = [];
  const deadLetterLog: DeadLetter[] = [];
  let nextSeq = 0;
  let tickInFlight: Promise<TickResult> | null = null;

  function remove(job: Job): void {
    const byId = jobs.get(job.companyId);
    if (!byId) return;
    byId.delete(job.id);
    if (byId.size === 0) jobs.delete(job.companyId);
  }

  function dueSnapshot(at: number): Job[] {
    const due: Job[] = [];
    for (const byId of jobs.values()) {
      for (const job of byId.values()) {
        if (job.runAt <= at) due.push(job);
      }
    }
    return due.sort((a, b) => a.runAt - b.runAt || a.seq - b.seq);
  }

  async function runJob(job: Job): Promise<void> {
    const startedAt = now();
    const attempt = job.failures + 1;
    let failed = false;
    let error = '';
    try {
      await job.work({ companyId: job.companyId, jobId: job.id, agentId: job.agentId, attempt });
    } catch (err) {
      failed = true;
      error = errorText(err);
    }
    const finishedAt = now();

    if (!failed) {
      attemptLog.push({
        companyId: job.companyId,
        jobId: job.id,
        agentId: job.agentId,
        workKind: job.workKind,
        attempt,
        startedAt,
        finishedAt,
        ok: true,
      });
      job.failures = 0;
      if (job.kind === 'once') {
        remove(job);
      } else {
        job.slotAt += job.intervalMs as number;
        job.runAt = job.slotAt;
      }
      return;
    }

    attemptLog.push({
      companyId: job.companyId,
      jobId: job.id,
      agentId: job.agentId,
      workKind: job.workKind,
      attempt,
      startedAt,
      finishedAt,
      ok: false,
      error,
    });
    job.failures += 1;
    const delay = nextRetryDelayMs(job.failures, {
      baseMs: retry.baseMs,
      maxMs: retry.maxMs,
      maxAttempts: retry.maxAttempts,
      deadlineAt: job.deadlineAt,
      now: finishedAt,
    });
    if (delay === null) {
      remove(job);
      deadLetterLog.push({
        companyId: job.companyId,
        jobId: job.id,
        agentId: job.agentId,
        workKind: job.workKind,
        kind: job.kind,
        attempts: job.failures,
        error,
        deadAt: finishedAt,
      });
      return;
    }
    job.runAt = finishedAt + delay;
  }

  async function runTick(): Promise<TickResult> {
    const at = now();
    let attempts = 0;
    for (const job of dueSnapshot(at)) {
      attempts += 1;
      await runJob(job);
    }
    return { attempts };
  }

  return {
    schedule(spec: JobSpec): void {
      validateSpec(spec);
      let byId = jobs.get(spec.companyId);
      if (!byId) {
        byId = new Map();
        jobs.set(spec.companyId, byId);
      }
      if (byId.has(spec.id)) throw new Error(`job ${spec.id} already scheduled for company ${spec.companyId}`);
      byId.set(spec.id, {
        seq: nextSeq++,
        id: spec.id,
        companyId: spec.companyId,
        agentId: spec.agentId,
        kind: spec.kind,
        workKind: spec.workKind,
        intervalMs: spec.kind === 'recurring' ? spec.intervalMs : undefined,
        deadlineAt: spec.deadlineAt ?? NO_DEADLINE,
        work: spec.work,
        runAt: spec.runAt,
        slotAt: spec.runAt,
        failures: 0,
      });
    },

    tick(): Promise<TickResult> {
      // Single-flight: a call made while a tick is running does nothing, so no job runs twice at once.
      if (tickInFlight) return Promise.resolve({ attempts: 0 });
      tickInFlight = runTick().finally(() => {
        tickInFlight = null;
      });
      return tickInFlight;
    },

    list(companyId: string): JobView[] {
      const byId = jobs.get(companyId);
      if (!byId) return [];
      return [...byId.values()]
        .sort((a, b) => a.runAt - b.runAt || a.seq - b.seq)
        .map((job) => ({
          id: job.id,
          companyId: job.companyId,
          agentId: job.agentId,
          kind: job.kind,
          workKind: job.workKind,
          runAt: job.runAt,
          intervalMs: job.intervalMs,
          failures: job.failures,
        }));
    },

    attempts(companyId: string): AttemptRecord[] {
      return attemptLog.filter((record) => record.companyId === companyId).map((record) => ({ ...record }));
    },

    deadLetters(companyId: string): DeadLetter[] {
      return deadLetterLog.filter((letter) => letter.companyId === companyId).map((letter) => ({ ...letter }));
    },
  };
}

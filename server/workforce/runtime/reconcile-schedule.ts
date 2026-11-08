/**
 * Reconciliation schedule for the workforce runtime. Registers one nightly recurring job with the scheduler and
 * exposes runAfterRun, which reconciles a company once a run has completed.
 *
 * Idempotency: reconcile runs at most once per company per UTC night. The nightly job and runAfterRun share the
 * same guard, so a run that finishes on a night already reconciled does not reconcile again that night. A failed
 * reconcile clears its guard, so a later call or the scheduler's retry can try again.
 *
 * No timers and no database. The caller supplies `now`, and `schedule` is the scheduler's schedule method.
 */

import type { JobSpec } from './scheduler.ts';

export type ReconcileTrigger = 'nightly' | 'run';

export type ReconcileFn = (companyId: string, trigger: ReconcileTrigger) => unknown;

export interface ReconcileScheduleOptions {
  schedule: (spec: JobSpec) => void;
  reconcile: ReconcileFn;
  now: () => number;
}

export interface ReconcileSchedule {
  /** Reconciles the company once for the current night. Resolves true when reconcile ran, false when skipped. */
  runAfterRun(companyId: string, runId: string): Promise<boolean>;
}

export const NIGHTLY_JOB_ID = 'workforce-reconcile-nightly';
/** Owner of the nightly job inside the scheduler, since one nightly job covers every company. */
export const NIGHTLY_OWNER_ID = 'workforce-system';
export const NIGHTLY_AGENT_ID = 'reconciler';

const DAY_MS = 86_400_000;

function utcNightKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** The first UTC midnight strictly after `at`. */
function nextUtcMidnight(at: number): number {
  return (Math.floor(at / DAY_MS) + 1) * DAY_MS;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new TypeError(`${name} is required`);
  return value;
}

export function scheduleReconciliation(options: ReconcileScheduleOptions): ReconcileSchedule {
  if (options === null || typeof options !== 'object') throw new TypeError('reconcile schedule options must be an object');
  if (typeof options.schedule !== 'function') throw new TypeError('schedule must be a function');
  if (typeof options.reconcile !== 'function') throw new TypeError('reconcile must be a function');
  if (typeof options.now !== 'function') throw new TypeError('now must be a function returning epoch milliseconds');
  const { schedule, reconcile, now } = options;

  /** Guard keys of the form "<UTC night>|<companyId>" for reconciliations that have started or finished. */
  const claimed = new Set<string>();
  /** Companies seen through runAfterRun. The nightly job reconciles these. */
  const knownCompanies = new Set<string>();

  async function reconcileOncePerNight(companyId: string, trigger: ReconcileTrigger): Promise<boolean> {
    const key = `${utcNightKey(now())}|${companyId}`;
    if (claimed.has(key)) return false;
    claimed.add(key);
    try {
      await reconcile(companyId, trigger);
    } catch (err) {
      claimed.delete(key);
      throw err;
    }
    return true;
  }

  schedule({
    id: NIGHTLY_JOB_ID,
    companyId: NIGHTLY_OWNER_ID,
    agentId: NIGHTLY_AGENT_ID,
    runAt: nextUtcMidnight(now()),
    kind: 'recurring',
    intervalMs: DAY_MS,
    workKind: 'scheduled',
    work: async () => {
      // Sequential, so a failure stops the pass and the retry resumes it. Companies already reconciled tonight skip.
      for (const companyId of [...knownCompanies]) {
        await reconcileOncePerNight(companyId, 'nightly');
      }
    },
  });

  return {
    async runAfterRun(companyId: string, runId: string): Promise<boolean> {
      nonEmptyString(companyId, 'companyId');
      nonEmptyString(runId, 'runId');
      knownCompanies.add(companyId);
      return reconcileOncePerNight(companyId, 'run');
    },
  };
}

/**
 * Startup for the workforce runtime. Composes the runtime from the real stores, the loaded role catalogue and the
 * operator controls, registers it for the health route, and starts the scheduler that runs the nightly jobs.
 *
 * Fail closed:
 * - A missing catalogue, store or composition error leaves no active runtime. Health then reports not ready.
 * - No model provider exists in this build, so the runtime refuses startRun and health reports the model NOT CONFIGURED.
 * - No company scope is set at startup. The process serves many companies, so identity is not ready and health
 *   stays not ready. Each company is swept for interrupted runs on its first call (compose.ts).
 * - No handoff roster store is set, so every handoff is refused. No budget ledger or company policy is set, so
 *   the matching checks do not run. No run can start without a model, so nothing here spends or acts.
 * - Reconciliation runs only when a reconcile function is passed in. The repo has no reconciliation engine yet.
 * - Retention runs as a dry run unless its dryRun option is exactly false.
 *
 * Logs carry status only: a readiness line, the scheduled job ids and one reason code. Errors are logged by code,
 * never by message, so no key or connection string reaches the log. No secret is read here.
 *
 * Dependencies are resolved lazily. The database and approval modules load only when a default is needed, so a
 * caller that passes every dependency loads neither.
 */
import { AiRuntimeError } from '../../services/ai-runtime/types.ts';
import type { ApprovalServiceLike } from '../../modules/approvals/approval-gate-adapter.ts';
import type { RoleCatalogue } from '../catalogue/loader.ts';
import { getActiveCatalogue } from '../catalogue/startup.ts';
import type { ReadStore } from '../tools/read-handlers.ts';
import { composeWorkforceRuntime, setActiveWorkforceRuntime, type ControlSource, type WorkforceRuntime } from './compose.ts';
import { NIGHTLY_JOB_ID, scheduleReconciliation, type ReconcileFn } from './reconcile-schedule.ts';
import { redactForAudit } from './redact.ts';
import { RETENTION_JOB_ID, createPgRetentionStore, scheduleRetentionPruning, type RetentionStore } from './retention.ts';
import { createScheduler, type Scheduler } from './scheduler.ts';
import { StoreUnavailableError, type RunStore } from './store.ts';
import { createPgRunStore, type SqlExecutor, type SqlResult } from './pg-store.ts';
import { runtimeHealth } from './health.ts';

export type StartupLogger = Pick<Console, 'log' | 'error'>;

/** Every field is optional. An absent field takes its default, described above. */
export interface WorkforceStartupDeps {
  catalogue?: RoleCatalogue;
  store?: RunStore;
  readStore?: ReadStore;
  /** SQL executor for the handler group reads. Absent: the app pool is used, if it loads. */
  sqlExecutor?: SqlExecutor;
  approvalService?: ApprovalServiceLike;
  controls?: ControlSource;
  retentionStore?: RetentionStore & { listCompanyIds(): Promise<string[]> };
  /** No reconciliation engine exists in the repo, so none is scheduled unless this is given. */
  reconcile?: ReconcileFn;
  /** A dry run unless exactly false. */
  retentionDryRun?: boolean;
  now?: () => Date;
  /** How often the scheduler is ticked. Defaults to one minute. */
  tickMs?: number;
  /** Set false to skip the timer. Tests then call scheduler ticks themselves. */
  startTimer?: boolean;
  logger?: StartupLogger;
}

export interface WorkforceStartupResult {
  /** The composed runtime, or null when startup failed closed. */
  runtime: WorkforceRuntime | null;
  /** One reason code when runtime is null, otherwise null. Never a message from a dependency. */
  reason: string | null;
  /** Ids of the jobs registered with the scheduler. */
  jobs: string[];
  /** The scheduler, or null when no job could be scheduled. */
  scheduler: Scheduler | null;
  /** Stops the scheduler timer. Safe to call more than once. */
  stop(): void;
}

const DEFAULT_TICK_MS = 60_000;
const RETRY = { baseMs: 60_000, maxMs: 60 * 60_000, maxAttempts: 5 } as const;

/** A read store whose every method refuses. Read tools then fail closed until a real read store is passed in. */
export function createUnavailableReadStore(): ReadStore {
  const refuse = async (): Promise<never> => {
    throw new StoreUnavailableError('Read store is not configured.');
  };
  return {
    listBookings: refuse,
    getBooking: refuse,
    listInvoices: refuse,
    getInvoice: refuse,
    listPayments: refuse,
  };
}

/** Error text for logs: the code when there is one, otherwise a fixed phrase. No message is logged. */
function reasonOf(err: unknown, fallback: string): string {
  if (err instanceof AiRuntimeError) return err.code;
  if (err instanceof StoreUnavailableError) return 'store_unavailable';
  return fallback;
}

/** One SQL executor over the app pool, shared by the stores and the handler group reads. Throws when the database module cannot load. */
async function appPoolExecutor(): Promise<SqlExecutor> {
  const { pool } = await import('../../db.ts');
  return {
    query: async (text, values) => (await pool.query(text, [...values])) as unknown as SqlResult,
  };
}

/** The database-backed store and retention store, over the app pool. Throws when the database module cannot load. */
async function pgStores(): Promise<{ store: RunStore; retentionStore: RetentionStore & { listCompanyIds(): Promise<string[]> } }> {
  const executor = await appPoolExecutor();
  return { store: createPgRunStore(executor), retentionStore: createPgRetentionStore(executor) };
}

/** The group read executor: the injected one, else the app pool. Undefined when the pool cannot load, so reads refuse. */
async function readExecutor(injected: SqlExecutor | undefined): Promise<SqlExecutor | undefined> {
  if (injected !== undefined) return injected;
  try {
    return await appPoolExecutor();
  } catch {
    return undefined;
  }
}

async function approvalDefault(): Promise<ApprovalServiceLike> {
  const approvals = await import('../../modules/approvals/index.ts');
  return new approvals.ApprovalService({ tenant: approvals.poolTenantRunner, redact: approvals.defaultRedact });
}

async function controlsDefault(): Promise<ControlSource> {
  const admin = await import('./workforce-admin-routes.ts');
  const holder = admin.workforceControls;
  return {
    state: () => holder.state,
    replace: (next) => {
      holder.state = next;
    },
  };
}

/**
 * Composes the runtime and starts the scheduler. Never throws: every failure is returned as a reason, and no
 * runtime is registered for the health route then.
 */
export async function startWorkforceRuntime(deps: WorkforceStartupDeps = {}): Promise<WorkforceStartupResult> {
  const logger: StartupLogger = deps.logger ?? console;
  const now = deps.now ?? (() => new Date());
  const jobs: string[] = [];
  let scheduler: Scheduler | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  let reason: string | null = null;
  let runtime: WorkforceRuntime | null = null;

  try {
    // Resolve the stores. A default that cannot load leaves the run store unset, which fails closed below.
    let store = deps.store;
    let retentionStore = deps.retentionStore;
    if (store === undefined || retentionStore === undefined) {
      try {
        const pg = await pgStores();
        store = store ?? pg.store;
        retentionStore = retentionStore ?? pg.retentionStore;
      } catch {
        if (store === undefined) reason = 'store_unavailable';
      }
    }

    const catalogue = deps.catalogue ?? getActiveCatalogue();
    if (reason === null && catalogue === undefined) reason = 'catalogue_unavailable';

    // Scheduler and nightly jobs. Retention does not need the runtime, so it is scheduled even when composition fails.
    const sched = createScheduler({ now: () => now().getTime(), retry: RETRY });
    scheduler = sched;
    if (retentionStore !== undefined) {
      const retention = retentionStore;
      scheduleRetentionPruning({
        schedule: sched.schedule,
        store: retention,
        listCompanyIds: () => retention.listCompanyIds(),
        now,
        dryRun: deps.retentionDryRun,
      });
      jobs.push(RETENTION_JOB_ID);
    }
    const reconciler =
      deps.reconcile === undefined
        ? null
        : scheduleReconciliation({ schedule: sched.schedule, reconcile: deps.reconcile, now: () => now().getTime() });
    if (reconciler !== null) jobs.push(NIGHTLY_JOB_ID);

    if (reason === null && catalogue !== undefined && store !== undefined) {
      const approvalService = deps.approvalService ?? (await approvalDefault());
      const controls = deps.controls ?? (await controlsDefault());
      runtime = composeWorkforceRuntime({
        store,
        catalogue,
        approvalService,
        readStore: deps.readStore ?? createUnavailableReadStore(),
        sqlExecutor: await readExecutor(deps.sqlExecutor),
        redact: redactForAudit,
        controls,
        now,
        onRunFinished: reconciler === null ? undefined : (companyId, runId) => reconciler.runAfterRun(companyId, runId),
      });
    }
  } catch (err) {
    reason = reasonOf(err, 'compose_failed');
    runtime = null;
  }

  setActiveWorkforceRuntime(runtime);

  if (jobs.length > 0 && scheduler !== null && deps.startTimer !== false) {
    const tick = scheduler;
    timer = setInterval(() => {
      tick.tick().catch(() => undefined);
    }, deps.tickMs ?? DEFAULT_TICK_MS);
    timer.unref?.();
  }

  const health = runtimeHealth(runtime);
  if (runtime !== null) {
    logger.log(`[workforce] runtime composed; health ${health.status.toUpperCase()}`);
  } else {
    logger.error(`[workforce] runtime not composed (${reason ?? 'unknown'}); health NOT_READY`);
  }
  logger.log('[workforce] model provider NOT CONFIGURED: runs cannot start');
  logger.log(`[workforce] scheduled jobs: ${jobs.length > 0 ? jobs.join(', ') : 'none'}`);

  return { runtime, reason: runtime === null ? reason : null, jobs, scheduler, stop };
}

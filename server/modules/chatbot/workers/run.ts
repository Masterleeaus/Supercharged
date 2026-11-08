/**
 * One entry point for every chatbot background job.
 *
 * startChatbotWorkers(deps) starts one timer per job, behind CHATBOT_WORKERS_ENABLED. The flag must be exactly
 * "true". Otherwise it returns a no-op handle and starts nothing, and it does not read the interval variables.
 *
 * Each job is an adapter over an existing drain, sweep or reconcile function. The adapters receive the
 * already-built services through deps.services. A job whose service is not supplied is not started, and the
 * skip is logged once. This module builds no provider, credential or secret store of its own.
 *
 * Rules every job follows:
 * - It never overlaps itself. A tick that finds the previous run still going is skipped and logged.
 * - Errors are caught and logged per job and per company. One failing company or job does not stop the others,
 *   and the process is never crashed from here.
 * - Logs carry ids, counts and error codes only. Error messages are not logged, because a provider or storage
 *   message can carry a credential or a URL.
 *
 * stopChatbotWorkers clears every timer, then waits up to 10 seconds for in-flight ticks. It never calls
 * process.exit and never starts a server. The entry that calls it owns the process.
 */
import { sql } from "drizzle-orm";
import { readFlag, type FlagEnv } from "../contracts/flags.ts";
import type { OutboxProcessor } from "../events/outbox.ts";
import type { WorkflowRunRecord } from "../events/types.ts";
import type { WorkflowRuntimeExt } from "../events/workflow-runtime.ts";
import type { StructuredActionService } from "../events/structured-actions.ts";
import type { ChannelOutbox } from "../channels/outbox.ts";
import type { OutboundPipelineDeps } from "../channels/framework.ts";
import type { ReminderDispatcher } from "../booking-providers/reminders.ts";
import { runReconciliationJob, type ReconciliationJobDeps } from "../booking-providers/reconcile-job.ts";
import { sweepCallLimits } from "../voice-call/scheduler.ts";
import type { VoiceCallService } from "../voice-call/service.ts";
import { logger as sharedLogger } from "../../../utils/logger.ts";

/** The flag that turns the whole runner on. Read with readFlag, so only the exact value "true" enables it. */
export const CHATBOT_WORKERS_FLAG = "CHATBOT_WORKERS_ENABLED";

/** How long stopChatbotWorkers waits for in-flight ticks before it resolves anyway. */
export const WORKER_STOP_TIMEOUT_MS = 10_000;

/** Upper bound on workflow runs claimed in one events-worker tick. */
const EVENTS_WORKER_RUNS_PER_TICK = 10;

/** Widget rate-limit rows older than this are removed. Must be longer than the longest widget policy window. */
const WIDGET_RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000;

const DEFAULT_WORKER_ID = "chatbot-workers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkerLogger {
  info(event: string, fields: Record<string, unknown>): void;
  warn(event: string, fields: Record<string, unknown>): void;
  error(event: string, fields: Record<string, unknown>): void;
}

/** Only execute() is required. The DB type is the loose shape the rate-limit store uses, so tests can pass a fake. */
export interface ChatbotWorkerDb {
  execute(query: unknown): Promise<unknown>;
}

export interface VoiceSweepService {
  expireIdleSessions(companyId: string, options?: { limit?: number }): Promise<number>;
}

export interface ChatbotWorkerServices {
  /** Event outbox processor (events/outbox.ts). Drives the outbox drain job. */
  eventOutbox?: { processor: OutboxProcessor; workerId?: string };
  /** Channel send outbox (channels/outbox.ts) with the pipeline deps it sends through. */
  channelOutbox?: { outbox: ChannelOutbox; pipeline: OutboundPipelineDeps };
  /**
   * Workflow runs. claimNext leases one due run. execute does the work and returns the output. A throw from
   * execute marks the run failed with a fixed reason.
   */
  workflows?: {
    runtime: Pick<WorkflowRuntimeExt, "claimNext" | "complete" | "fail">;
    execute(companyId: string, run: WorkflowRunRecord): Promise<Record<string, unknown>>;
  };
  /**
   * Structured action service (events/structured-actions.ts). expireStaleProposals runs once per company inside the
   * events_worker tick. Optional: when it is absent the sweep is skipped and nothing is logged for it.
   */
  structuredActions?: Pick<StructuredActionService, "expireStaleProposals">;
  /** Voice service. expireIdleSessions ends sessions that have gone quiet (voice/voice-service.ts). */
  voice?: VoiceSweepService;
  /** Call service for the quota sweep. enforceLimitsForCompany ends in-progress calls past their cap (voice-call/service.ts). */
  voiceCallLimits?: Pick<VoiceCallService, "enforceLimitsForCompany">;
  /** Reminder dispatcher (booking-providers/reminders.ts). */
  reminders?: Pick<ReminderDispatcher, "runDue">;
  /** One entry per calendar provider. Each runs runReconciliationJob for every company. */
  reconciliation?: { jobs: ReconciliationJobDeps[] };
}

export interface ChatbotWorkersDeps {
  db: ChatbotWorkerDb;
  env: FlagEnv;
  services?: ChatbotWorkerServices;
  /** Passed to every job in its context. */
  fetch?: typeof fetch;
  /** Clock for the context's "now" and for tick durations. */
  clock?: () => Date;
  logger?: WorkerLogger;
  /**
   * Company ids that per-company jobs visit. Defaults to every row in the companies table. The list is read on
   * each tick.
   */
  companyIds?: () => Promise<string[]>;
}

export interface ChatbotWorkersHandle {
  readonly enabled: boolean;
  /** Names of the jobs that were started. Empty when the flag is off. */
  readonly jobs: readonly string[];
}

export interface StopWorkersResult {
  /** True when in-flight ticks were still running when the wait ended. */
  timedOut: boolean;
}

export class ChatbotWorkersConfigError extends Error {
  readonly code = "WORKER_CONFIG";
  constructor(message: string) {
    super(message);
    this.name = "ChatbotWorkersConfigError";
  }
}

interface WorkerContext {
  db: ChatbotWorkerDb;
  services: ChatbotWorkerServices;
  fetch: typeof fetch | undefined;
  now: () => Date;
  logger: WorkerLogger;
}

type Counts = Record<string, number>;

interface JobDefinition {
  name: string;
  defaultIntervalMs: number;
  /** Returns true when the services this job needs were supplied. */
  wired(services: ChatbotWorkerServices): boolean;
  /** Runs the job for one company and returns counts. */
  runForCompany(companyId: string, ctx: WorkerContext): Promise<Counts>;
}

// ---------------------------------------------------------------------------
// Job table. The only place intervals and job adapters are listed.
// ---------------------------------------------------------------------------

export const WORKER_JOB_DEFAULTS = {
  outbox_drain: 5_000,
  channel_send_drain: 10_000,
  events_worker: 5_000,
  voice_sweep: 60_000,
  voice_call_limits: 60_000,
  reminders: 60_000,
  booking_reconcile: 15 * 60_000,
  widget_rate_limit_cleanup: 60 * 60_000,
} as const;

async function countOf(result: unknown): Promise<number> {
  if (Array.isArray(result)) return result.length;
  const shaped = result as { rows?: unknown[]; rowCount?: number | null } | null;
  if (shaped && typeof shaped.rowCount === "number") return shaped.rowCount;
  if (shaped && Array.isArray(shaped.rows)) return shaped.rows.length;
  return 0;
}

const JOBS: readonly JobDefinition[] = [
  {
    name: "outbox_drain",
    defaultIntervalMs: WORKER_JOB_DEFAULTS.outbox_drain,
    wired: (s) => s.eventOutbox !== undefined,
    async runForCompany(companyId, ctx) {
      const { processor, workerId } = ctx.services.eventOutbox!;
      // OutboxProcessor.process returns { claimed, published, retried, deadLettered }.
      const r = await processor.process(companyId, { workerId: workerId ?? DEFAULT_WORKER_ID });
      return { claimed: r.claimed, published: r.published, retried: r.retried, deadLettered: r.deadLettered };
    },
  },
  {
    name: "channel_send_drain",
    defaultIntervalMs: WORKER_JOB_DEFAULTS.channel_send_drain,
    wired: (s) => s.channelOutbox !== undefined,
    async runForCompany(companyId, ctx) {
      const { outbox, pipeline } = ctx.services.channelOutbox!;
      // ChannelOutbox.drain returns DrainSummary: expired, claimed, sent, retryScheduled, failed.
      const r = await outbox.drain(companyId, pipeline);
      return { expired: r.expired, claimed: r.claimed, sent: r.sent, retryScheduled: r.retryScheduled, failed: r.failed };
    },
  },
  {
    name: "events_worker",
    defaultIntervalMs: WORKER_JOB_DEFAULTS.events_worker,
    // Runs when the workflow runtime or the structured action service is supplied. The proposal sweep lives here.
    wired: (s) => s.workflows !== undefined || s.structuredActions !== undefined,
    async runForCompany(companyId, ctx) {
      const counts: Counts = {};
      const workflows = ctx.services.workflows;
      if (workflows) {
        const { runtime, execute } = workflows;
        counts.claimed = 0;
        counts.completed = 0;
        counts.failed = 0;
        for (let i = 0; i < EVENTS_WORKER_RUNS_PER_TICK; i++) {
          const run = await runtime.claimNext(companyId);
          if (!run) break;
          counts.claimed += 1;
          try {
            const output = await execute(companyId, run);
            await runtime.complete(companyId, run.id, output);
            counts.completed += 1;
          } catch (error) {
            // The reason is fixed text. A step error can carry provider or storage detail.
            ctx.logger.warn("workers.events_run_failed", { companyId, runId: run.id, ...errorFields(error) });
            await runtime.fail(companyId, run.id, "Workflow step failed.");
            counts.failed += 1;
          }
        }
      }
      const actions = ctx.services.structuredActions;
      if (actions) {
        // One sweep per company per tick. It sets stale "proposed" actions to "expired" and returns the count.
        counts.proposalsExpired = await actions.expireStaleProposals(companyId, ctx.now());
      }
      return counts;
    },
  },
  {
    name: "voice_sweep",
    defaultIntervalMs: WORKER_JOB_DEFAULTS.voice_sweep,
    wired: (s) => s.voice !== undefined,
    async runForCompany(companyId, ctx) {
      const ended = await ctx.services.voice!.expireIdleSessions(companyId);
      return { idleEnded: ended };
    },
  },
  {
    name: "voice_call_limits",
    defaultIntervalMs: WORKER_JOB_DEFAULTS.voice_call_limits,
    wired: (s) => s.voiceCallLimits !== undefined,
    async runForCompany(companyId, ctx) {
      // sweepCallLimits takes a list. The tick loop hands it one company at a time, so a failure stays scoped to
      // that company. sweepCallLimits reports its own failures as fixed text, so they are counted, not thrown.
      const [report] = await sweepCallLimits(ctx.services.voiceCallLimits!, [companyId]);
      if (!report || !report.ok) return { checked: 1, ended: 0, failed: 1 };
      return { checked: 1, ended: report.ended, failed: 0 };
    },
  },
  {
    name: "reminders",
    defaultIntervalMs: WORKER_JOB_DEFAULTS.reminders,
    wired: (s) => s.reminders !== undefined,
    async runForCompany(companyId, ctx) {
      // ReminderDispatcher.runDue returns { due, sent, failed, skipped }.
      const r = await ctx.services.reminders!.runDue(companyId);
      return { due: r.due, sent: r.sent, failed: r.failed, skipped: r.skipped };
    },
  },
  {
    name: "booking_reconcile",
    defaultIntervalMs: WORKER_JOB_DEFAULTS.booking_reconcile,
    wired: (s) => s.reconciliation !== undefined,
    async runForCompany(companyId, ctx) {
      const counts: Counts = { reconciled: 0, not_connected: 0, failed: 0 };
      for (const jobDeps of ctx.services.reconciliation!.jobs) {
        const outcome = await runReconciliationJob(companyId, jobDeps);
        if (outcome.status === "reconciled") counts.reconciled += 1;
        else if (outcome.status === "not_connected") counts.not_connected += 1;
        else counts.failed += 1;
      }
      return counts;
    },
  },
  {
    name: "widget_rate_limit_cleanup",
    defaultIntervalMs: WORKER_JOB_DEFAULTS.widget_rate_limit_cleanup,
    // The table is owned by widget/rate-limit-store.ts. It needs no service, so this job is always wired.
    wired: () => true,
    async runForCompany(companyId, ctx) {
      // Deletes this company's expired fixed windows only. The company filter is part of the WHERE clause.
      const cutoffMs = ctx.now().getTime() - WIDGET_RATE_LIMIT_RETENTION_MS;
      const result = await ctx.db.execute(
        sql`delete from widget_rate_limits where company_id = ${companyId} and window_start_ms < ${cutoffMs} returning 1 as deleted`,
      );
      return { deleted: await countOf(result) };
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/** Reads CHATBOT_WORKER_<NAME>_INTERVAL_MS. Throws on anything that is not a positive integer. */
export function intervalFor(job: string, defaultMs: number, env: FlagEnv): number {
  const key = `CHATBOT_WORKER_${job.toUpperCase()}_INTERVAL_MS`;
  const raw = env[key];
  if (raw === undefined || raw === "") return defaultMs;
  const value = Number(raw);
  if (!POSITIVE_INTEGER.test(raw) || !Number.isSafeInteger(value)) {
    throw new ChatbotWorkersConfigError(`${key} must be a positive integer`);
  }
  return value;
}

/**
 * The single documented source of company ids for the workers. It is the only query in this module that reads
 * the companies table. It selects `id` and nothing else, so it is cross-tenant by design: it lists tenants and
 * never reads tenant data. Every per-company job then filters its own queries by company_id. Do not add columns
 * here, and do not use this query for anything other than the id list.
 */
export function companyIdsQuery() {
  return sql`select id from companies order by id`;
}

/** Default company source: every id in the companies table, through companyIdsQuery. Read again on each tick. */
export function listCompanyIdsFromDb(db: ChatbotWorkerDb): () => Promise<string[]> {
  return async () => {
    const result = await db.execute(companyIdsQuery());
    const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] } | null)?.rows ?? [])) as Array<{ id?: unknown }>;
    return rows.map((row) => row.id).filter((id): id is string => typeof id === "string");
  };
}

/** Logger that writes each event through the shared logger. It logs only the fields it is given. */
export function consoleWorkerLogger(): WorkerLogger {
  return {
    info: (event, fields) => sharedLogger.info(event, fields),
    warn: (event, fields) => sharedLogger.warn(event, fields),
    error: (event, fields) => sharedLogger.error(event, fields),
  };
}

/** Safe error fields: class name and a string code, never the message. */
function errorFields(error: unknown): Record<string, unknown> {
  const name = error instanceof Error ? error.name : "NonError";
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.length <= 64 ? { errorName: name, errorCode: code } : { errorName: name };
}

function addCounts(into: Counts, from: Counts): void {
  for (const [key, value] of Object.entries(from)) into[key] = (into[key] ?? 0) + value;
}

interface RunningState {
  timers: NodeJS.Timeout[];
  inflight: Set<Promise<void>>;
  stopped: boolean;
  logger: WorkerLogger;
  clock: () => Date;
}

const RUNNING = new WeakMap<ChatbotWorkersHandle, RunningState>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Starts the background jobs, or returns a no-op handle when CHATBOT_WORKERS_ENABLED is not exactly "true".
 * Throws ChatbotWorkersConfigError before any timer starts when an interval variable is not a positive integer.
 */
export function startChatbotWorkers(deps: ChatbotWorkersDeps): ChatbotWorkersHandle {
  const logger = deps.logger ?? consoleWorkerLogger();
  const clock = deps.clock ?? (() => new Date());

  if (!readFlag(CHATBOT_WORKERS_FLAG, deps.env)) {
    const handle: ChatbotWorkersHandle = { enabled: false, jobs: [] };
    RUNNING.set(handle, { timers: [], inflight: new Set(), stopped: true, logger, clock });
    return handle;
  }

  const services = deps.services ?? {};
  const ctx: WorkerContext = { db: deps.db, services, fetch: deps.fetch, now: clock, logger };
  const listCompanies = deps.companyIds ?? listCompanyIdsFromDb(deps.db);

  // Validate every interval before the first timer exists, so a bad value starts nothing.
  const plan = JOBS.map((job) => ({ job, intervalMs: intervalFor(job.name, job.defaultIntervalMs, deps.env) }));

  const state: RunningState = { timers: [], inflight: new Set(), stopped: false, logger, clock };
  const started: string[] = [];

  for (const { job, intervalMs } of plan) {
    if (!job.wired(services)) {
      logger.info("workers.job_not_wired", { job: job.name });
      continue;
    }
    let running = false;

    const tick = async (): Promise<void> => {
      if (state.stopped) return;
      if (running) {
        logger.warn("workers.job_skipped_overlap", { job: job.name });
        return;
      }
      running = true;
      const startedAt = clock().getTime();
      const totals: Counts = {};
      let companies = 0;
      let companyErrors = 0;
      try {
        const ids = await listCompanies();
        for (const companyId of ids) {
          if (state.stopped) break;
          companies += 1;
          try {
            addCounts(totals, await job.runForCompany(companyId, ctx));
          } catch (error) {
            companyErrors += 1;
            logger.error("workers.company_failed", { job: job.name, companyId, ...errorFields(error) });
          }
        }
        const worked = Object.values(totals).some((n) => n > 0) || companyErrors > 0;
        if (worked) {
          logger.info("workers.tick", {
            job: job.name,
            companies,
            companyErrors,
            durationMs: clock().getTime() - startedAt,
            ...totals,
          });
        }
      } catch (error) {
        logger.error("workers.tick_failed", { job: job.name, ...errorFields(error) });
      } finally {
        running = false;
      }
    };

    const run = (): void => {
      const p = tick().catch((error: unknown) => {
        logger.error("workers.tick_unhandled", { job: job.name, ...errorFields(error) });
      });
      const tracked = p.finally(() => {
        state.inflight.delete(tracked);
      });
      state.inflight.add(tracked);
    };

    state.timers.push(setInterval(run, intervalMs));
    started.push(job.name);
  }

  const handle: ChatbotWorkersHandle = { enabled: true, jobs: started };
  RUNNING.set(handle, state);
  logger.info("workers.started", { jobs: started.length });
  return handle;
}

/**
 * Clears every timer, then waits for in-flight ticks to finish. The wait ends after timeoutMs (default 10 seconds)
 * even when a tick is still running. Calling it twice is safe.
 */
export async function stopChatbotWorkers(
  handle: ChatbotWorkersHandle,
  options: { timeoutMs?: number } = {},
): Promise<StopWorkersResult> {
  const state = RUNNING.get(handle);
  if (!state) return { timedOut: false };

  state.stopped = true;
  for (const timer of state.timers) clearInterval(timer);
  state.timers.length = 0;

  const pending = [...state.inflight];
  if (pending.length === 0) return { timedOut: false };

  const timeoutMs = options.timeoutMs ?? WORKER_STOP_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    Promise.allSettled(pending).then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);

  if (timedOut) {
    state.logger.warn("workers.stop_timeout", { inflight: state.inflight.size, timeoutMs });
  } else {
    state.logger.info("workers.stopped", { inflight: 0 });
  }
  return { timedOut };
}

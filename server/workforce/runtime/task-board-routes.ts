/**
 * Read-only task board and run history routes for the workforce screens.
 *
 *   GET /api/workforce/tasks         one row per run in the session's company, newest update first
 *   GET /api/workforce/run-history   each recent run with its outcome and audit timeline
 *
 * Every route runs the same chain, in this order: authenticate, requireCompanyScope, admin or manager, company scope.
 * Company scope comes only from the verified session (req.user.companyId, through getCompanyScope), copied to
 * res.locals.companyId. Request bodies, queries, params and headers are never read for tenancy or filtering.
 *
 * Reads go through the injected RunStore (listRuns, listAudit). Each run is shown through task-view.ts
 * (buildTaskView), so raw tool params, plans, budgets and team data are never copied into a response.
 * Status is shown as a run-status-view label with its plain English text. Free text (outcome reason, audit
 * kind) is redacted before it leaves the server.
 *
 * Responses are capped: at most MAX_TASKS tasks and MAX_HISTORY_RUNS runs, each with at most MAX_EVENTS_PER_RUN
 * audit events. `truncated` is true when a cap removed rows.
 *
 * Errors are generic. A missing store returns 503, a store that reports itself unavailable returns 503, and any
 * other failure returns 500 with no message or stack. A missing company returns 403 from the scope middleware.
 */
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { getCompanyScope } from '../../middleware/company-scope.ts';
import { StoreUnavailableError, type AuditEvent, type RunStore } from './store.ts';
import type { RunRecord } from './run.ts';
import { runStatusView, type RunViewLabel } from './run-status-view.ts';
import { buildTaskView } from './task-view.ts';
import { redactForAudit } from './redact.ts';

export const TASKS_PATH = '/api/workforce/tasks';
export const RUN_HISTORY_PATH = '/api/workforce/run-history';

export const MAX_TASKS = 100;
export const MAX_HISTORY_RUNS = 50;
export const MAX_EVENTS_PER_RUN = 200;

/** An approval waiting longer than this is shown as needing attention. One day. */
export const DEFAULT_STALE_APPROVAL_MS = 24 * 60 * 60 * 1000;

export interface TaskBoardDeps {
  /** Run and audit reads. Pass the production store (createPgRunStore) or a test double. Absent means 503. */
  store?: RunStore;
  /** Clock for status detail. Defaults to the current time. */
  now?: () => Date;
  /** Approval wait after which a run shows as needing attention. Defaults to DEFAULT_STALE_APPROVAL_MS. */
  staleAfterMs?: number;
}

/** Guards are injected so the real auth middleware is wired by the caller and tests can use stubs. */
export interface TaskBoardGuards {
  authenticate: RequestHandler;
  requireCompanyScope: RequestHandler;
  /** Admin or manager only. */
  requireAdminOrManager: RequestHandler;
}

export interface TaskBoardRow {
  runId: string;
  label: RunViewLabel;
  text: string;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunHistoryEntry {
  runId: string;
  label: RunViewLabel;
  text: string;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
  outcome: { reason: string | null };
  events: { action: string; createdAt: string }[];
}

const redactText = (value: string): string => redactForAudit({ value }).value;

function millis(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Only runs whose company matches are read. The store is already scoped; this is a second check. */
function ownRuns(runs: readonly RunRecord[], companyId: string): RunRecord[] {
  return runs.filter((run) => run.companyId === companyId);
}

export function buildTaskRows(
  runs: readonly RunRecord[],
  companyId: string,
  now: Date,
  staleAfterMs: number,
): { tasks: TaskBoardRow[]; truncated: boolean } {
  const sorted = ownRuns(runs, companyId)
    .slice()
    .sort((a, b) => millis(b.updatedAt) - millis(a.updatedAt));
  const tasks = sorted.slice(0, MAX_TASKS).map((run) => {
    const status = runStatusView(run, now, { staleAfterMs });
    return {
      runId: run.id,
      label: status.label,
      text: status.text,
      detail: status.detail,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  });
  return { tasks, truncated: sorted.length > MAX_TASKS };
}

export function buildRunHistory(
  runs: readonly RunRecord[],
  auditEvents: readonly AuditEvent[],
  companyId: string,
  now: Date,
  staleAfterMs: number,
): { runs: RunHistoryEntry[]; truncated: boolean } {
  const byRun = new Map<string, AuditEvent[]>();
  for (const event of auditEvents) {
    if (event.companyId !== companyId || event.runId === null) continue;
    const list = byRun.get(event.runId) ?? [];
    list.push(event);
    byRun.set(event.runId, list);
  }

  const sorted = ownRuns(runs, companyId)
    .slice()
    .sort((a, b) => millis(b.createdAt) - millis(a.createdAt));
  const entries: RunHistoryEntry[] = [];
  for (const run of sorted.slice(0, MAX_HISTORY_RUNS)) {
    const view = buildTaskView({
      run,
      toolCalls: [],
      approvals: [],
      auditEvents: byRun.get(run.id) ?? [],
      companyId,
      redact: redactText,
    });
    if (view === null) continue;
    const status = runStatusView(run, now, { staleAfterMs });
    entries.push({
      runId: view.runId,
      label: status.label,
      text: status.text,
      detail: status.detail,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      outcome: { reason: view.outcome.reason },
      events: view.audit.slice(0, MAX_EVENTS_PER_RUN),
    });
  }
  return { runs: entries, truncated: sorted.length > MAX_HISTORY_RUNS };
}

/** Sets res.locals.companyId from the verified session company. Fails closed with 403 when absent. */
function setScopedCompany(req: Request, res: Response, next: NextFunction): void {
  try {
    res.locals.companyId = getCompanyScope(req);
  } catch {
    res.status(403).json({ error: 'Company scope required' });
    return;
  }
  next();
}

function scopedCompanyId(res: Response): string {
  return res.locals.companyId as string;
}

function failure(res: Response, error: unknown): void {
  if (error instanceof StoreUnavailableError) {
    res.status(503).json({ error: 'store_unavailable' });
    return;
  }
  res.status(500).json({ error: 'internal_error' });
}

export function createTaskBoardRouter(deps: TaskBoardDeps, guards: TaskBoardGuards): Router {
  const router = Router();
  const chain: RequestHandler[] = [guards.authenticate, guards.requireCompanyScope, guards.requireAdminOrManager, setScopedCompany];
  const clock = deps.now ?? (() => new Date());
  const staleAfterMs = deps.staleAfterMs ?? DEFAULT_STALE_APPROVAL_MS;

  router.get(TASKS_PATH, ...chain, async (_req: Request, res: Response) => {
    const store = deps.store;
    if (!store) {
      res.status(503).json({ error: 'dependency_not_configured', dependency: 'store' });
      return;
    }
    const companyId = scopedCompanyId(res);
    try {
      const runs = await store.listRuns(companyId);
      res.json(buildTaskRows(runs, companyId, clock(), staleAfterMs));
    } catch (error) {
      failure(res, error);
    }
  });

  router.get(RUN_HISTORY_PATH, ...chain, async (_req: Request, res: Response) => {
    const store = deps.store;
    if (!store) {
      res.status(503).json({ error: 'dependency_not_configured', dependency: 'store' });
      return;
    }
    const companyId = scopedCompanyId(res);
    try {
      const [runs, audit] = await Promise.all([store.listRuns(companyId), store.listAudit(companyId)]);
      res.json(buildRunHistory(runs, audit, companyId, clock(), staleAfterMs));
    } catch (error) {
      failure(res, error);
    }
  });

  return router;
}

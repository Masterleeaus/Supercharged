/**
 * Retention policy for workforce runtime data, keyed by companyId.
 *
 * Periods (decided by Jason):
 * - finished runs: kept 365 days after they end
 * - tool calls and tasks: kept 180 days
 * - budget usage: kept 90 days
 * - audit events: never pruned (7 year retention is handled outside this module). Audit is not a table here,
 *   so no code path in this file can reach it.
 *
 * pruneRetention() is a dry run unless dryRun is exactly false. It works out which rows are expired, then either
 * reports the counts or asks the injected store to delete those ids. This module does no I/O of its own.
 *
 * scheduleRetentionPruning() registers one nightly job with the scheduler. It is a dry run unless dryRun is
 * exactly false. createPgRetentionStore() is the production store, reached through an injected SqlExecutor.
 * Its SQL names only the run, tool call, task and budget tables. The audit table is never named.
 */
import { requireCompanyId } from '../../services/ai-runtime/company.ts';
import type { CompanyId } from '../../services/ai-runtime/types.ts';
import { TERMINAL_RUN_STATUSES } from './run.ts';
import type { JobSpec } from './scheduler.ts';
import type { SqlExecutor } from './pg-store.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export const RETENTION_DAYS = {
  runs: 365,
  tool_calls: 180,
  tasks: 180,
  budget_usage: 90,
} as const;

/** Tables this module may prune. Audit is deliberately absent. */
export type RetentionTable = keyof typeof RETENTION_DAYS;
export const RETENTION_TABLES: readonly RetentionTable[] = ['runs', 'tool_calls', 'tasks', 'budget_usage'];

/**
 * One row as the store reports it. `at` is the timestamp the period is measured from:
 * for runs, the time the run ended; for tool calls, tasks and budget usage, the time the row was written.
 * `status` is set for runs only, so an unfinished run is never treated as expired.
 */
export interface RetentionRow {
  id: string;
  companyId: CompanyId;
  at: string | null;
  status?: string | null;
}

export interface RetentionStore {
  /** Returns the rows of one table for one company. Must filter by companyId. */
  listRetentionRows(companyId: CompanyId, table: RetentionTable): Promise<RetentionRow[]>;
  /** Deletes the given ids from one table for one company. Returns how many were removed. */
  deleteRetentionRows(companyId: CompanyId, table: RetentionTable, ids: readonly string[]): Promise<number>;
}

export interface PruneRetentionOptions {
  store: RetentionStore;
  now: Date;
  dryRun: boolean;
}

export interface PruneRetentionResult {
  companyId: CompanyId;
  dryRun: boolean;
  /** Rows that were (or, in a dry run, would be) removed, per table. */
  counts: Record<RetentionTable, number>;
  /** Cutoff instant per table: rows measured before this time are expired. */
  cutoffs: Record<RetentionTable, string>;
}

function emptyCounts(): Record<RetentionTable, number> {
  return { runs: 0, tool_calls: 0, tasks: 0, budget_usage: 0 };
}

function isExpired(row: RetentionRow, table: RetentionTable, cutoffMs: number): boolean {
  if (row.at === null) return false;
  const at = Date.parse(row.at);
  if (Number.isNaN(at)) return false;
  if (table === 'runs') {
    // Only finished runs age out. A run that is still going keeps its data whatever its age.
    if (!row.status || !(TERMINAL_RUN_STATUSES as readonly string[]).includes(row.status)) return false;
  }
  return at < cutoffMs;
}

export async function pruneRetention(options: PruneRetentionOptions, companyId: CompanyId): Promise<PruneRetentionResult> {
  const scoped = requireCompanyId(companyId);
  const { store, now } = options;
  const dryRun = options.dryRun === false ? false : true;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('pruneRetention requires a valid Date for now');
  }

  const nowMs = now.getTime();
  const counts = emptyCounts();
  const cutoffs = {} as Record<RetentionTable, string>;

  for (const table of RETENTION_TABLES) {
    const cutoffMs = nowMs - RETENTION_DAYS[table] * DAY_MS;
    cutoffs[table] = new Date(cutoffMs).toISOString();

    const rows = await store.listRetentionRows(scoped, table);
    for (const row of rows) {
      if (row.companyId !== scoped) {
        throw new Error(`retention row ${row.id} belongs to another company`);
      }
    }
    const expired = rows.filter((row) => isExpired(row, table, cutoffMs)).map((row) => row.id);

    if (dryRun) {
      counts[table] = expired.length;
    } else if (expired.length > 0) {
      counts[table] = await store.deleteRetentionRows(scoped, table, expired);
    }
  }

  return { companyId: scoped, dryRun, counts, cutoffs };
}

export const RETENTION_JOB_ID = 'workforce-retention-nightly';
/** Owner of the nightly job inside the scheduler, since one nightly job covers every company. */
export const RETENTION_OWNER_ID = 'workforce-system';
export const RETENTION_AGENT_ID = 'retention';
/** Hour (UTC) the nightly pruning pass starts, after the nightly reconciliation at midnight. */
export const RETENTION_HOUR_UTC = 2;

export interface RetentionSchedule {
  /** Runs one pass now over every listed company. Resolves with one result per company, in order. */
  runNow(): Promise<PruneRetentionResult[]>;
}

export interface RetentionScheduleOptions {
  schedule: (spec: JobSpec) => void;
  store: RetentionStore;
  /** Companies to prune. Read at each pass. */
  listCompanyIds: () => Promise<readonly string[]>;
  now: () => Date;
  /** A dry run unless exactly false. Absent, null or any other value keeps it a dry run. */
  dryRun?: boolean;
}

/** The first RETENTION_HOUR_UTC instant strictly after `at`. */
function nextRetentionSlot(at: number): number {
  const hourMs = RETENTION_HOUR_UTC * 60 * 60 * 1000;
  let slot = Math.floor(at / DAY_MS) * DAY_MS + hourMs;
  if (slot <= at) slot += DAY_MS;
  return slot;
}

/**
 * Registers one nightly retention job with the scheduler. The job prunes every listed company in turn. A failure
 * stops the pass, and the scheduler retries the whole pass. Pruning is idempotent, so a repeat is safe.
 */
export function scheduleRetentionPruning(options: RetentionScheduleOptions): RetentionSchedule {
  if (options === null || typeof options !== 'object') throw new TypeError('retention schedule options must be an object');
  if (typeof options.schedule !== 'function') throw new TypeError('schedule must be a function');
  if (typeof options.listCompanyIds !== 'function') throw new TypeError('listCompanyIds must be a function');
  if (typeof options.now !== 'function') throw new TypeError('now must be a function returning a Date');
  const dryRun = options.dryRun !== false;

  const runNow = async (): Promise<PruneRetentionResult[]> => {
    const results: PruneRetentionResult[] = [];
    for (const companyId of await options.listCompanyIds()) {
      results.push(await pruneRetention({ store: options.store, now: options.now(), dryRun }, companyId as CompanyId));
    }
    return results;
  };

  options.schedule({
    id: RETENTION_JOB_ID,
    companyId: RETENTION_OWNER_ID,
    agentId: RETENTION_AGENT_ID,
    runAt: nextRetentionSlot(options.now().getTime()),
    kind: 'recurring',
    intervalMs: DAY_MS,
    workKind: 'scheduled',
    work: async () => {
      await runNow();
    },
  });

  return { runNow };
}

/** SQL for each prunable table. Audit has no entry, so no query can name it. */
const RETENTION_SQL: Record<RetentionTable, { table: string; at: string; idExpr: string }> = {
  runs: { table: 'workforce_runs', at: 'updated_at', idExpr: 'id::text' },
  tool_calls: { table: 'workforce_tool_calls', at: 'created_at', idExpr: 'id::text' },
  tasks: { table: 'workforce_tasks', at: 'created_at', idExpr: 'id::text' },
  // Budget usage has a composite key. Its row id joins the key parts with a unit separator.
  budget_usage: {
    table: 'workforce_budget_usage',
    at: 'day::text',
    idExpr: `scope || chr(31) || scope_key || chr(31) || day::text`,
  },
};

/**
 * Production RetentionStore over the workforce tables, through an injected SqlExecutor. Every query filters on
 * company_id. Run deletes also require a terminal status, so a run that became active after it was listed is kept.
 */
export function createPgRetentionStore(db: SqlExecutor): RetentionStore & { listCompanyIds(): Promise<string[]> } {
  return {
    async listRetentionRows(companyId, table) {
      const spec = RETENTION_SQL[table];
      if (!spec) throw new Error(`no retention rule for table ${String(table)}`);
      const statusColumn = table === 'runs' ? ', status' : ', NULL::text AS status';
      const result = await db.query(
        `SELECT ${spec.idExpr} AS id, company_id::text AS company_id, ${spec.at} AS at${statusColumn} FROM ${spec.table} WHERE company_id = $1`,
        [companyId],
      );
      return result.rows.map((row) => ({
        id: String(row.id),
        companyId: String(row.company_id) as CompanyId,
        at: row.at === null || row.at === undefined ? null : row.at instanceof Date ? row.at.toISOString() : String(row.at),
        status: row.status === null || row.status === undefined ? null : String(row.status),
      }));
    },

    async deleteRetentionRows(companyId, table, ids) {
      if (ids.length === 0) return 0;
      const spec = RETENTION_SQL[table];
      if (!spec) throw new Error(`no retention rule for table ${String(table)}`);
      if (table === 'runs') {
        const result = await db.query(
          `DELETE FROM workforce_runs WHERE company_id = $1 AND id::text = ANY($2::text[]) AND status = ANY($3::text[])`,
          [companyId, [...ids], [...TERMINAL_RUN_STATUSES]],
        );
        return result.rowCount ?? 0;
      }
      const result = await db.query(
        `DELETE FROM ${spec.table} WHERE company_id = $1 AND (${spec.idExpr}) = ANY($2::text[])`,
        [companyId, [...ids]],
      );
      return result.rowCount ?? 0;
    },

    async listCompanyIds() {
      const result = await db.query(`SELECT DISTINCT company_id::text AS company_id FROM workforce_runs`, []);
      return result.rows.map((row) => String(row.company_id));
    },
  };
}

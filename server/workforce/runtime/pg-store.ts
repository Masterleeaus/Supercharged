/**
 * Production RunStore backed by the workforce_runs and workforce_audit_events tables (shared/schema.ts,
 * migrations/DRAFT_workforce_runs.sql). The database is reached only through the injected SqlExecutor, so
 * this file never imports a driver. The composition root passes in a pg Pool or Client.
 *
 * Tenant rules:
 * - Every query filters on company_id. For reads and updates the company is the caller's argument.
 * - appendAudit takes no separate company argument, so it uses event.companyId, validated by requireCompanyId.
 * - A row is never read back under a company other than the one the caller named.
 *
 * Update is a compare-and-set: UPDATE ... WHERE company_id = $1 AND id = $2 AND version = $3, and the
 * affected row count decides the result. The audit table is append-only: no update or delete is exposed.
 */
import { requireCompanyId } from '../../services/ai-runtime/company.ts';
import type { CompanyId } from '../../services/ai-runtime/types.ts';
import type { PendingApproval, RetryPolicy, RunBudget, RunRecord, RunStatus } from './run.ts';
import type { Delegation, Team, TeamLimits } from './team.ts';
import { AUDIT_KINDS, RunVersionConflictError, type AuditEvent, type RunStore } from './store.ts';
import { redactForAudit } from './redact.ts';

export interface SqlResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

/** Anything with a parameterised query method, such as a pg Pool or Client. Values use $1, $2, ... placeholders. */
export interface SqlExecutor {
  query(text: string, values: readonly unknown[]): Promise<SqlResult>;
}

const RUN_COLUMNS = [
  'id',
  'company_id',
  'status',
  'version',
  'team',
  'path',
  'delegations',
  'limits',
  'budget_max_tokens',
  'budget_max_tool_calls',
  'budget_tokens_used',
  'budget_tool_calls',
  'retry',
  'pending_approval',
  'reason',
  'created_at',
  'updated_at',
].join(', ');

const AUDIT_COLUMNS = 'id, company_id, run_id, kind, data, created_at';

const INSERT_RUN = `INSERT INTO workforce_runs (id, company_id, status, version, team, path, delegations, limits, budget_max_tokens, budget_max_tool_calls, budget_tokens_used, budget_tool_calls, retry, pending_approval, reason, created_at, updated_at)
VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
ON CONFLICT (id) DO NOTHING
RETURNING ${RUN_COLUMNS}`;

// $1 company, $2 id, $3 expected version, $4..$15 mutable fields, $16 updated_at.
const UPDATE_RUN = `UPDATE workforce_runs SET status = $4, team = $5, path = $6, delegations = $7, limits = $8,
  budget_max_tokens = $9, budget_max_tool_calls = $10, budget_tokens_used = $11, budget_tool_calls = $12,
  retry = $13, pending_approval = $14, reason = $15, updated_at = $16, version = version + 1
WHERE company_id = $1 AND id = $2 AND version = $3
RETURNING ${RUN_COLUMNS}`;

const SELECT_RUN_VERSION = 'SELECT version FROM workforce_runs WHERE company_id = $1 AND id = $2';

const SELECT_RUN = `SELECT ${RUN_COLUMNS} FROM workforce_runs WHERE company_id = $1 AND id = $2`;

const SELECT_RUNS = `SELECT ${RUN_COLUMNS} FROM workforce_runs WHERE company_id = $1 ORDER BY created_at, id`;

const INSERT_AUDIT = `INSERT INTO workforce_audit_events (id, company_id, run_id, kind, actor, outcome, data, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

const SELECT_AUDIT = `SELECT ${AUDIT_COLUMNS} FROM workforce_audit_events WHERE company_id = $1 ORDER BY seq`;

const SELECT_AUDIT_FOR_RUN = `SELECT ${AUDIT_COLUMNS} FROM workforce_audit_events WHERE company_id = $1 AND run_id = $2 ORDER BY seq`;

function jsonParam(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function parseJson<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function toIso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return date.toISOString();
}

function assertTimestamp(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value))) throw new Error(`${field} must be an ISO timestamp`);
}

function assertSameCompany(run: RunRecord, scoped: CompanyId): void {
  if (run.companyId !== scoped) throw new Error('run companyId does not match the store call');
}

function toRun(row: Record<string, unknown>, companyId: CompanyId): RunRecord {
  const pending = row.pending_approval;
  return {
    id: String(row.id),
    companyId,
    status: row.status as RunStatus,
    version: Number(row.version),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    team: parseJson<Team>(row.team),
    path: parseJson<string[]>(row.path),
    delegations: parseJson<Delegation[]>(row.delegations),
    limits: parseJson<TeamLimits>(row.limits),
    budget: {
      maxTokens: Number(row.budget_max_tokens),
      maxToolCalls: Number(row.budget_max_tool_calls),
      tokensUsed: Number(row.budget_tokens_used),
      toolCalls: Number(row.budget_tool_calls),
    } as RunBudget,
    retry: parseJson<RetryPolicy>(row.retry),
    pendingApproval: pending === null || pending === undefined ? null : parseJson<PendingApproval>(pending),
    reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
  };
}

function toAudit(row: Record<string, unknown>, companyId: CompanyId): AuditEvent {
  return {
    id: String(row.id),
    companyId,
    runId: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
    kind: row.kind as AuditEvent['kind'],
    at: toIso(row.created_at),
    data: parseJson<Record<string, unknown>>(row.data),
  };
}

/** Mutable run fields, in the order UPDATE_RUN expects them at $4..$15. */
function mutableParams(run: RunRecord): unknown[] {
  return [
    run.status,
    jsonParam(run.team),
    jsonParam(run.path),
    jsonParam(run.delegations),
    jsonParam(run.limits),
    run.budget.maxTokens,
    run.budget.maxToolCalls,
    run.budget.tokensUsed,
    run.budget.toolCalls,
    jsonParam(run.retry),
    jsonParam(run.pendingApproval),
    run.reason,
  ];
}

export function createPgRunStore(db: SqlExecutor): RunStore {
  return {
    async insertRun(companyId, run) {
      const scoped = requireCompanyId(companyId);
      assertSameCompany(run, scoped);
      assertTimestamp(run.createdAt, 'createdAt');
      assertTimestamp(run.updatedAt, 'updatedAt');
      const result = await db.query(INSERT_RUN, [
        run.id,
        scoped,
        run.status,
        jsonParam(run.team),
        jsonParam(run.path),
        jsonParam(run.delegations),
        jsonParam(run.limits),
        run.budget.maxTokens,
        run.budget.maxToolCalls,
        run.budget.tokensUsed,
        run.budget.toolCalls,
        jsonParam(run.retry),
        jsonParam(run.pendingApproval),
        run.reason,
        run.createdAt,
        run.updatedAt,
      ]);
      const row = result.rows[0];
      // ON CONFLICT DO NOTHING returns no row when the id already exists.
      if (!row) throw new Error(`run already exists: ${run.id}`);
      return toRun(row, scoped);
    },

    async updateRun(companyId, run, expectedVersion) {
      const scoped = requireCompanyId(companyId);
      assertSameCompany(run, scoped);
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
        throw new Error('expectedVersion must be a positive integer');
      }
      assertTimestamp(run.updatedAt, 'updatedAt');
      const result = await db.query(UPDATE_RUN, [scoped, run.id, expectedVersion, ...mutableParams(run), run.updatedAt]);
      if (result.rowCount === 1 && result.rows[0]) return toRun(result.rows[0], scoped);

      // No row changed. Either the run is not in this company, or another writer moved the version on.
      const current = await db.query(SELECT_RUN_VERSION, [scoped, run.id]);
      if (current.rows.length === 0) throw new Error(`run not found: ${run.id}`);
      throw new RunVersionConflictError(run.id);
    },

    async getRun(companyId, runId) {
      const scoped = requireCompanyId(companyId);
      const result = await db.query(SELECT_RUN, [scoped, runId]);
      const row = result.rows[0];
      return row ? toRun(row, scoped) : null;
    },

    async listRuns(companyId) {
      const scoped = requireCompanyId(companyId);
      const result = await db.query(SELECT_RUNS, [scoped]);
      return result.rows.map((row) => toRun(row, scoped));
    },

    async appendAudit(event) {
      if (event.companyId === null || event.companyId === undefined) {
        // The table's company_id is NOT NULL. A refusal with no valid company cannot be stored, so say so.
        throw new Error('audit event has no companyId and cannot be stored: workforce_audit_events.company_id is NOT NULL');
      }
      const scoped = requireCompanyId(event.companyId);
      if (!(AUDIT_KINDS as readonly string[]).includes(event.kind)) throw new Error(`unknown audit kind: ${event.kind}`);
      assertTimestamp(event.at, 'at');
      // Detail is redacted before storage (secrets, emails, card numbers). redactForAudit returns a copy,
      // so the caller's event is not mutated. The fixed fields (company, run, kind, outcome, timestamps) are not redacted.
      const raw = event.data ?? {};
      const data = redactForAudit(raw);
      // Actor is lifted from the redacted data. Outcome is a fixed field and is lifted from the raw data.
      const actor = typeof data.actorId === 'string' ? data.actorId : null;
      const outcome = typeof raw.outcome === 'string' ? raw.outcome : null;
      const result = await db.query(INSERT_AUDIT, [
        event.id,
        scoped,
        event.runId,
        event.kind,
        actor,
        outcome,
        JSON.stringify(data),
        event.at,
      ]);
      if (result.rowCount !== 1) throw new Error(`audit event was not stored: ${event.id}`);
    },

    async listAudit(companyId, runId) {
      const scoped = requireCompanyId(companyId);
      const result = runId === undefined
        ? await db.query(SELECT_AUDIT, [scoped])
        : await db.query(SELECT_AUDIT_FOR_RUN, [scoped, runId]);
      return result.rows.map((row) => toAudit(row, scoped));
    },
  };
}

/**
 * Postgres adapter for shadow changes (docs/SHADOW_WRITES_DESIGN.md, migrations/DRAFT_shadow_changes.sql).
 *
 * Pure: no driver import. Every query goes through the injected SqlExecutor, and values are bound as $1, $2, ...
 * - createPgShadowStore(db): a ShadowStore for shadow-changes.ts. Pass a pool or client.
 * - createPgShadowApply(db, options): the apply function for createShadowChanges. It runs BEGIN, SELECT ... FOR
 *   UPDATE on the target row, compares its version to base_version, writes, and COMMITs. Any error, or a
 *   version mismatch, ROLLBACKs. Pass a single client (one connection), not a pool, so that BEGIN, the check,
 *   the write and COMMIT all run on the same connection.
 * - retryApprovedChange(...): re-applies a change left at 'approved' after an apply error. Only an explicit
 *   call runs it. It never runs on its own.
 *
 * Target table names cannot be bound as parameters, so they must be on the allowlist passed to
 * createPgShadowApply. Column names come from the stored JSON and must match a strict identifier pattern.
 */

import type { SqlExecutor, SqlResult } from './pg-store.ts'
import type { ShadowChange, ShadowStatus, ShadowStore } from './shadow-changes.ts'

const TABLE = 'shadow_changes'
/** Upper bound on one pending list, so a large backlog cannot load unbounded rows. */
export const PENDING_LIST_LIMIT = 200

const COLUMNS = [
  'id',
  'company_id',
  'run_id',
  'tool_id',
  'category',
  'target_table',
  'target_id',
  'operation',
  'before_json',
  'after_json',
  'base_version',
  'requested_by_agent_id',
  'requested_by_role_id',
  'policy_version',
  'status',
  'approved_by_kind',
  'approved_by_id',
  'created_at',
  'decided_at',
  'applied_at',
] as const

/** Patch keys the store may update, mapped to their columns. Anything else is refused. */
const PATCH_COLUMNS: Readonly<Record<string, string>> = {
  status: 'status',
  decidedAt: 'decided_at',
  appliedAt: 'applied_at',
  approvedByKind: 'approved_by_kind',
  approvedById: 'approved_by_id',
}

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/
/** Columns the adapter sets itself, so stored JSON cannot override them. */
const RESERVED_COLUMNS: ReadonlySet<string> = new Set(['id', 'company_id', 'version'])

export interface PgApplyOptions {
  /** Tables an approved change may write to. A change naming any other table is refused. */
  targetTables: readonly string[]
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

function assertIdentifier(name: string, what: string): void {
  if (!IDENTIFIER.test(name)) throw new Error(`invalid ${what}: ${name}`)
}

function toMillis(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  const parsed = Date.parse(String(value))
  return Number.isNaN(parsed) ? undefined : parsed
}

function jsonOrNull(value: Record<string, unknown> | null): string | null {
  return value === null ? null : JSON.stringify(value)
}

function fromRow(row: Record<string, unknown>): ShadowChange {
  const change: ShadowChange = {
    id: String(row.id),
    companyId: String(row.company_id),
    runId: String(row.run_id ?? ''),
    toolId: String(row.tool_id),
    category: row.category as ShadowChange['category'],
    targetTable: String(row.target_table),
    targetId: String(row.target_id ?? ''),
    operation: row.operation as ShadowChange['operation'],
    before: (row.before_json ?? null) as Record<string, unknown> | null,
    after: (row.after_json ?? null) as Record<string, unknown> | null,
    baseVersion: Number(row.base_version ?? 0),
    requestedBy: {
      agentId: String(row.requested_by_agent_id ?? ''),
      roleId: String(row.requested_by_role_id ?? ''),
    },
    policyVersion: Number(row.policy_version ?? 0),
    status: row.status as ShadowStatus,
    createdAt: toMillis(row.created_at) ?? 0,
  }
  if (row.approved_by_kind) change.approvedByKind = row.approved_by_kind as 'human' | 'agent'
  if (row.approved_by_id) change.approvedById = String(row.approved_by_id)
  const decidedAt = toMillis(row.decided_at)
  if (decidedAt !== undefined) change.decidedAt = decidedAt
  const appliedAt = toMillis(row.applied_at)
  if (appliedAt !== undefined) change.appliedAt = appliedAt
  return change
}

const SELECT_COLUMNS = COLUMNS.join(', ')

/** A ShadowStore backed by the shadow_changes table. Every query filters on company_id. */
export function createPgShadowStore(db: SqlExecutor): ShadowStore {
  return {
    async insert(change: ShadowChange): Promise<void> {
      await db.query(
        `INSERT INTO ${TABLE} (${SELECT_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
        [
          change.id,
          change.companyId,
          change.runId,
          change.toolId,
          change.category,
          change.targetTable,
          change.targetId,
          change.operation,
          jsonOrNull(change.before),
          jsonOrNull(change.after),
          change.baseVersion,
          change.requestedBy.agentId,
          change.requestedBy.roleId,
          String(change.policyVersion),
          change.status,
          change.approvedByKind ?? null,
          change.approvedById ?? null,
          new Date(change.createdAt).toISOString(),
          change.decidedAt === undefined ? null : new Date(change.decidedAt).toISOString(),
          change.appliedAt === undefined ? null : new Date(change.appliedAt).toISOString(),
        ],
      )
    },

    async get(companyId: string, id: string): Promise<ShadowChange | null> {
      const result: SqlResult = await db.query(
        `SELECT ${SELECT_COLUMNS} FROM ${TABLE} WHERE company_id = $1 AND id = $2`,
        [companyId, id],
      )
      return result.rows.length === 0 ? null : fromRow(result.rows[0])
    },

    async listPending(companyId: string): Promise<ShadowChange[]> {
      const result: SqlResult = await db.query(
        `SELECT ${SELECT_COLUMNS} FROM ${TABLE} WHERE company_id = $1 AND status = $2 ORDER BY created_at ASC LIMIT $3`,
        [companyId, 'pending', PENDING_LIST_LIMIT],
      )
      return result.rows.map(fromRow)
    },

    async transition(companyId, id, from, patch): Promise<boolean> {
      const sets: string[] = []
      const values: unknown[] = [companyId, id, from]
      for (const [key, value] of Object.entries(patch)) {
        const column = PATCH_COLUMNS[key]
        if (!column) throw new Error(`shadow store: cannot update ${key}`)
        const isTimestamp = key === 'decidedAt' || key === 'appliedAt'
        values.push(isTimestamp && typeof value === 'number' ? new Date(value).toISOString() : value)
        sets.push(`${column} = $${values.length}`)
      }
      if (sets.length === 0) throw new Error('shadow store: empty patch')
      const result = await db.query(
        `UPDATE ${TABLE} SET ${sets.join(', ')} WHERE company_id = $1 AND id = $2 AND status = $3`,
        values,
      )
      return result.rowCount === 1
    },
  }
}

/**
 * Builds the apply function for createShadowChanges. It ignores the baseVersionMatches argument, which reads
 * outside this transaction, and runs its own check on the same connection, inside BEGIN ... COMMIT.
 */
export function createPgShadowApply(db: SqlExecutor, options: PgApplyOptions) {
  const allowed = new Set(options.targetTables)
  for (const table of allowed) assertIdentifier(table, 'target table')

  return async function applyShadowChange(change: ShadowChange): Promise<'applied' | 'conflict'> {
    if (!allowed.has(change.targetTable)) throw new Error(`target table not allowed: ${change.targetTable}`)
    const table = change.targetTable

    await db.query('BEGIN', [])
    try {
      const current = await db.query(
        `SELECT version FROM ${table} WHERE company_id = $1 AND id = $2 FOR UPDATE`,
        [change.companyId, change.targetId],
      )
      // An absent target counts as version 0, the same rule as shadow-changes.ts.
      const version = current.rows.length === 0 ? 0 : Number(current.rows[0].version)
      if (version !== change.baseVersion) {
        await db.query('ROLLBACK', [])
        return 'conflict'
      }
      await writeTarget(db, change)
      await db.query('COMMIT', [])
      return 'applied'
    } catch (error) {
      try {
        await db.query('ROLLBACK', [])
      } catch {
        // The original error is the one worth reporting.
      }
      throw error
    }
  }
}

async function writeTarget(db: SqlExecutor, change: ShadowChange): Promise<void> {
  const table = change.targetTable
  const scope = [change.companyId, change.targetId]

  if (change.operation === 'delete') {
    const result = await db.query(`DELETE FROM ${table} WHERE company_id = $1 AND id = $2`, scope)
    if (result.rowCount !== 1) throw new Error(`delete target missing: ${table}/${change.targetId}`)
    return
  }

  const columns = Object.keys(change.after ?? {}).filter((key) => !RESERVED_COLUMNS.has(key))
  for (const column of columns) assertIdentifier(column, 'column')
  const values = columns.map((column) => {
    const value = (change.after as Record<string, unknown>)[column]
    return value !== null && typeof value === 'object' ? JSON.stringify(value) : value
  })

  if (change.operation === 'insert') {
    const names = ['company_id', 'id', 'version', ...columns]
    const params = [change.companyId, change.targetId, change.baseVersion + 1, ...values]
    const placeholders = params.map((_, index) => `$${index + 1}`).join(', ')
    await db.query(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${placeholders})`, params)
    return
  }

  // update: bump the version so that any later base_version check fails.
  const sets = columns.map((column, index) => `${column} = $${index + 3}`)
  sets.push('version = version + 1')
  const result = await db.query(
    `UPDATE ${table} SET ${sets.join(', ')} WHERE company_id = $1 AND id = $2`,
    [...scope, ...values],
  )
  if (result.rowCount !== 1) throw new Error(`update target missing: ${table}/${change.targetId}`)
}

export type RetryResult =
  | { ok: true; status: 'applied' }
  | { ok: false; reason: 'not_found' | 'not_approved' | 'conflict' }

export interface RetryDeps {
  store: ShadowStore
  apply: (change: ShadowChange) => Promise<'applied' | 'conflict'>
  now: () => number
}

/**
 * Re-applies a change that is still at 'approved' because an earlier apply threw. Runs only when called.
 * If apply throws again, the error propagates and the row stays 'approved'.
 */
export async function retryApprovedChange(deps: RetryDeps, companyId: string, id: string): Promise<RetryResult> {
  if (!isText(companyId) || !isText(id)) return { ok: false, reason: 'not_found' }
  const change = await deps.store.get(companyId, id)
  if (!change) return { ok: false, reason: 'not_found' }
  if (change.status !== 'approved') return { ok: false, reason: 'not_approved' }

  const outcome = await deps.apply(change)
  if (outcome === 'applied') {
    const moved = await deps.store.transition(companyId, id, 'approved', { status: 'applied', appliedAt: deps.now() })
    return moved ? { ok: true, status: 'applied' } : { ok: false, reason: 'not_approved' }
  }
  await deps.store.transition(companyId, id, 'approved', { status: 'conflict' })
  return { ok: false, reason: 'conflict' }
}

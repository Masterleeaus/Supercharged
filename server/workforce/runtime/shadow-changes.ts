/**
 * Shadow writes (docs/SHADOW_WRITES_DESIGN.md).
 *
 * An agent's write is recorded as a pending shadow change. Nothing is applied until an approver decides.
 * - request(): stores a pending change. It never calls apply.
 * - decide(): an approver approves or rejects a pending change.
 *   - Approval rules by category. money, customer_send and delete: owner, admin or manager only. other: owner,
 *     admin or manager, or a second agent whose agentId AND roleId both differ from the requester.
 *   - Approval first moves the row pending -> approved (compare-and-set), then calls the injected apply.
 *     apply receives the change and a base-version check. The check is true when the target's current version
 *     equals baseVersion (an absent target counts as version 0). apply must call the check inside its own
 *     transaction and return 'conflict' when it is false. The module also checks once before apply, so a
 *     conflicted change is never handed to apply.
 *   - A rejected or conflicted change is never applied. It stays in the store for review.
 * - Every read and write is scoped by companyId. A change from another company is reported as not_found.
 *
 * Pure: no database driver, no network. Store, clock, id source, version reader and apply are injected.
 * Status flow: pending -> rejected | approved -> applied | conflict. An apply that throws leaves the row at
 * 'approved' (not applied). retry() re-applies such a row, with the same approver rules as decide().
 */

import { randomUUID } from 'node:crypto'

export const POLICY_VERSION = 1

export const SHADOW_CATEGORIES = ['money', 'customer_send', 'delete', 'other'] as const
export type ShadowCategory = (typeof SHADOW_CATEGORIES)[number]

export const SHADOW_OPERATIONS = ['insert', 'update', 'delete'] as const
export type ShadowOperation = (typeof SHADOW_OPERATIONS)[number]

export type ShadowStatus = 'pending' | 'approved' | 'rejected' | 'applied' | 'conflict'

/** Human roles that may decide any category. Admin is included so the route guard and the service rule agree. */
export const APPROVER_ROLES = ['owner', 'admin', 'manager'] as const
const MANAGER_ROLES: ReadonlySet<string> = new Set<string>(APPROVER_ROLES)

export interface Requester {
  agentId: string
  roleId: string
}

export type Approver =
  | { kind: 'human'; id: string; role: string }
  | { kind: 'agent'; agentId: string; roleId: string }

export interface ShadowChange {
  id: string
  companyId: string
  runId: string
  toolId: string
  category: ShadowCategory
  targetTable: string
  targetId: string
  operation: ShadowOperation
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  baseVersion: number
  requestedBy: Requester
  policyVersion: number
  status: ShadowStatus
  approvedByKind?: 'human' | 'agent'
  approvedById?: string
  createdAt: number
  decidedAt?: number
  appliedAt?: number
}

export interface ShadowChangeInput {
  companyId: string
  runId: string
  toolId: string
  category: ShadowCategory
  targetTable: string
  targetId: string
  operation: ShadowOperation
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  baseVersion: number
  requestedBy: Requester
}

export interface ShadowStore {
  insert(change: ShadowChange): Promise<void>
  get(companyId: string, id: string): Promise<ShadowChange | null>
  /** Pending changes for one company, oldest first. Never returns another company's rows. */
  listPending(companyId: string): Promise<ShadowChange[]>
  /** Compare-and-set on status. Returns false, and changes nothing, if the stored status is not `from`. */
  transition(
    companyId: string,
    id: string,
    from: ShadowStatus,
    patch: Partial<ShadowChange> & { status: ShadowStatus },
  ): Promise<boolean>
}

export type BaseVersionCheck = () => Promise<boolean>

export interface ShadowDeps {
  store: ShadowStore
  now: () => number
  newId?: () => string
  /** Current version of the target row, or null when the row is absent. */
  readVersion: (companyId: string, table: string, id: string) => Promise<number | null>
  /** Applies an approved change. Must call the check inside its transaction; returns 'conflict' if it is false. */
  apply: (change: ShadowChange, baseVersionMatches: BaseVersionCheck) => Promise<'applied' | 'conflict'>
  /**
   * Whether an approved change may be applied to this target table. Checked before any status moves, so a
   * refused table leaves the change pending. Absent means every table is allowed (tests only; production
   * always passes it).
   */
  canApply?: (targetTable: string) => boolean
}

export type RequestResult =
  | { ok: true; change: ShadowChange }
  | { ok: false; reason: 'invalid'; detail: string }

export type DecideResult =
  | { ok: true; status: 'applied' | 'rejected' }
  | { ok: false; reason: 'not_found' | 'not_pending' | 'not_permitted' | 'conflict' | 'invalid' }

/** Retry uses the same reasons as decide. A retry is refused unless the change is still at approved. */
export type RetryResult = DecideResult

/** Whether this approver may decide a change of this category. Pure. */
export function mayDecide(category: ShadowCategory, requester: Requester, approver: Approver): boolean {
  if (approver.kind === 'human') return MANAGER_ROLES.has(approver.role)
  if (approver.kind === 'agent') {
    if (category !== 'other') return false
    return approver.agentId !== requester.agentId && approver.roleId !== requester.roleId
  }
  return false
}

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 200

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Returns an error message, or null when the input is a valid shadow change request. */
export function validateInput(input: ShadowChangeInput): string | null {
  if (!isText(input.companyId)) return 'companyId'
  if (!isText(input.runId)) return 'runId'
  if (!isText(input.toolId)) return 'toolId'
  if (!isText(input.targetTable)) return 'targetTable'
  if (!isText(input.targetId)) return 'targetId'
  if (!SHADOW_CATEGORIES.includes(input.category)) return 'category'
  if (!SHADOW_OPERATIONS.includes(input.operation)) return 'operation'
  if (!Number.isInteger(input.baseVersion) || input.baseVersion < 0) return 'baseVersion'
  if (!input.requestedBy || !isText(input.requestedBy.agentId) || !isText(input.requestedBy.roleId)) {
    return 'requestedBy'
  }
  const { operation, before, after } = input
  if (operation === 'insert' && !(before === null && isObject(after))) return 'insert values'
  if (operation === 'update' && !(isObject(before) && isObject(after))) return 'update values'
  if (operation === 'delete' && !(isObject(before) && after === null)) return 'delete values'
  return null
}

const copy = <T>(value: T): T => (value === null || value === undefined ? value : JSON.parse(JSON.stringify(value)))

const approverId = (approver: Approver): string => (approver.kind === 'human' ? approver.id : approver.agentId)

export function createShadowChanges(deps: ShadowDeps) {
  const newId = deps.newId ?? randomUUID

  async function request(input: ShadowChangeInput): Promise<RequestResult> {
    const problem = validateInput(input)
    if (problem) return { ok: false, reason: 'invalid', detail: problem }
    const change: ShadowChange = {
      id: newId(),
      companyId: input.companyId,
      runId: input.runId,
      toolId: input.toolId,
      category: input.category,
      targetTable: input.targetTable,
      targetId: input.targetId,
      operation: input.operation,
      before: copy(input.before),
      after: copy(input.after),
      baseVersion: input.baseVersion,
      requestedBy: { agentId: input.requestedBy.agentId, roleId: input.requestedBy.roleId },
      policyVersion: POLICY_VERSION,
      status: 'pending',
      createdAt: deps.now(),
    }
    await deps.store.insert(change)
    return { ok: true, change: copy(change) }
  }

  async function get(companyId: string, id: string): Promise<ShadowChange | null> {
    if (!isText(companyId) || !isText(id)) return null
    const found = await deps.store.get(companyId, id)
    return found ? copy(found) : null
  }

  async function decide(
    companyId: string,
    id: string,
    approver: Approver,
    decision: 'approve' | 'reject',
  ): Promise<DecideResult> {
    if (!isText(companyId) || !isText(id)) return { ok: false, reason: 'not_found' }
    if (decision !== 'approve' && decision !== 'reject') return { ok: false, reason: 'invalid' }
    if (!approver || (approver.kind !== 'human' && approver.kind !== 'agent') || !isText(approverId(approver))) {
      return { ok: false, reason: 'not_permitted' }
    }

    const change = await deps.store.get(companyId, id)
    if (!change) return { ok: false, reason: 'not_found' }
    if (change.status !== 'pending') return { ok: false, reason: 'not_pending' }
    if (!mayDecide(change.category, change.requestedBy, approver)) return { ok: false, reason: 'not_permitted' }

    const decidedAt = deps.now()
    const by = { approvedByKind: approver.kind, approvedById: approverId(approver) } as const

    if (decision === 'reject') {
      const moved = await deps.store.transition(companyId, id, 'pending', {
        status: 'rejected',
        decidedAt,
        ...by,
      })
      return moved ? { ok: true, status: 'rejected' } : { ok: false, reason: 'not_pending' }
    }

    if (!canApplyTable(change.targetTable)) return { ok: false, reason: 'invalid' }

    const approved = await deps.store.transition(companyId, id, 'pending', {
      status: 'approved',
      decidedAt,
      ...by,
    })
    if (!approved) return { ok: false, reason: 'not_pending' }

    const outcome = await runApply(companyId, id, { ...change, status: 'approved', decidedAt, ...by })
    return outcome === 'applied' ? { ok: true, status: 'applied' } : { ok: false, reason: 'conflict' }
  }

  function canApplyTable(table: string): boolean {
    return deps.canApply ? deps.canApply(table) : true
  }

  /**
   * The base-version check, then apply, then the final status. Shared by decide and retry.
   * An apply that throws propagates, and the row stays at 'approved' for retry.
   */
  async function runApply(companyId: string, id: string, change: ShadowChange): Promise<'applied' | 'conflict'> {
    const baseVersionMatches: BaseVersionCheck = async () =>
      ((await deps.readVersion(companyId, change.targetTable, change.targetId)) ?? 0) === change.baseVersion

    if (!(await baseVersionMatches())) {
      await deps.store.transition(companyId, id, 'approved', { status: 'conflict' })
      return 'conflict'
    }

    const outcome = await deps.apply(copy(change), baseVersionMatches)
    if (outcome === 'applied') {
      await deps.store.transition(companyId, id, 'approved', { status: 'applied', appliedAt: deps.now() })
      return 'applied'
    }
    await deps.store.transition(companyId, id, 'approved', { status: 'conflict' })
    return 'conflict'
  }

  /** Pending changes for one company. An invalid company id returns none. */
  async function listPending(companyId: string): Promise<ShadowChange[]> {
    if (!isText(companyId)) return []
    const rows = await deps.store.listPending(companyId)
    return rows.filter((c) => c.companyId === companyId && c.status === 'pending').map((c) => copy(c))
  }

  /**
   * Re-applies a change left at 'approved' because an earlier apply threw. Runs only when called, with the same
   * approver rules as decide. The first approver's record is kept. A retry that throws again leaves the row at
   * 'approved'.
   */
  async function retry(companyId: string, id: string, approver: Approver): Promise<RetryResult> {
    if (!isText(companyId) || !isText(id)) return { ok: false, reason: 'not_found' }
    if (!approver || (approver.kind !== 'human' && approver.kind !== 'agent') || !isText(approverId(approver))) {
      return { ok: false, reason: 'not_permitted' }
    }
    const change = await deps.store.get(companyId, id)
    if (!change) return { ok: false, reason: 'not_found' }
    if (change.status !== 'approved') return { ok: false, reason: 'not_pending' }
    if (!mayDecide(change.category, change.requestedBy, approver)) return { ok: false, reason: 'not_permitted' }
    if (!canApplyTable(change.targetTable)) return { ok: false, reason: 'invalid' }

    const outcome = await runApply(companyId, id, change)
    return outcome === 'applied' ? { ok: true, status: 'applied' } : { ok: false, reason: 'conflict' }
  }

  return { request, get, decide, listPending, retry }
}

/** In-memory store for tests and local use. Keys include companyId, so one company never sees another's rows. */
export function createMemoryShadowStore(): ShadowStore & { size(): number } {
  const rows = new Map<string, ShadowChange>()
  const key = (companyId: string, id: string) => `${companyId}\u0000${id}`
  return {
    size: () => rows.size,
    async insert(change) {
      rows.set(key(change.companyId, change.id), copy(change))
    },
    async get(companyId, id) {
      const row = rows.get(key(companyId, id))
      return row ? copy(row) : null
    },
    async listPending(companyId) {
      const out: ShadowChange[] = []
      for (const row of rows.values()) {
        if (row.companyId === companyId && row.status === 'pending') out.push(copy(row))
      }
      return out.sort((a, b) => a.createdAt - b.createdAt)
    },
    async transition(companyId, id, from, patch) {
      const row = rows.get(key(companyId, id))
      if (!row || row.status !== from) return false
      rows.set(key(companyId, id), { ...copy(row), ...copy(patch) })
      return true
    },
  }
}

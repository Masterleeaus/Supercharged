/**
 * Predictive staging (owner decision: predictive work may only STAGE actions).
 *
 * A predictive agent never writes directly. Each write it wants to make is recorded as a pending shadow
 * change through shadow-changes.ts. Nothing is applied here. A staged change still needs an Auto-tier run
 * or a verified approval (shadow-changes decide()) before it runs. Policy rules are in
 * server/modules/approvals/policy-evaluator.ts (PREDICTIVE_PERMISSIONS).
 *
 * - stagePredictiveAction(): records a pending change. It never calls apply and never calls decide.
 * - refusePredictiveDirectWrite(): refuses any predictive write that did not go through staging.
 *   Reads are not refused.
 *
 * Pure: no database driver, no network. The shadow service is injected.
 */

import type { ShadowCategory, ShadowChange, ShadowOperation, RequestResult } from './shadow-changes.ts'

/** The subset of the shadow service this module uses. */
export interface PredictiveShadow {
  request: (input: {
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
    requestedBy: { agentId: string; roleId: string }
  }) => Promise<RequestResult>
}

export interface PredictiveStageParams {
  runId: string
  targetTable: string
  targetId: string
  operation: ShadowOperation
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  baseVersion: number
}

export interface PredictiveStageInput {
  companyId: string
  agentId: string
  roleId: string
  toolId: string
  params: PredictiveStageParams
  category: ShadowCategory
}

export type StageResult =
  | { ok: true; staged: true; change: ShadowChange }
  | { ok: false; reason: 'invalid'; detail: string }

/**
 * Record a predictive write as a pending shadow change. Never applies it.
 * Returns the pending change, or an invalid result when the input fails shadow validation.
 */
export async function stagePredictiveAction(
  deps: { shadow: PredictiveShadow },
  input: PredictiveStageInput,
): Promise<StageResult> {
  const params = input.params
  if (!params || typeof params !== 'object') return { ok: false, reason: 'invalid', detail: 'params' }

  const result = await deps.shadow.request({
    companyId: input.companyId,
    runId: params.runId,
    toolId: input.toolId,
    category: input.category,
    targetTable: params.targetTable,
    targetId: params.targetId,
    operation: params.operation,
    before: params.before,
    after: params.after,
    baseVersion: params.baseVersion,
    requestedBy: { agentId: input.agentId, roleId: input.roleId },
  })

  if (!result.ok) return { ok: false, reason: 'invalid', detail: result.detail }
  return { ok: true, staged: true, change: result.change }
}

export type PredictiveWriteGate =
  | { allowed: true }
  | { allowed: false; reason: 'direct_write_refused'; detail: string }

/**
 * Gate for a predictive action that is not staged. Reads pass. Any write is refused,
 * and the caller must use stagePredictiveAction instead. Pure.
 */
export function refusePredictiveDirectWrite(access: unknown): PredictiveWriteGate {
  if (access === 'read') return { allowed: true }
  return {
    allowed: false,
    reason: 'direct_write_refused',
    detail: 'predictive agents may only stage writes; use stagePredictiveAction',
  }
}

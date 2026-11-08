/**
 * Recovery pass for runs left in status 'running' after a crash. Each such run is moved to 'failed', the
 * visible terminal state that the run machine (run.ts) allows from 'running' and that marks the run as not
 * finished. The reason says it was interrupted and needs review. The run is never resumed, and no tool runs.
 *
 * Why 'failed': 'completed' would report a result that never existed. 'cancelled' implies a human stop.
 * 'budget_exhausted' implies a cap was hit. 'awaiting_approval' needs a pending approval the run does not have.
 *
 * Idempotent: a second pass finds no run in 'running' and writes nothing. Scoped to one company.
 * Does not import the database. The store and audit sink are injected.
 */
import type { CompanyId } from '../../services/ai-runtime/types.ts';
import { tryCompanyId } from '../../services/ai-runtime/company.ts';
import { canTransition, type RunRecord } from './run.ts';
import { RunVersionConflictError, type AuditSink, type RunStore } from './store.ts';

export const INTERRUPTED_RUN_REASON = 'interrupted: left in running after a crash; not resumed; needs review';

export interface RecoveryDeps {
  store: RunStore;
  /** Receives the run.status audit event. Use the same sink the run engine uses. */
  audit: AuditSink;
  now: () => Date;
  /** Test seam. Defaults to crypto.randomUUID. */
  newId?: () => string;
}

export interface RecoveryResult {
  /** Ids of the runs this pass moved out of 'running'. Empty on a second pass. */
  recovered: string[];
  /** Ids of runs skipped because another writer changed them first. A later pass picks them up if still running. */
  skipped: string[];
}

export async function recoverInterruptedRuns(deps: RecoveryDeps, companyId: CompanyId | string): Promise<RecoveryResult> {
  const scoped = tryCompanyId(companyId);
  if (scoped === null) throw new Error('recoverInterruptedRuns needs a valid companyId');
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const result: RecoveryResult = { recovered: [], skipped: [] };

  const runs = await deps.store.listRuns(scoped);
  for (const run of runs) {
    if (run.status !== 'running') continue;
    if (!canTransition('running', 'failed')) throw new Error('run machine no longer allows running -> failed');

    const at = deps.now().toISOString();
    const patch: RunRecord = { ...run, status: 'failed', reason: INTERRUPTED_RUN_REASON, updatedAt: at };
    try {
      const saved = await deps.store.updateRun(scoped, patch, run.version);
      await deps.audit.record({
        id: newId(),
        companyId: scoped,
        runId: saved.id,
        kind: 'run.status',
        at,
        data: { from: 'running', to: 'failed', reason: INTERRUPTED_RUN_REASON },
      });
      result.recovered.push(saved.id);
    } catch (err) {
      if (err instanceof RunVersionConflictError) {
        result.skipped.push(run.id);
        continue;
      }
      throw err;
    }
  }
  return result;
}

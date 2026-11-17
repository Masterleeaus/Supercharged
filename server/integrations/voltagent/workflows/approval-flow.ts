/**
 * Approval waits as suspend and resume (Phase 1, W2, issue #376).
 *
 * A workflow step runs one workforce tool through the agent bridge. When the engine answers
 * awaiting_approval, the step is suspended: its state is saved with the approval id and nothing runs.
 * On resume, the approval is read from the gate. Only an approved, unexecuted approval resumes, and
 * the engine's resumeAfterApproval runs the tool. Each suspended step can resume once.
 *
 * Fail closed:
 * - Any state other than 'suspended' refuses resume, so a completed or rejected step never runs again.
 * - The state store uses a version check. Two resumes of the same step race, and only one wins.
 * - A pending approval keeps the step suspended. No engine call is made.
 *
 * Not wired anywhere. The pilot covers approval waits only. The flow-automation pilot is not in this change.
 *
 * Licence: original TitanZero code. It copies no Mastra or VoltAgent source. See source/mastra-apache-only/README.md.
 * The VoltAgent suspend/resume names are not verified against an installed @voltagent/core, because
 * node_modules/@voltagent is empty in this checkout.
 */
import type { CompanyId } from '../../../services/ai-runtime/types.ts';
import { requireCompanyId } from '../../../services/ai-runtime/company.ts';
import type { ApprovalRecord } from '../../../workforce/runtime/tool-registry.ts';
import type { BridgeActor, BridgeOutcome, VoltAgentToolLike } from '../agents/bridge.ts';

export type StepStatus = 'suspended' | 'completed' | 'rejected' | 'expired' | 'failed';

export interface SuspendedStep {
  key: string;
  companyId: string;
  runId: string;
  toolId: string;
  params: Record<string, unknown>;
  actor: BridgeActor;
  approvalId: string | null;
  status: StepStatus;
  version: number;
}

export interface StepStateStore {
  get(key: string): Promise<SuspendedStep | null>;
  /** Writes next only when the stored version is expectedVersion. Returns false on a version conflict. */
  compareAndSet(key: string, expectedVersion: number, next: SuspendedStep): Promise<boolean>;
}

export interface ApprovalReader {
  readApproval(companyId: CompanyId, approvalId: string): Promise<ApprovalRecord | null>;
}

export interface ResumeEngine {
  resumeAfterApproval(
    companyId: unknown,
    runId: string,
    call: { toolId: string; params?: Record<string, unknown>; actor: unknown },
  ): Promise<{ ok: boolean; reason?: string; tool: null | { outcome: string; output?: Record<string, unknown>; truncated?: boolean } }>;
}

export type StepResult =
  | { status: 'completed'; output: Record<string, unknown> }
  | { status: 'suspended'; approvalId: string }
  | { status: 'refused'; reason: string }
  | { status: 'failed'; reason: string };

/** Runs a step. A bridge tool that answers awaiting_approval becomes a saved suspended step. */
export async function runStep(options: {
  tool: VoltAgentToolLike;
  key: string;
  store: StepStateStore;
  companyId: unknown;
  runId: string;
  toolId: string;
  params: Record<string, unknown>;
  actor: BridgeActor;
}): Promise<StepResult> {
  const companyId = requireCompanyId(options.companyId);
  const existing = await options.store.get(options.key);
  if (existing) return { status: 'refused', reason: `step_already_${existing.status}` };

  const outcome: BridgeOutcome = await options.tool.execute(options.params);
  if (outcome.status === 'executed') return { status: 'completed', output: outcome.output };
  if (outcome.status === 'awaiting_approval') {
    const saved = await options.store.compareAndSet(options.key, 0, {
      key: options.key,
      companyId,
      runId: options.runId,
      toolId: options.toolId,
      params: options.params,
      actor: options.actor,
      approvalId: outcome.approvalId,
      status: 'suspended',
      version: 1,
    });
    if (!saved) return { status: 'refused', reason: 'step_state_conflict' };
    return { status: 'suspended', approvalId: outcome.approvalId };
  }
  if (outcome.status === 'refused') return { status: 'refused', reason: outcome.reason };
  if (outcome.status === 'failed') return { status: 'failed', reason: outcome.reason };
  return { status: 'failed', reason: outcome.status === 'error' ? outcome.code : outcome.status };
}

/** Resumes a suspended step once its approval is approved. Any other approval state leaves the step as it is or ends it. */
export async function resumeStep(options: {
  key: string;
  store: StepStateStore;
  approvals: ApprovalReader;
  engine: ResumeEngine;
  companyId: unknown;
}): Promise<StepResult> {
  const companyId = requireCompanyId(options.companyId);
  const step = await options.store.get(options.key);
  if (!step) return { status: 'refused', reason: 'step_not_found' };
  if (step.companyId !== companyId) return { status: 'refused', reason: 'step_company_mismatch' };
  if (step.status !== 'suspended' || !step.approvalId) return { status: 'refused', reason: `step_not_suspended` };

  const approval = await options.approvals.readApproval(companyId, step.approvalId);
  if (!approval) return { status: 'refused', reason: 'approval_not_found' };
  if (approval.companyId !== companyId) return { status: 'refused', reason: 'approval_company_mismatch' };
  if (approval.executed) return { status: 'refused', reason: 'approval_already_executed' };

  if (approval.status === 'pending') return { status: 'suspended', approvalId: step.approvalId };
  if (approval.status === 'rejected' || approval.status === 'expired') {
    const ended: StepStatus = approval.status === 'rejected' ? 'rejected' : 'expired';
    await options.store.compareAndSet(options.key, step.version, { ...step, status: ended, version: step.version + 1 });
    return { status: 'refused', reason: `approval_${approval.status}` };
  }
  if (approval.status !== 'approved') return { status: 'refused', reason: 'approval_not_approved' };

  // Claim the step first. Only one resume can move it off 'suspended'.
  const claimed = await options.store.compareAndSet(options.key, step.version, {
    ...step,
    status: 'completed',
    version: step.version + 1,
  });
  if (!claimed) return { status: 'refused', reason: 'step_state_conflict' };

  const result = await options.engine.resumeAfterApproval(companyId, step.runId, {
    toolId: step.toolId,
    params: step.params,
    actor: step.actor,
  });
  if (!result.ok || !result.tool) {
    await options.store.compareAndSet(options.key, step.version + 1, { ...step, status: 'failed', version: step.version + 2 });
    return { status: 'failed', reason: result.reason ?? 'resume_failed' };
  }
  if (result.tool.outcome === 'executed') return { status: 'completed', output: result.tool.output ?? {} };
  await options.store.compareAndSet(options.key, step.version + 1, { ...step, status: 'failed', version: step.version + 2 });
  return { status: 'failed', reason: result.tool.outcome };
}

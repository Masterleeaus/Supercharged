/**
 * Flow-automation pilot on the approval suspend and resume path (Phase 1, W2, issue #376).
 *
 * A flow is an ordered list of workforce tool steps. Each step runs through runStep, so an approval wait
 * suspends the flow at that step and nothing after it runs. When the approval is approved, resumeStep runs
 * the suspended step once, and only then do the remaining steps run, in order.
 *
 * Fail closed:
 * - A step that is refused or fails ends the flow. Later steps never run.
 * - A suspended flow reports the step key and approval id. It does not run later steps until that step completes.
 * - Resume only continues from the step recorded as suspended. Steps before it are never run again.
 *
 * Not wired anywhere. Progress is held by the caller (the step index). Durable flow progress is a wiring task.
 *
 * Licence: original TitanZero code. It copies no Mastra or VoltAgent source. See source/mastra-apache-only/README.md.
 */
import {
  resumeStep,
  runStep,
  type ApprovalReader,
  type ResumeEngine,
  type StepStateStore,
} from './approval-flow.ts';
import type { BridgeActor, VoltAgentToolLike } from '../agents/bridge.ts';

export interface FlowStep {
  /** Stable name for the step inside the flow. Used to build the saved step key. */
  name: string;
  toolId: string;
  params: Record<string, unknown>;
  tool: VoltAgentToolLike;
}

export interface FlowDeps {
  store: StepStateStore;
  companyId: unknown;
  runId: string;
  actor: BridgeActor;
}

export type FlowResult =
  | { status: 'completed'; completed: string[] }
  | { status: 'suspended'; completed: string[]; suspendedStep: string; approvalId: string }
  | { status: 'refused'; completed: string[]; failedStep: string; reason: string }
  | { status: 'failed'; completed: string[]; failedStep: string; reason: string };

function stepKey(runId: string, name: string): string {
  return `${runId}:${name}`;
}

/** Runs steps from `from` onward until the flow completes, suspends, or ends. */
async function runFrom(steps: readonly FlowStep[], from: number, completed: string[], deps: FlowDeps): Promise<FlowResult> {
  for (let i = from; i < steps.length; i += 1) {
    const step = steps[i];
    const res = await runStep({
      tool: step.tool,
      key: stepKey(deps.runId, step.name),
      store: deps.store,
      companyId: deps.companyId,
      runId: deps.runId,
      toolId: step.toolId,
      params: step.params,
      actor: deps.actor,
    });
    if (res.status === 'completed') {
      completed.push(step.name);
      continue;
    }
    if (res.status === 'suspended') {
      return { status: 'suspended', completed, suspendedStep: step.name, approvalId: res.approvalId };
    }
    if (res.status === 'refused') return { status: 'refused', completed, failedStep: step.name, reason: res.reason };
    return { status: 'failed', completed, failedStep: step.name, reason: res.reason };
  }
  return { status: 'completed', completed };
}

/** Starts a flow. Stops at the first approval wait, refusal or failure. */
export async function runFlowAutomationPilot(steps: readonly FlowStep[], deps: FlowDeps): Promise<FlowResult> {
  return runFrom(steps, 0, [], deps);
}

/**
 * Resumes a flow suspended at `suspendedStep`. The suspended step resumes once. If it completes, the
 * remaining steps run in order. Steps before the suspended one are not run again.
 */
export async function resumeFlowAutomationPilot(
  steps: readonly FlowStep[],
  suspendedStep: string,
  deps: FlowDeps & { approvals: ApprovalReader; engine: ResumeEngine; completedBefore?: readonly string[] },
): Promise<FlowResult> {
  const index = steps.findIndex((s) => s.name === suspendedStep);
  if (index < 0) return { status: 'refused', completed: [...(deps.completedBefore ?? [])], failedStep: suspendedStep, reason: 'step_not_in_flow' };
  const completed = [...(deps.completedBefore ?? [])];

  const res = await resumeStep({
    key: stepKey(deps.runId, suspendedStep),
    store: deps.store,
    approvals: deps.approvals,
    engine: deps.engine,
    companyId: deps.companyId,
  });
  if (res.status === 'suspended') {
    return { status: 'suspended', completed, suspendedStep, approvalId: res.approvalId };
  }
  if (res.status === 'refused') {
    return { status: 'refused', completed, failedStep: suspendedStep, reason: res.reason };
  }
  if (res.status === 'failed') {
    return { status: 'failed', completed, failedStep: suspendedStep, reason: res.reason };
  }
  completed.push(suspendedStep);
  return runFrom(steps, index + 1, completed, deps);
}

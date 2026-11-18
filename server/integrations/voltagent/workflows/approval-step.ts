/**
 * Approval wait as a workflow step (W2).
 *
 * The step calls the workforce run engine and nothing else. When the engine answers awaiting_approval, the step
 * reports 'suspended' and the tool handler has not run. Resume goes back through engine.resumeAfterApproval with the
 * same actor and params, so the engine's own checks still apply: actor, params hash, approval status and the atomic
 * claim. A step never calls a handler or the registry directly.
 *
 * Off by default. Building the step throws unless VOLTAGENT_WORKFLOWS_ENABLED is exactly "true", and every call
 * checks the flag again, so turning it off stops new work.
 *
 * This file does not import @voltagent/core. That package does not load in this tree (gray-matter needs the js-yaml
 * 3 API and js-yaml 5.x is installed), so the step is a plain adapter. It is not imported at boot and it mounts no
 * route.
 */
import { readVoltAgentFlags } from '../flags.ts';
import type { RunEngine, RunRecord, RunToolCall } from '../../../workforce/runtime/run.ts';

export type WorkflowEngine = Pick<RunEngine, 'callTool' | 'resumeAfterApproval'>;

export interface GatedCallInput {
  companyId: string;
  runId: string;
  call: RunToolCall;
}

export type ApprovalStepResult =
  | { status: 'completed'; runId: string; toolId: string; output: Record<string, unknown> }
  | { status: 'suspended'; runId: string; toolId: string; approvalId: string }
  | { status: 'failed'; runId: string; reason: string }
  | { status: 'already_resolved'; runId: string; runStatus: RunRecord['status'] | 'unknown' };

export interface ApprovalStep {
  /** Runs the gated call. Suspends when the engine says the call needs a human approval. */
  start(input: GatedCallInput): Promise<ApprovalStepResult>;
  /** Resumes a suspended call after a decision. A second call after the wait is settled changes nothing. */
  resume(input: GatedCallInput): Promise<ApprovalStepResult>;
}

export const WORKFLOWS_OFF_MESSAGE =
  'VoltAgent workflows are off. Set VOLTAGENT_WORKFLOWS_ENABLED to "true" to build them.';

/** True only when VOLTAGENT_WORKFLOWS_ENABLED is exactly "true". */
export function workflowsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readVoltAgentFlags(env).workflowsEnabled;
}

function assertEnabled(env: NodeJS.ProcessEnv): void {
  if (!workflowsEnabled(env)) throw new Error(WORKFLOWS_OFF_MESSAGE);
}

/** Builds an approval step over a run engine. Throws while the workflows flag is off. */
export function createApprovalStep(options: { engine: WorkflowEngine; env?: NodeJS.ProcessEnv }): ApprovalStep {
  const env = options.env ?? process.env;
  assertEnabled(env);
  const { engine } = options;
  if (!engine || typeof engine.callTool !== 'function' || typeof engine.resumeAfterApproval !== 'function') {
    throw new TypeError('approval step needs a run engine with callTool and resumeAfterApproval');
  }

  return {
    async start({ companyId, runId, call }) {
      assertEnabled(env);
      const res = await engine.callTool(companyId, runId, call);
      if (!res.ok) return { status: 'failed', runId, reason: res.reason };

      const tool = res.tool;
      if (tool.outcome === 'executed') {
        return { status: 'completed', runId, toolId: tool.toolId, output: tool.output };
      }
      if (tool.outcome === 'awaiting_approval') {
        return { status: 'suspended', runId, toolId: tool.toolId, approvalId: tool.approvalId };
      }
      return { status: 'failed', runId, reason: 'reason' in tool ? String(tool.reason) : tool.outcome };
    },

    async resume({ companyId, runId, call }) {
      assertEnabled(env);
      const res = await engine.resumeAfterApproval(companyId, runId, call);

      if (!res.ok) {
        // The engine refuses without side effects when the wait is already settled, so nothing runs twice and the
        // stored run is left as it is. Report where the run stands instead.
        if (res.reason === 'run_not_awaiting_approval' || res.reason === 'no_pending_approval') {
          return { status: 'already_resolved', runId, runStatus: res.run?.status ?? 'unknown' };
        }
        return { status: 'failed', runId, reason: res.reason };
      }

      if (res.run.status === 'failed') {
        // A rejected approval fails the run and the handler does not run.
        return { status: 'failed', runId, reason: 'reason' in res.tool ? String(res.tool.reason) : res.tool.outcome };
      }

      const tool = res.tool;
      if (tool.outcome === 'executed') {
        return { status: 'completed', runId, toolId: tool.toolId, output: tool.output };
      }
      if (tool.outcome === 'awaiting_approval') {
        return { status: 'suspended', runId, toolId: tool.toolId, approvalId: tool.approvalId };
      }
      return { status: 'failed', runId, reason: 'reason' in tool ? String(tool.reason) : tool.outcome };
    },
  };
}

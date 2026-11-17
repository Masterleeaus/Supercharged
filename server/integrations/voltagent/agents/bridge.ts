/**
 * VoltAgent agent bridge (Phase 1, W1, issue #375).
 *
 * Exposes an allowlist of workforce registry tools as VoltAgent-shaped tools. Every execute() call goes
 * through the workforce run engine's callTool, so the engine's gates (run state, budgets, controls, risk
 * tier, approvals, idempotency, audit) apply to every call. This module never holds a registry reference and
 * never calls a handler directly.
 *
 * Fail closed:
 * - companyId, runId and an agent actor are required; anything else throws before a tool is built.
 * - Only tools named in the allowlist are exposed. Anything else is not in the returned list.
 * - An engine error is returned as status 'error' with a fixed code, so no message text leaks to the model.
 *
 * Not wired anywhere yet. Nothing mounts these tools while VOLTAGENT_AGENTS_ENABLED is off.
 *
 * Licence: original TitanZero code. It copies no Mastra or VoltAgent source. See source/mastra-apache-only/README.md.
 *
 * The VoltAgent tool shape (name, description, parameters, execute) is written from the public docs. Not verified
 * against an installed @voltagent/core, because node_modules/@voltagent is empty in this checkout.
 */
import { requireCompanyId } from '../../../services/ai-runtime/company.ts';
import type { RunEngine, RunToolResult } from '../../../workforce/runtime/run.ts';

export type BridgeActor = { kind: 'agent'; agentId: string; roleId: string };

export interface BridgeToolSpec {
  /** Registry tool id. Used as the VoltAgent tool name. */
  toolId: string;
  description: string;
  /** JSON Schema for the tool arguments. Supplied by the caller; the registry does not expose its schemas. */
  parameters: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required?: string[] };
}

export type BridgeOutcome =
  | { status: 'executed'; output: Record<string, unknown>; truncated: boolean }
  | { status: 'awaiting_approval'; approvalId: string }
  | { status: 'staged'; paramsSha256: string }
  | { status: 'refused'; reason: string }
  | { status: 'failed'; reason: string; transient: boolean }
  | { status: 'error'; code: 'bridge_call_failed' | 'invalid_arguments' };

export interface VoltAgentToolLike {
  name: string;
  description: string;
  parameters: BridgeToolSpec['parameters'];
  execute(args: unknown): Promise<BridgeOutcome>;
}

export interface AgentBridgeOptions {
  engine: Pick<RunEngine, 'callTool'>;
  companyId: unknown;
  runId: string;
  actor: BridgeActor;
  allowlist: readonly BridgeToolSpec[];
}

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

function assertActor(actor: unknown): BridgeActor {
  if (typeof actor !== 'object' || actor === null) throw new Error('bridge_actor_required');
  const a = actor as Record<string, unknown>;
  if (a.kind !== 'agent') throw new Error('bridge_actor_must_be_agent');
  if (typeof a.agentId !== 'string' || a.agentId.trim() === '') throw new Error('bridge_agent_id_required');
  if (typeof a.roleId !== 'string' || a.roleId.trim() === '') throw new Error('bridge_role_id_required');
  return { kind: 'agent', agentId: a.agentId, roleId: a.roleId };
}

function mapResult(result: RunToolResult): BridgeOutcome {
  if (!result.ok) return { status: 'refused', reason: String(result.reason) };
  const tool = result.tool;
  switch (tool.outcome) {
    case 'executed':
      return { status: 'executed', output: tool.output, truncated: tool.truncated };
    case 'awaiting_approval':
      return { status: 'awaiting_approval', approvalId: tool.approvalId };
    case 'staged':
      return { status: 'staged', paramsSha256: tool.paramsSha256 };
    case 'failed':
      return { status: 'failed', reason: tool.reason, transient: tool.transient };
    case 'refused':
      return { status: 'refused', reason: tool.reason };
    default:
      return { status: 'error', code: 'bridge_call_failed' };
  }
}

export function createAgentBridgeTools(options: AgentBridgeOptions): VoltAgentToolLike[] {
  const companyId = requireCompanyId(options.companyId);
  if (typeof options.runId !== 'string' || options.runId.trim() === '') throw new Error('bridge_run_id_required');
  if (!options.engine || typeof options.engine.callTool !== 'function') throw new Error('bridge_engine_required');
  const actor = assertActor(options.actor);

  const seen = new Set<string>();
  for (const spec of options.allowlist) {
    if (!TOOL_NAME_PATTERN.test(spec.toolId)) throw new Error('bridge_tool_name_invalid');
    if (seen.has(spec.toolId)) throw new Error('bridge_tool_duplicate');
    seen.add(spec.toolId);
  }

  return options.allowlist.map((spec) => ({
    name: spec.toolId,
    description: spec.description,
    parameters: spec.parameters,
    async execute(args: unknown): Promise<BridgeOutcome> {
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        return { status: 'error', code: 'invalid_arguments' };
      }
      try {
        const result = await options.engine.callTool(companyId, options.runId, {
          toolId: spec.toolId,
          params: args as Record<string, unknown>,
          actor,
        });
        return mapResult(result);
      } catch {
        return { status: 'error', code: 'bridge_call_failed' };
      }
    },
  }));
}

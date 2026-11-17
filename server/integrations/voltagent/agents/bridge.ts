/**
 * VoltAgent tool bridge for the workforce registry (workstream W1).
 *
 * Each bridged tool calls engine.callTool with the run's companyId, runId and actor, so budget, role,
 * approval and audit checks all run inside the workforce runtime. This file never calls a registry handler.
 *
 * Only the tools the caller lists are exposed. Nothing is built unless VOLTAGENT_AGENTS_ENABLED is exactly "true".
 *
 * The tool objects have the shape VoltAgent's createTool takes (id, name, description, parameters, execute).
 * They are not passed to @voltagent/core yet: importing it fails with the current lockfile (gray-matter needs
 * js-yaml 3, the hoisted js-yaml is 5.5.0). Do not import this file at boot until the pre-boot entry exists (issue 393).
 */
import { z } from 'zod';
import { readVoltAgentFlags } from '../flags.ts';
import type { RunActorInput, RunEngine } from '../../../workforce/runtime/index.ts';

export interface BridgeToolSpec {
  /** Registry tool id. Must already be registered in the registry, or the engine refuses the call. */
  toolId: string;
  description: string;
  /** Zod schema for the agent's input. The engine still checks the params against the registry schema. */
  parameters: z.ZodType;
}

export interface BridgeOptions {
  engine: RunEngine;
  companyId: unknown;
  runId: string;
  actor: RunActorInput;
  /** The only tools that are exposed. Anything not listed here is not built. */
  tools: readonly BridgeToolSpec[];
  /** Defaults to process.env. Read at build time only. */
  env?: NodeJS.ProcessEnv;
}

/** What the agent sees after a call. Refusals and approval waits are returned, not thrown. */
export type BridgeCallResult =
  | { ok: true; outcome: 'executed'; toolId: string; output: Record<string, unknown>; truncated: boolean }
  | { ok: false; outcome: 'awaiting_approval'; toolId: string; approvalId: string }
  | { ok: false; outcome: 'refused'; toolId: string | null; reason: string; message?: string }
  | { ok: false; outcome: 'failed'; toolId: string; reason: string; message: string }
  | { ok: false; outcome: 'staged'; toolId: string };

export interface BridgeTool {
  id: string;
  name: string;
  description: string;
  parameters: z.ZodType;
  execute: (args: Record<string, unknown>) => Promise<BridgeCallResult>;
}

export const VOLTAGENT_AGENTS_DISABLED_MESSAGE =
  'VoltAgent agents are off. Set VOLTAGENT_AGENTS_ENABLED to "true" to build registry tools.';

function assertBuildable(options: BridgeOptions): void {
  const flags = readVoltAgentFlags(options.env ?? process.env);
  if (!flags.agentsEnabled) throw new Error(VOLTAGENT_AGENTS_DISABLED_MESSAGE);
  if (typeof options.runId !== 'string' || options.runId.trim() === '') {
    throw new Error('bridge needs a runId');
  }
  if (!options.engine || typeof options.engine.callTool !== 'function') {
    throw new Error('bridge needs a run engine');
  }
  const seen = new Set<string>();
  for (const spec of options.tools) {
    if (typeof spec.toolId !== 'string' || spec.toolId.trim() === '') throw new Error('bridge tool needs a toolId');
    if (seen.has(spec.toolId)) throw new Error(`bridge tool listed twice: ${spec.toolId}`);
    seen.add(spec.toolId);
  }
}

/**
 * Builds one bridged tool per listed registry tool. Throws when agents are off, so nothing is built by accident.
 */
export function buildRegistryTools(options: BridgeOptions): BridgeTool[] {
  assertBuildable(options);
  const { engine, companyId, runId, actor } = options;

  return options.tools.map((spec): BridgeTool => ({
    id: spec.toolId,
    name: spec.toolId,
    description: spec.description,
    parameters: spec.parameters,
    execute: async (args) => {
      const result = await engine.callTool(companyId, runId, {
        toolId: spec.toolId,
        params: args ?? {},
        actor,
      });

      if (result.ok === false) {
        return { ok: false, outcome: 'refused', toolId: null, reason: result.reason };
      }

      const tool = result.tool;
      switch (tool.outcome) {
        case 'executed':
          return { ok: true, outcome: 'executed', toolId: tool.toolId, output: tool.output, truncated: tool.truncated };
        case 'awaiting_approval':
          return { ok: false, outcome: 'awaiting_approval', toolId: tool.toolId, approvalId: tool.approvalId };
        case 'refused':
          return { ok: false, outcome: 'refused', toolId: tool.toolId, reason: tool.reason, message: tool.message };
        case 'failed':
          return { ok: false, outcome: 'failed', toolId: tool.toolId, reason: tool.reason, message: tool.message };
        case 'staged':
          return { ok: false, outcome: 'staged', toolId: tool.toolId };
      }
    },
  }));
}

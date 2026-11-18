/**
 * Converts agent bridge tools into VoltAgent tools (Phase 1, W1, issue #375; spans for issue #381).
 *
 * The installed @voltagent/core createTool() takes a zod schema for `parameters`, not JSON Schema, so the
 * bridge's JSON-shaped spec is converted here. The conversion is strict:
 * - unknown argument keys are rejected by the schema, so the model cannot send extra fields to the engine;
 * - only string, number, integer and boolean properties are supported; anything else throws at build time;
 * - a required key that is not declared as a property throws at build time.
 *
 * createTool is injected by the caller. This module does not import @voltagent/core, so it loads without it.
 * Every execute() still goes through the bridge, and so through engine.callTool.
 *
 * Telemetry: when a Telemetry instance is given, each tool call runs inside a span named
 * 'voltagent.tool.call'. The span carries the tool id, the role id and the outcome status only. Tool arguments
 * and tool output are never put on the span.
 *
 * Not wired anywhere yet. Nothing mounts these tools while VOLTAGENT_AGENTS_ENABLED is off.
 *
 * Licence: original TitanZero code. It copies no Mastra or VoltAgent source.
 */
import { z } from 'zod';
import type { BridgeOutcome, BridgeToolSpec, VoltAgentToolLike } from './bridge.ts';
import type { Telemetry } from '../../../infrastructure/telemetry/index.ts';

export const TOOL_CALL_SPAN_NAME = 'voltagent.tool.call';
export const AGENT_RUN_SPAN_NAME = 'voltagent.agent.run';

/**
 * Runs one agent run inside an 'voltagent.agent.run' span. The caller passes only ids and counts as attributes,
 * never prompts or model output. Without telemetry, or with telemetry disabled, fn runs unchanged.
 */
export async function runAgentTraced<T>(
  telemetry: Telemetry | undefined,
  attrs: { role_id: string; run_id: string },
  fn: () => Promise<T>,
): Promise<T> {
  if (!telemetry) return fn();
  return telemetry.withSpan(AGENT_RUN_SPAN_NAME, { ...attrs }, async () => fn());
}

export type CreateToolFn<T> = (options: {
  name: string;
  description: string;
  parameters: z.ZodType;
  execute: (args: unknown) => Promise<BridgeOutcome>;
}) => T;

export interface VoltAgentToolOptions {
  /** Supplied by the caller, typically createTool from @voltagent/core. */
  createTool: CreateToolFn<unknown>;
  /** Optional. Spans are recorded only when this is given and telemetry is enabled. */
  telemetry?: Telemetry;
  /** Role id recorded on the span. Never the tenant id. */
  roleId?: string;
}

type PropertySpec = BridgeToolSpec['parameters']['properties'][string];

function propertySchema(prop: PropertySpec): z.ZodType {
  let schema: z.ZodType;
  switch (prop.type) {
    case 'string':
      schema = z.string();
      break;
    case 'number':
      schema = z.number();
      break;
    case 'integer':
      schema = z.number().int();
      break;
    case 'boolean':
      schema = z.boolean();
      break;
    default:
      throw new Error('bridge_schema_type_unsupported');
  }
  return prop.description ? schema.describe(prop.description) : schema;
}

/** Builds a strict zod object from the bridge's JSON-shaped parameter spec. Throws on any unsupported shape. */
export function parametersToZod(parameters: BridgeToolSpec['parameters']): z.ZodObject<Record<string, z.ZodType>> {
  if (parameters.type !== 'object') throw new Error('bridge_schema_must_be_object');
  const required = new Set(parameters.required ?? []);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(parameters.properties, key)) {
      throw new Error('bridge_schema_required_unknown');
    }
  }
  const shape: Record<string, z.ZodType> = {};
  for (const [name, prop] of Object.entries(parameters.properties)) {
    const schema = propertySchema(prop);
    shape[name] = required.has(name) ? schema : schema.optional();
  }
  return z.strictObject(shape);
}

async function runTraced(
  tool: VoltAgentToolLike,
  args: unknown,
  options: VoltAgentToolOptions,
): Promise<BridgeOutcome> {
  if (!options.telemetry) return tool.execute(args);
  return options.telemetry.withSpan(
    TOOL_CALL_SPAN_NAME,
    { tool_id: tool.name, role_id: options.roleId ?? 'unknown' },
    async (span) => {
      const outcome = await tool.execute(args);
      span.setAttributes({ outcome_status: outcome.status });
      return outcome;
    },
  );
}

/** Wraps each bridge tool with createTool. Build-time errors throw before any tool is returned. */
export function toVoltAgentTools<T>(
  bridgeTools: readonly VoltAgentToolLike[],
  options: Omit<VoltAgentToolOptions, 'createTool'> & { createTool: CreateToolFn<T> },
): T[] {
  return bridgeTools.map((tool) => {
    const parameters = parametersToZod(tool.parameters);
    return options.createTool({
      name: tool.name,
      description: tool.description,
      parameters,
      execute: (args: unknown) => runTraced(tool, args, options),
    });
  });
}

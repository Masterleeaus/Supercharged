/**
 * Tool simulator: a dry run for workflows. It checks each tool call the way the tool registry checks it (tool is
 * registered, input is a plain object, no tenant override key, input matches the schema, writes are not allowed)
 * and records the outcome. It never calls a handler, never writes, and never reaches an external provider.
 *
 * The simulator keeps only a metadata stub of each definition (id, access, schema). The handler is never read,
 * so no handler lookup can reach real code.
 *
 * Reasons are fixed codes plus field names only. Input values are never copied into a reason. The input is echoed
 * on the outcome as given, so callers must not pass secrets to a simulator they log.
 */
import { validateToolParams, type ToolDefinition, type ToolSchema } from '../runtime/tool-registry.ts';

export const SIMULATED_WRITE_REFUSED = 'simulated_write_refused';

const TENANT_OVERRIDE_KEYS = new Set(['companyid', 'company_id', 'tenantid', 'tenant_id', 'tenant']);
const MAX_NESTING = 10;

export interface SimulationStep {
  tool: string;
  input: unknown;
  /** Writes stay refused unless this is true. Even then the call is only recorded, never run. */
  allowSimulatedWrite?: boolean;
}

export interface SimulatedOutcome {
  tool: string;
  wouldExecute: boolean;
  reason: string;
  input: unknown;
}

export interface ToolSimulator {
  simulate(step: SimulationStep): SimulatedOutcome;
}

/** Metadata only. There is no handler field, so a simulator cannot call one. */
interface ToolStub {
  id: string;
  access: 'read' | 'write';
  schema: ToolSchema;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasTenantOverride(value: unknown, depth = 0): boolean {
  if (depth > MAX_NESTING) return false;
  if (Array.isArray(value)) return value.some((item) => hasTenantOverride(item, depth + 1));
  if (isPlainObject(value)) {
    for (const [key, inner] of Object.entries(value)) {
      if (TENANT_OVERRIDE_KEYS.has(key.toLowerCase())) return true;
      if (hasTenantOverride(inner, depth + 1)) return true;
    }
  }
  return false;
}

function outcome(tool: string, wouldExecute: boolean, reason: string, input: unknown): SimulatedOutcome {
  return { tool, wouldExecute, reason, input };
}

export function createToolSimulator(definitions: readonly ToolDefinition[]): ToolSimulator {
  if (!Array.isArray(definitions)) throw new Error('tool simulator needs an array of tool definitions');

  const stubs = new Map<string, ToolStub>();
  for (const definition of definitions) {
    if (!definition || typeof definition.id !== 'string' || definition.id === '') {
      throw new Error('tool simulator: every definition needs an id');
    }
    if (stubs.has(definition.id)) throw new Error('tool simulator: duplicate tool id');
    // Only the metadata is copied. definition.handler is never read.
    stubs.set(definition.id, {
      id: definition.id,
      access: definition.access === 'read' ? 'read' : 'write', // absent or invalid means write (fails closed)
      schema: definition.schema,
    });
  }

  return {
    simulate(step: SimulationStep): SimulatedOutcome {
      const raw: unknown = step;
      const tool = isPlainObject(raw) && typeof raw.tool === 'string' ? raw.tool : '';
      const input = isPlainObject(raw) ? raw.input : undefined;

      const stub = stubs.get(tool);
      if (!stub) return outcome(tool, false, 'tool_unknown', input);

      if (!isPlainObject(input)) return outcome(tool, false, 'input_invalid: input must be an object', input);
      if (hasTenantOverride(input)) return outcome(tool, false, 'tenant_override', input);

      const issues = validateToolParams(stub.schema, input);
      if (issues.length > 0) return outcome(tool, false, `input_invalid: ${issues.join('; ')}`, input);

      if (stub.access === 'write') {
        if (raw.allowSimulatedWrite !== true) return outcome(tool, false, SIMULATED_WRITE_REFUSED, input);
        return outcome(tool, true, 'simulated_write_recorded', input);
      }

      return outcome(tool, true, 'would_execute', input);
    },
  };
}

/**
 * Runs the steps in order and returns every recorded outcome. Stops at the first refusal, and that refusal is the
 * last outcome returned. Nothing runs for the steps after it.
 */
export function runSimulatedWorkflow(simulator: ToolSimulator, steps: readonly SimulationStep[]): SimulatedOutcome[] {
  if (!simulator || typeof simulator.simulate !== 'function') throw new Error('runSimulatedWorkflow needs a simulator');
  if (!Array.isArray(steps)) throw new Error('runSimulatedWorkflow needs an array of steps');

  const outcomes: SimulatedOutcome[] = [];
  for (const step of steps) {
    const result = simulator.simulate(step);
    outcomes.push(result);
    if (!result.wouldExecute) break;
  }
  return outcomes;
}

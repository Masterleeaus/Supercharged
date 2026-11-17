/**
 * In-memory fake tool registry for tests. It has the same method shape as ToolRegistry in
 * server/workforce/runtime/tool-registry.ts: register(definition), has(toolId), list(), invoke(invocation).
 *
 * It is a stand-in, not a policy engine. It does not check authority, approvals, freshness or idempotency.
 * It does check what a test usually needs: a company id, an actor, a registered tool, plain-object params with
 * no unknown or required-missing fields, and a handler that either returns output or throws.
 *
 * Every call to invoke() or callTool() is recorded in `calls`, including refused ones, so a test can assert
 * exactly what was attempted.
 *
 * Result shapes match ToolInvocationResult: 'executed', 'failed' or 'refused'.
 * No network, no database, no timers.
 */

const TOOL_ID_PATTERN = /^[a-z][a-z0-9_.:-]{0,127}$/;
const RISK_TIERS = ['low', 'medium', 'high', 'critical'];
const FIELD_TYPES = ['string', 'number', 'boolean', 'object', 'array'];
const TENANT_KEYS = new Set(['companyid', 'company_id', 'tenantid', 'tenant_id', 'tenant']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function matchesType(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'object': return isPlainObject(value);
    case 'array': return Array.isArray(value);
    default: return false;
  }
}

function checkParams(schema, params) {
  const issues = [];
  for (const key of Object.keys(params)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) issues.push(`${key}: unknown field`);
  }
  for (const [field, rule] of Object.entries(schema)) {
    const value = params[field];
    if (value === undefined || value === null) {
      if (rule.required === true) issues.push(`${field}: required`);
      continue;
    }
    if (!matchesType(rule.type, value)) issues.push(`${field}: expected ${rule.type}`);
  }
  return issues;
}

/**
 * @returns {{
 *   register(def: object): void,
 *   has(toolId: string): boolean,
 *   list(): Array<{id: string, risk: string}>,
 *   invoke(invocation: object): Promise<object>,
 *   callTool(invocation: object): Promise<object>,
 *   calls: Array<object>,
 *   reset(): void
 * }}
 */
export function createFakeRegistry() {
  const tools = new Map();
  const calls = [];

  function refused(toolId, reason, message) {
    return { outcome: 'refused', toolId, reason, message };
  }

  async function invoke(invocation) {
    calls.push({ ...invocation });
    const toolId = typeof invocation?.toolId === 'string' ? invocation.toolId : null;
    const companyId = invocation?.companyId;
    if (companyId === undefined || companyId === null || companyId === '') {
      return refused(toolId, 'company_id_required', 'companyId is required for every tool call.');
    }
    const actor = invocation?.actor;
    const actorOk = isPlainObject(actor)
      && ((actor.kind === 'agent' && typeof actor.agentId === 'string' && typeof actor.roleId === 'string')
        || (actor.kind === 'human' && typeof actor.userId === 'string'));
    if (!actorOk) return refused(toolId, 'actor_invalid', 'Actor must be an agent with agentId and roleId, or a human with userId.');
    const tool = toolId !== null ? tools.get(toolId) : undefined;
    if (!tool) return refused(toolId, 'tool_unknown', 'Tool is not registered.');
    const params = invocation.params === undefined ? {} : invocation.params;
    if (!isPlainObject(params)) return refused(toolId, 'input_invalid', 'Input must be an object.');
    if (Object.keys(params).some((k) => TENANT_KEYS.has(k.toLowerCase()))) {
      return refused(toolId, 'tenant_override', 'Input may not name a company or tenant.');
    }
    const issues = checkParams(tool.schema, params);
    if (issues.length > 0) return refused(toolId, 'input_invalid', `Input is invalid: ${issues.join('; ')}`);

    try {
      const output = await tool.handler(params, { companyId, signal: new AbortController().signal });
      return { outcome: 'executed', toolId, tier: tool.risk, output: isPlainObject(output) ? output : { value: output }, truncated: false };
    } catch (error) {
      const transient = error?.transient === true;
      return {
        outcome: 'failed',
        toolId,
        tier: tool.risk,
        reason: 'tool_failed',
        transient,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    register(definition) {
      if (!isPlainObject(definition)) throw new TypeError('tool definition must be an object');
      if (typeof definition.id !== 'string' || !TOOL_ID_PATTERN.test(definition.id)) throw new TypeError('tool id is invalid');
      if (!RISK_TIERS.includes(definition.risk)) throw new TypeError(`tool ${definition.id} needs a risk tier`);
      if (typeof definition.handler !== 'function') throw new TypeError(`tool ${definition.id} needs a handler`);
      if (!isPlainObject(definition.schema)) throw new TypeError(`tool ${definition.id} needs a schema`);
      for (const rule of Object.values(definition.schema)) {
        if (!isPlainObject(rule) || !FIELD_TYPES.includes(rule.type)) throw new TypeError(`tool ${definition.id} has an invalid schema`);
      }
      if (tools.has(definition.id)) throw new TypeError(`tool already registered: ${definition.id}`);
      tools.set(definition.id, { ...definition, schema: { ...definition.schema } });
    },

    has(toolId) {
      return tools.has(toolId);
    },

    list() {
      return [...tools.values()].map((t) => ({ id: t.id, risk: t.risk }));
    },

    invoke,

    /** Same as invoke. The run engine's name for a tool call; both are recorded in `calls`. */
    callTool: invoke,

    /** Every invocation received, refused or not, in order. */
    calls,

    /** Clears recorded calls. Registered tools are kept. */
    reset() {
      calls.length = 0;
    },
  };
}

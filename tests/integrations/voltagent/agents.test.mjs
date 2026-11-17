// Licence: original TitanZero test code. No Mastra or VoltAgent source is copied.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentBridgeTools } from '../../../server/integrations/voltagent/agents/bridge.ts';

const ACTOR = { kind: 'agent', agentId: 'agent-1', roleId: 'role-dispatch' };
const SPEC = {
  toolId: 'jobs.lookup',
  description: 'Look up a job by id',
  parameters: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
};

function fakeEngine(result) {
  const calls = [];
  return {
    calls,
    async callTool(companyId, runId, call) {
      calls.push({ companyId, runId, call });
      if (result instanceof Error) throw result;
      return typeof result === 'function' ? result(call) : result;
    },
  };
}

function build(engine, overrides = {}) {
  return createAgentBridgeTools({
    engine,
    companyId: 7,
    runId: 'run-1',
    actor: ACTOR,
    allowlist: [SPEC],
    ...overrides,
  });
}

test('every execute goes through engine.callTool with company, run, tool, params and actor', async () => {
  const engine = fakeEngine({ ok: true, run: {}, tool: { outcome: 'executed', toolId: 'jobs.lookup', tier: 'read', output: { id: 'j1' }, truncated: false } });
  const [tool] = build(engine);
  const out = await tool.execute({ jobId: 'j1' });
  assert.deepEqual(out, { status: 'executed', output: { id: 'j1' }, truncated: false });
  assert.equal(engine.calls.length, 1);
  assert.equal(engine.calls[0].companyId, '7');
  assert.equal(engine.calls[0].runId, 'run-1');
  assert.deepEqual(engine.calls[0].call, { toolId: 'jobs.lookup', params: { jobId: 'j1' }, actor: ACTOR });
});

test('only allowlisted tools are exposed', () => {
  const tools = build(fakeEngine({ ok: false, reason: 'x', run: null, tool: null }));
  assert.deepEqual(tools.map((t) => t.name), ['jobs.lookup']);
  assert.deepEqual(tools[0].parameters, SPEC.parameters);
});

test('an empty allowlist exposes no tools', () => {
  assert.deepEqual(build(fakeEngine({ ok: false, reason: 'x', run: null, tool: null }), { allowlist: [] }), []);
});

test('a refused run is returned as refused and never as executed', async () => {
  const engine = fakeEngine({ ok: false, reason: 'run_not_running', run: null, tool: null });
  const [tool] = build(engine);
  assert.deepEqual(await tool.execute({ jobId: 'j1' }), { status: 'refused', reason: 'run_not_running' });
});

test('approval waits, staged drafts, failures and tool refusals keep their status', async () => {
  const cases = [
    [{ outcome: 'awaiting_approval', toolId: 'jobs.lookup', tier: 'write', approvalId: 'ap-1', paramsSha256: 'h' }, { status: 'awaiting_approval', approvalId: 'ap-1' }],
    [{ outcome: 'staged', toolId: 'jobs.lookup', tier: 'draft', paramsSha256: 'h' }, { status: 'staged', paramsSha256: 'h' }],
    [{ outcome: 'failed', toolId: 'jobs.lookup', tier: 'read', reason: 'tool_timed_out', transient: true, message: 'm' }, { status: 'failed', reason: 'tool_timed_out', transient: true }],
    [{ outcome: 'refused', toolId: 'jobs.lookup', reason: 'policy_denied', message: 'm' }, { status: 'refused', reason: 'policy_denied' }],
  ];
  for (const [tool, expected] of cases) {
    const [t] = build(fakeEngine({ ok: true, run: {}, tool }));
    assert.deepEqual(await t.execute({ jobId: 'j1' }), expected);
  }
});

test('an engine throw is returned as a fixed error code and leaks no message', async () => {
  const [tool] = build(fakeEngine(new Error('secret db password leaked')));
  const out = await tool.execute({ jobId: 'j1' });
  assert.deepEqual(out, { status: 'error', code: 'bridge_call_failed' });
  assert.equal(JSON.stringify(out).includes('secret'), false);
});

test('non-object arguments are rejected before the engine is called', async () => {
  const engine = fakeEngine({ ok: true, run: {}, tool: { outcome: 'executed', toolId: 'x', tier: 'read', output: {}, truncated: false } });
  const [tool] = build(engine);
  for (const bad of [null, 'str', 42, ['a'], undefined]) {
    assert.deepEqual(await tool.execute(bad), { status: 'error', code: 'invalid_arguments' });
  }
  assert.equal(engine.calls.length, 0);
});

test('missing company id throws before any tool is built', () => {
  const engine = fakeEngine({ ok: false, reason: 'x', run: null, tool: null });
  assert.throws(() => build(engine, { companyId: undefined }), /companyId is required/);
  assert.throws(() => build(engine, { companyId: '' }), /companyId is required/);
});

test('missing run id, engine, or a non-agent actor throws', () => {
  const engine = fakeEngine({ ok: false, reason: 'x', run: null, tool: null });
  assert.throws(() => build(engine, { runId: '' }), /bridge_run_id_required/);
  assert.throws(() => build(engine, { engine: {} }), /bridge_engine_required/);
  assert.throws(() => build(engine, { actor: { kind: 'human', userId: 'u1' } }), /bridge_actor_must_be_agent/);
  assert.throws(() => build(engine, { actor: { kind: 'agent', agentId: '', roleId: 'r' } }), /bridge_agent_id_required/);
  assert.throws(() => build(engine, { actor: { kind: 'agent', agentId: 'a', roleId: ' ' } }), /bridge_role_id_required/);
});

test('invalid or duplicate tool ids throw', () => {
  const engine = fakeEngine({ ok: false, reason: 'x', run: null, tool: null });
  assert.throws(() => build(engine, { allowlist: [{ ...SPEC, toolId: 'bad name!' }] }), /bridge_tool_name_invalid/);
  assert.throws(() => build(engine, { allowlist: [SPEC, SPEC] }), /bridge_tool_duplicate/);
});

// ---- VoltAgent tool adapter (issue #375) and tool-call spans (issue #381) ----
import { parametersToZod, toVoltAgentTools, TOOL_CALL_SPAN_NAME } from '../../../server/integrations/voltagent/agents/voltagent-tools.ts';
import { createTelemetry } from '../../../server/infrastructure/telemetry/index.ts';

const SCHEMA = {
  type: 'object',
  properties: { jobId: { type: 'string', description: 'job id' }, limit: { type: 'integer' }, dryRun: { type: 'boolean' } },
  required: ['jobId'],
};

test('parametersToZod is strict: unknown keys are rejected', () => {
  const schema = parametersToZod(SCHEMA);
  assert.equal(schema.safeParse({ jobId: 'j1', extra: 1 }).success, false);
});

test('parametersToZod enforces required keys and allows optional ones', () => {
  const schema = parametersToZod(SCHEMA);
  assert.equal(schema.safeParse({}).success, false);
  assert.equal(schema.safeParse({ jobId: 'j1' }).success, true);
  assert.equal(schema.safeParse({ jobId: 'j1', limit: 5, dryRun: true }).success, true);
});

test('parametersToZod checks types, including integer versus number', () => {
  const schema = parametersToZod(SCHEMA);
  assert.equal(schema.safeParse({ jobId: 7 }).success, false);
  assert.equal(schema.safeParse({ jobId: 'j1', limit: 1.5 }).success, false);
  assert.equal(schema.safeParse({ jobId: 'j1', dryRun: 'yes' }).success, false);
});

test('unsupported property types and unknown required keys throw at build time', () => {
  assert.throws(() => parametersToZod({ type: 'object', properties: { a: { type: 'array' } } }), /bridge_schema_type_unsupported/);
  assert.throws(() => parametersToZod({ type: 'object', properties: {}, required: ['ghost'] }), /bridge_schema_required_unknown/);
  assert.throws(() => parametersToZod({ type: 'array', properties: {} }), /bridge_schema_must_be_object/);
});

test('toVoltAgentTools passes name, description and schema to createTool and forwards execute through the bridge', async () => {
  const engine = fakeEngine({ ok: true, run: {}, tool: { outcome: 'executed', toolId: 'jobs.lookup', tier: 'read', output: { id: 'j1' }, truncated: false } });
  const [bridge] = build(engine, { allowlist: [{ ...SPEC, parameters: SCHEMA }] });
  const seen = [];
  const [made] = toVoltAgentTools([bridge], { createTool: (o) => { seen.push(o); return { wrapped: o.name }; } });
  assert.deepEqual(made, { wrapped: 'jobs.lookup' });
  assert.equal(seen[0].description, SPEC.description);
  const out = await seen[0].execute({ jobId: 'j1' });
  assert.deepEqual(out, { status: 'executed', output: { id: 'j1' }, truncated: false });
  assert.equal(engine.calls.length, 1);
  assert.equal(engine.calls[0].call.toolId, 'jobs.lookup');
});

test('toVoltAgentTools throws before creating any tool when a schema is unsupported', () => {
  const engine = fakeEngine({ ok: false, reason: 'x', run: null, tool: null });
  const [bridge] = build(engine, { allowlist: [{ ...SPEC, parameters: { type: 'object', properties: { a: { type: 'array' } } } }] });
  let created = 0;
  assert.throws(() => toVoltAgentTools([bridge], { createTool: () => { created += 1; } }), /bridge_schema_type_unsupported/);
  assert.equal(created, 0);
});

test('tool calls record a redacted span with tool id, role and outcome, and never the arguments', async () => {
  const spans = [];
  const tracer = {
    startSpan(name, attrs) {
      const span = { name, attrs: { ...attrs }, ended: false };
      spans.push(span);
      return { setAttributes(more) { Object.assign(span.attrs, more); }, recordError() {}, end() { span.ended = true; } };
    },
  };
  const engine = fakeEngine({ ok: true, run: {}, tool: { outcome: 'staged', toolId: 'jobs.lookup', tier: 'draft', paramsSha256: 'h' } });
  const [bridge] = build(engine, { allowlist: [{ ...SPEC, parameters: SCHEMA }] });
  let execute;
  toVoltAgentTools([bridge], { createTool: (o) => { execute = o.execute; }, telemetry: createTelemetry({ enabled: true, tracer }), roleId: 'role-dispatch' });
  const out = await execute({ jobId: 'SECRET-ARG-VALUE' });
  assert.equal(out.status, 'staged');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].name, TOOL_CALL_SPAN_NAME);
  assert.deepEqual(spans[0].attrs, { tool_id: 'jobs.lookup', role_id: 'role-dispatch', outcome_status: 'staged' });
  assert.equal(spans[0].ended, true);
  assert.equal(JSON.stringify(spans).includes('SECRET-ARG-VALUE'), false);
});

test('with telemetry disabled the tool still runs and no span is created', async () => {
  const engine = fakeEngine({ ok: false, reason: 'run_not_running', run: null, tool: null });
  const [bridge] = build(engine, { allowlist: [{ ...SPEC, parameters: SCHEMA }] });
  let execute;
  toVoltAgentTools([bridge], { createTool: (o) => { execute = o.execute; }, telemetry: createTelemetry({ enabled: false }) });
  assert.deepEqual(await execute({ jobId: 'j1' }), { status: 'refused', reason: 'run_not_running' });
});

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

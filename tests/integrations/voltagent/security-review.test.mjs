// Security review regressions for VoltAgent W1 (bridge), W2 (approval flow) and W9 (MCP registry). Issue #389.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentBridgeTools } from '../../../server/integrations/voltagent/agents/bridge.ts';
import { createMcpRegistry } from '../../../server/integrations/voltagent/mcp/tools.ts';

const ACTOR = { kind: 'agent', agentId: 'a1', roleId: 'r1' };
const SPEC = {
  toolId: 'jobs.lookup',
  description: 'Look up a job',
  parameters: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
};

function bridgeWith(engineCalls) {
  const engine = {
    async callTool(companyId, runId, call) {
      engineCalls.push({ companyId, runId, call });
      return { ok: true, tool: { outcome: 'executed', output: {}, truncated: false } };
    },
  };
  return createAgentBridgeTools({ engine, companyId: 'co-1', runId: 'run-1', actor: ACTOR, allowlist: [SPEC] })[0];
}

test('W1: the bridge refuses unknown argument keys before the engine is called', async () => {
  const calls = [];
  const tool = bridgeWith(calls);
  const out = await tool.execute({ jobId: 'j1', extra: 'smuggled' });
  assert.deepEqual(out, { status: 'error', code: 'invalid_arguments' });
  assert.equal(calls.length, 0);
});

test('W1: declared arguments still reach the engine', async () => {
  const calls = [];
  const tool = bridgeWith(calls);
  const out = await tool.execute({ jobId: 'j1' });
  assert.equal(out.status, 'executed');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].call.params, { jobId: 'j1' });
});

test('W9: a handler error message is not returned to the caller', async () => {
  const reg = createMcpRegistry({
    enabled: true,
    tools: [{ name: 'x', kind: 'read', handler: () => { throw new Error('password=hunter2 at db.internal'); } }],
  });
  const out = await reg.call({ companyId: 'co-1', tool: 'x' });
  assert.deepEqual(out, { ok: false, code: 'tool_failed', message: 'tool failed' });
  assert.equal(JSON.stringify(out).includes('hunter2'), false);
});

test('W9: a throwing approval check fails closed and the write handler does not run', async () => {
  let ran = false;
  const reg = createMcpRegistry({
    enabled: true,
    tools: [{ name: 'w', kind: 'write', handler: () => { ran = true; return 'done'; } }],
    checkApproval: () => { throw new Error('approval store down'); },
  });
  const out = await reg.call({ companyId: 'co-1', tool: 'w', approvalId: 'ap-1' });
  assert.deepEqual(out, { ok: false, code: 'approval_rejected', message: 'approval was not accepted for this tenant and tool' });
  assert.equal(ran, false);
});

test('W9: an approval check that returns a truthy non-true value does not pass', async () => {
  let ran = false;
  const reg = createMcpRegistry({
    enabled: true,
    tools: [{ name: 'w', kind: 'write', handler: () => { ran = true; return 'done'; } }],
    checkApproval: () => 'yes',
  });
  const out = await reg.call({ companyId: 'co-1', tool: 'w', approvalId: 'ap-1' });
  assert.equal(out.code, 'approval_rejected');
  assert.equal(ran, false);
});

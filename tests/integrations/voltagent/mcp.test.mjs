import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpRegistry, TOOL_FAILED_MESSAGE } from '../../../server/integrations/voltagent/mcp/tools.ts';
import { hashToolParams } from '../../../server/workforce/runtime/tool-registry.ts';

const readTool = { name: 'jobs.list', kind: 'read', handler: (p, c) => ({ company: c, n: p.limit ?? 10 }) };
const writeTool = { name: 'jobs.cancel', kind: 'write', handler: () => 'cancelled' };
const approvals = new Set(['appr-1|co-1|jobs.cancel']);
const checkApproval = (id, co, tool) => approvals.has(`${id}|${co}|${tool}`);

test('disabled registry lists nothing and refuses every call', async () => {
  const reg = createMcpRegistry({ enabled: false, tools: [readTool] });
  assert.deepEqual(reg.list(), []);
  assert.equal((await reg.call({ companyId: 'co-1', tool: 'jobs.list' })).ok, false);
});

test('read tool runs for the tenant that asked', async () => {
  const reg = createMcpRegistry({ enabled: true, tools: [readTool] });
  const out = await reg.call({ companyId: 'co-1', tool: 'jobs.list', params: { limit: 3 } });
  assert.deepEqual(out, { ok: true, result: { company: 'co-1', n: 3 } });
});

test('a missing or blank companyId is refused', async () => {
  const reg = createMcpRegistry({ enabled: true, tools: [readTool] });
  assert.equal((await reg.call({ companyId: '  ', tool: 'jobs.list' })).code, 'company_required');
});

test('unknown tools are refused', async () => {
  const reg = createMcpRegistry({ enabled: true, tools: [readTool] });
  assert.equal((await reg.call({ companyId: 'co-1', tool: 'nope' })).code, 'unknown_tool');
});

test('write tool without an approval id is refused and never runs', async () => {
  let ran = false;
  const reg = createMcpRegistry({
    enabled: true,
    tools: [{ ...writeTool, handler: () => { ran = true; } }],
    checkApproval,
  });
  assert.equal((await reg.call({ companyId: 'co-1', tool: 'jobs.cancel' })).code, 'approval_required');
  assert.equal(ran, false);
});

test('write tool with an approval for another tenant is rejected', async () => {
  const reg = createMcpRegistry({ enabled: true, tools: [writeTool], checkApproval });
  const out = await reg.call({ companyId: 'co-2', tool: 'jobs.cancel', approvalId: 'appr-1' });
  assert.equal(out.code, 'approval_rejected');
});

test('write tool runs with a valid approval for its tenant', async () => {
  const reg = createMcpRegistry({ enabled: true, tools: [writeTool], checkApproval });
  assert.deepEqual(await reg.call({ companyId: 'co-1', tool: 'jobs.cancel', approvalId: 'appr-1' }), { ok: true, result: 'cancelled' });
});

test('write tool with no approval checker fails closed', async () => {
  const reg = createMcpRegistry({ enabled: true, tools: [writeTool] });
  assert.equal((await reg.call({ companyId: 'co-1', tool: 'jobs.cancel', approvalId: 'appr-1' })).code, 'approval_rejected');
});

test('a throwing handler becomes tool_failed with a fixed message that leaks no handler text', async () => {
  const reg = createMcpRegistry({ enabled: true, tools: [{ name: 'x', kind: 'read', handler: () => { throw new Error('db password=hunter2'); } }] });
  const out = await reg.call({ companyId: 'co-1', tool: 'x' });
  assert.deepEqual(out, { ok: false, code: 'tool_failed', message: TOOL_FAILED_MESSAGE });
  assert.doesNotMatch(JSON.stringify(out), /hunter2/);
});

test('a write approval is bound to the exact params: other params are refused and never run', async () => {
  let ran = 0;
  const bound = (id, co, tool, sha) => sha === hashToolParams({ jobId: 'j1' }) && approvals.has(`${id}|${co}|${tool}`);
  const reg = createMcpRegistry({
    enabled: true,
    tools: [{ name: 'jobs.cancel', kind: 'write', handler: () => { ran += 1; return 'cancelled'; } }],
    checkApproval: bound,
  });
  const other = await reg.call({ companyId: 'co-1', tool: 'jobs.cancel', approvalId: 'appr-1', params: { jobId: 'j2' } });
  assert.equal(other.code, 'approval_rejected');
  assert.equal(ran, 0);
  const same = await reg.call({ companyId: 'co-1', tool: 'jobs.cancel', approvalId: 'appr-1', params: { jobId: 'j1' } });
  assert.deepEqual(same, { ok: true, result: 'cancelled' });
  assert.equal(ran, 1);
});

test('params that cannot be serialised are refused for a write tool, not run', async () => {
  let ran = 0;
  const reg = createMcpRegistry({
    enabled: true,
    tools: [{ name: 'jobs.cancel', kind: 'write', handler: () => { ran += 1; return 'x'; } }],
    checkApproval: () => true,
  });
  const cyclic = {};
  cyclic.self = cyclic;
  const out = await reg.call({ companyId: 'co-1', tool: 'jobs.cancel', approvalId: 'appr-1', params: cyclic });
  assert.equal(out.code, 'approval_rejected');
  assert.equal(ran, 0);
});

test('duplicate tool names are rejected at construction', () => {
  assert.throws(() => createMcpRegistry({ enabled: true, tools: [readTool, readTool] }), /duplicate/);
});

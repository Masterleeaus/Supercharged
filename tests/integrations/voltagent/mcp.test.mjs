import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpRegistry } from '../../../server/integrations/voltagent/mcp/tools.ts';

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

test('a throwing handler becomes tool_failed', async () => {
  const reg = createMcpRegistry({ enabled: true, tools: [{ name: 'x', kind: 'read', handler: () => { throw new Error('down'); } }] });
  assert.deepEqual(await reg.call({ companyId: 'co-1', tool: 'x' }), { ok: false, code: 'tool_failed', message: 'tool failed' });
});

test('duplicate tool names are rejected at construction', () => {
  assert.throws(() => createMcpRegistry({ enabled: true, tools: [readTool, readTool] }), /duplicate/);
});

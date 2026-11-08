/**
 * Checklist item: "Separate read, draft, and execute capabilities" (supercharged-fixes-checklist.md, line 62).
 *
 * Proves, with fakes only (no network, no database, no real handler), that:
 *   1. a read tool cannot execute a write;
 *   2. a draft tool produces a staged action and cannot send or pay;
 *   3. an execute (write) tool is refused under the Suggest and Assist tiers;
 *   4. a tool with no declared class is treated as write.
 *
 * Tests that assert a property the code does not yet meet are expected to fail. Each failing test names the
 * file and line that causes it in its message. Source files are not changed by this test.
 *
 * Run: cd /home/claude/desk-review && node --test --experimental-transform-types tests/workforce/capability-separation.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Silence console output before any server code is imported. The test runner's IPC breaks on stdout.
const noop = () => {};
console.log = noop;
console.info = noop;
console.warn = noop;
console.error = noop;

const { createToolRegistry } = await import('../../server/workforce/runtime/tool-registry.ts');
const { createToolSimulator, runSimulatedWorkflow } = await import('../../server/workforce/tools/simulator.ts');
const { TOOL_ACCESS } = await import('../../server/workforce/catalogue/tool-access.ts');

const CO = 'company-1';
const SCHEMA = {};

function fakeGate() {
  const approvals = new Map();
  let seq = 0;
  return {
    gateCalls: 0,
    async gateAction(req) {
      this.gateCalls += 1;
      const id = `ap-${++seq}`;
      approvals.set(id, { id, companyId: req.companyId, action: req.action, status: 'pending', paramsSha256: req.context.paramsSha256, executed: false });
      return { status: 'pending', approval: { id } };
    },
    async readApproval(companyId, id) {
      const a = approvals.get(id);
      return a ? { ...a } : null;
    },
    async claimApproval(companyId, id) {
      const a = approvals.get(id);
      if (!a || a.companyId !== companyId || a.status !== 'approved' || a.executed) return false;
      a.executed = true;
      return true;
    },
  };
}

/** A registry with an in-memory audit sink and a fake gate. Every registered handler is a counting spy. */
function setup(tools) {
  const gate = fakeGate();
  const audited = [];
  const registry = createToolRegistry({
    gate,
    redact: (value) => value,
    audit: { record: async (event) => { audited.push(event); } },
  });
  const calls = {};
  for (const def of tools) {
    calls[def.id] = 0;
    registry.register({
      schema: SCHEMA,
      ...def,
      handler: async () => {
        calls[def.id] += 1;
        return { ok: true };
      },
    });
  }
  return { registry, gate, audited, calls };
}

const agent = (autonomy, extra = {}) => ({ kind: 'agent', agentId: 'agent-1', roleId: 'role-1', autonomy, ...extra });

// ---------------------------------------------------------------------------
// 1. A read tool cannot execute a write
// ---------------------------------------------------------------------------

test('R1: a tool declared read runs under Suggest, so the read class is usable', async () => {
  const { registry, calls } = setup([{ id: 'invoices.list', risk: 'low', access: 'read' }]);
  const result = await registry.invoke({ companyId: CO, toolId: 'invoices.list', params: {}, actor: agent('suggest') });
  assert.equal(result.outcome, 'executed');
  assert.equal(calls['invoices.list'], 1);
});

test('R2: every tool classed read in TOOL_ACCESS has a read verb as its last segment', () => {
  const readVerbs = new Set(['list', 'get', 'search', 'view', 'check', 'status', 'read', 'availability', 'lookup']);
  const misclassified = Object.entries(TOOL_ACCESS)
    .filter(([toolId, access]) => access === 'read' && !readVerbs.has(toolId.split('.').pop()))
    .map(([toolId]) => toolId);
  assert.deepEqual(misclassified, [], `read-classed tools with a non-read verb: ${misclassified.join(', ')}`);
});

test('R3: a write-named tool whose role claims toolAccess read is refused under Suggest', async () => {
  // Expected to FAIL. tool-registry.ts:410 (resolveAccess) takes the role's 'read' claim at face value, so the
  // registry runs a write-named tool as a read. Nothing in the runtime checks that claim against TOOL_ACCESS;
  // only tests/workforce/capability-classes.test.mjs does.
  const { registry, calls } = setup([{ id: 'clients.create', risk: 'low' }]);
  const actor = agent('suggest', { toolAccess: { 'clients.create': 'read' } });
  const result = await registry.invoke({ companyId: CO, toolId: 'clients.create', params: {}, actor });
  assert.notEqual(result.outcome, 'executed', 'a suggest agent executed a write-named tool because its role said read');
  assert.equal(calls['clients.create'], 0);
});

test('R4: a tool declared read cannot override a role that declares it write (stricter must win)', async () => {
  // Expected to FAIL. tool-registry.ts:410 returns the tool's own access before the role's, so a tool registered
  // as read runs under Suggest even when the role says write. Judgment: the stricter declaration should win.
  const { registry, calls } = setup([{ id: 'notes.write', risk: 'low', access: 'read' }]);
  const actor = agent('suggest', { toolAccess: { 'notes.write': 'write' } });
  const result = await registry.invoke({ companyId: CO, toolId: 'notes.write', params: {}, actor });
  assert.notEqual(result.outcome, 'executed', 'a tool declared read ran although its role declared write');
  assert.equal(calls['notes.write'], 0);
});

// ---------------------------------------------------------------------------
// 2. A draft tool produces a staged action and cannot send or pay
// ---------------------------------------------------------------------------

test('D1: a draft tool is staged, not executed, under Auto at low risk', async () => {
  // Expected to FAIL. There is no draft class. customer_messages.draft is classed write (tool-access.ts:34), so it
  // runs straight through to the handler and returns 'executed' (tool-registry.ts:828). Nothing marks it staged.
  const { registry, calls } = setup([{ id: 'customer_messages.draft', risk: 'low' }]);
  const result = await registry.invoke({ companyId: CO, toolId: 'customer_messages.draft', params: {}, actor: agent('auto') });
  assert.notEqual(result.outcome, 'executed', 'a draft tool ran straight through to its handler instead of staging');
  assert.equal(calls['customer_messages.draft'], 0);
});

test('D2: a draft tool under Predictive with no staging function is refused and does not run', async () => {
  const { registry, calls } = setup([{ id: 'messages.draft_customer', risk: 'low' }]);
  const result = await registry.invoke({ companyId: CO, toolId: 'messages.draft_customer', params: {}, actor: agent('predictive') });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'direct_write_refused');
  assert.equal(calls['messages.draft_customer'], 0);
});

test('D3: a customer send cannot run under Auto without a verified approval', async () => {
  const { registry, gate, calls } = setup([{ id: 'customer_messages.send', risk: 'low' }]);
  const result = await registry.invoke({ companyId: CO, toolId: 'customer_messages.send', params: {}, actor: agent('auto') });
  assert.equal(result.outcome, 'awaiting_approval');
  assert.equal(gate.gateCalls, 1);
  assert.equal(calls['customer_messages.send'], 0);
});

test('D4: a purchase-order draft (money out) cannot run under Auto without a verified approval', async () => {
  const { registry, gate, calls } = setup([{ id: 'purchase_orders.draft', risk: 'low' }]);
  const result = await registry.invoke({ companyId: CO, toolId: 'purchase_orders.draft', params: {}, actor: agent('auto') });
  assert.equal(result.outcome, 'awaiting_approval');
  assert.equal(gate.gateCalls, 1);
  assert.equal(calls['purchase_orders.draft'], 0);
});

test('D5: a money-category tool cannot run under Auto without a verified approval, whatever its name', async () => {
  const { registry, calls } = setup([{ id: 'ledger.adjust', risk: 'low', category: 'money' }]);
  const result = await registry.invoke({ companyId: CO, toolId: 'ledger.adjust', params: {}, actor: agent('auto') });
  assert.equal(result.outcome, 'awaiting_approval');
  assert.equal(calls['ledger.adjust'], 0);
});

// ---------------------------------------------------------------------------
// 3. An execute (write) tool is refused under Suggest and Assist
// ---------------------------------------------------------------------------

test('E1: a write tool is refused under Suggest and its handler does not run', async () => {
  const { registry, calls } = setup([{ id: 'clients.create', risk: 'low', access: 'write' }]);
  const result = await registry.invoke({ companyId: CO, toolId: 'clients.create', params: {}, actor: agent('suggest') });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'authority_denied');
  assert.equal(calls['clients.create'], 0);
});

test('E2: a write tool is refused under Assist and its handler does not run', async () => {
  const { registry, calls } = setup([{ id: 'clients.create', risk: 'low', access: 'write' }]);
  const result = await registry.invoke({ companyId: CO, toolId: 'clients.create', params: {}, actor: agent('assist') });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'authority_denied');
  assert.equal(calls['clients.create'], 0);
});

test('E3: a money write is refused under Assist and under Suggest', async () => {
  const { registry, calls } = setup([{ id: 'ledger.adjust', risk: 'low', access: 'write', category: 'money' }]);
  for (const autonomy of ['assist', 'suggest']) {
    const result = await registry.invoke({ companyId: CO, toolId: 'ledger.adjust', params: {}, actor: agent(autonomy) });
    assert.equal(result.outcome, 'refused', `${autonomy} should refuse a money write`);
  }
  assert.equal(calls['ledger.adjust'], 0);
});

test('E4: a read tool is refused under Assist, because Assist runs no tools', async () => {
  const { registry, calls } = setup([{ id: 'invoices.list', risk: 'low', access: 'read' }]);
  const result = await registry.invoke({ companyId: CO, toolId: 'invoices.list', params: {}, actor: agent('assist') });
  assert.equal(result.outcome, 'refused');
  assert.equal(calls['invoices.list'], 0);
});

// ---------------------------------------------------------------------------
// 4. A tool with no declared class is treated as write
// ---------------------------------------------------------------------------

test('U1: a tool with no access and no role toolAccess is treated as write and refused under Suggest', async () => {
  const { registry, calls } = setup([{ id: 'customers.note', risk: 'low' }]);
  const result = await registry.invoke({ companyId: CO, toolId: 'customers.note', params: {}, actor: agent('suggest') });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'authority_denied');
  assert.equal(calls['customers.note'], 0);
});

test('U2: an access value that is neither read nor write is refused at every tier (fail closed)', async () => {
  const { registry, calls } = setup([{ id: 'ops.run', risk: 'low', access: 'execute' }]);
  for (const autonomy of ['suggest', 'auto', 'predictive']) {
    const result = await registry.invoke({ companyId: CO, toolId: 'ops.run', params: {}, actor: agent(autonomy) });
    assert.equal(result.outcome, 'refused', `${autonomy} should refuse an unknown access class`);
  }
  assert.equal(calls['ops.run'], 0);
});

test('U3: the simulator treats a tool with no access as write and never calls its handler', () => {
  let handlerCalls = 0;
  const sim = createToolSimulator([
    { id: 'customers.note', risk: 'low', schema: { text: { type: 'string', required: true } }, handler: () => { handlerCalls += 1; } },
  ]);
  const [result] = runSimulatedWorkflow(sim, [{ tool: 'customers.note', input: { text: 'hi' } }]);
  assert.equal(result.wouldExecute, false);
  assert.equal(result.reason, 'simulated_write_refused');
  assert.equal(handlerCalls, 0);
});

test('U4: the simulator treats an unknown access value as write (fail closed)', () => {
  let handlerCalls = 0;
  const sim = createToolSimulator([
    { id: 'ops.run', risk: 'low', access: 'execute', schema: {}, handler: () => { handlerCalls += 1; } },
  ]);
  const [result] = runSimulatedWorkflow(sim, [{ tool: 'ops.run', input: {} }]);
  assert.equal(result.wouldExecute, false);
  assert.equal(handlerCalls, 0);
});

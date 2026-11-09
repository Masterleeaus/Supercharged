/**
 * Tests that the tool registry's authority decision goes through evaluatePolicy: category gates,
 * the authority ladder, and company rules. In-memory audit, fake approval gate, fake handlers.
 * No network, no database.
 * Run: cd /home/claude/desk-review && node --test --experimental-transform-types tests/workforce/tool-registry-policy.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry } from '../../server/workforce/runtime/tool-registry.ts';

const CO = 'company-1';

function fakeGate() {
  const approvals = new Map();
  let seq = 0;
  return {
    approvals,
    gateCalls: 0,
    async gateAction(req) {
      this.gateCalls += 1;
      const id = `ap-${++seq}`;
      approvals.set(id, {
        id,
        companyId: req.companyId,
        action: req.action,
        status: 'pending',
        decidedBy: null,
        paramsSha256: req.context.paramsSha256,
        executed: false,
      });
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
    decide(id, status, decidedBy = 'dashboard:owner') {
      const a = approvals.get(id);
      a.status = status;
      a.decidedBy = decidedBy;
    },
  };
}

function setup({ companyPolicy, tools }) {
  const gate = fakeGate();
  const audited = [];
  const registry = createToolRegistry({
    gate,
    redact: (value) => value,
    audit: { record: async (event) => { audited.push(event); } },
    companyPolicy,
  });
  const calls = {};
  for (const def of tools) {
    calls[def.id] = 0;
    registry.register({
      ...def,
      handler: async () => {
        calls[def.id] += 1;
        return { ok: true };
      },
    });
  }
  return { registry, gate, audited, calls };
}

const agent = (autonomy) => ({ kind: 'agent', agentId: 'agent-1', roleId: 'role-1', autonomy });

test('a money-category tool at auto with no approval requires approval and does not run', async () => {
  const { registry, gate, calls } = setup({
    tools: [{ id: 'payments.refund', risk: 'low', access: 'write', category: 'money', schema: {} }],
  });
  const result = await registry.invoke({ companyId: CO, toolId: 'payments.refund', params: {}, identityVerified: true, actor: agent('auto') });
  assert.equal(result.outcome, 'awaiting_approval');
  assert.equal(gate.gateCalls, 1);
  assert.equal(calls['payments.refund'], 0);
});

test('a money-category tool at auto runs once a verified owner approval covers the exact params', async () => {
  const { registry, gate, calls } = setup({
    tools: [{ id: 'payments.refund', risk: 'low', access: 'write', category: 'money', schema: {} }],
  });
  const first = await registry.invoke({ companyId: CO, toolId: 'payments.refund', params: {}, identityVerified: true, actor: agent('auto') });
  assert.equal(first.outcome, 'awaiting_approval');
  gate.decide(first.approvalId, 'approved');
  const second = await registry.invoke({
    companyId: CO,
    toolId: 'payments.refund',
    params: {},
    identityVerified: true, actor: agent('auto'),
    approvalId: first.approvalId,
  });
  assert.equal(second.outcome, 'executed');
  assert.equal(calls['payments.refund'], 1);
});

test('a suggest read tool at low risk is allowed and runs', async () => {
  const { registry, calls } = setup({
    tools: [{ id: 'invoices.list', risk: 'low', access: 'read', schema: {} }],
  });
  const result = await registry.invoke({ companyId: CO, toolId: 'invoices.list', params: {}, identityVerified: true, actor: agent('suggest') });
  assert.equal(result.outcome, 'executed');
  assert.equal(calls['invoices.list'], 1);
});

test('a suggest write tool is denied by the ladder and does not run', async () => {
  const { registry, gate, calls } = setup({
    tools: [{ id: 'notes.write', risk: 'low', access: 'write', schema: {} }],
  });
  const result = await registry.invoke({ companyId: CO, toolId: 'notes.write', params: {}, identityVerified: true, actor: agent('suggest') });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'authority_denied');
  assert.equal(result.message, 'suggest agents cannot write or send');
  assert.equal(gate.gateCalls, 0);
  assert.equal(calls['notes.write'], 0);
});

test('a ladder deny cannot become allow with a company rule or an approval', async () => {
  const { registry, gate, calls } = setup({
    companyPolicy: { requireApprovalFor: ['notes.write'], deniedTools: [] },
    tools: [{ id: 'notes.write', risk: 'low', access: 'write', schema: {} }],
  });
  const result = await registry.invoke({ companyId: CO, toolId: 'notes.write', params: {}, identityVerified: true, actor: agent('suggest') });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'authority_denied');

  // Even a verified owner approval for this exact action cannot lift the ladder deny.
  gate.approvals.set('ap-x', {
    id: 'ap-x',
    companyId: CO,
    action: 'notes.write',
    status: 'approved',
    decidedBy: 'dashboard:owner',
    paramsSha256: null,
    executed: false,
  });
  const withApproval = await registry.invoke({
    companyId: CO,
    toolId: 'notes.write',
    params: {},
    identityVerified: true, actor: agent('suggest'),
    approvalId: 'ap-x',
  });
  assert.equal(withApproval.outcome, 'refused');
  assert.equal(calls['notes.write'], 0);
});

test('a company deniedTools entry refuses an action the ladder would allow', async () => {
  const { registry, calls } = setup({
    companyPolicy: { deniedTools: ['invoices.list'] },
    tools: [{ id: 'invoices.list', risk: 'low', access: 'read', schema: {} }],
  });
  const result = await registry.invoke({ companyId: CO, toolId: 'invoices.list', params: {}, identityVerified: true, actor: agent('auto') });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'authority_denied');
  assert.equal(calls['invoices.list'], 0);
});

test('a company requireApprovalFor entry sends an allowed action to the gate', async () => {
  const { registry, gate, calls } = setup({
    companyPolicy: { requireApprovalFor: ['invoices.list'] },
    tools: [{ id: 'invoices.list', risk: 'low', access: 'read', schema: {} }],
  });
  const result = await registry.invoke({ companyId: CO, toolId: 'invoices.list', params: {}, identityVerified: true, actor: agent('auto') });
  assert.equal(result.outcome, 'awaiting_approval');
  assert.equal(gate.gateCalls, 1);
  assert.equal(calls['invoices.list'], 0);
});

test('an absent category is treated as other and does not add a category gate', async () => {
  const { registry, calls } = setup({
    tools: [{ id: 'notes.summarise', risk: 'low', access: 'write', schema: {} }],
  });
  const result = await registry.invoke({ companyId: CO, toolId: 'notes.summarise', params: {}, identityVerified: true, actor: agent('auto') });
  assert.equal(result.outcome, 'executed');
  assert.equal(calls['notes.summarise'], 1);
});

test('a tool with an unknown category is refused at registration', () => {
  const registry = createToolRegistry({
    gate: fakeGate(),
    redact: (value) => value,
    audit: { record: async () => {} },
  });
  assert.throws(
    () => registry.register({ id: 'bad.tool', risk: 'low', access: 'read', category: 'payments', schema: {}, handler: () => ({}) }),
    /unknown category/,
  );
});

test('a caller whose identity is not verified is refused, whatever the autonomy, and the handler does not run', async () => {
  const { registry, gate, calls, audited } = setup({
    tools: [{ id: 'invoices.list', risk: 'low', access: 'read', schema: {} }],
  });
  const missing = await registry.invoke({ companyId: CO, toolId: 'invoices.list', params: {}, actor: agent('auto') });
  const falsy = await registry.invoke({ companyId: CO, toolId: 'invoices.list', params: {}, identityVerified: false, actor: agent('auto') });
  const notBoolean = await registry.invoke({ companyId: CO, toolId: 'invoices.list', params: {}, identityVerified: 'yes', actor: agent('auto') });
  for (const result of [missing, falsy, notBoolean]) {
    assert.equal(result.outcome, 'refused');
    assert.equal(result.reason, 'actor_unverified');
  }
  assert.equal(calls['invoices.list'], 0);
  assert.equal(gate.gateCalls, 0);
  assert.ok(audited.some((event) => JSON.stringify(event).includes('actor_unverified')), 'refusal was not audited');
});

test('a human caller that is not verified is refused for a write too', async () => {
  const { registry, calls } = setup({
    tools: [{ id: 'notes.write', risk: 'low', access: 'write', schema: {} }],
  });
  const result = await registry.invoke({ companyId: CO, toolId: 'notes.write', params: {}, actor: { kind: 'human', userId: 'user-1' } });
  assert.equal(result.reason, 'actor_unverified');
  assert.equal(calls['notes.write'], 0);
});

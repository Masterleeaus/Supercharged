import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovalGate } from '../../server/modules/approvals/approval-gate-adapter.ts';

// In-memory stand-in for ApprovalService. It keeps the two properties the gate depends on:
// every lookup is scoped by companyId, and markExecuted only succeeds on an approved,
// unexecuted row (the SQL conditional update in approval-service.ts). No database, no Express.

const COMPANY_A = '11111111-1111-4111-8111-111111111111';
const COMPANY_B = '22222222-2222-4222-8222-222222222222';

function memoryService() {
  const rows = new Map();
  let seq = 0;

  const view = (row) => ({
    id: row.id,
    action: row.action,
    status: row.status,
    decidedBy: row.decidedBy,
    paramsSha256: row.paramsSha256,
    executedAt: row.executedAt,
  });

  return {
    async gateAction(input) {
      const row = {
        id: `apr-${++seq}`,
        companyId: input.companyId,
        action: input.action,
        status: 'pending',
        decidedBy: null,
        paramsSha256: typeof input.context?.paramsSha256 === 'string' ? input.context.paramsSha256 : null,
        executedAt: null,
      };
      rows.set(row.id, row);
      return { status: 'pending', approval: view(row), decision: 'route_to_human', policyId: null };
    },
    async getApproval(companyId, id) {
      const row = rows.get(id);
      return row && row.companyId === companyId ? view(row) : null;
    },
    async markExecuted(companyId, id) {
      const row = rows.get(id);
      if (!row || row.companyId !== companyId || row.status !== 'approved' || row.executedAt !== null) return null;
      row.executedAt = new Date();
      return view(row);
    },
    /** Test helper: a human decision, as decideApproval would record it. */
    approve(id, decidedBy = 'dashboard:user-1') {
      const row = rows.get(id);
      row.status = 'approved';
      row.decidedBy = decidedBy;
    },
    reject(id) {
      const row = rows.get(id);
      row.status = 'rejected';
      row.decidedBy = 'dashboard:user-1';
    },
  };
}

async function requestApproval(gate, companyId, paramsSha256 = 'sha-1') {
  const requested = await gate.gateAction({
    companyId,
    requestedBy: 'agent-user',
    agentId: 'agent-1',
    action: 'send_quote',
    params: { customer: 'c-1' },
    context: { paramsSha256, runId: 'run-1', tier: 'write', roleId: 'role-1' },
    urgency: 'normal',
    ttlMs: 60_000,
  });
  return requested.approval.id;
}

test('gateAction records a pending request and returns its id', async () => {
  const svc = memoryService();
  const gate = createApprovalGate(svc);
  const id = await requestApproval(gate, COMPANY_A, 'sha-abc');

  const record = await gate.readApproval(COMPANY_A, id);
  assert.equal(record.status, 'pending');
  assert.equal(record.paramsSha256, 'sha-abc');
  assert.equal(record.executed, false);
});

test('an approved approval can be claimed once; the second claim fails', async () => {
  const svc = memoryService();
  const gate = createApprovalGate(svc);
  const id = await requestApproval(gate, COMPANY_A);
  svc.approve(id);

  assert.equal(await gate.claimApproval(COMPANY_A, id, 'user-1'), true);
  assert.equal(await gate.claimApproval(COMPANY_A, id, 'user-1'), false);
  assert.equal((await gate.readApproval(COMPANY_A, id)).executed, true);
});

test('concurrent claims of the same approval: exactly one succeeds', async () => {
  const svc = memoryService();
  const gate = createApprovalGate(svc);
  const id = await requestApproval(gate, COMPANY_A);
  svc.approve(id);

  const results = await Promise.all([1, 2, 3, 4].map(() => gate.claimApproval(COMPANY_A, id, null)));
  assert.equal(results.filter(Boolean).length, 1);
});

test('a claim for another company fails and does not consume the approval', async () => {
  const svc = memoryService();
  const gate = createApprovalGate(svc);
  const id = await requestApproval(gate, COMPANY_A);
  svc.approve(id);

  assert.equal(await gate.claimApproval(COMPANY_B, id, 'user-2'), false);
  assert.equal(await gate.readApproval(COMPANY_B, id), null);
  assert.equal((await gate.readApproval(COMPANY_A, id)).executed, false);
  assert.equal(await gate.claimApproval(COMPANY_A, id, 'user-1'), true);
});

test('a pending approval is not claimable', async () => {
  const svc = memoryService();
  const gate = createApprovalGate(svc);
  const id = await requestApproval(gate, COMPANY_A);

  assert.equal(await gate.claimApproval(COMPANY_A, id, 'user-1'), false);
  assert.equal((await gate.readApproval(COMPANY_A, id)).executed, false);
});

test('a rejected approval is not claimable', async () => {
  const svc = memoryService();
  const gate = createApprovalGate(svc);
  const id = await requestApproval(gate, COMPANY_A);
  svc.reject(id);

  assert.equal(await gate.claimApproval(COMPANY_A, id, 'user-1'), false);
});

test('readApproval returns null for an unknown id', async () => {
  const gate = createApprovalGate(memoryService());
  assert.equal(await gate.readApproval(COMPANY_A, 'missing'), null);
});

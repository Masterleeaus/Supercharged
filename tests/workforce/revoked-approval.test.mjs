/**
 * Tests that the tool registry refuses a call whose approval was revoked after it was granted,
 * writes an audit event for the refusal, and fails closed on an unknown status. Also checks that
 * 'approval.revoked' is a member of the AuditAction union. In-memory audit, fake approval gate.
 * No network, no database.
 * Run: cd /home/claude/desk-review && node --test --experimental-transform-types tests/workforce/revoked-approval.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createToolRegistry } from '../../server/workforce/runtime/tool-registry.ts';

const CO = 'company-1';
const TOOL = 'payments.refund';

function fakeGate() {
  const approvals = new Map();
  let seq = 0;
  return {
    approvals,
    async gateAction(req) {
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
    set(id, status, decidedBy = 'dashboard:owner') {
      const a = approvals.get(id);
      a.status = status;
      a.decidedBy = decidedBy;
    },
  };
}

function setup() {
  const gate = fakeGate();
  const audited = [];
  const registry = createToolRegistry({
    gate,
    redact: (value) => value,
    audit: { record: async (event) => { audited.push(event); } },
  });
  let runs = 0;
  registry.register({
    id: TOOL,
    risk: 'low',
    access: 'write',
    category: 'money',
    schema: {},
    handler: async () => {
      runs += 1;
      return { ok: true };
    },
  });
  return { registry, gate, audited, runs: () => runs };
}

const agent = { kind: 'agent', agentId: 'agent-1', roleId: 'role-1', autonomy: 'auto' };

/** Requests an approval, grants it by setting `status`, then invokes the tool with that approval. */
async function invokeAfterStatus(ctx, status, decidedBy) {
  const first = await ctx.registry.invoke({ companyId: CO, toolId: TOOL, params: {}, identityVerified: true, actor: agent });
  assert.equal(first.outcome, 'awaiting_approval');
  ctx.gate.set(first.approvalId, 'approved');
  // The approval is granted, then its status changes to the one under test.
  ctx.gate.set(first.approvalId, status, decidedBy);
  return ctx.registry.invoke({ companyId: CO, toolId: TOOL, params: {}, identityVerified: true, actor: agent, approvalId: first.approvalId });
}

test('an approval revoked after being granted is refused with approval_revoked and does not run', async () => {
  const ctx = setup();
  const result = await invokeAfterStatus(ctx, 'revoked');
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'approval_revoked');
  assert.equal(ctx.runs(), 0);
});

test('a revoked-approval refusal writes an audit record with the reason', async () => {
  const ctx = setup();
  await invokeAfterStatus(ctx, 'revoked');
  const refusal = ctx.audited.find((e) => e.data?.outcome === 'refused' && e.data?.reason === 'approval_revoked');
  assert.ok(refusal, 'expected a refused audit event with reason approval_revoked');
  assert.equal(refusal.companyId, CO);
  assert.equal(refusal.kind, 'tool.decision');
});

test('an unknown approval status fails closed with gate_error and does not run', async () => {
  const ctx = setup();
  const result = await invokeAfterStatus(ctx, 'withdrawn-by-magic');
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'gate_error');
  assert.equal(ctx.runs(), 0);
  assert.ok(ctx.audited.some((e) => e.data?.outcome === 'refused' && e.data?.reason === 'gate_error'));
});

test('expired and rejected approvals keep their existing refusal reasons', async () => {
  const expired = setup();
  assert.equal((await invokeAfterStatus(expired, 'expired')).reason, 'approval_expired');
  const rejected = setup();
  assert.equal((await invokeAfterStatus(rejected, 'rejected')).reason, 'approval_rejected');
  assert.equal(expired.runs() + rejected.runs(), 0);
});

test("audit-log AuditAction union contains 'approval.revoked'", () => {
  const source = readFileSync(new URL('../../server/services/audit-log.ts', import.meta.url), 'utf8');
  const union = source.slice(source.indexOf('export type AuditAction'), source.indexOf('export interface AuditLogEntry'));
  assert.match(union, /\| "approval\.revoked"/);
});

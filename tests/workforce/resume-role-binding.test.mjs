/**
 * Resume role binding after approval: a run paused on an approval must resume only for the same agent acting under
 * the same role. A resume by the same agent id under a different roleId is refused as a different actor, without
 * running the handler or consuming the approval.
 *
 * Same harness as tests/workforce/resume-integrity.test.mjs: in-memory run store and run engine, the real tool
 * registry, and the real approval gate adapter over an in-memory approval service. No database, no network, no timers.
 *
 * Run: cd /home/claude/desk-review && node --test --experimental-transform-types tests/workforce/resume-role-binding.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry, createRunEngine, createTeam, createMemoryRunStore } from '../../server/workforce/runtime/index.ts';
import { createApprovalGate } from '../../server/modules/approvals/approval-gate-adapter.ts';

const CO = 'company-1';
const TOOL = 'payments.refund';
const PARAMS = { amount: 40, payee: 'acme' };

const ROLES = new Map([
  ['coordinator', { id: 'coordinator', handoffTo: ['writer'], autonomy: 'auto' }],
  ['writer', { id: 'writer', handoffTo: ['coordinator'], autonomy: 'auto' }],
]);
const roleSource = { getRole: (id) => ROLES.get(id) ?? null };
const TEAM = createTeam(
  {
    id: 'team-1',
    name: 'Finance',
    members: [
      { roleId: 'coordinator', coordinator: true },
      { roleId: 'writer', coordinator: false },
    ],
  },
  roleSource,
);

const WRITER = { kind: 'agent', agentId: 'writer-1', roleId: 'writer' };
const SAME_AGENT_OTHER_ROLE = { kind: 'agent', agentId: 'writer-1', roleId: 'coordinator' };

/** In-memory stand-in for ApprovalService: company-scoped lookups and a conditional claim (executed_at IS NULL). */
function inMemoryApprovalService() {
  const rows = new Map();
  let seq = 0;
  const view = (r) => ({ ...r });
  return {
    rows,
    async gateAction(input) {
      const id = `ap-${++seq}`;
      const row = {
        id,
        companyId: input.companyId,
        requestedBy: input.requestedBy,
        agentId: input.agentId,
        action: input.action,
        status: 'pending',
        decidedBy: null,
        paramsSha256: typeof input.context?.paramsSha256 === 'string' ? input.context.paramsSha256 : null,
        executedAt: null,
      };
      rows.set(id, row);
      return { status: 'pending', approval: view(row), decision: 'route_to_human', policyId: null };
    },
    async getApproval(companyId, id) {
      const row = rows.get(id);
      return row && row.companyId === companyId ? view(row) : null;
    },
    async markExecuted(companyId, id) {
      const row = rows.get(id);
      if (!row || row.companyId !== companyId || row.status !== 'approved' || row.executedAt !== null) return null;
      row.executedAt = new Date('2026-11-03T00:00:00Z');
      return view(row);
    },
    decide(id, status, decidedBy) {
      const row = rows.get(id);
      row.status = status;
      row.decidedBy = decidedBy;
    },
  };
}

function setup() {
  const store = createMemoryRunStore();
  const service = inMemoryApprovalService();
  const registry = createToolRegistry({
    gate: createApprovalGate(service),
    redact: (value) => value,
    audit: { record: (event) => store.appendAudit(event) },
  });
  const executed = [];
  registry.register({
    id: TOOL,
    risk: 'low',
    access: 'write',
    category: 'money',
    schema: { amount: { type: 'number', required: true }, payee: { type: 'string' } },
    handler: (params) => {
      executed.push({ ...params });
      return { ok: true };
    },
  });
  const engine = createRunEngine({
    registry,
    store,
    audit: { record: (event) => store.appendAudit(event) },
    now: () => new Date('2026-11-03T00:00:00Z'),
    sleep: async () => {},
  });
  return { store, service, registry, engine, executed };
}

/** Starts a run and makes the requested call as the writer, which pauses the run on an approval request. */
async function pausedOnApproval(env) {
  const created = await env.engine.createRun({ companyId: CO, team: TEAM, budget: { maxTokens: 100, maxToolCalls: 10 } });
  assert.equal(created.ok, true, `createRun failed: ${created.reason}`);
  const started = await env.engine.startRun(CO, created.run.id);
  assert.equal(started.ok, true);
  const call = await env.engine.callTool(CO, started.run.id, { toolId: TOOL, params: PARAMS, identityVerified: true, actor: WRITER });
  assert.equal(call.ok, true);
  assert.equal(call.tool.outcome, 'awaiting_approval', `expected a pause, got ${call.tool.outcome}`);
  assert.equal(call.run.status, 'awaiting_approval');
  assert.equal(env.executed.length, 0, 'nothing runs before approval');
  return { runId: started.run.id, approvalId: call.tool.approvalId };
}

test('1. control: the same agent under the same role resumes the paused run', async () => {
  const env = setup();
  const { runId, approvalId } = await pausedOnApproval(env);
  env.service.decide(approvalId, 'approved', 'dashboard:owner-1');

  const resumed = await env.engine.resumeAfterApproval(CO, runId, { toolId: TOOL, params: { ...PARAMS }, identityVerified: true, actor: WRITER });
  assert.equal(resumed.ok, true, `resume refused: ${resumed.reason}`);
  assert.equal(resumed.tool.outcome, 'executed');
  assert.deepEqual(env.executed, [PARAMS]);
});

test('2. the same agent id under a different roleId is refused as a different actor, nothing runs, the approval is not consumed', async () => {
  const env = setup();
  const { runId, approvalId } = await pausedOnApproval(env);
  env.service.decide(approvalId, 'approved', 'dashboard:owner-1');

  const reRoled = await env.engine.resumeAfterApproval(CO, runId, {
    toolId: TOOL,
    params: { ...PARAMS },
    identityVerified: true, actor: SAME_AGENT_OTHER_ROLE,
  });
  assert.equal(reRoled.ok, false, 'a resume under another role must not succeed');
  assert.equal(reRoled.reason, 'actor_mismatch');
  assert.equal(reRoled.run.status, 'awaiting_approval');
  assert.equal(reRoled.run.pendingApproval.approvalId, approvalId, 'the pending approval is kept');
  assert.equal(env.executed.length, 0, 'the handler does not run under the other role');
  assert.equal(env.service.rows.get(approvalId).executedAt, null, 'the approval is not claimed');
});

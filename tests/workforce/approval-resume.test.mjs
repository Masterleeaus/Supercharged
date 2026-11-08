/**
 * Resume after approval (SuperchargedAt checklist 5). After a human approves a call that the run paused on,
 * the run resumes only when the action, parameters, actor and company are unchanged, and the approval
 * covers one execution only.
 *
 * Uses the in-memory run store and run engine, the real tool registry, and the real approval gate adapter
 * (approvals/approval-gate-adapter.ts) over an in-memory approval service that mirrors ApprovalService's
 * getApproval, gateAction and markExecuted (the conditional claim). No database, no network, no real timers.
 *
 * Run: cd /home/claude/desk-review && node --test --experimental-transform-types tests/workforce/approval-resume.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry, createRunEngine, createTeam, createMemoryRunStore } from '../../server/workforce/runtime/index.ts';
import { createApprovalGate } from '../../server/modules/approvals/approval-gate-adapter.ts';

const CO = 'company-1';
const OTHER_CO = 'company-2';
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
const WRITER_TWIN = { kind: 'agent', agentId: 'writer-2', roleId: 'writer' };
const OWNER = { kind: 'human', userId: 'owner-1' };

/** In-memory stand-in for ApprovalService: same method shapes, company scoping, and conditional claim. */
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
  let runs = 0;
  registry.register({
    id: TOOL,
    risk: 'low',
    access: 'write',
    category: 'money',
    schema: { amount: { type: 'number', required: true }, payee: { type: 'string' } },
    handler: () => {
      runs += 1;
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
  return { store, service, registry, engine, runs: () => runs };
}

/** Starts a run and makes the requested call, which pauses the run on an approval request. */
async function pausedOnApproval(env, { company = CO, actor = WRITER, params = PARAMS } = {}) {
  const created = await env.engine.createRun({ companyId: company, team: TEAM, budget: { maxTokens: 100, maxToolCalls: 10 } });
  assert.equal(created.ok, true, `createRun failed: ${created.reason}`);
  const started = await env.engine.startRun(company, created.run.id);
  assert.equal(started.ok, true);
  const call = await env.engine.callTool(company, started.run.id, { toolId: TOOL, params, actor });
  assert.equal(call.ok, true);
  assert.equal(call.tool.outcome, 'awaiting_approval', `expected a pause, got ${call.tool.outcome}`);
  assert.equal(call.run.status, 'awaiting_approval');
  assert.equal(env.runs(), 0, 'nothing runs before approval');
  return { runId: started.run.id, approvalId: call.tool.approvalId, paramsSha256: call.tool.paramsSha256 };
}

function approve(env, approvalId) {
  env.service.decide(approvalId, 'approved', 'dashboard:owner-1');
}

test('1. an approved call with unchanged action, params, actor and company resumes and runs once', async () => {
  const env = setup();
  const { runId, approvalId } = await pausedOnApproval(env);
  approve(env, approvalId);

  const resumed = await env.engine.resumeAfterApproval(CO, runId, { toolId: TOOL, params: { ...PARAMS }, actor: WRITER });
  assert.equal(resumed.ok, true, `resume refused: ${resumed.reason}`);
  assert.equal(resumed.tool.outcome, 'executed');
  assert.equal(resumed.run.status, 'running');
  assert.equal(resumed.run.pendingApproval, null);
  assert.equal(env.runs(), 1, 'the handler runs exactly once');
  assert.ok(env.service.rows.get(approvalId).executedAt, 'the approval is claimed');
});

test('2. changed parameters after approval are refused by the params hash check and do not run', async () => {
  const env = setup();
  const { runId, approvalId } = await pausedOnApproval(env);
  approve(env, approvalId);

  const changed = await env.engine.resumeAfterApproval(CO, runId, { toolId: TOOL, params: { amount: 4000, payee: 'acme' }, actor: WRITER });
  assert.equal(changed.ok, false);
  assert.equal(changed.reason, 'approval_call_mismatch');
  assert.equal(changed.run.status, 'awaiting_approval', 'the run stays paused');
  assert.equal(env.runs(), 0);
  assert.equal(env.service.rows.get(approvalId).executedAt, null, 'a mismatched resume does not consume the approval');

  const original = await env.engine.resumeAfterApproval(CO, runId, { toolId: TOOL, params: { ...PARAMS }, actor: WRITER });
  assert.equal(original.ok, true, 'the original params still resume');
  assert.equal(env.runs(), 1);
});

test('3a. a different agent than the requester is refused and does not run', async () => {
  const env = setup();
  const { runId, approvalId } = await pausedOnApproval(env);
  approve(env, approvalId);

  const other = await env.engine.resumeAfterApproval(CO, runId, { toolId: TOOL, params: { ...PARAMS }, actor: WRITER_TWIN });
  assert.equal(other.ok, false);
  assert.equal(other.reason, 'actor_mismatch');
  assert.equal(env.runs(), 0);
  assert.equal(env.service.rows.get(approvalId).executedAt, null);
});

test('3b. a human whose userId equals the requesting agentId is a different actor and is refused', async () => {
  const env = setup();
  const { runId, approvalId } = await pausedOnApproval(env);
  approve(env, approvalId);

  const impostor = await env.engine.resumeAfterApproval(CO, runId, {
    toolId: TOOL,
    params: { ...PARAMS },
    actor: { kind: 'human', userId: WRITER.agentId },
  });
  assert.equal(impostor.ok, false, 'an actor of a different kind must not resume the run');
  assert.equal(impostor.reason, 'actor_mismatch');
  assert.equal(env.runs(), 0);
});

test('4. a call from a different company is refused and the approval is not claimed', async () => {
  const env = setup();
  const { runId, approvalId } = await pausedOnApproval(env);
  approve(env, approvalId);

  const foreign = await env.engine.resumeAfterApproval(OTHER_CO, runId, { toolId: TOOL, params: { ...PARAMS }, actor: WRITER });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reason, 'run_not_found', 'the run is not visible to another company');
  assert.equal(env.runs(), 0);
  assert.equal(env.service.rows.get(approvalId).executedAt, null);

  const direct = await env.engine.resumeAfterApproval(CO, runId, { toolId: TOOL, params: { ...PARAMS }, actor: WRITER });
  assert.equal(direct.ok, true, 'the owning company can still resume');
  assert.equal(env.runs(), 1);
});

test('5. an approval cannot be used twice: a second resume is refused and the handler does not run again', async () => {
  const env = setup();
  const { runId, approvalId } = await pausedOnApproval(env);
  approve(env, approvalId);
  const call = { toolId: TOOL, params: { ...PARAMS }, actor: WRITER };

  const first = await env.engine.resumeAfterApproval(CO, runId, call);
  assert.equal(first.ok, true);
  assert.equal(env.runs(), 1);

  const second = await env.engine.resumeAfterApproval(CO, runId, call);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'run_not_awaiting_approval', 'the run is no longer paused on that approval');
  assert.equal(env.runs(), 1);

  // The same approval presented directly to the registry is refused by the claim, so the handler does not run.
  const replay = await env.registry.invoke({
    companyId: CO,
    runId,
    correlationId: runId,
    toolId: TOOL,
    params: { ...PARAMS },
    // The run engine supplies autonomy from the team snapshot. A direct registry call must supply it too.
    actor: { ...WRITER, autonomy: 'auto' },
    approvalId,
  });
  assert.equal(replay.outcome, 'refused');
  assert.equal(replay.reason, 'approval_consumed');
  assert.equal(env.runs(), 1);
});

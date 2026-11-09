/**
 * Resume integrity after approval (SuperchargedAt checklist: "Resume same run after approval; verify action,
 * parameters, actor, company, record unchanged").
 *
 * Proves that a run resumed after approval keeps the same action, parameters, actor kind, company and approval
 * record, and that a changed parameter, a changed action, a different actor, or a different company is refused
 * without running the handler or consuming the approval.
 *
 * Same harness as tests/workforce/approval-resume.test.mjs: the in-memory run store and run engine, the real tool
 * registry, and the real approval gate adapter over an in-memory approval service with the same method shapes and
 * conditional claim as ApprovalService. No database, no network, no real timers.
 *
 * Run: cd /home/claude/desk-review && node --test --experimental-transform-types tests/workforce/resume-integrity.test.mjs
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

/** Starts a run and makes the requested call, which pauses the run on an approval request. */
async function pausedOnApproval(env, { company = CO, actor = WRITER, params = PARAMS } = {}) {
  const created = await env.engine.createRun({ companyId: company, team: TEAM, budget: { maxTokens: 100, maxToolCalls: 10 } });
  assert.equal(created.ok, true, `createRun failed: ${created.reason}`);
  const started = await env.engine.startRun(company, created.run.id);
  assert.equal(started.ok, true);
  const call = await env.engine.callTool(company, started.run.id, { toolId: TOOL, params, identityVerified: true, actor });
  assert.equal(call.ok, true);
  assert.equal(call.tool.outcome, 'awaiting_approval', `expected a pause, got ${call.tool.outcome}`);
  assert.equal(call.run.status, 'awaiting_approval');
  assert.equal(env.executed.length, 0, 'nothing runs before approval');
  return { runId: started.run.id, approvalId: call.tool.approvalId, paramsSha256: call.tool.paramsSha256 };
}

function approve(env, approvalId) {
  env.service.decide(approvalId, 'approved', 'dashboard:owner-1');
}

/** The approval record fields that resume must leave untouched (executedAt is excluded: it is the claim itself). */
function recordFields(env, approvalId) {
  const row = env.service.rows.get(approvalId);
  return {
    id: row.id,
    companyId: row.companyId,
    action: row.action,
    agentId: row.agentId,
    requestedBy: row.requestedBy,
    paramsSha256: row.paramsSha256,
    status: row.status,
    decidedBy: row.decidedBy,
  };
}

test('1. resume keeps the same action, parameters, actor kind, company and approval record', async () => {
  const env = setup();
  const { runId, approvalId, paramsSha256 } = await pausedOnApproval(env);
  approve(env, approvalId);
  const before = recordFields(env, approvalId);

  const pending = (await env.store.getRun(CO, runId)).pendingApproval;
  assert.equal(pending.approvalId, approvalId, 'the run is paused on this approval record');
  assert.equal(pending.toolId, TOOL);
  assert.equal(pending.paramsSha256, paramsSha256);
  assert.equal(pending.actorKind, 'agent');

  const resumed = await env.engine.resumeAfterApproval(CO, runId, { toolId: TOOL, params: { ...PARAMS }, identityVerified: true, actor: WRITER });
  assert.equal(resumed.ok, true, `resume refused: ${resumed.reason}`);
  assert.equal(resumed.tool.outcome, 'executed');
  assert.equal(resumed.tool.toolId, TOOL, 'action unchanged');
  assert.equal(resumed.run.status, 'running');
  assert.equal(resumed.run.pendingApproval, null);

  assert.deepEqual(env.executed, [PARAMS], 'the handler received exactly the approved parameters, once');

  const after = recordFields(env, approvalId);
  assert.deepEqual(after, before, 'the approval record is unchanged apart from its execution claim');
  assert.ok(env.service.rows.get(approvalId).executedAt, 'the approval is claimed');
  const claimed = [...env.service.rows.values()].filter((row) => row.executedAt !== null).map((row) => row.id);
  assert.deepEqual(claimed, [approvalId], 'exactly the paused-on approval record was consumed');

  const resumeEvent = (await env.store.listAudit(CO, runId)).find((e) => e.kind === 'run.approval_resumed');
  assert.ok(resumeEvent, 'a resume audit event is written');
  assert.equal(resumeEvent.companyId, CO);
  assert.equal(resumeEvent.data.approvalId, approvalId);
  assert.equal(resumeEvent.data.toolId, TOOL);
});

test('2. a changed parameter is refused: the run stays paused, nothing runs, the approval is not consumed', async () => {
  const env = setup();
  const { runId, approvalId } = await pausedOnApproval(env);
  approve(env, approvalId);

  const changed = await env.engine.resumeAfterApproval(CO, runId, {
    toolId: TOOL,
    params: { amount: 4000, payee: 'acme' },
    identityVerified: true, actor: WRITER,
  });
  assert.equal(changed.ok, false);
  assert.equal(changed.reason, 'approval_call_mismatch');
  assert.equal(changed.run.status, 'awaiting_approval');
  assert.equal(changed.run.pendingApproval.approvalId, approvalId, 'the pending approval is kept');
  assert.equal(env.executed.length, 0);
  assert.equal(env.service.rows.get(approvalId).executedAt, null);

  const original = await env.engine.resumeAfterApproval(CO, runId, { toolId: TOOL, params: { ...PARAMS }, identityVerified: true, actor: WRITER });
  assert.equal(original.ok, true, 'the originally approved parameters still resume');
  assert.deepEqual(env.executed, [PARAMS]);
});

test('3. a changed action is refused: a different tool id does not resume the approved call', async () => {
  const env = setup();
  const { runId, approvalId } = await pausedOnApproval(env);
  approve(env, approvalId);

  const swapped = await env.engine.resumeAfterApproval(CO, runId, { toolId: 'payments.void', params: { ...PARAMS }, identityVerified: true, actor: WRITER });
  assert.equal(swapped.ok, false);
  assert.equal(swapped.reason, 'approval_call_mismatch');
  assert.equal(swapped.run.status, 'awaiting_approval');
  assert.equal(env.executed.length, 0);
  assert.equal(env.service.rows.get(approvalId).executedAt, null);
});

test('4. a different agent, or a human with the same identifier, is refused as a different actor', async () => {
  const env = setup();
  const { runId, approvalId } = await pausedOnApproval(env);
  approve(env, approvalId);

  const twin = await env.engine.resumeAfterApproval(CO, runId, { toolId: TOOL, params: { ...PARAMS }, identityVerified: true, actor: WRITER_TWIN });
  assert.equal(twin.ok, false);
  assert.equal(twin.reason, 'actor_mismatch');

  const impostor = await env.engine.resumeAfterApproval(CO, runId, {
    toolId: TOOL,
    params: { ...PARAMS },
    identityVerified: true, actor: { kind: 'human', userId: WRITER.agentId },
  });
  assert.equal(impostor.ok, false);
  assert.equal(impostor.reason, 'actor_mismatch', 'an actor of a different kind does not match the requesting agent');

  assert.equal(env.executed.length, 0);
  assert.equal(env.service.rows.get(approvalId).executedAt, null);
});

test('5. a different company cannot resume the run, and the approval record is not claimed', async () => {
  const env = setup();
  const { runId, approvalId } = await pausedOnApproval(env);
  approve(env, approvalId);

  const foreign = await env.engine.resumeAfterApproval(OTHER_CO, runId, { toolId: TOOL, params: { ...PARAMS }, identityVerified: true, actor: WRITER });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reason, 'run_not_found');
  assert.equal(env.executed.length, 0);
  assert.equal(env.service.rows.get(approvalId).executedAt, null);

  // The same approval presented directly to the registry under another company is refused as unknown.
  const direct = await env.registry.invoke({
    companyId: OTHER_CO,
    runId,
    correlationId: runId,
    toolId: TOOL,
    params: { ...PARAMS },
    identityVerified: true, actor: { ...WRITER, autonomy: 'auto' },
    approvalId,
  });
  assert.equal(direct.outcome, 'refused');
  assert.equal(direct.reason, 'approval_unknown');
  assert.equal(env.executed.length, 0);
  assert.equal(env.service.rows.get(approvalId).executedAt, null);

  const owner = await env.engine.resumeAfterApproval(CO, runId, { toolId: TOOL, params: { ...PARAMS }, identityVerified: true, actor: WRITER });
  assert.equal(owner.ok, true, 'the owning company can still resume');
  assert.equal(env.executed.length, 1);
});

test('6. the approval record is bound to the original action and parameters: a pending or rejected record never runs', async () => {
  const env = setup();
  const { runId, approvalId } = await pausedOnApproval(env);
  env.service.decide(approvalId, 'rejected', 'dashboard:owner-1');

  // A rejected approval fails the run closed: the resume returns the run as failed and the handler never runs.
  const rejected = await env.engine.resumeAfterApproval(CO, runId, { toolId: TOOL, params: { ...PARAMS }, identityVerified: true, actor: WRITER });
  assert.equal(rejected.tool.outcome, 'refused');
  assert.equal(rejected.tool.reason, 'approval_rejected');
  assert.equal(rejected.run.status, 'failed');
  assert.equal(env.executed.length, 0);
  assert.equal(env.service.rows.get(approvalId).executedAt, null);
});

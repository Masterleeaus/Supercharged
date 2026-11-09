/**
 * Tests for server/workforce/runtime. In-memory store, fake approval gate, fake handlers. No network,
 * no database, no real timers (retry sleep is recorded, not waited on).
 * Run: cd /home/claude/work/merged4 && node --test tests/workforce/runtime.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createToolRegistry,
  createRunEngine,
  createTeam,
  createMemoryRunStore,
  createUnavailableRunStore,
  transientError,
  planDelegation,
  planHandoff,
  closeDelegation,
  resolveTeamLimits,
  backoffDelay,
  StoreUnavailableError,
} from '../../server/workforce/runtime/index.ts';

const CO = 'company-1';

// ---------- fixtures ----------

const ROLE_LIST = [
  { id: 'coordinator', handoffTo: ['writer', 'reviewer', 'booker', 'a', 'b', 'c', 'd', 'e'], autonomy: 'auto' },
  { id: 'writer', handoffTo: ['reviewer'], autonomy: 'auto', toolRisk: { publish_page: 'low' } },
  { id: 'reviewer', handoffTo: ['writer', 'coordinator'], autonomy: 'auto' },
  { id: 'booker', handoffTo: [], autonomy: 'auto', toolRisk: {} },
  { id: 'a', handoffTo: ['b'], autonomy: 'auto' },
  { id: 'b', handoffTo: ['c'], autonomy: 'auto' },
  { id: 'c', handoffTo: ['d'], autonomy: 'auto' },
  { id: 'd', handoffTo: [], autonomy: 'auto' },
  { id: 'e', handoffTo: [], autonomy: 'auto' },
];
const ROLES = new Map(ROLE_LIST.map((r) => [r.id, r]));
const roleSource = { getRole: (id) => ROLES.get(id) ?? null };

function makeTeam(members = ['coordinator', 'writer', 'reviewer', 'booker']) {
  return createTeam(
    {
      id: 'team-1',
      name: 'Content',
      members: members.map((roleId) => ({ roleId, coordinator: roleId === 'coordinator' })),
    },
    roleSource,
  );
}

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
    decide(id, status, decidedBy = 'dashboard:owner') {
      const a = approvals.get(id);
      a.status = status;
      a.decidedBy = status === 'approved' ? decidedBy : null;
    },
  };
}

const redact = (value) => {
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = /token|secret/i.test(k) ? '[REDACTED]' : v;
  return out;
};

function setup(options = {}) {
  const store = createMemoryRunStore();
  const gate = fakeGate();
  const sink = { record: (event) => store.appendAudit(event) };
  const sleeps = [];
  const registry = createToolRegistry({
    gate,
    redact,
    audit: sink,
    timeoutMs: options.timeoutMs ?? 2000,
    maxOutputBytes: options.maxOutputBytes,
  });
  const engine = createRunEngine({
    registry,
    store,
    audit: sink,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    defaultLimits: options.limits,
  });
  return { store, gate, sink, registry, engine, sleeps };
}

const agent = (roleId, autonomy, extra = {}) => ({ kind: 'agent', agentId: `${roleId}-1`, roleId, autonomy, ...extra });

// ---------- tool registry ----------

test('a critical tool is refused without approval and does not run', async () => {
  const { registry, gate } = setup();
  let calls = 0;
  registry.register({
    id: 'delete_records',
    risk: 'critical',
    schema: { id: { type: 'string', required: true } },
    handler: () => {
      calls += 1;
      return { deleted: true };
    },
  });

  const denied = await registry.invoke({
    companyId: CO,
    toolId: 'delete_records',
    params: { id: 'r1' },
    identityVerified: true, actor: agent('booker', 'suggest'),
  });
  assert.equal(denied.outcome, 'refused');
  assert.equal(denied.reason, 'authority_denied');

  const waiting = await registry.invoke({
    companyId: CO,
    toolId: 'delete_records',
    params: { id: 'r1' },
    identityVerified: true, actor: agent('booker', 'auto'),
  });
  assert.equal(waiting.outcome, 'awaiting_approval');
  assert.equal(calls, 0);
  assert.equal(gate.approvals.size, 1);
});

test('an approved decision runs the tool once and a second use of the same approval is refused', async () => {
  const { registry, gate } = setup();
  let calls = 0;
  registry.register({
    id: 'publish_page',
    risk: 'high',
    schema: { slug: { type: 'string', required: true } },
    handler: (params) => {
      calls += 1;
      return { url: `/p/${params.slug}` };
    },
  });
  const actor = agent('booker', 'auto');
  const first = await registry.invoke({ companyId: CO, toolId: 'publish_page', params: { slug: 'home' }, identityVerified: true, actor });
  assert.equal(first.outcome, 'awaiting_approval');

  gate.decide(first.approvalId, 'approved');
  const run = await registry.invoke({ companyId: CO, toolId: 'publish_page', params: { slug: 'home' }, identityVerified: true, actor, approvalId: first.approvalId });
  assert.equal(run.outcome, 'executed');
  assert.equal(calls, 1);

  const again = await registry.invoke({ companyId: CO, toolId: 'publish_page', params: { slug: 'home' }, identityVerified: true, actor, approvalId: first.approvalId });
  assert.equal(again.outcome, 'refused');
  assert.equal(again.reason, 'approval_consumed');
  assert.equal(calls, 1);
});

test('a policy auto-approval is not a human approval and does not run the tool', async () => {
  const { registry, gate } = setup();
  let calls = 0;
  registry.register({ id: 'publish_page', risk: 'high', schema: {}, handler: () => (calls += 1) });
  const actor = agent('booker', 'auto');
  const first = await registry.invoke({ companyId: CO, toolId: 'publish_page', params: {}, identityVerified: true, actor });
  gate.decide(first.approvalId, 'approved', 'policy:auto_approve');
  const result = await registry.invoke({ companyId: CO, toolId: 'publish_page', params: {}, identityVerified: true, actor, approvalId: first.approvalId });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'approval_not_human');
  assert.equal(calls, 0);
});

test('an approval for one tool or one set of params cannot be used for another', async () => {
  const { registry, gate } = setup();
  let calls = 0;
  const handler = () => (calls += 1);
  registry.register({ id: 'publish_page', risk: 'high', schema: { slug: { type: 'string' } }, handler });
  registry.register({ id: 'archive_page', risk: 'high', schema: { slug: { type: 'string' } }, handler });
  const actor = agent('booker', 'auto');
  const first = await registry.invoke({ companyId: CO, toolId: 'publish_page', params: { slug: 'home' }, identityVerified: true, actor });
  gate.decide(first.approvalId, 'approved');

  const otherTool = await registry.invoke({ companyId: CO, toolId: 'archive_page', params: { slug: 'home' }, identityVerified: true, actor, approvalId: first.approvalId });
  assert.equal(otherTool.reason, 'approval_mismatch');
  const otherParams = await registry.invoke({ companyId: CO, toolId: 'publish_page', params: { slug: 'about' }, identityVerified: true, actor, approvalId: first.approvalId });
  assert.equal(otherParams.reason, 'approval_mismatch');
  assert.equal(calls, 0);
});

test('a tool call without companyId is refused and the handler does not run', async () => {
  const { registry } = setup();
  let calls = 0;
  registry.register({ id: 'read_note', risk: 'low', schema: {}, handler: () => (calls += 1) });
  const actor = agent('writer', 'auto');

  const missing = await registry.invoke({ toolId: 'read_note', params: {}, identityVerified: true, actor });
  assert.equal(missing.outcome, 'refused');
  assert.equal(missing.reason, 'company_id_required');

  const bad = await registry.invoke({ companyId: '../other', toolId: 'read_note', params: {}, identityVerified: true, actor });
  assert.equal(bad.reason, 'company_id_invalid');
  assert.equal(calls, 0);
});

test('an unknown tool fails closed', async () => {
  const { registry } = setup();
  const result = await registry.invoke({ companyId: CO, toolId: 'drop_database', params: {}, identityVerified: true, actor: agent('writer', 'auto') });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'tool_unknown');
});

test('input that names a tenant, has unknown fields, or misses a required field is refused', async () => {
  const { registry } = setup();
  let calls = 0;
  registry.register({ id: 'read_note', risk: 'low', schema: { note_id: { type: 'string', required: true } }, handler: () => (calls += 1) });
  const actor = agent('writer', 'auto');

  const tenant = await registry.invoke({ companyId: CO, toolId: 'read_note', params: { note_id: 'n', company_id: 'other' }, identityVerified: true, actor });
  assert.equal(tenant.reason, 'tenant_override');
  const extra = await registry.invoke({ companyId: CO, toolId: 'read_note', params: { note_id: 'n', admin: true }, identityVerified: true, actor });
  assert.equal(extra.reason, 'input_invalid');
  const missing = await registry.invoke({ companyId: CO, toolId: 'read_note', params: {}, identityVerified: true, actor });
  assert.equal(missing.reason, 'input_invalid');
  assert.equal(calls, 0);
});

test('a role can raise a tool risk but never lower it', async () => {
  const { registry } = setup();
  let calls = 0;
  registry.register({ id: 'publish_page', risk: 'high', schema: {}, handler: () => (calls += 1) });
  const raised = await registry.invoke({
    companyId: CO,
    toolId: 'publish_page',
    params: {},
    identityVerified: true, actor: agent('writer', 'auto', { toolRisk: { publish_page: 'critical' } }),
  });
  assert.equal(raised.outcome, 'awaiting_approval', 'the raised critical tier is never auto-run');
  assert.equal(raised.tier, 'critical');

  const lowered = await registry.invoke({
    companyId: CO,
    toolId: 'publish_page',
    params: {},
    identityVerified: true, actor: agent('writer', 'auto', { toolRisk: { publish_page: 'low' } }),
  });
  assert.equal(lowered.outcome, 'awaiting_approval');
  assert.equal(lowered.tier, 'high');
  assert.equal(calls, 0);
});

test('output is redacted and capped', async () => {
  const { registry } = setup({ maxOutputBytes: 64 });
  registry.register({
    id: 'read_note',
    risk: 'low',
    schema: {},
    handler: () => ({ api_token: 'secret-value', body: 'x'.repeat(500) }),
  });
  const result = await registry.invoke({ companyId: CO, toolId: 'read_note', params: {}, identityVerified: true, actor: agent('writer', 'auto') });
  assert.equal(result.outcome, 'executed');
  assert.equal(result.truncated, true);
  assert.equal(result.output.truncated, true);
  assert.ok(!JSON.stringify(result.output).includes('secret-value'));
});

test('a handler that throws a non-transient error fails without a transient flag', async () => {
  const { registry } = setup();
  registry.register({ id: 'read_note', risk: 'low', schema: {}, handler: () => { throw new Error('bad input upstream'); } });
  const result = await registry.invoke({ companyId: CO, toolId: 'read_note', params: {}, identityVerified: true, actor: agent('writer', 'auto') });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.transient, false);
});

test('audit records every decision, including refusals and approval waits', async () => {
  const { registry, store } = setup();
  registry.register({ id: 'read_note', risk: 'low', schema: {}, handler: () => ({ ok: 1 }) });
  registry.register({ id: 'delete_records', risk: 'critical', schema: {}, handler: () => ({}) });
  const writer = agent('writer', 'auto');

  await registry.invoke({ companyId: CO, toolId: 'read_note', params: {}, identityVerified: true, actor: writer });
  await registry.invoke({ companyId: CO, toolId: 'delete_records', params: {}, identityVerified: true, actor: writer });
  await registry.invoke({ toolId: 'read_note', params: {}, identityVerified: true, actor: writer });

  const events = (await store.listAudit(CO)).filter((e) => e.kind === 'tool.decision' || e.kind === 'tool.execution');
  const outcomes = events.map((e) => e.data.outcome);
  assert.ok(outcomes.includes('allowed'));
  assert.ok(outcomes.includes('awaiting_approval'));
  assert.ok(outcomes.includes('executed'));
  assert.equal(store.unscopedAudit().length, 1, 'the call with no companyId is audited with a null company');
  for (const event of events) {
    assert.equal(JSON.stringify(event).includes('"params"'), false, 'audit never stores raw params');
  }
});

test('an audit failure before execution refuses the call and nothing runs', async () => {
  let calls = 0;
  const registry = createToolRegistry({
    gate: fakeGate(),
    redact,
    audit: { record: () => { throw new Error('sink down'); } },
  });
  registry.register({ id: 'read_note', risk: 'low', schema: {}, handler: () => (calls += 1) });
  const result = await registry.invoke({ companyId: CO, toolId: 'read_note', params: {}, identityVerified: true, actor: agent('writer', 'auto') });
  assert.equal(result.reason, 'audit_unavailable');
  assert.equal(calls, 0);
});

test('a registry rejects a bad tool definition at registration', () => {
  const { registry } = setup();
  assert.throws(() => registry.register({ id: 'Bad Id', risk: 'low', schema: {}, handler: () => ({}) }));
  assert.throws(() => registry.register({ id: 'ok_tool', risk: 'severe', schema: {}, handler: () => ({}) }));
  assert.throws(() => registry.register({ id: 'ok_tool', risk: 'low', schema: { x: { type: 'blob' } }, handler: () => ({}) }));
});

test('a hung handler times out and is reported as a transient failure', async () => {
  const { registry } = setup({ timeoutMs: 20 });
  registry.register({
    id: 'slow_tool',
    risk: 'low',
    access: 'read',
    schema: {},
    handler: () => new Promise(() => {}),
  });
  const result = await registry.invoke({ companyId: CO, toolId: 'slow_tool', params: {}, identityVerified: true, actor: agent('writer', 'auto') });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'tool_timed_out');
  assert.equal(result.transient, true);
});

// ---------- teams, handoffs, delegation ----------

test('a team has exactly one coordinator and only known roles', () => {
  assert.throws(() => createTeam({ id: 't', name: 'n', members: [{ roleId: 'writer' }] }, roleSource), /exactly one coordinator/);
  assert.throws(
    () => createTeam({ id: 't', name: 'n', members: [{ roleId: 'writer', coordinator: true }, { roleId: 'reviewer', coordinator: true }] }, roleSource),
    /exactly one coordinator/,
  );
  assert.throws(() => createTeam({ id: 't', name: 'n', members: [{ roleId: 'ghost', coordinator: true }] }, roleSource), /unknown role/);
  const team = makeTeam();
  assert.equal(team.coordinator, 'coordinator');
});

test('a handoff outside the handoffTo list is refused', () => {
  const team = makeTeam();
  const plan = planHandoff(team, ['coordinator', 'writer'], 'writer', 'booker');
  assert.deepEqual(plan, { ok: false, reason: 'not_in_handoff_to' });
});

test('a handoff from a role that does not own the work is refused', () => {
  const team = makeTeam();
  assert.deepEqual(planHandoff(team, ['coordinator'], 'writer', 'reviewer'), { ok: false, reason: 'not_owner' });
});

test('a handoff cycle is refused', () => {
  const team = makeTeam();
  const first = planHandoff(team, ['coordinator'], 'coordinator', 'writer');
  assert.equal(first.ok, true);
  const second = planHandoff(team, first.path, 'writer', 'reviewer');
  assert.equal(second.ok, true);
  const cycle = planHandoff(team, second.path, 'reviewer', 'writer');
  assert.deepEqual(cycle, { ok: false, reason: 'handoff_cycle' });
});

test('delegation depth is capped at the default of 3', () => {
  const team = makeTeam(['coordinator', 'a', 'b', 'c', 'd']);
  const limits = resolveTeamLimits();
  assert.equal(limits.maxDelegationDepth, 3);
  let delegations = [];
  const chain = [
    { id: 'd1', parentId: null, fromRole: 'coordinator', toRole: 'a' },
    { id: 'd2', parentId: 'd1', fromRole: 'a', toRole: 'b' },
    { id: 'd3', parentId: 'd2', fromRole: 'b', toRole: 'c' },
  ];
  for (const request of chain) {
    const plan = planDelegation(team, delegations, request, limits);
    assert.equal(plan.ok, true, `${request.id} should be allowed`);
    delegations = [...delegations, plan.delegation];
  }
  assert.equal(delegations[2].depth, 3);
  const tooDeep = planDelegation(team, delegations, { id: 'd4', parentId: 'd3', fromRole: 'c', toRole: 'd' }, limits);
  assert.deepEqual(tooDeep, { ok: false, reason: 'depth_exceeded' });
});

test('delegation fan-out is capped at four open children per parent', () => {
  const team = makeTeam(['coordinator', 'a', 'b', 'c', 'd', 'e']);
  const limits = resolveTeamLimits();
  let delegations = [];
  for (const toRole of ['a', 'b', 'c', 'd']) {
    const plan = planDelegation(team, delegations, { id: `to-${toRole}`, parentId: null, fromRole: 'coordinator', toRole }, limits);
    assert.equal(plan.ok, true, `${toRole} should be allowed`);
    delegations = [...delegations, plan.delegation];
  }
  const fifth = planDelegation(team, delegations, { id: 'to-e', parentId: null, fromRole: 'coordinator', toRole: 'e' }, limits);
  assert.deepEqual(fifth, { ok: false, reason: 'fan_out_exceeded' });

  const closed = closeDelegation(delegations, 'to-a');
  assert.equal(closed.ok, true);
  const afterClose = planDelegation(team, closed.delegations, { id: 'to-e', parentId: null, fromRole: 'coordinator', toRole: 'e' }, limits);
  assert.equal(afterClose.ok, true);
});

test('a delegation cycle back to an open ancestor is refused', () => {
  const team = createTeam(
    { id: 't', name: 'n', members: [{ roleId: 'coordinator', coordinator: true }, { roleId: 'a' }] },
    { getRole: (id) => (id === 'coordinator' ? { id, handoffTo: ['a'] } : id === 'a' ? { id, handoffTo: ['coordinator'] } : null) },
  );
  const limits = resolveTeamLimits();
  const root = planDelegation(team, [], { id: 'r', parentId: null, fromRole: 'coordinator', toRole: 'a' }, limits);
  const back = planDelegation(team, [root.delegation], { id: 'x', parentId: 'r', fromRole: 'a', toRole: 'coordinator' }, limits);
  assert.deepEqual(back, { ok: false, reason: 'delegation_cycle' });
});

test('a parent cannot close while a child is open', () => {
  const team = makeTeam(['coordinator', 'a', 'b']);
  const limits = resolveTeamLimits();
  const root = planDelegation(team, [], { id: 'r', parentId: null, fromRole: 'coordinator', toRole: 'a' }, limits);
  const child = planDelegation(team, [root.delegation], { id: 'c', parentId: 'r', fromRole: 'a', toRole: 'b' }, limits);
  assert.equal(child.ok, true, 'a hands to b in the role data');
  const both = [root.delegation, child.delegation];
  assert.deepEqual(closeDelegation(both, 'r'), { ok: false, reason: 'open_children' });
  const childClosed = closeDelegation(both, 'c');
  assert.equal(childClosed.ok, true);
  assert.equal(closeDelegation(childClosed.delegations, 'r').ok, true);
});

// ---------- run lifecycle ----------

async function startedRun(engine, options = {}) {
  const created = await engine.createRun({
    companyId: CO,
    team: options.team ?? makeTeam(),
    budget: options.budget ?? { maxTokens: 1000, maxToolCalls: 10 },
    retry: options.retry,
    limits: options.limits,
  });
  assert.equal(created.ok, true, created.reason);
  const started = await engine.startRun(CO, created.run.id);
  assert.equal(started.ok, true);
  return started.run;
}

test('budget exhaustion on tool calls stops the run', async () => {
  const { engine, registry, store } = setup();
  let calls = 0;
  registry.register({ id: 'read_note', risk: 'low', schema: {}, handler: () => (calls += 1) });
  const run = await startedRun(engine, { budget: { maxTokens: 1000, maxToolCalls: 2 } });
  const actor = { kind: 'agent', agentId: 'writer-1', roleId: 'writer' };

  assert.equal((await engine.callTool(CO, run.id, { toolId: 'read_note', identityVerified: true, actor })).ok, true);
  assert.equal((await engine.callTool(CO, run.id, { toolId: 'read_note', identityVerified: true, actor })).ok, true);
  const third = await engine.callTool(CO, run.id, { toolId: 'read_note', identityVerified: true, actor });
  assert.equal(third.ok, false);
  assert.equal(third.reason, 'budget_exhausted');
  assert.equal(calls, 2);
  assert.equal((await store.getRun(CO, run.id)).status, 'budget_exhausted');
});

test('token budget exhaustion stops the run', async () => {
  const { engine } = setup();
  const run = await startedRun(engine, { budget: { maxTokens: 100, maxToolCalls: 5 } });
  assert.equal((await engine.recordTokens(CO, run.id, 60)).ok, true);
  const over = await engine.recordTokens(CO, run.id, 60);
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'budget_exhausted');
  assert.equal(over.run.status, 'budget_exhausted');
  assert.equal(over.run.budget.tokensUsed, 120, 'the overage is recorded so the audit shows the real number');
});

test('a terminal run cannot change state', async () => {
  const { engine, store, registry } = setup();
  registry.register({ id: 'read_note', risk: 'low', schema: {}, handler: () => ({}) });
  const run = await startedRun(engine);
  const done = await engine.complete(CO, run.id, 'finished');
  assert.equal(done.ok, true);
  const versionAtEnd = (await store.getRun(CO, run.id)).version;

  assert.equal((await engine.fail(CO, run.id, 'late')).reason, 'run_terminal');
  assert.equal((await engine.cancel(CO, run.id)).reason, 'run_terminal');
  assert.equal((await engine.startRun(CO, run.id)).reason, 'run_terminal');
  const tool = await engine.callTool(CO, run.id, { toolId: 'read_note', identityVerified: true, actor: { kind: 'agent', agentId: 'w', roleId: 'writer' } });
  assert.equal(tool.reason, 'run_terminal');

  const after = await store.getRun(CO, run.id);
  assert.equal(after.status, 'completed');
  assert.equal(after.version, versionAtEnd);
});

test('a queued run can only start or be cancelled', async () => {
  const { engine } = setup();
  const created = await engine.createRun({ companyId: CO, team: makeTeam(), budget: { maxTokens: 10, maxToolCalls: 1 } });
  assert.equal(created.run.status, 'queued');
  assert.equal((await engine.complete(CO, created.run.id)).reason, 'illegal_transition');
  assert.equal((await engine.cancel(CO, created.run.id)).ok, true);
});

test('a transient failure is retried with backoff, but a refusal or an approval wait is not', async () => {
  const { engine, registry, sleeps } = setup();
  let attempts = 0;
  registry.register({
    id: 'flaky_tool',
    risk: 'low',
    access: 'read',
    schema: {},
    handler: () => {
      attempts += 1;
      if (attempts < 3) throw transientError('upstream 503');
      return { done: true };
    },
  });
  registry.register({ id: 'delete_records', risk: 'critical', schema: {}, handler: () => ({}) });
  const run = await startedRun(engine, { budget: { maxTokens: 10, maxToolCalls: 10 } });
  const actor = { kind: 'agent', agentId: 'writer-1', roleId: 'writer' };

  const ok = await engine.callTool(CO, run.id, { toolId: 'flaky_tool', identityVerified: true, actor });
  assert.equal(ok.tool.outcome, 'executed');
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [backoffDelay(run.retry, 1), backoffDelay(run.retry, 2)]);
  assert.deepEqual(sleeps, [200, 400]);

  const denied = await engine.callTool(CO, run.id, { toolId: 'delete_records', identityVerified: true, actor });
  assert.equal(denied.tool.outcome, 'awaiting_approval');
  assert.equal(sleeps.length, 2, 'an approval wait adds no retry sleep');
});

test('retries stop at the policy limit and a non-transient failure is not retried', async () => {
  const { engine, registry, sleeps } = setup();
  let attempts = 0;
  registry.register({
    id: 'always_503',
    risk: 'low',
    access: 'read',
    schema: {},
    handler: () => {
      attempts += 1;
      throw transientError('still down');
    },
  });
  registry.register({ id: 'bad_input', risk: 'low', schema: {}, handler: () => { attempts += 1; throw new Error('bad'); } });
  const run = await startedRun(engine, { retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 10 } });
  const actor = { kind: 'agent', agentId: 'writer-1', roleId: 'writer' };

  const exhausted = await engine.callTool(CO, run.id, { toolId: 'always_503', identityVerified: true, actor });
  assert.equal(exhausted.tool.outcome, 'failed');
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [10]);

  attempts = 0;
  const plain = await engine.callTool(CO, run.id, { toolId: 'bad_input', identityVerified: true, actor });
  assert.equal(plain.tool.outcome, 'failed');
  assert.equal(attempts, 1);
});

test('a call that needs approval moves the run to awaiting_approval, and resumes only with the same actor and params', async () => {
  const { engine, registry, gate, store } = setup();
  let calls = 0;
  registry.register({ id: 'publish_page', risk: 'high', schema: { slug: { type: 'string', required: true } }, handler: () => (calls += 1) });
  const run = await startedRun(engine);
  const booker = { kind: 'agent', agentId: 'booker-1', roleId: 'booker' };

  const waiting = await engine.callTool(CO, run.id, { toolId: 'publish_page', params: { slug: 'home' }, identityVerified: true, actor: booker });
  assert.equal(waiting.tool.outcome, 'awaiting_approval');
  assert.equal((await store.getRun(CO, run.id)).status, 'awaiting_approval');
  assert.equal(calls, 0);

  const wrongParams = await engine.resumeAfterApproval(CO, run.id, { toolId: 'publish_page', params: { slug: 'other' }, identityVerified: true, actor: booker });
  assert.equal(wrongParams.reason, 'approval_call_mismatch');
  const wrongActor = await engine.resumeAfterApproval(CO, run.id, { toolId: 'publish_page', params: { slug: 'home' }, identityVerified: true, actor: { kind: 'agent', agentId: 'other', roleId: 'booker' } });
  assert.equal(wrongActor.reason, 'actor_mismatch');

  const approvalId = waiting.run.pendingApproval.approvalId;
  gate.decide(approvalId, 'approved', 'dashboard:owner');
  const resumed = await engine.resumeAfterApproval(CO, run.id, { toolId: 'publish_page', params: { slug: 'home' }, identityVerified: true, actor: booker });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.tool.outcome, 'executed');
  assert.equal(resumed.run.status, 'running');
  assert.equal(resumed.run.pendingApproval, null);
  assert.equal(calls, 1);

  const twice = await engine.resumeAfterApproval(CO, run.id, { toolId: 'publish_page', params: { slug: 'home' }, identityVerified: true, actor: booker });
  assert.equal(twice.reason, 'run_not_awaiting_approval');
});

test('a rejected approval fails the run and the handler does not run', async () => {
  const { engine, registry, gate } = setup();
  let calls = 0;
  registry.register({ id: 'publish_page', risk: 'high', schema: {}, handler: () => (calls += 1) });
  const run = await startedRun(engine);
  const booker = { kind: 'agent', agentId: 'booker-1', roleId: 'booker' };
  const waiting = await engine.callTool(CO, run.id, { toolId: 'publish_page', params: {}, identityVerified: true, actor: booker });
  gate.decide(waiting.run.pendingApproval.approvalId, 'rejected');
  const resumed = await engine.resumeAfterApproval(CO, run.id, { toolId: 'publish_page', params: {}, identityVerified: true, actor: booker });
  assert.equal(resumed.run.status, 'failed');
  assert.equal(resumed.tool.reason, 'approval_rejected');
  assert.equal(calls, 0);
});

test('handoffs and delegation run through the engine with the same limits', async () => {
  const { engine, store } = setup();
  const team = makeTeam(['coordinator', 'writer', 'reviewer', 'booker', 'a', 'b', 'c', 'd', 'e']);
  const run = await startedRun(engine, { team });

  const bad = await engine.handoff(CO, run.id, { actor: agent('coordinator', 'auto'), toRole: 'booker' });
  assert.equal(bad.ok, true, 'coordinator may hand to booker');
  const outside = await engine.handoff(CO, run.id, { actor: agent('booker', 'auto'), toRole: 'writer' });
  assert.equal(outside.reason, 'not_in_handoff_to');

  const delegated = await engine.delegate(CO, run.id, { actor: agent('coordinator', 'auto'), toRole: 'writer' });
  assert.equal(delegated.ok, true);
  assert.equal(delegated.detail.depth, 1);

  const persisted = await store.getRun(CO, run.id);
  assert.equal(persisted.delegations.length, 1);
  assert.equal(persisted.path.at(-1), 'booker');
});

test('one company cannot read another company run, and audit is scoped to the run', async () => {
  const { engine, store, registry } = setup();
  registry.register({ id: 'read_note', risk: 'low', schema: {}, handler: () => ({}) });
  const run = await startedRun(engine);
  assert.equal(await engine.getRun('company-2', run.id), null);
  assert.equal(await store.getRun('company-2', run.id), null);
  await engine.callTool(CO, run.id, { toolId: 'read_note', identityVerified: true, actor: { kind: 'agent', agentId: 'w', roleId: 'writer' } });
  const events = await store.listAudit(CO, run.id);
  assert.ok(events.some((e) => e.kind === 'run.status'));
  assert.ok(events.some((e) => e.kind === 'tool.decision'));
  assert.equal((await store.listAudit('company-2')).length, 0);
});

test('every run state change is audited', async () => {
  const { engine, store } = setup();
  const run = await startedRun(engine);
  await engine.complete(CO, run.id, 'done');
  const statusEvents = (await store.listAudit(CO, run.id)).filter((e) => e.kind === 'run.status');
  assert.deepEqual(
    statusEvents.map((e) => [e.data.from, e.data.to]),
    [
      ['queued', 'running'],
      ['running', 'completed'],
    ],
  );
});

test('the production store placeholder throws until the schema exists', async () => {
  const store = createUnavailableRunStore();
  await assert.rejects(() => store.getRun(CO, 'x'), StoreUnavailableError);
  await assert.rejects(() => store.insertRun(CO, {}), StoreUnavailableError);
});

test('the registry and engine refuse to start without a gate, redactor or audit sink', () => {
  assert.throws(() => createToolRegistry({ gate: null, redact, audit: { record() {} } }));
  assert.throws(() => createToolRegistry({ gate: fakeGate(), redact: null, audit: { record() {} } }));
  assert.throws(() => createToolRegistry({ gate: fakeGate(), redact, audit: null }));
});

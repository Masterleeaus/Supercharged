/**
 * Full task through the workforce run engine, with fakes only:
 *   trigger -> run created and started -> coordinator reads a note -> delegation -> handoff to a second role ->
 *   that role's write waits for approval -> process restart (new engine on the same store) with a recovery pass
 *   -> human approval -> the write runs once -> delegation closed -> run completed.
 *
 * Fakes: in-memory run store (also the audit log), in-memory approval gate, no database, no network, no timers.
 * Known gaps are kept as failing assertions and listed in the report under CHANGES_NEEDED.
 * Run: cd /home/claude/desk-review && node --test --experimental-transform-types tests/integration/workforce-full-task.test.mjs
 */
for (const method of ['log', 'info', 'warn']) console[method] = () => {};

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createToolRegistry,
  createRunEngine,
  createTeam,
  createMemoryRunStore,
} from '../../server/workforce/runtime/index.ts';
import { recoverInterruptedRuns, INTERRUPTED_RUN_REASON } from '../../server/workforce/runtime/recovery.ts';

const CO = 'company-1';
const OTHER_CO = 'company-2';
const NOW = new Date('2026-11-04T09:00:00Z');

const ROLES = new Map([
  ['coordinator', { id: 'coordinator', handoffTo: ['writer'], tools: ['read_note'], autonomy: 'auto' }],
  ['writer', { id: 'writer', handoffTo: ['coordinator'], tools: ['read_note', 'send_reply'], autonomy: 'auto' }],
]);
const roleSource = { getRole: (id) => ROLES.get(id) ?? null };

const COORDINATOR = { kind: 'agent', agentId: 'coordinator-1', roleId: 'coordinator' };
const WRITER = { kind: 'agent', agentId: 'writer-1', roleId: 'writer' };
const OWNER = { kind: 'human', userId: 'owner-1' };

/** Approval gate fake. It keeps the approval records, so a restart with the same gate still sees them. */
function fakeGate() {
  const approvals = new Map();
  let seq = 0;
  return {
    approvals,
    approve(id, decidedBy) {
      const record = approvals.get(id);
      record.status = 'approved';
      record.decidedBy = decidedBy;
    },
    gateAction: async (request) => {
      seq += 1;
      const id = `approval-${seq}`;
      approvals.set(id, {
        id,
        companyId: request.companyId,
        action: request.action,
        status: 'pending',
        decidedBy: null,
        paramsSha256: request.context.paramsSha256,
        executed: false,
      });
      return { status: 'pending', approval: { id } };
    },
    readApproval: async (companyId, id) => {
      const record = approvals.get(id);
      return record && record.companyId === companyId ? { ...record } : null;
    },
    claimApproval: async (companyId, id) => {
      const record = approvals.get(id);
      if (!record || record.companyId !== companyId || record.status !== 'approved' || record.executed) return false;
      record.executed = true;
      return true;
    },
  };
}

/** Builds a registry and engine over the given store and gate. Calling it again models a process restart. */
function boot({ store, gate, counts }) {
  const audit = { record: (event) => store.appendAudit(event) };
  const registry = createToolRegistry({ gate, redact: (v) => v, audit });
  registry.register({
    id: 'read_note',
    risk: 'low',
    access: 'read',
    category: 'other',
    schema: {},
    handler: () => {
      counts.read += 1;
      return { note: 'quote request on file' };
    },
  });
  registry.register({
    id: 'send_reply',
    risk: 'medium',
    access: 'write',
    category: 'customer_send',
    schema: { text: { type: 'string', required: true } },
    handler: () => {
      counts.sent += 1;
      return { sent: true };
    },
  });
  const engine = createRunEngine({
    registry,
    store,
    audit,
    now: () => NOW,
    sleep: async () => {},
    newId: nextId,
  });
  return { registry, engine };
}

// Shared across boots, so a restarted engine never reuses an id the store already holds.
let idSeq = 0;
function nextId() {
  idSeq += 1;
  return `id-${idSeq}`;
}

function newTeam() {
  return createTeam(
    {
      id: 'team-quotes',
      name: 'Quotes',
      members: [{ roleId: 'coordinator', coordinator: true }, { roleId: 'writer' }],
    },
    roleSource,
  );
}

test('full task: trigger, delegation, approval, restart with recovery, completion', async () => {
  const store = createMemoryRunStore();
  const gate = fakeGate();
  const counts = { read: 0, sent: 0 };
  const stack1 = boot({ store, gate, counts });

  // Trigger: an inbound customer message creates and starts the run.
  const trigger = { source: 'inbound_message', companyId: CO, payload: { customerRef: 'cust-7', text: 'Need a quote' } };
  const created = await stack1.engine.createRun({
    companyId: trigger.companyId,
    team: newTeam(),
    budget: { maxTokens: 10_000, maxToolCalls: 10 },
    roleVersion: 'v1',
  });
  assert.equal(created.ok, true, `createRun failed: ${created.reason}`);
  assert.equal(created.run.status, 'queued');
  const runId = created.run.id;

  const started = await stack1.engine.startRun(CO, runId);
  assert.equal(started.ok, true);
  assert.equal(started.run.status, 'running');

  // Coordinator reads the note: one tool execution.
  const read = await stack1.engine.callTool(CO, runId, { toolId: 'read_note', params: {}, actor: COORDINATOR });
  assert.equal(read.ok, true);
  assert.equal(read.tool.outcome, 'executed');
  assert.equal(counts.read, 1);

  // Delegation to the second role, then the handoff of ownership.
  const delegated = await stack1.engine.delegate(CO, runId, { actor: COORDINATOR, toRole: 'writer' });
  assert.equal(delegated.ok, true, `delegate failed: ${delegated.reason}`);
  const delegationId = delegated.detail.delegationId;
  assert.equal(delegated.run.delegations.length, 1);
  assert.equal(delegated.run.delegations[0].status, 'open');

  const handed = await stack1.engine.handoff(CO, runId, { actor: COORDINATOR, toRole: 'writer' });
  assert.equal(handed.ok, true, `handoff failed: ${handed.reason}`);
  assert.deepEqual(handed.run.path, ['coordinator', 'writer']);

  // The writer's customer reply is a customer_send, so it waits for the owner.
  const sendParams = { text: 'Your quote is ready' };
  const waiting = await stack1.engine.callTool(CO, runId, { toolId: 'send_reply', params: sendParams, actor: WRITER });
  assert.equal(waiting.ok, true);
  assert.equal(waiting.tool.outcome, 'awaiting_approval');
  assert.equal(waiting.run.status, 'awaiting_approval');
  assert.equal(counts.sent, 0, 'nothing is sent before approval');
  const approvalId = waiting.run.pendingApproval.approvalId;

  // Restart: a new registry and engine on the same store and gate. Before that, an unrelated run is left in
  // 'running' to stand for work a crash interrupted.
  const orphanCreated = await stack1.engine.createRun({
    companyId: CO,
    team: newTeam(),
    budget: { maxTokens: 1_000, maxToolCalls: 5 },
  });
  await stack1.engine.startRun(CO, orphanCreated.run.id);

  const stack2 = boot({ store, gate, counts });

  const recovery = await recoverInterruptedRuns({ store, audit: { record: (e) => store.appendAudit(e) }, now: () => NOW }, CO);
  assert.deepEqual(recovery.recovered, [orphanCreated.run.id], 'only the interrupted run is recovered');
  const orphan = await store.getRun(CO, orphanCreated.run.id);
  assert.equal(orphan.status, 'failed');
  assert.equal(orphan.reason, INTERRUPTED_RUN_REASON);

  const secondPass = await recoverInterruptedRuns({ store, audit: { record: (e) => store.appendAudit(e) }, now: () => NOW }, CO);
  assert.deepEqual(secondPass.recovered, [], 'a second recovery pass changes nothing');

  const survivor = await store.getRun(CO, runId);
  assert.equal(survivor.status, 'awaiting_approval', 'the waiting run is not touched by recovery');

  // Resuming before the owner approves runs nothing.
  const early = await stack2.engine.resumeAfterApproval(CO, runId, { toolId: 'send_reply', params: sendParams, actor: WRITER });
  assert.equal(early.tool.outcome, 'awaiting_approval');
  assert.equal(counts.sent, 0);

  // Owner approves; the resumed call runs once.
  gate.approve(approvalId, 'dashboard:owner-1');
  const resumed = await stack2.engine.resumeAfterApproval(CO, runId, { toolId: 'send_reply', params: sendParams, actor: WRITER });
  assert.equal(resumed.ok, true, `resume failed: ${resumed.reason}`);
  assert.equal(resumed.tool.outcome, 'executed');
  assert.equal(resumed.run.status, 'running');
  assert.equal(counts.sent, 1);

  // The same approval cannot be used twice, and a second resume is refused by run state.
  // The registry takes the autonomy from the actor it is given. The engine passes the team snapshot's value; this test does the same.
  const replay = await stack2.registry.invoke({
    companyId: CO,
    toolId: 'send_reply',
    params: sendParams,
    actor: { ...WRITER, autonomy: 'auto' },
    runId,
    correlationId: runId,
    approvalId,
  });
  assert.equal(replay.outcome, 'refused');
  assert.equal(replay.reason, 'approval_consumed');
  const again = await stack2.engine.resumeAfterApproval(CO, runId, { toolId: 'send_reply', params: sendParams, actor: WRITER });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'run_not_awaiting_approval');
  assert.equal(counts.sent, 1, 'the reply was sent exactly once');

  // Close the delegation and complete the run.
  const closed = await stack2.engine.closeDelegation(CO, runId, delegationId);
  assert.equal(closed.ok, true, `close failed: ${closed.reason}`);
  const done = await stack2.engine.complete(CO, runId, 'quote sent');
  assert.equal(done.ok, true, `complete failed: ${done.reason}`);
  assert.equal(done.run.status, 'completed');
  assert.equal(done.run.reason, 'quote sent');
  // Counted attempts: read, first send (waiting), early resume (waiting), resumed send. The direct replay and the
  // second resume are refused before an attempt, so they do not count.
  assert.equal(done.run.budget.toolCalls, 4);

  // Audit trail for this run, in the company's own log.
  const audit = await store.listAudit(CO, runId);
  const kinds = audit.map((e) => e.kind);
  for (const kind of ['run.created', 'run.delegation', 'run.handoff', 'run.approval_resumed', 'run.delegation_closed']) {
    assert.ok(kinds.includes(kind), `audit is missing ${kind}`);
  }
  const statuses = audit.filter((e) => e.kind === 'run.status').map((e) => e.data.to);
  assert.deepEqual(statuses, ['running', 'awaiting_approval', 'running', 'completed']);
});

test('the run is not visible to another company', async () => {
  const store = createMemoryRunStore();
  const gate = fakeGate();
  const stack = boot({ store, gate, counts: { read: 0, sent: 0 } });
  const created = await stack.engine.createRun({ companyId: CO, team: newTeam(), budget: { maxTokens: 1, maxToolCalls: 1 } });
  assert.equal(created.ok, true);

  assert.equal(await stack.engine.getRun(OTHER_CO, created.run.id), null);
  const crossStart = await stack.engine.startRun(OTHER_CO, created.run.id);
  assert.equal(crossStart.ok, false);
  assert.equal(crossStart.reason, 'run_not_found');
  assert.equal((await store.listRuns(OTHER_CO)).length, 0);
});

// CHANGES_NEEDED: run.ts callTool checks the role's tool list only after a handoff (path.length > 1). Before any
// handoff the coordinator (tools: read_note) can reach the approval gate for send_reply. This assertion states the
// expected behaviour and is expected to FAIL until run.ts enforces the owner's tool list from the first call.
test('a coordinator cannot call a tool outside its own role list before any handoff', async () => {
  const store = createMemoryRunStore();
  const gate = fakeGate();
  const counts = { read: 0, sent: 0 };
  const stack = boot({ store, gate, counts });
  const created = await stack.engine.createRun({ companyId: CO, team: newTeam(), budget: { maxTokens: 1, maxToolCalls: 5 } });
  await stack.engine.startRun(CO, created.run.id);

  const result = await stack.engine.callTool(CO, created.run.id, {
    toolId: 'send_reply',
    params: { text: 'hi' },
    actor: COORDINATOR,
  });
  assert.equal(result.ok, false, 'send_reply is not in the coordinator role list, so the call must be refused');
  assert.equal(result.reason, 'tool_not_in_role');
  assert.equal(gate.approvals.size, 0, 'no approval is requested for a tool the role may not call');
  assert.equal(counts.sent, 0);
});

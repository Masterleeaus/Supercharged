/**
 * Tests for the approval wait workflow step (server/integrations/voltagent/workflows).
 * Uses the real workforce run engine with an in-memory store and a fake approval gate, plus a fake handler.
 * No network, no database, no @voltagent/core, no route.
 * Run: node --test tests/integrations/voltagent/workflows.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createToolRegistry,
  createRunEngine,
  createTeam,
  createMemoryRunStore,
} from '../../../server/workforce/runtime/index.ts';
import {
  createApprovalStep,
  workflowsEnabled,
  WORKFLOWS_OFF_MESSAGE,
} from '../../../server/integrations/voltagent/workflows/approval-step.ts';

const CO = 'company-1';
const ON = { VOLTAGENT_WORKFLOWS_ENABLED: 'true' };
const booker = { kind: 'agent', agentId: 'booker-1', roleId: 'booker' };

// ---------- fixtures (inline, no shared helpers) ----------

const ROLES = new Map([
  ['coordinator', { id: 'coordinator', handoffTo: ['booker'], autonomy: 'auto' }],
  ['booker', { id: 'booker', handoffTo: [], autonomy: 'auto' }],
]);
const roleSource = { getRole: (id) => ROLES.get(id) ?? null };

function makeTeam() {
  return createTeam(
    {
      id: 'team-1',
      name: 'Bookings',
      members: [
        { roleId: 'coordinator', coordinator: true },
        { roleId: 'booker', coordinator: false },
      ],
    },
    roleSource,
  );
}

/** Minimal approval gate with the same contract the runtime tests use. */
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

function setup() {
  const store = createMemoryRunStore();
  const gate = fakeGate();
  const sink = { record: (event) => store.appendAudit(event) };
  const registry = createToolRegistry({ gate, redact, audit: sink, timeoutMs: 2000 });
  const engine = createRunEngine({ registry, store, audit: sink, sleep: async () => {} });
  let handlerRuns = 0;
  registry.register({
    id: 'publish_page',
    risk: 'high',
    schema: { slug: { type: 'string', required: true } },
    handler: async () => {
      handlerRuns += 1;
      return { url: '/p/home' };
    },
  });
  return { store, gate, engine, registry, sink, handlerRuns: () => handlerRuns };
}

async function startedRun(engine) {
  const created = await engine.createRun({
    companyId: CO,
    team: makeTeam(),
    budget: { maxTokens: 1000, maxToolCalls: 10 },
  });
  await engine.startRun(CO, created.run.id);
  return created.run;
}

const call = { toolId: 'publish_page', params: { slug: 'home' }, actor: booker };

// ---------- flag gate ----------

test('the flag must be exactly "true" to build the step', () => {
  const { engine } = setup();
  assert.throws(() => createApprovalStep({ engine, env: {} }), (e) => e.message === WORKFLOWS_OFF_MESSAGE);
  for (const value of ['TRUE', '1', 'yes', ' true', '']) {
    assert.throws(() => createApprovalStep({ engine, env: { VOLTAGENT_WORKFLOWS_ENABLED: value } }), /workflows are off/);
  }
  assert.equal(workflowsEnabled({ VOLTAGENT_WORKFLOWS_ENABLED: 'true' }), true);
  assert.equal(workflowsEnabled({}), false);
});

test('with the flag off after build, a step call refuses and the engine is not called', async () => {
  const { engine, store, handlerRuns } = setup();
  const run = await startedRun(engine);
  const env = { ...ON };
  const step = createApprovalStep({ engine, env });
  delete env.VOLTAGENT_WORKFLOWS_ENABLED;
  await assert.rejects(step.start({ companyId: CO, runId: run.id, call }), /workflows are off/);
  assert.equal(handlerRuns(), 0);
  assert.equal((await store.getRun(CO, run.id)).status, 'running');
});

// ---------- suspend and resume ----------

test('a high-risk step suspends and does not run its handler', async () => {
  const { engine, gate, store, handlerRuns } = setup();
  const run = await startedRun(engine);
  const step = createApprovalStep({ engine, env: ON });

  const result = await step.start({ companyId: CO, runId: run.id, call });
  assert.equal(result.status, 'suspended');
  assert.equal(result.toolId, 'publish_page');
  assert.equal(gate.approvals.size, 1);
  assert.equal(handlerRuns(), 0);
  assert.equal((await store.getRun(CO, run.id)).status, 'awaiting_approval');
});

test('approving resumes the handler exactly once', async () => {
  const { engine, gate, store, handlerRuns } = setup();
  const run = await startedRun(engine);
  const step = createApprovalStep({ engine, env: ON });
  const waiting = await step.start({ companyId: CO, runId: run.id, call });

  gate.decide(waiting.approvalId, 'approved');
  const done = await step.resume({ companyId: CO, runId: run.id, call });
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.output, { url: '/p/home' });
  assert.equal(handlerRuns(), 1);
  assert.equal((await store.getRun(CO, run.id)).status, 'running');
});

test('a pending decision keeps the run suspended and does not run the handler', async () => {
  const { engine, store, handlerRuns } = setup();
  const run = await startedRun(engine);
  const step = createApprovalStep({ engine, env: ON });
  await step.start({ companyId: CO, runId: run.id, call });

  const early = await step.resume({ companyId: CO, runId: run.id, call });
  assert.equal(early.status, 'suspended');
  assert.equal(handlerRuns(), 0);
  assert.equal((await store.getRun(CO, run.id)).status, 'awaiting_approval');
});

test('rejecting does not run the handler and fails the run', async () => {
  const { engine, gate, store, handlerRuns } = setup();
  const run = await startedRun(engine);
  const step = createApprovalStep({ engine, env: ON });
  const waiting = await step.start({ companyId: CO, runId: run.id, call });

  gate.decide(waiting.approvalId, 'rejected');
  const result = await step.resume({ companyId: CO, runId: run.id, call });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'approval_rejected');
  assert.equal(handlerRuns(), 0);
  assert.equal((await store.getRun(CO, run.id)).status, 'failed');
});

test('a resume after the wait is settled changes nothing and does not run the handler again', async () => {
  const { engine, gate, store, handlerRuns } = setup();
  const run = await startedRun(engine);
  const step = createApprovalStep({ engine, env: ON });
  const waiting = await step.start({ companyId: CO, runId: run.id, call });
  gate.decide(waiting.approvalId, 'approved');
  await step.resume({ companyId: CO, runId: run.id, call });

  const before = await store.getRun(CO, run.id);
  const auditBefore = (await store.listAudit(CO, run.id)).length;
  const again = await step.resume({ companyId: CO, runId: run.id, call });
  const after = await store.getRun(CO, run.id);

  assert.equal(again.status, 'already_resolved');
  assert.equal(again.runStatus, 'running');
  assert.equal(handlerRuns(), 1);
  assert.equal(after.version, before.version);
  assert.equal(after.status, before.status);
  assert.equal(after.pendingApproval, null);
  assert.equal((await store.listAudit(CO, run.id)).length, auditBefore);
});

test('a resume with a different actor or params is refused and leaves the wait in place', async () => {
  const { engine, gate, store, handlerRuns } = setup();
  const run = await startedRun(engine);
  const step = createApprovalStep({ engine, env: ON });
  const waiting = await step.start({ companyId: CO, runId: run.id, call });
  gate.decide(waiting.approvalId, 'approved');

  const wrong = await step.resume({ companyId: CO, runId: run.id, call: { ...call, params: { slug: 'other' } } });
  assert.equal(wrong.status, 'failed');
  assert.equal(wrong.reason, 'approval_call_mismatch');
  assert.equal(handlerRuns(), 0);
  assert.equal((await store.getRun(CO, run.id)).status, 'awaiting_approval');
});

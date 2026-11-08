/**
 * Handoff refusals at the run level (run.ts engine.handoff and engine.callTool), for checklist section
 * "Coordinator and supervisor hierarchy: assignment, delegation, handoffs, ownership, escalation".
 *   1. a handoff beyond the run's depth limit is refused, and the run's path does not change
 *   2. a handoff to a role whose agent is paused or retired is refused
 *   3. a handoff does not let the receiving agent call tools outside its own role
 *
 * Assumption for case 2: engine.handoff takes a role (toRole), not an agent. The role's agent is taken to
 * be `${roleId}-1`, the id the test puts under operator control.
 * Assumption for case 3: a role's tools are the catalogue's `tools` list. The runtime has no per-role
 * tool allowlist yet, so case 3 is expected to fail until one exists.
 * In-memory store and registry, fixed clock, no network, no database.
 * Run: node --test --experimental-transform-types tests/workforce/handoff-depth.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry, createRunEngine, createTeam, createMemoryRunStore } from '../../server/workforce/runtime/index.ts';
import { createControlState, pauseAgent, retireAgent } from '../../server/workforce/runtime/controls.ts';

const CO = 'company-1';
const HUMAN = { kind: 'human', userId: 'owner-1' };

// Role tools: writer owns draft_note, reviewer owns review_note. Each role may hand to the next in the chain.
const ROLE_LIST = [
  { id: 'coordinator', handoffTo: ['writer', 'reviewer'], autonomy: 'auto', tools: [] },
  { id: 'writer', handoffTo: ['reviewer'], autonomy: 'auto', tools: ['draft_note'] },
  { id: 'reviewer', handoffTo: ['writer'], autonomy: 'auto', tools: ['review_note'] },
];
const ROLES = new Map(ROLE_LIST.map((r) => [r.id, r]));
const roleSource = { getRole: (id) => ROLES.get(id) ?? null };

function makeTeam() {
  return createTeam(
    {
      id: 'team-1',
      name: 'Content',
      members: ROLE_LIST.map((r) => ({ roleId: r.id, coordinator: r.id === 'coordinator' })),
    },
    roleSource,
  );
}

const COORD = { kind: 'agent', agentId: 'coordinator-1', roleId: 'coordinator' };
const WRITER = { kind: 'agent', agentId: 'writer-1', roleId: 'writer' };
const REVIEWER = { kind: 'agent', agentId: 'reviewer-1', roleId: 'reviewer' };

/** Engine with two tools that each count their calls. Controls are passed in so a test can pause or retire an agent. */
function setup(controlState = createControlState()) {
  const store = createMemoryRunStore();
  const registry = createToolRegistry({
    gate: { gateAction: async () => ({ status: 'pending', approval: { id: 'x' } }), readApproval: async () => null, claimApproval: async () => false },
    redact: (v) => v,
    audit: { record: (e) => store.appendAudit(e) },
  });
  const calls = { draft_note: 0, review_note: 0 };
  for (const id of ['draft_note', 'review_note']) {
    registry.register({
      id,
      risk: 'low',
      schema: {},
      handler: () => {
        calls[id] += 1;
        return { ok: true };
      },
    });
  }
  const engine = createRunEngine({
    registry,
    store,
    audit: { record: (e) => store.appendAudit(e) },
    now: () => new Date('2026-11-03T00:00:00Z'),
    sleep: async () => {},
    controls: { state: () => controlState },
  });
  return { engine, calls };
}

async function startedRun(engine, limits) {
  const created = await engine.createRun({
    companyId: CO,
    team: makeTeam(),
    budget: { maxTokens: 100, maxToolCalls: 10 },
    ...(limits ? { limits } : {}),
  });
  assert.equal(created.ok, true, `createRun failed: ${created.reason}`);
  const started = await engine.startRun(CO, created.run.id);
  assert.equal(started.ok, true, `startRun failed: ${started.reason}`);
  return started.run.id;
}

test('a handoff beyond the run depth limit is refused and the path is left unchanged', async () => {
  const { engine } = setup();
  const runId = await startedRun(engine, { maxDelegationDepth: 1 });

  const first = await engine.handoff(CO, runId, { actor: COORD, toRole: 'writer' });
  assert.equal(first.ok, true, 'the first hop is within the limit');

  const second = await engine.handoff(CO, runId, { actor: WRITER, toRole: 'reviewer' });
  assert.equal(second.ok, false, 'the second hop is beyond the limit');
  assert.equal(second.reason, 'depth_exceeded');
  assert.deepEqual(second.run.path, ['coordinator', 'writer'], 'the refused handoff does not move the path');
});

test('a handoff to a paused agent is refused', async () => {
  const paused = pauseAgent(createControlState(), CO, 'reviewer-1', HUMAN);
  assert.equal(paused.ok, true, 'the test setup pauses the reviewer agent');
  const { engine } = setup(paused.state);
  const runId = await startedRun(engine);

  const result = await engine.handoff(CO, runId, { actor: COORD, toRole: 'reviewer' });
  assert.equal(result.ok, false, 'handing work to a paused agent must be refused');
  assert.equal(result.reason, 'agent_paused');
  assert.deepEqual(result.run.path, ['coordinator'], 'the path does not move');
});

test('a handoff to a retired agent is refused', async () => {
  const retired = retireAgent(createControlState(), CO, 'reviewer-1', HUMAN);
  assert.equal(retired.ok, true, 'the test setup retires the reviewer agent');
  const { engine } = setup(retired.state);
  const runId = await startedRun(engine);

  const result = await engine.handoff(CO, runId, { actor: COORD, toRole: 'reviewer' });
  assert.equal(result.ok, false, 'handing work to a retired agent must be refused');
  assert.equal(result.reason, 'agent_retired');
  assert.deepEqual(result.run.path, ['coordinator'], 'the path does not move');
});

test('control: a handoff to an active agent is allowed', async () => {
  const { engine } = setup();
  const runId = await startedRun(engine);
  const result = await engine.handoff(CO, runId, { actor: COORD, toRole: 'reviewer' });
  assert.equal(result.ok, true);
});

test('after a handoff the receiving agent cannot call a tool that belongs to the previous role', async () => {
  const { engine, calls } = setup();
  const runId = await startedRun(engine);

  const handed = await engine.handoff(CO, runId, { actor: COORD, toRole: 'writer' });
  assert.equal(handed.ok, true);
  const next = await engine.handoff(CO, runId, { actor: WRITER, toRole: 'reviewer' });
  assert.equal(next.ok, true);

  // draft_note is in the writer's tools only. The reviewer now owns the work and must not use it.
  const outside = await engine.callTool(CO, runId, { toolId: 'draft_note', params: {}, actor: REVIEWER });
  assert.equal(outside.ok, false, 'a tool outside the reviewer role must be refused');
  assert.equal(calls.draft_note, 0, 'the handler for the out-of-role tool does not run');
});

test('control: the receiving agent can call a tool in its own role', async () => {
  const { engine, calls } = setup();
  const runId = await startedRun(engine);
  await engine.handoff(CO, runId, { actor: COORD, toRole: 'writer' });
  await engine.handoff(CO, runId, { actor: WRITER, toRole: 'reviewer' });

  const own = await engine.callTool(CO, runId, { toolId: 'review_note', params: {}, actor: REVIEWER });
  assert.equal(own.ok, true);
  assert.equal(calls.review_note, 1);
});

/**
 * Recovery and concurrency for run updates. Checklist item: "Concurrency-safe run updates; recover interrupted
 * runs; record uncertain-outcome actions".
 *
 * Claims under test:
 * 1. A run whose tool call was interrupted mid-call (the process went away after the handler started) has that
 *    call recorded as an uncertain outcome, not as executed or failed.
 * 2. After such an interruption the call is not re-executed blindly by a fresh engine on the same store.
 * 3. Two concurrent updates to the same run cannot both apply: a stale write is refused, not silently merged.
 *
 * In-memory store and registry, fixed clock, no network, no database, no real timers.
 * Run: cd /home/claude/desk-review && node --test --experimental-transform-types tests/workforce/recovery-uncertain.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createToolRegistry,
  createRunEngine,
  createTeam,
  createMemoryRunStore,
} from '../../server/workforce/runtime/index.ts';
import { RunVersionConflictError } from '../../server/workforce/runtime/store.ts';

const CO = 'company-1';
const WRITER = { kind: 'agent', agentId: 'writer-1', roleId: 'writer' };
const COORD = { kind: 'agent', agentId: 'coordinator-1', roleId: 'coordinator' };

const ROLES = new Map([
  ['coordinator', { id: 'coordinator', handoffTo: ['writer'], autonomy: 'auto' }],
  ['writer', { id: 'writer', handoffTo: [], autonomy: 'auto' }],
]);
const roleSource = { getRole: (id) => ROLES.get(id) ?? null };
const team = createTeam(
  { id: 'team-1', name: 'Content', members: [{ roleId: 'coordinator', coordinator: true }, { roleId: 'writer' }] },
  roleSource,
);

const NOW = new Date('2026-11-03T00:00:00Z');

/** Builds an engine over the given store. The handler is supplied per engine, so a "restarted" engine can differ. */
function buildEngine(store, handler) {
  const registry = createToolRegistry({
    gate: { gateAction: async () => ({ status: 'pending', approval: { id: 'x' } }), readApproval: async () => null, claimApproval: async () => false },
    redact: (v) => v,
    audit: { record: (e) => store.appendAudit(e) },
    now: () => NOW,
  });
  registry.register({ id: 'send_note', risk: 'low', schema: {}, handler });
  return createRunEngine({
    registry,
    store,
    audit: { record: (e) => store.appendAudit(e) },
    now: () => NOW,
    sleep: async () => {},
  });
}

async function startedRun(engine) {
  const created = await engine.createRun({ companyId: CO, team, budget: { maxTokens: 100, maxToolCalls: 10 } });
  assert.equal(created.ok, true, `createRun failed: ${created.reason}`);
  const started = await engine.startRun(CO, created.run.id);
  assert.equal(started.ok, true, `startRun failed: ${started.reason}`);
  return started.run.id;
}

/**
 * Starts a tool call whose handler never returns, waits until the handler has begun, then abandons the call.
 * Abandoning the promise is the stand-in for a process that died mid-call: only the store survives.
 */
async function interruptMidCall(store, runId) {
  let executions = 0;
  let entered;
  const enteredHandler = new Promise((resolve) => {
    entered = resolve;
  });
  const engine = buildEngine(store, () => {
    executions += 1;
    entered();
    return new Promise(() => {});
  });
  void engine.callTool(CO, runId, { toolId: 'send_note', params: {}, identityVerified: true, actor: WRITER }).catch(() => {});
  await enteredHandler;
  return { executions: () => executions };
}

test('a run interrupted mid-tool-call records that call as uncertain, not executed or failed', async () => {
  const store = createMemoryRunStore();
  const runId = await startedRun(buildEngine(store, () => ({ ok: true })));
  await interruptMidCall(store, runId);

  const audit = await store.listAudit(CO, runId);
  const uncertain = audit.filter((e) => e.data?.outcome === 'uncertain');
  assert.equal(uncertain.length, 1, 'exactly one uncertain-outcome record for the interrupted call');
  assert.equal(uncertain[0].data.toolId, 'send_note');

  const settled = audit.filter((e) => e.kind === 'tool.execution' && (e.data?.outcome === 'executed' || e.data?.outcome === 'failed'));
  assert.equal(settled.length, 0, 'the interrupted call is not recorded as executed or failed');
});

test('a fresh engine does not re-execute an interrupted tool call blindly', async () => {
  const store = createMemoryRunStore();
  const runId = await startedRun(buildEngine(store, () => ({ ok: true })));
  const first = await interruptMidCall(store, runId);
  assert.equal(first.executions(), 1);

  let restartedExecutions = 0;
  const restarted = buildEngine(store, () => {
    restartedExecutions += 1;
    return { ok: true };
  });
  const retry = await restarted.callTool(CO, runId, { toolId: 'send_note', params: {}, identityVerified: true, actor: WRITER });

  assert.equal(restartedExecutions, 0, 'the restarted engine must not run the same call again without a decision');
  assert.equal(retry.ok, false, 'the uncertain call is refused until a human or reconciliation resolves it');
});

test('two concurrent engine updates to one run: exactly one applies, the other is refused', async () => {
  const store = createMemoryRunStore();
  const engine = buildEngine(store, () => ({ ok: true }));
  const runId = await startedRun(engine);

  const results = await Promise.allSettled([engine.recordTokens(CO, runId, 5), engine.recordTokens(CO, runId, 7)]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'one of the two updates applies');
  assert.equal(rejected.length, 1, 'the stale update is refused');
  assert.ok(rejected[0].reason instanceof RunVersionConflictError, 'the refusal is a version conflict');

  const stored = await store.getRun(CO, runId);
  assert.ok([5, 7].includes(stored.budget.tokensUsed), `tokensUsed is ${stored.budget.tokensUsed}, not a merge of both`);
  // Version 1 at insert, 2 after startRun, 3 after the one applied token update.
  assert.equal(stored.version, 3, 'version advanced exactly once for this pair');
});

test('a store compare-and-set refuses a second write based on the same version', async () => {
  const store = createMemoryRunStore();
  const engine = buildEngine(store, () => ({ ok: true }));
  const runId = await startedRun(engine);
  const base = await store.getRun(CO, runId);

  const a = store.updateRun(CO, { ...base, reason: 'writer A' }, base.version);
  const b = store.updateRun(CO, { ...base, reason: 'writer B' }, base.version);
  const [ra, rb] = await Promise.allSettled([a, b]);

  assert.equal(ra.status, 'fulfilled');
  assert.equal(rb.status, 'rejected');
  assert.ok(rb.reason instanceof RunVersionConflictError);
  assert.equal((await store.getRun(CO, runId)).reason, 'writer A');
});

/**
 * Tests for server/workforce/runtime/predictive-staging.ts. Uses the real shadow-changes service with an
 * in-memory store and a spy apply, so the test can prove nothing is applied.
 * Run: node --test --experimental-transform-types tests/workforce/predictive-staging.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowChanges, createMemoryShadowStore } from '../../server/workforce/runtime/shadow-changes.ts';
import {
  stagePredictiveAction,
  refusePredictiveDirectWrite,
} from '../../server/workforce/runtime/predictive-staging.ts';

const COMPANY = 'co-a';
const AGENT = { agentId: 'agent-p1', roleId: 'role-predictive-scheduler' };

function harness() {
  const applied = [];
  const versions = new Map();
  let seq = 0;
  const store = createMemoryShadowStore();
  const shadow = createShadowChanges({
    store,
    now: () => 1000,
    newId: () => `sc-${++seq}`,
    readVersion: async (company, table, id) => versions.get(`${company}|${table}|${id}`) ?? null,
    apply: async (change) => {
      applied.push(change.id);
      return 'applied';
    },
  });
  return { shadow, store, applied, versions };
}

const params = {
  runId: 'run-pred-1',
  targetTable: 'desk_jobs',
  targetId: 'job-42',
  operation: 'update',
  before: { status: 'open' },
  after: { status: 'scheduled' },
  baseVersion: 0,
};

function stageInput(overrides = {}) {
  return {
    companyId: COMPANY,
    agentId: AGENT.agentId,
    roleId: AGENT.roleId,
    toolId: 'tool-job-schedule',
    params,
    category: 'other',
    ...overrides,
  };
}

test('staging records a pending change and does not apply it', async () => {
  const h = harness();
  const result = await stagePredictiveAction({ shadow: h.shadow }, stageInput());

  assert.equal(result.ok, true);
  assert.equal(result.staged, true);
  assert.equal(result.change.status, 'pending');
  assert.equal(result.change.companyId, COMPANY);
  assert.equal(result.change.requestedBy.agentId, AGENT.agentId);
  assert.equal(result.change.targetId, 'job-42');
  assert.equal(h.store.size(), 1);

  const stored = await h.shadow.get(COMPANY, result.change.id);
  assert.equal(stored.status, 'pending');
});

test('nothing is applied by staging', async () => {
  const h = harness();
  await stagePredictiveAction({ shadow: h.shadow }, stageInput({ category: 'delete' }));
  await stagePredictiveAction({ shadow: h.shadow }, stageInput());

  assert.deepEqual(h.applied, []);
  assert.equal(h.store.size(), 2);
});

test('a staged change still needs a permitted approver before it runs', async () => {
  const h = harness();
  const { change } = await stagePredictiveAction({ shadow: h.shadow }, stageInput({ category: 'money' }));

  // The predictive agent cannot approve its own change, and a money change needs an owner or manager.
  const selfDecision = await h.shadow.decide(COMPANY, change.id, { kind: 'agent', ...AGENT }, 'approve');
  assert.deepEqual(selfDecision, { ok: false, reason: 'not_permitted' });
  assert.deepEqual(h.applied, []);
});

test('a staging request that fails validation records nothing', async () => {
  const h = harness();
  const result = await stagePredictiveAction(
    { shadow: h.shadow },
    stageInput({ params: { ...params, operation: 'upsert' } }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid');
  assert.equal(h.store.size(), 0);
  assert.deepEqual(h.applied, []);
});

test('a direct predictive write is refused', () => {
  assert.deepEqual(refusePredictiveDirectWrite('write'), {
    allowed: false,
    reason: 'direct_write_refused',
    detail: 'predictive agents may only stage writes; use stagePredictiveAction',
  });
  assert.equal(refusePredictiveDirectWrite(undefined).allowed, false);
  assert.equal(refusePredictiveDirectWrite('read').allowed, true);
});

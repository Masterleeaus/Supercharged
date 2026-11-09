/**
 * Tests the idempotency and freshness wiring in the tool registry invoke pipeline.
 * In-memory audit and idempotency store, fake handlers, a gate that must not be called for these tools.
 * No network, no database.
 * Run: cd /home/claude/desk-review && node --test --experimental-transform-types tests/workforce/tool-registry-idempotency-freshness.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry } from '../../server/workforce/runtime/tool-registry.ts';
import { createIdempotencyStore } from '../../server/workforce/runtime/idempotency.ts';

const CO = 'company-1';
const NOW = Date.parse('2026-11-03T10:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const agent = (autonomy = 'auto') => ({ kind: 'agent', agentId: 'agent-1', roleId: 'role-1', autonomy });

/** A gate that fails the test if any call reaches it. These tools should never need an approval. */
function unusedGate() {
  const fail = async () => {
    throw new Error('approval gate should not be used');
  };
  return { gateAction: fail, readApproval: fail, claimApproval: fail };
}

function setup({ store, tools, withStore = true }) {
  const audited = [];
  const options = {
    gate: unusedGate(),
    redact: (value) => value,
    audit: { record: async (event) => { audited.push(event); } },
    now: () => new Date(NOW),
  };
  if (withStore) options.idempotencyStore = store;
  const registry = createToolRegistry(options);
  const calls = {};
  for (const def of tools) {
    calls[def.id] = 0;
    registry.register({
      ...def,
      handler: async (params) => {
        calls[def.id] += 1;
        return { done: true, n: calls[def.id], echo: params };
      },
    });
  }
  return { registry, audited, calls };
}

const writeTool = (extra = {}) => ({ id: 'notes.write', risk: 'low', access: 'write', schema: { text: { type: 'string' } }, ...extra });

test('a repeated write with the same run, call index and params runs the handler once', async () => {
  const store = createIdempotencyStore();
  const { registry, calls, audited } = setup({ store, tools: [writeTool()] });
  const call = { companyId: CO, toolId: 'notes.write', params: { text: 'hi' }, identityVerified: true, actor: agent(), runId: 'run-1', callIndex: 0 };

  const first = await registry.invoke(call);
  assert.equal(first.outcome, 'executed');
  assert.equal(first.reason, undefined);
  assert.equal(calls['notes.write'], 1);

  const second = await registry.invoke(call);
  assert.equal(second.outcome, 'executed');
  assert.equal(second.reason, 'duplicate_suppressed');
  assert.deepEqual(second.output, first.output, 'the repeat returns the previous output');
  assert.equal(calls['notes.write'], 1, 'the handler did not run again');
  assert.ok(audited.some((e) => e.data.outcome === 'duplicate_suppressed'), 'the suppressed repeat is audited');
});

test('a different call index in the same run runs the handler again', async () => {
  const store = createIdempotencyStore();
  const { registry, calls } = setup({ store, tools: [writeTool()] });
  const base = { companyId: CO, toolId: 'notes.write', params: { text: 'hi' }, identityVerified: true, actor: agent(), runId: 'run-1' };

  assert.equal((await registry.invoke({ ...base, callIndex: 0 })).outcome, 'executed');
  const next = await registry.invoke({ ...base, callIndex: 1 });
  assert.equal(next.outcome, 'executed');
  assert.equal(next.reason, undefined);
  assert.equal(calls['notes.write'], 2);
});

test('a write without an idempotency store is unchanged: a repeat runs the handler again', async () => {
  const { registry, calls } = setup({ store: undefined, tools: [writeTool()], withStore: false });
  const call = { companyId: CO, toolId: 'notes.write', params: { text: 'hi' }, identityVerified: true, actor: agent(), runId: 'run-1', callIndex: 0 };

  const first = await registry.invoke(call);
  const second = await registry.invoke(call);
  assert.equal(first.outcome, 'executed');
  assert.equal(second.outcome, 'executed');
  assert.equal(second.reason, undefined);
  assert.equal(calls['notes.write'], 2);
});

test('a write with a store but no runId or callIndex is refused as idempotency_error and does not run', async () => {
  const store = createIdempotencyStore();
  const { registry, calls } = setup({ store, tools: [writeTool()] });
  const result = await registry.invoke({ companyId: CO, toolId: 'notes.write', params: { text: 'hi' }, identityVerified: true, actor: agent() });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'idempotency_error');
  assert.equal(calls['notes.write'], 0);
});

test('a read tool is not idempotency-checked, so a repeat runs again', async () => {
  const store = createIdempotencyStore();
  const { registry, calls } = setup({ store, tools: [{ id: 'invoices.list', risk: 'low', access: 'read', schema: {} }] });
  const call = { companyId: CO, toolId: 'invoices.list', params: {}, identityVerified: true, actor: agent(), runId: 'run-1', callIndex: 0 };
  await registry.invoke(call);
  await registry.invoke(call);
  assert.equal(calls['invoices.list'], 2);
});

test('a stale input is refused before the handler runs, with the stale reasons', async () => {
  const store = createIdempotencyStore();
  const { registry, calls, audited } = setup({
    store,
    tools: [
      writeTool({
        requiresFresh: ['schedule'],
        freshnessOf: (params, now) => [{ kind: 'schedule', observedAt: now.getTime() - 2 * DAY, source: 'calendar' }],
      }),
    ],
  });
  const result = await registry.invoke({
    companyId: CO,
    toolId: 'notes.write',
    params: { text: 'hi' },
    identityVerified: true, actor: agent(),
    runId: 'run-1',
    callIndex: 0,
  });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'stale_data');
  assert.deepEqual(result.reasons, [{ kind: 'schedule', reason: 'stale_schedule' }]);
  assert.equal(calls['notes.write'], 0);
  assert.equal(audited.at(-1).data.reason, 'stale_data');
});

test('a fresh input runs the handler', async () => {
  const { registry, calls } = setup({
    store: undefined,
    withStore: false,
    tools: [
      writeTool({
        requiresFresh: ['availability'],
        freshnessOf: (params, now) => [{ kind: 'availability', observedAt: now.getTime() - 10 * 60 * 1000, source: 'slots' }],
      }),
    ],
  });
  const result = await registry.invoke({ companyId: CO, toolId: 'notes.write', params: { text: 'hi' }, identityVerified: true, actor: agent() });
  assert.equal(result.outcome, 'executed');
  assert.equal(calls['notes.write'], 1);
});

test('a freshness function that throws fails closed and does not run the handler', async () => {
  const { registry, calls } = setup({
    store: undefined,
    withStore: false,
    tools: [
      writeTool({
        freshnessOf: () => {
          throw new Error('boom');
        },
      }),
    ],
  });
  const result = await registry.invoke({ companyId: CO, toolId: 'notes.write', params: { text: 'hi' }, identityVerified: true, actor: agent() });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'freshness_error');
  assert.equal(calls['notes.write'], 0);
});

test('a definition without freshnessOf is unchanged, even if it declares requiresFresh', async () => {
  const { registry, calls } = setup({
    store: undefined,
    withStore: false,
    tools: [writeTool({ requiresFresh: ['pricing'] })],
  });
  const result = await registry.invoke({ companyId: CO, toolId: 'notes.write', params: { text: 'hi' }, identityVerified: true, actor: agent() });
  assert.equal(result.outcome, 'executed');
  assert.equal(calls['notes.write'], 1);
});

test('register rejects an unknown requiresFresh kind and a non-function freshnessOf', () => {
  const registry = createToolRegistry({
    gate: unusedGate(),
    redact: (v) => v,
    audit: { record: async () => {} },
  });
  assert.throws(() => registry.register({ ...writeTool({ requiresFresh: ['weather'] }), handler: () => ({}) }), /requiresFresh/);
  assert.throws(() => registry.register({ ...writeTool({ id: 'notes.other', freshnessOf: 'nope' }), handler: () => ({}) }), /freshnessOf/);
});

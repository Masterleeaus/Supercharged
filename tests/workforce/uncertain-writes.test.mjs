/**
 * Repeated-action guard. A write that times out may already have acted on the outside world.
 *  - A write with an idempotency key is retried with the SAME key (up to KEYED_WRITE_MAX_ATTEMPTS). The key lets the
 *    external system recognise a repeat. If every attempt fails, the write is marked uncertain, not transient.
 *  - A write with no key is never retried. It is marked uncertain, not transient.
 *  - A read has no side effects, so a timed-out read stays transient and keeps its retry.
 *
 * No network, no database, no real timers beyond the short tool timeout.
 * Run: cd /home/claude/desk-review && node --test --experimental-transform-types tests/workforce/uncertain-writes.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry, KEYED_WRITE_MAX_ATTEMPTS } from '../../server/workforce/runtime/tool-registry.ts';
import { createIdempotencyStore } from '../../server/workforce/runtime/idempotency.ts';

const CO = 'company-1';
const NOW = Date.parse('2026-11-03T10:00:00.000Z');
const agent = { kind: 'agent', agentId: 'agent-1', roleId: 'role-1', autonomy: 'auto' };

const unusedGate = () => {
  const fail = async () => {
    throw new Error('approval gate should not be used');
  };
  return { gateAction: fail, readApproval: fail, claimApproval: fail };
};

/**
 * A handler that runs longer than the registry timeout for its first `slowCalls` calls, so those calls time out.
 * It records the idempotency key each call received.
 */
function slowTool(id, access, slowCalls = Infinity) {
  const calls = { n: 0, keys: [] };
  const tool = {
    id,
    risk: 'low',
    access,
    schema: { note: { type: 'string' } },
    handler: async (_params, context) => {
      calls.n += 1;
      calls.keys.push(context.idempotencyKey);
      if (calls.n <= slowCalls) await new Promise((resolve) => setTimeout(resolve, 200));
      return { done: true };
    },
  };
  return { tool, calls };
}

function setup(tools, extra = {}) {
  const registry = createToolRegistry({
    gate: unusedGate(),
    redact: (value) => value,
    audit: { record: async () => {} },
    now: () => new Date(NOW),
    timeoutMs: 20,
    ...extra,
  });
  for (const t of tools) registry.register(t.tool);
  return registry;
}

const call = (toolId) => ({ companyId: CO, identityVerified: true, toolId, params: { note: 'x' }, actor: agent, runId: 'run-1', callIndex: 0 });

test('an unkeyed timed-out write is recorded as uncertain, is not transient, and is not retried', async () => {
  const write = slowTool('notes.write', 'write');
  const registry = setup([write]);

  const result = await registry.invoke(call('notes.write'));

  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'tool_timed_out');
  assert.equal(result.uncertain, true, 'an unkeyed timed-out write must be marked uncertain');
  assert.equal(result.transient, false, 'an unkeyed timed-out write must not be marked transient');
  assert.equal(write.calls.n, 1, 'an unkeyed write runs once');
});

test('a write with no access declared counts as a write (fail closed), so unkeyed it is uncertain and not retried', async () => {
  const write = slowTool('notes.default', undefined);
  const registry = setup([write]);

  const result = await registry.invoke(call('notes.default'));

  assert.equal(result.uncertain, true);
  assert.equal(result.transient, false);
  assert.equal(write.calls.n, 1);
});

test('a keyed timed-out write is retried with the same idempotency key and then succeeds', async () => {
  const write = slowTool('notes.write', 'write', 1);
  const registry = setup([write], { idempotencyStore: createIdempotencyStore() });

  const result = await registry.invoke(call('notes.write'));

  assert.equal(result.outcome, 'executed', 'the retry of a keyed write should complete');
  assert.equal(write.calls.n, 2, 'one timeout, then one retry');
  assert.equal(typeof write.calls.keys[0], 'string');
  assert.ok(write.calls.keys[0].length > 0, 'the handler receives a key');
  assert.equal(write.calls.keys[1], write.calls.keys[0], 'the retry reuses the same key');
});

test('a keyed write that keeps timing out stops at the attempt limit, every attempt uses one key, and it is uncertain', async () => {
  const write = slowTool('notes.write', 'write');
  const registry = setup([write], { idempotencyStore: createIdempotencyStore() });

  const result = await registry.invoke(call('notes.write'));

  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'tool_timed_out');
  assert.equal(write.calls.n, KEYED_WRITE_MAX_ATTEMPTS, 'retries stop at the attempt limit');
  assert.equal(new Set(write.calls.keys).size, 1, 'every attempt carries the same key');
  assert.equal(result.uncertain, true, 'a keyed write that never confirmed is uncertain');
  assert.equal(result.transient, false, 'it is never handed back to run.ts as transient');
});

test('a timed-out read stays transient and is not marked uncertain, so its retry is kept', async () => {
  const read = slowTool('invoices.list', 'read');
  const registry = setup([read]);

  const result = await registry.invoke(call('invoices.list'));

  assert.equal(result.outcome, 'failed');
  assert.equal(result.transient, true, 'a timed-out read keeps its retry');
  assert.ok(!result.uncertain, 'a read is never uncertain');
  assert.equal(read.calls.n, 1, 'the registry runs a read once; run.ts owns its retry');
});

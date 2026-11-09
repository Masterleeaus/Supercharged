/**
 * Tests that a tool's own timeoutMs is enforced on each call, and that the registry-wide timeout is the fallback
 * when the tool declares none. Also that a non-positive-integer timeoutMs is refused at register().
 * In-memory audit, fake approval gate, fake handlers. No network, no database.
 * Run: node --test --experimental-transform-types tests/workforce/tool-registry-timeouts.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry } from '../../server/workforce/runtime/tool-registry.ts';

const CO = 'company-1';
const READER = { kind: 'agent', agentId: 'agent-1', roleId: 'role-1', autonomy: 'auto' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function registryWith({ registryTimeoutMs, tools }) {
  const registry = createToolRegistry({
    gate: { gateAction: async () => ({ status: 'pending', approval: { id: 'x' } }), readApproval: async () => null, claimApproval: async () => false },
    redact: (value) => value,
    audit: { record: async () => {} },
    timeoutMs: registryTimeoutMs,
  });
  for (const def of tools) {
    registry.register({
      id: def.id,
      risk: 'low',
      access: 'read',
      schema: {},
      timeoutMs: def.timeoutMs,
      handler: async () => {
        await sleep(def.sleepMs);
        return { ok: true };
      },
    });
  }
  return registry;
}

test('a call that runs past its per-tool timeoutMs fails with tool_timed_out', async () => {
  const registry = registryWith({
    registryTimeoutMs: 1_000,
    tools: [{ id: 'calendar.slow', timeoutMs: 10, sleepMs: 200 }],
  });
  const result = await registry.invoke({ companyId: CO, toolId: 'calendar.slow', params: {}, actor: READER });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'tool_timed_out');
});

test('a longer per-tool timeoutMs lets a call succeed that the registry-wide timeout would have failed', async () => {
  const registry = registryWith({
    registryTimeoutMs: 20,
    tools: [
      { id: 'calendar.patient', timeoutMs: 500, sleepMs: 100 },
      { id: 'calendar.default', sleepMs: 100 },
    ],
  });
  const patient = await registry.invoke({ companyId: CO, toolId: 'calendar.patient', params: {}, actor: READER });
  assert.equal(patient.outcome, 'executed');

  // Control: the same handler without its own timeoutMs falls back to the registry-wide 20 ms and times out.
  const fallback = await registry.invoke({ companyId: CO, toolId: 'calendar.default', params: {}, actor: READER });
  assert.equal(fallback.outcome, 'failed');
  assert.equal(fallback.reason, 'tool_timed_out');
});

test('register refuses a per-tool timeoutMs that is not a positive integer', () => {
  const registry = registryWith({ registryTimeoutMs: 1_000, tools: [] });
  const base = { risk: 'low', access: 'read', schema: {}, handler: async () => ({}) };
  [0, -5, 1.5, '100', Number.NaN, null].forEach((bad, i) => {
    assert.throws(
      () => registry.register({ ...base, id: `bad.timeout${i}`, timeoutMs: bad }),
      /timeoutMs must be a positive integer/,
      `timeoutMs ${String(bad)} should be refused`,
    );
  });
});

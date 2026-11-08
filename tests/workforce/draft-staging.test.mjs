/**
 * Draft tools stage and never execute; effective access is the stricter of tool and role.
 * Fakes only: no network, no database, no provider. Console output is silenced before server code is imported.
 *
 * Run: cd /home/claude/desk-review && node --test --experimental-transform-types tests/workforce/draft-staging.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const noop = () => {};
console.log = noop;
console.info = noop;
console.warn = noop;
console.error = noop;

const { createToolRegistry } = await import('../../server/workforce/runtime/tool-registry.ts');

const CO = 'company-1';

function setup(def) {
  const audited = [];
  const registry = createToolRegistry({
    gate: {
      gateCalls: 0,
      async gateAction() {
        this.gateCalls += 1;
        return { status: 'pending', approval: { id: 'ap-1' } };
      },
      async readApproval() { return null; },
      async claimApproval() { return false; },
    },
    redact: (value) => value,
    audit: { record: async (event) => { audited.push(event); } },
  });
  let calls = 0;
  registry.register({ schema: {}, ...def, handler: async () => { calls += 1; return { ok: true }; } });
  return { registry, audited, handlerCalls: () => calls };
}

const agent = (autonomy, extra = {}) => ({ kind: 'agent', agentId: 'agent-1', roleId: 'role-1', autonomy, ...extra });

test('a low-risk draft under Auto returns staged, runs no handler, and is audited as staged', async () => {
  const { registry, audited, handlerCalls } = setup({ id: 'customer_messages.draft', risk: 'low' });
  const result = await registry.invoke({ companyId: CO, toolId: 'customer_messages.draft', params: {}, actor: agent('auto') });
  assert.equal(result.outcome, 'staged');
  assert.equal(result.toolId, 'customer_messages.draft');
  assert.equal(handlerCalls(), 0);
  assert.ok(audited.some((e) => e.data?.outcome === 'staged'), 'the staged decision is audited');
  assert.ok(!audited.some((e) => e.data?.outcome === 'executed'), 'nothing is audited as executed');
});

test('a draft declared read still stages and does not execute', async () => {
  const { registry, handlerCalls } = setup({ id: 'notes.draft', risk: 'low', access: 'read' });
  const result = await registry.invoke({ companyId: CO, toolId: 'notes.draft', params: {}, actor: agent('auto') });
  assert.equal(result.outcome, 'staged');
  assert.equal(handlerCalls(), 0);
});

test('a role that declares a read-declared tool write makes it refused under Suggest', async () => {
  const { registry, handlerCalls } = setup({ id: 'notes.write', risk: 'low', access: 'read' });
  const result = await registry.invoke({
    companyId: CO,
    toolId: 'notes.write',
    params: {},
    actor: agent('suggest', { toolAccess: { 'notes.write': 'write' } }),
  });
  assert.equal(result.outcome, 'refused');
  assert.equal(handlerCalls(), 0);
});

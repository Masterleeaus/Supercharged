/**
 * Smoke tests for the shared VoltAgent test helpers as they exist on main (#391, W13).
 * Targets main's fake-chat-provider, fake-registry and fixtures. No network, no database.
 * Run: node --test --experimental-strip-types tests/integrations/voltagent/_helpers/harness.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeChatProvider, createFakeRegistry, TENANT_A, TENANT_B, agentRunFixture } from './index.mjs';

test('chat provider returns scripted replies in order and reports what is left', async () => {
  const provider = createFakeChatProvider(['first', { text: 'second', tool_calls: [] }]);
  const a = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
  const b = await provider.complete({ messages: [] });
  assert.deepEqual(a, { text: 'first', tool_calls: [] });
  assert.equal(b.text, 'second');
  assert.equal(provider.remaining(), 0);
});

test('chat provider throws when the script runs out, so a test cannot pass by accident', async () => {
  const provider = createFakeChatProvider([]);
  await assert.rejects(() => provider.complete({ messages: [] }), /no scripted reply left/);
});

test('chat provider rethrows a scripted error and still records the call', async () => {
  const boom = new Error('provider down');
  const provider = createFakeChatProvider([boom]);
  await assert.rejects(() => provider.complete({ messages: [{ role: 'user', content: 'x' }] }), /provider down/);
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(provider.calls[0].messages, [{ role: 'user', content: 'x' }]);
});

test('chat provider records a copy of each request, so later mutation does not change the record', async () => {
  const provider = createFakeChatProvider(['ok']);
  const request = { messages: [{ role: 'user', content: 'before' }] };
  await provider.complete(request);
  request.messages[0].content = 'after';
  assert.equal(provider.calls[0].messages[0].content, 'before');
});

test('fake registry runs a named tool with its params and context', async () => {
  const registry = createFakeRegistry({ echo: (params, ctx) => ({ said: params.text, company: ctx.companyId }) });
  const out = await registry.invoke('echo', { text: 'hi' }, { companyId: TENANT_A.companyId });
  assert.deepEqual(out, { said: 'hi', company: TENANT_A.companyId });
  assert.deepEqual(registry.names(), ['echo']);
});

test('fake registry fails loudly on an unknown tool and still records the attempt', async () => {
  const registry = createFakeRegistry({});
  await assert.rejects(() => registry.invoke('nope', {}, {}), /unknown tool "nope"/);
  assert.equal(registry.invocations.length, 1);
  assert.equal(registry.invocations[0].name, 'nope');
});

test('fake registry records params as a copy and the company id it was given (or null)', async () => {
  const registry = createFakeRegistry({ t: (p) => p });
  const params = { n: 1 };
  await registry.invoke('t', params, { companyId: TENANT_B.companyId });
  params.n = 2;
  await registry.invoke('t', {});
  assert.deepEqual(registry.invocations[0].params, { n: 1 });
  assert.equal(registry.invocations[0].companyId, TENANT_B.companyId);
  assert.equal(registry.invocations[1].companyId, null);
});

test('tenant fixtures are two distinct frozen companies', () => {
  assert.notEqual(TENANT_A.companyId, TENANT_B.companyId);
  assert.ok(Object.isFrozen(TENANT_A));
});

test('agent run fixture defaults to tenant A and accepts overrides', () => {
  assert.equal(agentRunFixture().companyId, TENANT_A.companyId);
  assert.equal(agentRunFixture({ companyId: TENANT_B.companyId }).companyId, TENANT_B.companyId);
});

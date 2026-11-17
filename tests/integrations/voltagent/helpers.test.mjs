import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeChatProvider, createFakeRegistry, TENANT_A, TENANT_B, agentRunFixture } from './_helpers/index.mjs';

test('fake chat provider replays script in order and records requests', async () => {
  const chat = createFakeChatProvider(['first', { text: 'second', tool_calls: [] }]);
  assert.equal((await chat.complete({ messages: [1] })).text, 'first');
  assert.equal((await chat.complete({ messages: [2] })).text, 'second');
  assert.equal(chat.calls.length, 2);
  assert.equal(chat.remaining(), 0);
});

test('fake chat provider throws when the script runs out', async () => {
  const chat = createFakeChatProvider([]);
  await assert.rejects(chat.complete({}), /no scripted reply/);
});

test('fake chat provider rethrows a scripted error', async () => {
  const chat = createFakeChatProvider([new Error('rate limited')]);
  await assert.rejects(chat.complete({}), /rate limited/);
});

test('recorded requests are copies, not live references', async () => {
  const chat = createFakeChatProvider(['ok']);
  const req = { messages: ['hi'] };
  await chat.complete(req);
  req.messages.push('changed');
  assert.deepEqual(chat.calls[0].messages, ['hi']);
});

test('fake registry invokes known tools and records the tenant', async () => {
  const reg = createFakeRegistry({ 'jobs.list': (p) => ({ n: p.limit }) });
  assert.deepEqual(await reg.invoke('jobs.list', { limit: 2 }, { companyId: TENANT_A.companyId }), { n: 2 });
  assert.equal(reg.invocations[0].companyId, TENANT_A.companyId);
  assert.deepEqual(reg.names(), ['jobs.list']);
});

test('fake registry fails loudly on an unknown tool', async () => {
  const reg = createFakeRegistry({});
  await assert.rejects(reg.invoke('missing'), /unknown tool/);
  assert.equal(reg.invocations.length, 1);
});

test('fixtures define two distinct tenants and a valid run', () => {
  assert.notEqual(TENANT_A.companyId, TENANT_B.companyId);
  assert.equal(agentRunFixture().companyId, TENANT_A.companyId);
  assert.equal(agentRunFixture({ companyId: TENANT_B.companyId }).companyId, TENANT_B.companyId);
});

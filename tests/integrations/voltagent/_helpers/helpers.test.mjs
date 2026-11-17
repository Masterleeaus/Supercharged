/**
 * Smoke tests for the shared test helpers. No network, no database, no runtime imports.
 * Run: node --test tests/integrations/voltagent/_helpers/helpers.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeChatProvider } from './fake-chat-provider.mjs';
import { createFakeRegistry } from './fake-registry.mjs';
import {
  DEFAULT_COMPANY_ID,
  OTHER_COMPANY_ID,
  makeBudget,
  makeRetry,
  makeBudgetLimits,
  makeAgentActor,
  makeHumanActor,
  makeRole,
  makeTeam,
} from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MSG = [{ role: 'user', content: 'hello' }];

// ---------- fake chat provider ----------

test('chat provider returns scripted text replies in order', async () => {
  const provider = createFakeChatProvider({ script: ['first', { content: 'second', usage: { total_tokens: 7 } }] });
  const a = await provider.chat({ companyId: DEFAULT_COMPANY_ID, messages: MSG });
  const b = await provider.chat({ companyId: DEFAULT_COMPANY_ID, messages: MSG });
  assert.equal(a.ok, true);
  assert.equal(a.content, 'first');
  assert.equal(b.content, 'second');
  assert.deepEqual(b.usage, { total_tokens: 7 });
  assert.equal(provider.remaining(), 0);
});

test('chat provider fails with the scripted HTTP status and failover flag', async () => {
  const provider = createFakeChatProvider({ script: [{ fail: 503 }, { fail: 400 }, { fail: null }] });
  const a = await provider.chat({ companyId: DEFAULT_COMPANY_ID, messages: MSG });
  const b = await provider.chat({ companyId: DEFAULT_COMPANY_ID, messages: MSG });
  const c = await provider.chat({ companyId: DEFAULT_COMPANY_ID, messages: MSG });
  assert.deepEqual([a.ok, a.status, a.retryable], [false, 503, true]);
  assert.deepEqual([b.ok, b.status, b.retryable], [false, 400, false]);
  assert.deepEqual([c.ok, c.status, c.retryable], [false, null, true]);
});

test('chat provider sticky failWith fails every call with that status', async () => {
  const provider = createFakeChatProvider({ failWith: 429, name: 'primary' });
  const r1 = await provider.chat({ companyId: DEFAULT_COMPANY_ID, messages: MSG });
  const r2 = await provider.chat({ companyId: DEFAULT_COMPANY_ID, messages: MSG });
  assert.equal(r1.status, 429);
  assert.equal(r2.status, 429);
  assert.equal(r1.provider, 'primary');
  assert.equal(provider.providerName(), 'primary');
});

test('chat provider returns a non-retryable failure when the script runs out', async () => {
  const provider = createFakeChatProvider();
  const r = await provider.chat({ companyId: DEFAULT_COMPANY_ID, messages: MSG });
  assert.deepEqual([r.ok, r.error, r.status, r.retryable], [false, 'script_exhausted', null, false]);
});

test('chat provider records every call and its company id', async () => {
  const provider = createFakeChatProvider({ script: ['a'] });
  await provider.chat({ companyId: DEFAULT_COMPANY_ID, messages: MSG, options: { temperature: 0 } });
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].companyId, DEFAULT_COMPANY_ID);
  assert.deepEqual(provider.calls[0].options, { temperature: 0 });
});

// ---------- fake registry ----------

function registryWithEcho() {
  const registry = createFakeRegistry();
  registry.register({
    id: 'echo',
    risk: 'low',
    schema: { text: { type: 'string', required: true } },
    handler: (params) => ({ said: params.text }),
  });
  return registry;
}

test('fake registry runs a registered tool and returns executed output', async () => {
  const registry = registryWithEcho();
  const result = await registry.invoke({
    companyId: DEFAULT_COMPANY_ID,
    toolId: 'echo',
    params: { text: 'hi' },
    actor: makeAgentActor('writer'),
  });
  assert.equal(result.outcome, 'executed');
  assert.equal(result.tier, 'low');
  assert.deepEqual(result.output, { said: 'hi' });
});

test('fake registry refuses unknown tools, bad params, tenant keys and missing company', async () => {
  const registry = registryWithEcho();
  const actor = makeAgentActor('writer');
  const unknown = await registry.invoke({ companyId: DEFAULT_COMPANY_ID, toolId: 'nope', params: {}, actor });
  const missing = await registry.invoke({ companyId: DEFAULT_COMPANY_ID, toolId: 'echo', params: {}, actor });
  const extra = await registry.invoke({ companyId: DEFAULT_COMPANY_ID, toolId: 'echo', params: { text: 'x', bogus: 1 }, actor });
  const tenant = await registry.invoke({ companyId: DEFAULT_COMPANY_ID, toolId: 'echo', params: { text: 'x', company_id: 'other' }, actor });
  const noCompany = await registry.invoke({ companyId: undefined, toolId: 'echo', params: { text: 'x' }, actor });
  assert.equal(unknown.reason, 'tool_unknown');
  assert.equal(missing.reason, 'input_invalid');
  assert.equal(extra.reason, 'input_invalid');
  assert.equal(tenant.reason, 'tenant_override');
  assert.equal(noCompany.reason, 'company_id_required');
});

test('fake registry reports a thrown transient error as a transient failure', async () => {
  const registry = createFakeRegistry();
  const err = Object.assign(new Error('upstream 503'), { transient: true });
  registry.register({ id: 'flaky', risk: 'medium', schema: {}, handler: () => { throw err; } });
  const result = await registry.invoke({ companyId: DEFAULT_COMPANY_ID, toolId: 'flaky', params: {}, actor: makeHumanActor() });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.transient, true);
  assert.equal(result.message, 'upstream 503');
});

test('fake registry records every call, refused ones included, and callTool is the same path', async () => {
  const registry = registryWithEcho();
  const actor = makeAgentActor('writer');
  await registry.invoke({ companyId: DEFAULT_COMPANY_ID, toolId: 'echo', params: { text: 'a' }, actor });
  await registry.callTool({ companyId: DEFAULT_COMPANY_ID, toolId: 'echo', params: {}, actor });
  assert.equal(registry.calls.length, 2);
  assert.equal(registry.calls[1].toolId, 'echo');
  registry.reset();
  assert.equal(registry.calls.length, 0);
  assert.equal(registry.has('echo'), true);
});

test('fake registry rejects duplicate registration and lists tools', () => {
  const registry = registryWithEcho();
  assert.throws(() => registry.register({ id: 'echo', risk: 'low', schema: {}, handler: () => ({}) }), /already registered/);
  assert.deepEqual(registry.list(), [{ id: 'echo', risk: 'low' }]);
});

// ---------- fixtures ----------

test('fixtures give a valid default company and a different second one', () => {
  assert.match(DEFAULT_COMPANY_ID, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
  assert.notEqual(OTHER_COMPANY_ID, DEFAULT_COMPANY_ID);
});

test('fixture actors have the fields the registry needs', () => {
  const agent = makeAgentActor('reviewer');
  assert.deepEqual([agent.kind, agent.roleId, agent.agentId, agent.autonomy], ['agent', 'reviewer', 'reviewer-1', 'auto']);
  assert.deepEqual(makeHumanActor('u-9'), { kind: 'human', userId: 'u-9' });
});

test('fixture budget, retry and limits builders return positive integers', () => {
  assert.deepEqual(makeBudget({ maxToolCalls: 3 }), { maxTokens: 50_000, maxToolCalls: 3 });
  assert.deepEqual(makeRetry(), { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 2000 });
  const limits = makeBudgetLimits({ maxTokensPerRun: 10 });
  for (const value of Object.values(limits)) assert.ok(Number.isInteger(value) && value > 0);
  assert.equal(limits.maxTokensPerRun, 10);
});

test('team builder makes one coordinator and hands off from it', () => {
  const team = makeTeam({ members: ['lead', 'writer'] });
  assert.deepEqual(team.input.members, [
    { roleId: 'lead', coordinator: true },
    { roleId: 'writer', coordinator: false },
  ]);
  assert.deepEqual(team.roleSource.getRole('lead').handoffTo, ['writer']);
  assert.equal(team.roleSource.getRole('missing'), null);
  assert.equal(team.input.members.filter((m) => m.coordinator).length, 1);
});

test('team builder applies per-role overrides', () => {
  const team = makeTeam({ members: ['coordinator', 'writer'], roles: { writer: { toolRisk: { publish_page: 'high' } } } });
  assert.deepEqual(team.roleSource.getRole('writer').toolRisk, { publish_page: 'high' });
  assert.deepEqual(makeRole('x').handoffTo, []);
});

// ---------- README rule: helpers never import @mastra or ee/ ----------

test('no helper file imports @mastra or any ee/ path', () => {
  const files = readdirSync(HERE).filter((f) => f.endsWith('.mjs'));
  assert.ok(files.length >= 4, 'expected the helper files to be present');
  for (const file of files) {
    const source = readFileSync(join(HERE, file), 'utf8');
    assert.doesNotMatch(source, /from\s+['"][^'"]*@mastra/, `${file} imports @mastra`);
    assert.doesNotMatch(source, /from\s+['"][^'"]*\/ee\//, `${file} imports an ee/ path`);
    assert.doesNotMatch(source, /import\(\s*['"][^'"]*(@mastra|\/ee\/)/, `${file} dynamically imports @mastra or ee/`);
  }
});

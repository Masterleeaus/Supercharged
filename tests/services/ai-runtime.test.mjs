/**
 * Tests for server/services/ai-runtime. Ported from TitanPro Modules/TitanCore/AI and
 * Modules/TitanZero (see server/services/ai-runtime/PORT-MAP.md). Every provider is a fake.
 * No network, no keys, no database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AiRuntimeError,
  ProviderFailoverChain,
  DisabledChatProvider,
  DisabledEmbeddingProvider,
  createAiRuntime,
  requireCompanyId,
  createBlockedTermGuardrail,
  screenInput,
  screenOutput,
  retrieveChunks,
  extractTerms,
  rankCandidates,
  parseChunkId,
  buildCitation,
  resolveCitations,
  attachCitations,
  ToolExecutor,
  createToolPermissionGate,
  runPipeline,
  scoreTaskCompletion,
  detectHallucination,
  scoreToolAccuracy,
  compositeScore,
  evaluateResponse,
} from '../../server/services/ai-runtime/index.ts';

const OK = (name, content = 'answer') => ({ ok: true, provider: name, model: 'm', content, usage: null, latency_ms: 1 });
const FAIL = (name, status, extra = {}) => ({ ok: false, provider: name, error: `http_${status ?? 'transport'}`, status, retryable: true, latency_ms: 1, ...extra });

function fakeChat(name, respond, log) {
  return {
    providerName: () => name,
    chat: async (input) => {
      log.push(name);
      return typeof respond === 'function' ? respond(input) : respond;
    },
    health: async () => ({ ok: true, provider: name, reason: null }),
  };
}

function fakeEmbed(name, respond, log) {
  return {
    providerName: () => name,
    embed: async (input) => {
      log.push(name);
      return typeof respond === 'function' ? respond(input) : respond;
    },
    health: async () => ({ ok: true, provider: name, reason: null }),
  };
}

const USER_MSG = [{ role: 'user', content: 'hello' }];

// ---------------------------------------------------------------------------
// Tenancy: companyId is required and validated
// ---------------------------------------------------------------------------

test('requireCompanyId rejects missing values with company_id_required', () => {
  for (const value of [undefined, null, '']) {
    assert.throws(() => requireCompanyId(value), (e) => e instanceof AiRuntimeError && e.code === 'company_id_required');
  }
});

test('requireCompanyId rejects malformed values with company_id_invalid', () => {
  for (const value of [0, -1, 1.5, 'a b', '../x', ' 7', 'x'.repeat(129), {}, []]) {
    assert.throws(() => requireCompanyId(value), (e) => e instanceof AiRuntimeError && e.code === 'company_id_invalid');
  }
});

test('requireCompanyId accepts integer and string ids and normalises them to one string', () => {
  assert.equal(requireCompanyId(7), '7');
  assert.equal(requireCompanyId('7'), '7');
  assert.equal(requireCompanyId('acme-01'), 'acme-01');
});

test('chat refuses a call without companyId and never reaches the provider', async () => {
  const log = [];
  const runtime = createAiRuntime({ chatProviders: [fakeChat('primary', OK('primary'), log)] });
  await assert.rejects(runtime.chat({ companyId: undefined, messages: USER_MSG }), (e) => e.code === 'company_id_required');
  assert.deepEqual(log, []);
});

test('runPipeline and evaluateResponse refuse a missing companyId', async () => {
  await assert.rejects(runPipeline({ companyId: '', request: { text: 'x' }, stages: {} }), (e) => e.code === 'company_id_required');
  await assert.rejects(
    evaluateResponse({ companyId: null, agentName: 'a', sessionId: 's', response: { result: 'x' } }),
    (e) => e.code === 'company_id_required',
  );
});

test('retrieveChunks requires companyId and does not call the store without it', async () => {
  let called = false;
  const store = { findCandidates: async () => ((called = true), []) };
  await assert.rejects(retrieveChunks({ companyId: undefined, query: 'roof repair', store }), (e) => e.code === 'company_id_required');
  assert.equal(called, false);
});

// ---------------------------------------------------------------------------
// Fail-closed default
// ---------------------------------------------------------------------------

test('runtime with no clients configured is disabled and refuses every call', async () => {
  const runtime = createAiRuntime();
  assert.equal(runtime.mode, 'disabled');

  const chat = await runtime.chat({ companyId: 1, messages: USER_MSG });
  assert.equal(chat.ok, false);
  assert.equal(chat.error, 'provider_not_configured');
  assert.equal(chat.retryable, false);

  const embed = await runtime.embed({ companyId: 1, input: 'x' });
  assert.equal(embed.ok, false);
  assert.equal(embed.error, 'provider_not_configured');

  const health = await runtime.health();
  assert.equal(health.ok, false);
});

test('disabled runtime does not auto-wire a provider from environment variables', async () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-should-not-be-read';
  try {
    const runtime = createAiRuntime();
    assert.equal(runtime.mode, 'disabled');
    const result = await runtime.chat({ companyId: 1, messages: USER_MSG });
    assert.equal(result.error, 'provider_not_configured');
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  }
});

test('disabled provider classes perform no work and refuse', async () => {
  const chat = await new DisabledChatProvider().chat();
  const embed = await new DisabledEmbeddingProvider().embed();
  assert.equal(chat.error, 'provider_not_configured');
  assert.equal(embed.error, 'provider_not_configured');
  assert.equal(new DisabledChatProvider().providerName(), 'disabled');
});

test('chain with no providers refuses without calling anything', async () => {
  const result = await new ProviderFailoverChain({ chatProviders: [] }).chat({ companyId: 1, messages: USER_MSG });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no_chat_providers_configured');
});

// ---------------------------------------------------------------------------
// Provider failover
// ---------------------------------------------------------------------------

test('failover tries providers in order and moves on after a 429', async () => {
  const log = [];
  const events = [];
  const runtime = createAiRuntime({
    chatProviders: [fakeChat('primary', FAIL('primary', 429), log), fakeChat('secondary', OK('secondary', 'from secondary'), log)],
    onFailure: (e) => events.push(e),
  });
  const result = await runtime.chat({ companyId: 1, messages: USER_MSG });
  assert.deepEqual(log, ['primary', 'secondary']);
  assert.equal(result.ok, true);
  assert.equal(result.content, 'from secondary');
  assert.equal(events[0].status, 429);
  assert.equal(events[0].failover, true);
});

test('failover stops on a 400 and never calls the next provider', async () => {
  const log = [];
  const runtime = createAiRuntime({
    chatProviders: [fakeChat('primary', FAIL('primary', 400), log), fakeChat('secondary', OK('secondary'), log)],
  });
  const result = await runtime.chat({ companyId: 1, messages: USER_MSG });
  assert.deepEqual(log, ['primary']);
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

test('failover moves on when a provider throws (transport failure)', async () => {
  const log = [];
  const throwing = {
    providerName: () => 'primary',
    chat: async () => {
      log.push('primary');
      throw new Error('socket reset');
    },
    health: async () => ({ ok: true, provider: 'primary', reason: null }),
  };
  const runtime = createAiRuntime({ chatProviders: [throwing, fakeChat('secondary', OK('secondary'), log)] });
  const result = await runtime.chat({ companyId: 1, messages: USER_MSG });
  assert.deepEqual(log, ['primary', 'secondary']);
  assert.equal(result.ok, true);
});

test('failover moves on for a transport failure with no status', async () => {
  const log = [];
  const runtime = createAiRuntime({
    chatProviders: [fakeChat('primary', FAIL('primary', null), log), fakeChat('secondary', OK('secondary'), log)],
  });
  await runtime.chat({ companyId: 1, messages: USER_MSG });
  assert.deepEqual(log, ['primary', 'secondary']);
});

test('failover returns the last failure when every provider fails', async () => {
  const log = [];
  const chain = new ProviderFailoverChain({
    chatProviders: [fakeChat('primary', FAIL('primary', 500), log), fakeChat('secondary', FAIL('secondary', 503), log)],
  });
  const result = await chain.chat({ companyId: 1, messages: USER_MSG });
  assert.deepEqual(log, ['primary', 'secondary']);
  assert.equal(result.ok, false);
  assert.equal(result.provider, 'secondary');
  assert.equal(result.status, 503);
});

test('retryable false stops the chain even when the status would allow failover', async () => {
  const log = [];
  const chain = new ProviderFailoverChain({
    chatProviders: [fakeChat('primary', FAIL('primary', 500, { retryable: false }), log), fakeChat('secondary', OK('secondary'), log)],
  });
  const result = await chain.chat({ companyId: 1, messages: USER_MSG });
  assert.deepEqual(log, ['primary']);
  assert.equal(result.ok, false);
});

test('embedding failover moves on after a 500', async () => {
  const log = [];
  const vectors = { ok: true, provider: 'local', model: 'e', vectors: [[0.1, 0.2]], usage: null, latency_ms: 1 };
  const runtime = createAiRuntime({
    embeddingProviders: [fakeEmbed('openai', FAIL('openai', 500), log), fakeEmbed('local', vectors, log)],
  });
  const result = await runtime.embed({ companyId: 'acme', input: 'hello' });
  assert.deepEqual(log, ['openai', 'local']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.vectors, [[0.1, 0.2]]);
});

test('providers receive the normalised companyId', async () => {
  const seen = [];
  const runtime = createAiRuntime({
    chatProviders: [fakeChat('primary', (input) => (seen.push(input.companyId), OK('primary')), [])],
  });
  await runtime.chat({ companyId: 42, messages: USER_MSG });
  assert.deepEqual(seen, ['42']);
});

test('chat rejects malformed messages before any provider call', async () => {
  const log = [];
  const runtime = createAiRuntime({ chatProviders: [fakeChat('primary', OK('primary'), log)] });
  const result = await runtime.chat({ companyId: 1, messages: [{ role: 'robot', content: 'x' }] });
  assert.equal(result.error, 'messages_invalid');
  assert.deepEqual(log, []);
});

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

test('input guardrail blocks a chat call before the provider runs', async () => {
  const log = [];
  const runtime = createAiRuntime({
    chatProviders: [fakeChat('primary', OK('primary'), log)],
    stages: { guardrail: createBlockedTermGuardrail({ blocked_terms: ['jailbreak'] }) },
  });
  const result = await runtime.chat({ companyId: 1, messages: [{ role: 'user', content: 'please JAILBREAK this' }] });
  assert.equal(result.error, 'guardrail_blocked');
  assert.deepEqual(log, []);
});

test('output guardrail blocks an answer that contains a restricted term', async () => {
  const runtime = createAiRuntime({
    chatProviders: [fakeChat('primary', OK('primary', 'here is the secret code'), [])],
    outputGuardrail: createBlockedTermGuardrail({ blocked_terms: ['secret code'] }),
  });
  const result = await runtime.chat({ companyId: 1, messages: USER_MSG });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'output_blocked');
});

test('blocked-term screening is case-insensitive by default and reads structured block rules', () => {
  const manifest = {
    blocked_terms: ['forbidden'],
    input_guardrails: [{ action: 'block', patterns: ['Bypass Safety'] }, { action: 'allow', patterns: ['ok'] }],
  };
  assert.equal(screenInput(manifest, 'this is FORBIDDEN text').term, 'forbidden');
  assert.equal(screenInput(manifest, 'please bypass safety now').term, 'bypass safety');
  assert.equal(screenInput(manifest, 'an ok request'), null);
});

test('case_sensitive mode only matches the exact case', () => {
  const manifest = { blocked_terms: ['Secret'], case_sensitive: true };
  assert.equal(screenInput(manifest, 'secret'), null);
  assert.equal(screenInput(manifest, 'a Secret').term, 'Secret');
});

test('input_screening false turns input screening off, and output screening still applies', () => {
  const manifest = { blocked_terms: ['leak'], input_screening: false };
  assert.equal(screenInput(manifest, 'leak'), null);
  assert.equal(screenOutput(manifest, 'leak').context, 'output');
});

test('an injected handler replaces term matching', () => {
  const handler = { check: (text, context) => (text.includes('X') ? { term: 'X', context, message: 'handler' } : null) };
  const manifest = { blocked_terms: ['plain'] };
  assert.equal(screenInput(manifest, 'plain words', handler), null);
  assert.equal(screenInput(manifest, 'has X in it', handler).message, 'handler');
});

test('a guardrail verdict without an explicit pass blocks the request (fail-closed)', async () => {
  const log = [];
  const runtime = createAiRuntime({
    stages: {
      guardrail: { evaluate: () => ({ ok: true }) },
      retrieval: () => ((log.push('retrieval'), [])),
    },
  });
  const result = await runtime.runPipeline({ companyId: 1, request: { text: 'hi' } });
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'guardrail_malformed_result');
  assert.deepEqual(log, []);
});

test('a guardrail that throws blocks the request', async () => {
  const result = await runPipeline({
    companyId: 1,
    request: { text: 'hi' },
    stages: { guardrail: { evaluate: () => { throw new Error('boom'); } } },
  });
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'guardrail_error');
});

// ---------------------------------------------------------------------------
// Pipeline stage order and blocking
// ---------------------------------------------------------------------------

test('a guardrail block stops the pipeline before retrieval, tool and citation', async () => {
  const log = [];
  const result = await runPipeline({
    companyId: 1,
    request: { text: 'blocked text', tool: 'echo', params: {} },
    stages: {
      guardrail: { evaluate: () => ({ pass: false, reason: 'blocked term' }) },
      retrieval: () => (log.push('retrieval'), []),
      toolExecutor: { execute: async () => (log.push('tool'), {}) },
      citation: () => (log.push('citation'), []),
    },
  });
  assert.equal(result.blocked, true);
  assert.equal(result.stage, 'guardrail');
  assert.equal(result.reason, 'blocked term');
  assert.deepEqual(log, []);
});

test('pipeline runs guardrail, retrieval, tool, citation in order and passes companyId to each', async () => {
  const log = [];
  const seen = [];
  const doc = { chunk_id: '5:0', document_id: 5, chunk_index: 0, text: 'roof', metadata: {}, score: 1 };
  const result = await runPipeline({
    companyId: 42,
    request: { text: 'roof repair', tool: 'quote', params: { job: 'j1' } },
    context: { userId: 9 },
    stages: {
      guardrail: { evaluate: (input) => (seen.push(['guardrail', input.companyId]), log.push('guardrail'), { pass: true }) },
      retrieval: (q, companyId) => (seen.push(['retrieval', companyId]), log.push('retrieval'), [doc]),
      toolExecutor: {
        execute: async (name, params, ctx) => (seen.push(['tool', ctx.companyId, ctx.userId]), log.push('tool'), {
          ok: true, tool: name, data: { params }, message: 'ok', warnings: [], audit_ref: null, error_code: null,
        }),
      },
      citation: (results, companyId) => (seen.push(['citation', companyId]), log.push('citation'), results.map((r) => ({ document_id: r.document_id }))),
    },
  });
  assert.deepEqual(log, ['guardrail', 'retrieval', 'tool', 'citation']);
  assert.deepEqual(seen, [['guardrail', '42'], ['retrieval', '42'], ['tool', '42', 9], ['citation', '42']]);
  assert.equal(result.ok, true);
  assert.equal(result.stage, 'complete');
  assert.equal(result.citations[0].document_id, 5);
});

test('a tool request with no tool executor is refused at the tool stage', async () => {
  const result = await runPipeline({ companyId: 1, request: { text: 'x', tool: 'anything' }, stages: {} });
  assert.equal(result.stage, 'tool');
  assert.equal(result.reason, 'tool_not_configured');
  assert.equal(result.ok, false);
});

test('citations are not attached when retrieval returns nothing', async () => {
  let cited = false;
  const result = await runPipeline({
    companyId: 1,
    request: { text: 'nothing matches' },
    stages: { retrieval: () => [], citation: () => ((cited = true), []) },
  });
  assert.equal(cited, false);
  assert.equal(result.stage, 'complete');
});

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

test('extractTerms lower-cases, de-duplicates and drops terms shorter than three characters', () => {
  assert.deepEqual(extractTerms('  Roof  a ROOF gutter  '), ['roof', 'gutter']);
  assert.deepEqual(extractTerms(''), []);
});

test('retrieveChunks asks the store for tenant-scoped candidates with an over-fetch limit', async () => {
  const calls = [];
  const store = {
    findCandidates: async (q) => (calls.push(q), []),
  };
  await retrieveChunks({ companyId: 7, query: 'roof repair', policy: { top_k: 4 }, store });
  assert.deepEqual(calls, [{ companyId: '7', terms: ['roof', 'repair'], limit: 12 }]);
});

test('ranking keeps an older, better match ahead of a newer weaker one', () => {
  const candidates = [
    { company_id: 'acme', document_id: 2, chunk_index: 0, content: 'gutter cleaning', document: null },
    { company_id: 'acme', document_id: 1, chunk_index: 0, content: 'roof repair and roof sealing', document: null },
  ];
  const ranked = rankCandidates(candidates, { companyId: 'acme', terms: ['roof', 'repair'], topK: 5 });
  assert.equal(ranked[0].document_id, 1);
  assert.equal(ranked[0].score, 2);
  assert.equal(ranked.length, 1, 'zero-score candidates are dropped');
});

test('document preference boost is capped at 5', () => {
  const candidates = [
    { company_id: 'acme', document_id: 1, chunk_index: 0, content: 'roof', document: { preferred_weight: 500 } },
  ];
  const [only] = rankCandidates(candidates, { companyId: 'acme', terms: ['roof'], topK: 1 });
  assert.equal(only.score, 1 + 5);
});

test('ranking drops candidates from another tenant or with no tenant id', () => {
  const candidates = [
    { company_id: 'other', document_id: 1, chunk_index: 0, content: 'roof', document: null },
    { company_id: '', document_id: 2, chunk_index: 0, content: 'roof', document: null },
    { company_id: 'acme', document_id: 3, chunk_index: 0, content: 'roof', document: null },
  ];
  const ranked = rankCandidates(candidates, { companyId: 'acme', terms: ['roof'], topK: 5 });
  assert.deepEqual(ranked.map((r) => r.document_id), [3]);
});

test('ranking respects topK', () => {
  const candidates = Array.from({ length: 8 }, (_, i) => ({
    company_id: 'acme', document_id: i + 1, chunk_index: 0, content: 'roof', document: null,
  }));
  assert.equal(rankCandidates(candidates, { companyId: 'acme', terms: ['roof'], topK: 3 }).length, 3);
});

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

test('buildCitation sets source_url only for http or https sources and caps the excerpt at 200 characters', () => {
  const base = { company_id: 'acme', document_id: 1, chunk_index: 0, content: 'x'.repeat(300), content_hash: 'h', document_title: 'Guide' };
  const web = buildCitation({ ...base, document_source: 'https://example.com/guide' });
  assert.equal(web.source_url, 'https://example.com/guide');
  assert.equal(web.module_reference, null);
  assert.equal(web.excerpt.length, 200);

  const internal = buildCitation({ ...base, document_source: 'TitanZero/policies/example' });
  assert.equal(internal.source_url, null);
  assert.equal(internal.module_reference, 'TitanZero/policies/example');
  assert.equal(internal.title, 'Guide');
});

test('parseChunkId accepts only digits:digits', () => {
  assert.deepEqual(parseChunkId('12:3'), { document_id: 12, chunk_index: 3 });
  for (const bad of ['12', '1:x', '-1:0', 'a:b', '1:2:3', '']) {
    assert.equal(parseChunkId(bad), null);
  }
});

test('resolveCitations drops chunks from another tenant and reports them as unresolved', () => {
  const results = [
    { chunk_id: '1:0', document_id: 1, chunk_index: 0, text: 'a', metadata: {}, score: 1 },
    { chunk_id: '2:0', document_id: 2, chunk_index: 0, text: 'b', metadata: {}, score: 1 },
    { chunk_id: '3:0', document_id: 3, chunk_index: 0, text: 'c', metadata: {}, score: 1 },
  ];
  const chunks = new Map([
    ['1:0', { company_id: 'acme', document_id: 1, chunk_index: 0, content: 'a', content_hash: 'h1', document_title: 'A', document_source: null }],
    ['2:0', { company_id: 'other', document_id: 2, chunk_index: 0, content: 'b', content_hash: 'h2', document_title: 'B', document_source: null }],
  ]);
  const out = resolveCitations({ companyId: 'acme', results, chunks });
  assert.deepEqual(out.citations.map((c) => c.document_id), [1]);
  assert.deepEqual(out.unresolved, ['2:0', '3:0']);
});

test('attachCitations loads chunks for the tenant and resolves them', async () => {
  const seenTenants = [];
  const results = [{ chunk_id: '9:4', document_id: 9, chunk_index: 4, text: 't', metadata: {}, score: 2 }];
  const out = await attachCitations({
    companyId: 'acme',
    results,
    loadChunks: async (keys, companyId) => {
      seenTenants.push(companyId);
      return [{ company_id: 'acme', document_id: 9, chunk_index: 4, content: 'body', content_hash: 'hh', document_title: 'Doc', document_source: 'https://x.test/d' }];
    },
  });
  assert.deepEqual(seenTenants, ['acme']);
  assert.equal(out.citations[0].source_url, 'https://x.test/d');
  assert.deepEqual(out.unresolved, []);
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function auditSink() {
  const entries = [];
  return { entries, audit: (e) => entries.push(e) };
}

test('ToolExecutor requires an explicit allowlist (no wildcard default)', () => {
  assert.throws(() => new ToolExecutor({ manifest: {}, allowedTools: '*' }), (e) => e.code === 'config_invalid');
});

test('a tool outside the allowlist is refused, its handler is not called, and the attempt is audited', async () => {
  let called = false;
  const { entries, audit } = auditSink();
  const exec = new ToolExecutor({
    manifest: { send_sms: { handler: () => ((called = true), {}) } },
    allowedTools: ['echo'],
    audit,
  });
  const result = await exec.execute('send_sms', {}, { companyId: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'tool_not_allowed');
  assert.equal(called, false);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'blocked');
});

test('default-deny permission gate refuses unlisted tools and checks listed ones against the user', async () => {
  const gate = createToolPermissionGate({
    requirements: { create_quote: 'manage_quotes' },
    hasPermission: (user, perm) => user.perms.includes(perm),
  });
  const exec = new ToolExecutor({
    manifest: {
      create_quote: { handler: () => ({ id: 'q1' }) },
      list_roles: { handler: () => ({ roles: [] }) },
    },
    allowedTools: ['create_quote', 'list_roles'],
    permissionCheck: gate,
  });
  const noPerm = await exec.execute('create_quote', {}, { companyId: 1, user: { perms: [] } });
  assert.equal(noPerm.error_code, 'tool_permission_denied');

  const withPerm = await exec.execute('create_quote', {}, { companyId: 1, user: { perms: ['manage_quotes'] } });
  assert.equal(withPerm.ok, true);

  const unlisted = await exec.execute('list_roles', {}, { companyId: 1, user: { perms: [] } });
  assert.equal(unlisted.error_code, 'tool_permission_denied', 'unlisted tools are denied unless marked unrestricted');
});

test('a required input field that is missing or empty is refused before the handler runs', async () => {
  let called = false;
  const { entries, audit } = auditSink();
  const exec = new ToolExecutor({
    manifest: { book: { handler: () => ((called = true), {}), input_schema: { email: 'required|string' } } },
    allowedTools: ['book'],
    audit,
  });
  const result = await exec.execute('book', { email: '' }, { companyId: 1 });
  assert.equal(result.error_code, 'tool_input_invalid');
  assert.equal(result.data.errors.email, 'This field is required.');
  assert.equal(called, false);
  assert.equal(entries[0].status, 'blocked');
});

test('dry run returns without calling the handler and is audited as dry_run', async () => {
  let called = false;
  const { entries, audit } = auditSink();
  const exec = new ToolExecutor({ manifest: { t: { handler: () => ((called = true), {}) } }, allowedTools: ['t'], audit });
  const result = await exec.execute('t', { a: 1 }, { companyId: 1, dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.data.dry_run, true);
  assert.equal(called, false);
  assert.equal(entries[0].status, 'dry_run');
});

test('a successful call writes exactly one audit entry with a hashed input and the tenant', async () => {
  const { entries, audit } = auditSink();
  const exec = new ToolExecutor({ manifest: { echo: { handler: (p) => ({ echo: p }) } }, allowedTools: ['echo'], audit });
  const result = await exec.execute('echo', { message: 'hi' }, { companyId: 'acme', userId: 3 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { echo: { message: 'hi' } });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'success');
  assert.equal(entries[0].company_id, 'acme');
  assert.equal(entries[0].user_id, 3);
  assert.equal(entries[0].input_hash.length, 64);
});

test('a handler that throws returns tool_failed with a generic message, and one audit entry records the detail', async () => {
  const { entries, audit } = auditSink();
  const exec = new ToolExecutor({
    manifest: { boom: { handler: () => { throw new Error('db password leaked'); } } },
    allowedTools: ['boom'],
    audit,
  });
  const result = await exec.execute('boom', {}, { companyId: 1 });
  assert.equal(result.error_code, 'tool_failed');
  assert.equal(result.message, 'Tool failed.');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'failed');
  assert.equal(entries[0].error, 'db password leaked');
});

test('a slow handler times out once, its signal is aborted, and it is audited once', async () => {
  const { entries, audit } = auditSink();
  let signalAborted = null;
  const exec = new ToolExecutor({
    manifest: {
      slow: {
        handler: (_p, call) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve({ late: true }), 500);
            call.signal.addEventListener('abort', () => {
              signalAborted = call.signal.aborted;
              clearTimeout(timer);
              reject(new Error('aborted'));
            });
          }),
      },
    },
    allowedTools: ['slow'],
    timeoutMs: 20,
    audit,
  });
  const result = await exec.execute('slow', {}, { companyId: 1 });
  assert.equal(result.error_code, 'tool_timed_out');
  assert.equal(signalAborted, true);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'timed_out');
});

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

test('task completion: empty is 0, a result key with no expectations is 100, partial expected keys are pro rata', () => {
  assert.equal(scoreTaskCompletion({}, {}), 0);
  assert.equal(scoreTaskCompletion({ result: 'done' }, {}), 100);
  assert.equal(scoreTaskCompletion({ result: 'done' }, { expected_keys: ['result', 'data'] }), 90);
});

test('hallucination flag matches forbidden values, ignores key names, and skips empty needles', () => {
  assert.equal(detectHallucination({ result: 'the price is 10' }, { forbidden_strings: ['price is 10'] }), 1);
  assert.equal(detectHallucination({ result: 'ok' }, { forbidden_strings: ['result'] }), 0, 'a key name is not a value');
  assert.equal(detectHallucination({ result: 'ok' }, { forbidden_strings: [''] }), 0, 'an empty needle is skipped');
  assert.equal(detectHallucination({ result: 'As an AI I cannot do that' }), 1);
});

test('tool accuracy is recall over expected tools', () => {
  assert.equal(scoreToolAccuracy({ tool_calls: ['a'] }, { expected_tools: ['a', 'b'] }), 50);
  assert.equal(scoreToolAccuracy({}, {}), 100);
});

test('composite uses the 0.5 / 0.3 / 0.2 weights and stays within 0 to 100', () => {
  assert.equal(compositeScore(100, 0, 100), 100);
  assert.equal(compositeScore(100, 1, 100), 80);
  assert.equal(compositeScore(0, 1, 0), 0);
});

test('evaluateResponse persists through the sink with the tenant, and latency is outside the composite', async () => {
  const saved = [];
  const base = { companyId: 'acme', agentName: 'crm_agent', sessionId: 's1', response: { result: 'Lead created.' } };
  const fast = await evaluateResponse({ ...base, latencyMs: 250 }, (s) => saved.push(s));
  const slow = await evaluateResponse({ ...base, latencyMs: 9999 });
  assert.equal(fast.company_id, 'acme');
  assert.equal(fast.response_latency_ms, 250);
  assert.equal(fast.composite_score, slow.composite_score);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].agent_name, 'crm_agent');
});

test('evaluateResponse rejects a blank agent name', async () => {
  await assert.rejects(
    evaluateResponse({ companyId: 1, agentName: '  ', sessionId: 's', response: {} }),
    (e) => e.code === 'input_invalid',
  );
});

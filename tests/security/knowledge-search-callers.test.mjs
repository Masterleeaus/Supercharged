// Security regression test: every caller of RAGKnowledgeService.searchKnowledge passes a scope object first.
// Static source test: the modules need the database and provider clients to load, so this reads source only.
// No database, network or stdout.
// Run: node --test --experimental-transform-types tests/security/knowledge-search-callers.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('../../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, ROOT), 'utf8');

const CALLER_FILES = [
  'server/routes/rag-knowledge-routes.ts',
  'server/routes/webhook-routes.ts',
  'server/services/rag-elevenlabs-tool.ts',
  'server/modules/widget/public-widget-routes.ts',
  'server/services/openai-voice-agent/hydrator.ts',
  'server/engines/twilio-openai/services/openai-agent-factory.ts',
  'server/engines/plivo/services/openai-agent-factory.ts',
  'server/workforce/runtime/knowledge-retrieval.ts',
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(new URL(dir, ROOT), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(rel, out);
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

test('no call to searchKnowledge passes a positional query first (old signature)', () => {
  const offenders = [];
  for (const file of walk('server')) {
    if (file === 'server/services/rag-knowledge.ts') continue;
    const src = read(file);
    // The first argument must be a scope: an object literal or the `scope` parameter.
    const re = /searchKnowledge\(\s*(?!\{|scope\b)([^\s)]+)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      offenders.push(`${file}: ${src.slice(m.index, m.index + 60).split('\n')[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the search route is behind requireCompanyScope and takes company from res.locals', () => {
  const src = read('server/routes/rag-knowledge-routes.ts');
  assert.match(src, /router\.post\("\/search", authenticateToken, requireCompanyScope, /);
  assert.match(src, /\{ companyId: res\.locals\.companyId, userId: req\.userId! \}/);
});

test('the router factory takes requireCompanyScope as an injected guard and fails closed without it', () => {
  const src = read('server/routes/rag-knowledge-routes.ts');
  assert.match(src, /guards: \{ requireCompanyScope: RequestHandler \}/);
  assert.match(src, /throw new Error\("createRAGKnowledgeRoutes requires requireCompanyScope"\)/);
  assert.doesNotMatch(src, /from ["']\.\.\/middleware\/company-scope["']/, 'guards must be injected, not imported');
});

test('the tool webhook takes company and owner from the agents row and refuses a mismatched owner', () => {
  const src = read('server/routes/rag-knowledge-routes.ts');
  const start = src.indexOf('router.post("/tool-webhook"');
  const body = src.slice(start, src.indexOf('return router;', start));
  assert.match(body, /from\(agents\)/);
  assert.match(body, /\.where\(eq\(agents\.id, agent_id\)\)/);
  assert.match(body, /!agentRow\.companyId \|\| agentRow\.userId !== user_id/);
  assert.match(body, /\{ companyId: agentRow\.companyId, userId: agentRow\.userId \}/);
  assert.doesNotMatch(body, /req\.body\.companyId|company_id/, 'company must not come from the body');
});

test('the ElevenLabs webhook passes company from the same agent row into the tool handler', () => {
  const src = read('server/routes/webhook-routes.ts');
  assert.match(src, /companyId = agent\[0\]\.companyId \?\? null;/);
  assert.match(src, /companyId = regularAgent\[0\]\.companyId \?\? null;/);
  assert.match(src, /if \(!companyId\) \{/);
  assert.match(src, /handleAskKnowledgeToolCall\(query, knowledgeBaseIds, \{ companyId, userId \}\)/);
});

test('handleAskKnowledgeToolCall takes a scope object and forwards it', () => {
  const src = read('server/services/rag-elevenlabs-tool.ts');
  assert.match(src, /knowledgeBaseIds: string\[\],\s*scope: KnowledgeSearchScope/);
  assert.match(src, /searchKnowledge\(\s*scope,/);
});

test('the widget lookup takes company from the widget row and refuses when it is missing', () => {
  const src = read('server/modules/widget/public-widget-routes.ts');
  const start = src.indexOf("router.post('/widget/session/:sessionId/knowledge-lookup'");
  const body = src.slice(start, src.indexOf('formatResultsForAgent(results, 800)', start));
  assert.match(body, /if \(!widget\.companyId\) \{/);
  assert.match(body, /\{ companyId: widget\.companyId, userId: widget\.userId \}/);
  assert.ok(body.indexOf('if (!widget.companyId)') < body.indexOf('searchKnowledge('), 'refusal must precede the search');
});

test('the hydrator passes companyId into the knowledge handler and from the tool context', () => {
  const src = read('server/services/openai-voice-agent/hydrator.ts');
  assert.match(src, /function createKnowledgeBaseHandler\(\s*knowledgeBaseIds: string\[\],\s*userId: string,\s*companyId: string/);
  assert.match(src, /\{ companyId, userId \},/);
  assert.match(src, /context\.userId,\s*context\.companyId\s*\);/);
  assert.match(src, /companyId: toolContext\.companyId,/);
});

test('both OpenAI agent factories add companyId to the knowledge tool and refuse a missing company', () => {
  for (const file of [
    'server/engines/twilio-openai/services/openai-agent-factory.ts',
    'server/engines/plivo/services/openai-agent-factory.ts',
  ]) {
    const src = read(file);
    assert.match(src, /userId: string,\s*companyId: string\s*\): AgentConfigWithContext/, `${file} signature`);
    assert.match(src, /\{ companyId, userId \},/, `${file} search scope`);
    assert.match(src, /if \(!agent\.companyId\) \{/, `${file} refusal`);
  }
  const plivo = read('server/engines/plivo/services/openai-agent-factory.ts');
  assert.match(plivo, /context: \{\s*userId: string;\s*companyId: string;/);
  assert.match(plivo, /\{ companyId: context\.companyId, userId: context\.userId \},/);
});

test('the workforce knowledge port receives userId and retrieval refuses a missing user', () => {
  const src = read('server/workforce/runtime/knowledge-retrieval.ts');
  assert.match(src, /searchChunks\(input: \{ companyId: CompanyId; userId: string;/);
  assert.match(src, /port\.searchChunks\(\{ companyId, userId, query: request\.query, limit \}\)/);
  assert.match(src, /return \{ ok: false, error: 'user_required' \}/);
  const idx = src.indexOf("return { ok: false, error: 'user_required' }");
  assert.ok(idx < src.indexOf('port.searchChunks('), 'user check must precede the port call');
});

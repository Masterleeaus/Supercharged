// Security regression test: RAGKnowledgeService.searchKnowledge must be company-scoped and fail closed.
// Static source test: loading rag-knowledge.ts needs server/db.ts (DATABASE_URL, @shared alias), so this
// reads the declaration and asserts the guard order and filters. No database, network or stdout.
// Run: node --test --experimental-transform-types tests/security/knowledge-search-scope.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const FILE = 'server/services/rag-knowledge.ts';
const source = fs.readFileSync(new URL('../../' + FILE, import.meta.url), 'utf8');

function methodBody(name) {
  const start = source.indexOf(`static async ${name}(`);
  assert.ok(start >= 0, `${name} must exist in ${FILE}`);
  const next = source.indexOf('\n  /**', start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

test('searchKnowledge takes an explicit scope object as its first parameter', () => {
  const head = source.slice(source.indexOf('static async searchKnowledge('), source.indexOf('): Promise', source.indexOf('static async searchKnowledge(')));
  assert.match(head, /^static async searchKnowledge\(\s*scope: KnowledgeSearchScope,\s*query: string,/);
  assert.doesNotMatch(head, /userId: string,\s*maxResults/, 'old user-only signature must be gone');
});

test('the scope is validated before any database or embedding call', () => {
  const body = methodBody('searchKnowledge');
  const guard = body.indexOf('await assertKnowledgeScope(scope)');
  assert.ok(guard >= 0, 'searchKnowledge must call assertKnowledgeScope');
  for (const sink of ['generateEmbedding(', 'db\n', 'db.select']) {
    const at = body.indexOf(sink);
    if (at >= 0) assert.ok(guard < at, `scope check must precede ${sink.trim()}`);
  }
});

test('assertKnowledgeScope refuses a missing company and a company the user does not belong to', () => {
  const start = source.indexOf('async function assertKnowledgeScope(');
  const body = source.slice(start, source.indexOf('\n}\n', start));
  assert.match(body, /companyId !== 'string' \|\| !UUID_PATTERN\.test/);
  assert.match(body, /throw new KnowledgeScopeError\('company_scope_required'\)/);
  assert.match(body, /eq\(users\.companyId, candidate\.companyId\)/);
  assert.match(body, /throw new KnowledgeScopeError\('scope_mismatch'\)/);
});

test('the search query is restricted to the company knowledge bases and the user', () => {
  const body = methodBody('searchKnowledge');
  assert.match(body, /eq\(knowledgeBase\.companyId, companyId\)/);
  assert.match(body, /innerJoin\(knowledgeBase,/);
  assert.match(body, /eq\(knowledgeChunks\.userId, userId\)/);
});

test('a search failure throws a generic error instead of returning an empty list', () => {
  const body = methodBody('searchKnowledge');
  const catchStart = body.indexOf('} catch (error: any) {');
  assert.ok(catchStart >= 0, 'searchKnowledge must keep a catch block');
  const catchBody = body.slice(catchStart);
  assert.doesNotMatch(catchBody, /return \[\];/);
  assert.match(catchBody, /throw new Error\('Knowledge search failed\.'\)/);
  assert.doesNotMatch(catchBody, /new Error\([^)]*error\.message/, 'provider message must not be rethrown');
});

test('the scope error is a typed class and users is imported for the membership check', () => {
  assert.match(source, /export class KnowledgeScopeError extends Error/);
  assert.match(source, /^\s+users,$/m, 'users must be imported from @shared/schema');
});

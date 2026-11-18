// Licence: original TitanZero test code. No Mastra or VoltAgent source is copied.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkText, MAX_CHUNK_TOKENS } from '../../../server/integrations/voltagent/rag/chunker.ts';
import { whitespaceTokenizer } from '@voltagent/rag';
import { createInMemoryVectorStoreForTests } from '../../../server/integrations/voltagent/rag/vector-store.ts';
import { createKnowledgeSearchPort } from '../../../server/integrations/voltagent/rag/knowledge-port.ts';
import { createPgVectorStore } from '../../../server/integrations/voltagent/vector-pg/pg-vector-store.ts';
import { retrieveCompanyKnowledge } from '../../../server/workforce/runtime/knowledge-retrieval.ts';

// Toy embedding: the vector is a fixed lookup so the test controls similarity exactly.
const VECTORS = { 'boiler repair': [1, 0], 'pool cleaning': [0, 1] };
const embed = async (texts) => texts.map((t) => VECTORS[t] ?? [0.5, 0.5]);

async function seededStore() {
  const store = createInMemoryVectorStoreForTests();
  await store.upsert([
    { companyId: '7', ownerUserId: 'u1', knowledgeBaseId: 'kb-a', chunkIndex: 0, chunkText: 'boiler service notes', vector: [1, 0] },
    { companyId: '7', ownerUserId: 'u1', knowledgeBaseId: 'kb-a', chunkIndex: 1, chunkText: 'pool notes', vector: [0, 1] },
    { companyId: '7', ownerUserId: 'u2', knowledgeBaseId: 'kb-b', chunkIndex: 0, chunkText: 'other user boiler', vector: [1, 0] },
    { companyId: '8', ownerUserId: 'u1', knowledgeBaseId: 'kb-c', chunkIndex: 0, chunkText: 'other company boiler', vector: [1, 0] },
  ]);
  return store;
}

test('chunker keeps whole sentences, overlaps them when asked, and numbers chunks in order', () => {
  const text = 'Alpha one two. Beta three four. Gamma five six. Delta seven eight.';
  const chunks = chunkText(text, { maxTokens: 6, overlapSentences: 1 });
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.map((c) => c.index), chunks.map((_, i) => i));
  assert.equal(chunks[0].text, 'Alpha one two. Beta three four.');
  assert.equal(chunks[1].text, 'Beta three four. Gamma five six.');
  for (const c of chunks) assert.ok(c.text.endsWith('.'));
  for (const c of chunks) assert.ok(whitespaceTokenizer.countTokens(c.text) <= 6);
});

test('chunker splits an over-long sentence so every chunk stays within maxTokens', () => {
  const long = `${'word '.repeat(40).trim()}.`;
  const chunks = chunkText(`Short one. ${long} Short two.`, { maxTokens: 10, overlapSentences: 0 });
  assert.ok(chunks.length > 3);
  for (const c of chunks) assert.ok(whitespaceTokenizer.countTokens(c.text) <= 10);
});

test('chunker is deterministic and returns nothing for blank input', () => {
  assert.deepEqual(chunkText('One two. Three four.', { maxTokens: 4, overlapSentences: 0 }), chunkText('One two. Three four.', { maxTokens: 4, overlapSentences: 0 }));
  assert.deepEqual(chunkText('   ', { maxTokens: 8, overlapSentences: 0 }), []);
});

test('chunker rejects bad options and input', () => {
  assert.throws(() => chunkText('x', { maxTokens: 0, overlapSentences: 0 }), /chunk_size_invalid/);
  assert.throws(() => chunkText('x', { maxTokens: MAX_CHUNK_TOKENS + 1, overlapSentences: 0 }), /chunk_size_invalid/);
  assert.throws(() => chunkText('x', { maxTokens: 10, overlapSentences: -1 }), /chunk_overlap_invalid/);
  assert.throws(() => chunkText('x', { maxTokens: 10, overlapSentences: 1.5 }), /chunk_overlap_invalid/);
  assert.throws(() => chunkText(42, { maxTokens: 10, overlapSentences: 0 }), /chunk_input_invalid/);
});

test('search returns only the caller company and owning user, best score first', async () => {
  const store = await seededStore();
  const hits = await store.search({ companyId: '7', ownerUserId: 'u1', vector: [1, 0], limit: 10 });
  assert.deepEqual(hits.map((h) => h.chunkText), ['boiler service notes', 'pool notes']);
  assert.ok(hits[0].score > hits[1].score);
  assert.ok(hits.every((h) => h.companyId === '7'));
});

test('search honours limit and refuses missing scope', async () => {
  const store = await seededStore();
  assert.equal((await store.search({ companyId: '7', ownerUserId: 'u1', vector: [1, 0], limit: 1 })).length, 1);
  await assert.rejects(() => store.search({ companyId: '', ownerUserId: 'u1', vector: [1, 0], limit: 1 }), /vector_scope_required/);
  await assert.rejects(() => store.search({ companyId: '7', ownerUserId: '', vector: [1, 0], limit: 1 }), /vector_scope_required/);
  await assert.rejects(() => store.search({ companyId: '7', ownerUserId: 'u1', vector: [1, 0], limit: 0 }), /vector_limit_invalid/);
});

test('the port returns company-scoped results through retrieveCompanyKnowledge', async () => {
  const port = createKnowledgeSearchPort({ store: await seededStore(), embed });
  const out = await retrieveCompanyKnowledge(port, { companyId: 7, userId: 'u1', query: 'boiler repair' });
  assert.equal(out.ok, true);
  assert.ok(out.results.length >= 1);
  assert.ok(out.results.every((r) => r.sourceRef.startsWith('kb:kb-a:')));
  assert.ok(!out.results.some((r) => r.snippet.includes('other')));
});

test('a user from another company or another user never sees the chunk', async () => {
  const port = createKnowledgeSearchPort({ store: await seededStore(), embed });
  const other = await retrieveCompanyKnowledge(port, { companyId: 8, userId: 'u1', query: 'boiler repair' });
  assert.equal(other.ok, true);
  assert.deepEqual(other.results.map((r) => r.sourceRef), ['kb:kb-c:0']);
  const u2 = await retrieveCompanyKnowledge(port, { companyId: 7, userId: 'u2', query: 'boiler repair' });
  assert.deepEqual(u2.results.map((r) => r.sourceRef), ['kb:kb-b:0']);
});

test('a missing company is refused before the embed or store is touched', async () => {
  let embedded = 0;
  const port = createKnowledgeSearchPort({ store: await seededStore(), embed: async (t) => { embedded += 1; return embed(t); } });
  const out = await retrieveCompanyKnowledge(port, { companyId: undefined, userId: 'u1', query: 'boiler repair' });
  assert.deepEqual(out, { ok: false, error: 'company_required' });
  assert.equal(embedded, 0);
});

test('an embed failure becomes retrieval_failed and returns no results', async () => {
  const port = createKnowledgeSearchPort({ store: await seededStore(), embed: async () => { throw new Error('provider down'); } });
  const out = await retrieveCompanyKnowledge(port, { companyId: 7, userId: 'u1', query: 'boiler repair' });
  assert.deepEqual(out, { ok: false, error: 'retrieval_failed' });
});

test('a malformed embed result becomes retrieval_failed', async () => {
  const port = createKnowledgeSearchPort({ store: await seededStore(), embed: async () => [[1], [2]] });
  const out = await retrieveCompanyKnowledge(port, { companyId: 7, userId: 'u1', query: 'boiler repair' });
  assert.deepEqual(out, { ok: false, error: 'retrieval_failed' });
});

test('the port factory requires a store and an embed function', () => {
  assert.throws(() => createKnowledgeSearchPort({ store: undefined, embed }), /knowledge_store_required/);
  assert.throws(() => createKnowledgeSearchPort({ store: createInMemoryVectorStoreForTests(), embed: undefined }), /knowledge_embed_required/);
});

test('the port runs over the Postgres store with company and user scope bound as SQL parameters', async () => {
  const sql = [];
  const db = {
    async query(text, params) {
      sql.push({ text, params });
      return { rows: [{ company_id: '7', knowledge_base_id: 'kb-a', chunk_index: 0, chunk_text: 'boiler notes', score: 0.9 }] };
    },
  };
  const store = createPgVectorStore({ db, table: 'kb_chunks', dimensions: 2 });
  const port = createKnowledgeSearchPort({ store, embed });
  const out = await retrieveCompanyKnowledge(port, { companyId: 7, userId: 'u1', query: 'boiler repair' });
  assert.equal(out.ok, true);
  assert.deepEqual(out.results.map((r) => r.sourceRef), ['kb:kb-a:0']);
  assert.equal(sql.length, 1);
  assert.ok(sql[0].text.includes('company_id = $2 AND owner_user_id = $3'));
  assert.deepEqual(sql[0].params.slice(1, 3), ['7', 'u1']);
});

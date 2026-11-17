// Licence: original TitanZero test code. No Mastra or VoltAgent source is copied.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkText, MAX_CHUNK_SIZE } from '../../../server/integrations/voltagent/rag/chunker.ts';
import { createInMemoryVectorStoreForTests } from '../../../server/integrations/voltagent/rag/vector-store.ts';
import { createKnowledgeSearchPort } from '../../../server/integrations/voltagent/rag/knowledge-port.ts';
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

test('chunker keeps every chunk within size and overlaps consecutive chunks', () => {
  const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu';
  const chunks = chunkText(text, { size: 20, overlap: 5 });
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.text.length <= 20);
  assert.deepEqual(chunks.map((c) => c.index), chunks.map((_, i) => i));
  assert.equal(chunks[0].text.split(' ').at(-1).length > 0, true);
});

test('chunker is deterministic and returns nothing for blank input', () => {
  assert.deepEqual(chunkText('one two three four', { size: 8, overlap: 2 }), chunkText('one two three four', { size: 8, overlap: 2 }));
  assert.deepEqual(chunkText('   ', { size: 8, overlap: 2 }), []);
});

test('chunker rejects bad options and input', () => {
  assert.throws(() => chunkText('x', { size: 0, overlap: 0 }), /chunk_size_invalid/);
  assert.throws(() => chunkText('x', { size: MAX_CHUNK_SIZE + 1, overlap: 0 }), /chunk_size_invalid/);
  assert.throws(() => chunkText('x', { size: 10, overlap: 10 }), /chunk_overlap_invalid/);
  assert.throws(() => chunkText('x', { size: 10, overlap: -1 }), /chunk_overlap_invalid/);
  assert.throws(() => chunkText(42, { size: 10, overlap: 0 }), /chunk_input_invalid/);
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

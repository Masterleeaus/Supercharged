/**
 * W4 (#391): tests for the VoltAgent RAG retrieval adapter.
 * Off unless VOLTAGENT_RAG_ENABLED is exactly "true". No database, no provider.
 * Run: node --test --experimental-transform-types tests/integrations/voltagent/rag-adapter.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertRagEnabled,
  chunkDocuments,
  createMemoryRetrievalStore,
  retrieveRagChunks,
  DEFAULT_CHUNK_MAX_TOKENS,
} from '../../../server/integrations/voltagent/rag/retrieval-adapter.ts';

const ON = { VOLTAGENT_RAG_ENABLED: 'true' };
const OFF = {};
const DOCS = [
  { documentId: 1, text: 'Gutter cleaning is priced per metre. Ask about access for ladders.' },
  { documentId: 2, text: 'Pool chemical balance is checked every visit. Chlorine is logged.' },
];

test('retrieval rejects while the flag is off, before it reads any document', async () => {
  assert.throws(() => assertRagEnabled(OFF), /VOLTAGENT_RAG_ENABLED is not "true"/);
  await assert.rejects(retrieveRagChunks({ companyId: 'co-1', query: 'gutter', documents: DOCS, env: OFF }), /RAG retrieval is off/);
});

test('the flag must be exactly "true"', () => {
  assert.throws(() => assertRagEnabled({ VOLTAGENT_RAG_ENABLED: 'yes' }));
  assert.doesNotThrow(() => assertRagEnabled(ON));
});

test('retrieval returns the matching document chunks for the query, when enabled', async () => {
  const out = await retrieveRagChunks({ companyId: 'co-1', query: 'gutter ladders', documents: DOCS, env: ON });
  assert.ok(out.length >= 1);
  assert.match(out[0].content ?? out[0].text ?? '', /[Gg]utter/);
});

test('an empty document list returns no chunks', async () => {
  assert.deepEqual(await retrieveRagChunks({ companyId: 'co-1', query: 'gutter', documents: [], env: ON }), []);
});

test('a missing company is refused', async () => {
  await assert.rejects(retrieveRagChunks({ companyId: '', query: 'gutter', documents: DOCS, env: ON }));
});

test('chunking gives chunk_index counted from 0 inside each document and the tenant id', async () => {
  const chunks = await chunkDocuments('co-1', DOCS, DEFAULT_CHUNK_MAX_TOKENS);
  assert.ok(chunks.length >= 2);
  for (const doc of [1, 2]) {
    const mine = chunks.filter((c) => c.document_id === doc).map((c) => c.chunk_index);
    assert.equal(mine[0], 0);
    assert.deepEqual(mine, mine.map((_, i) => i));
  }
  assert.ok(chunks.every((c) => c.company_id === 'co-1'));
});

test('chunking rejects a repeated document id', async () => {
  await assert.rejects(chunkDocuments('co-1', [DOCS[0], DOCS[0]], DEFAULT_CHUNK_MAX_TOKENS));
});

test('the memory store only returns candidates for the requested tenant', async () => {
  const store = createMemoryRetrievalStore([
    { company_id: 'co-1', content: 'gutter cleaning', document_id: 1, chunk_index: 0 },
    { company_id: 'co-2', content: 'gutter cleaning', document_id: 9, chunk_index: 0 },
  ]);
  const found = await store.findCandidates({ companyId: 'co-1', terms: ['gutter'], limit: 10 });
  assert.deepEqual(found.map((c) => c.company_id), ['co-1']);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertRagEnabled,
  chunkDocuments,
  retrieveRagChunks,
} from '../../../server/integrations/voltagent/rag/retrieval-adapter.ts';
import { retrieveChunks } from '../../../server/services/ai-runtime/retrieval.ts';
import { AiRuntimeError } from '../../../server/services/ai-runtime/types.ts';

const ON = { VOLTAGENT_RAG_ENABLED: 'true' };

const DOCS = [
  {
    documentId: 1,
    text: 'Drain cleaning costs 120 dollars for a standard blockage. We also clean gutters every spring.',
    metadata: { title: 'Services', doc_type: 'service', preferred_weight: 0 },
  },
  {
    documentId: 2,
    text: 'Our opening hours are 8am to 5pm Monday to Friday. Emergency call-outs are charged at 1.5 times the rate.',
    metadata: { title: 'FAQ', doc_type: 'faq', preferred_weight: 0 },
  },
];

test('flag unset refuses, and so does any value other than exactly "true"', async () => {
  for (const env of [{}, { VOLTAGENT_RAG_ENABLED: '1' }, { VOLTAGENT_RAG_ENABLED: 'TRUE' }, { VOLTAGENT_RAG_ENABLED: 'false' }]) {
    assert.throws(() => assertRagEnabled(env), (err) => err instanceof AiRuntimeError && err.code === 'config_invalid');
    await assert.rejects(
      retrieveRagChunks({ companyId: 7, query: 'opening hours', documents: DOCS, env }),
      (err) => err instanceof AiRuntimeError && err.code === 'config_invalid',
    );
  }
});

test('a document is chunked, and the query returns the matching chunk first', async () => {
  const chunks = await chunkDocuments('7', DOCS);
  assert.ok(chunks.length >= 2, 'the FAQ document is split into more than one chunk');
  assert.ok(chunks.every((c) => c.company_id === '7'));

  const results = await retrieveRagChunks({ companyId: 7, query: 'opening hours', documents: DOCS, env: ON });
  assert.equal(results[0].document_id, 2);
  assert.match(results[0].text, /opening hours/i);

  const gutters = await retrieveRagChunks({ companyId: 7, query: 'gutters spring', documents: DOCS, env: ON });
  assert.equal(gutters[0].document_id, 1);
  assert.match(gutters[0].text, /gutters/);
});

test('output has the same shape as the existing retrieveChunks contract', async () => {
  const results = await retrieveRagChunks({ companyId: 7, query: 'opening hours', documents: DOCS, env: ON });
  assert.ok(results.length > 0);

  const reference = await retrieveChunks({
    companyId: '7',
    query: 'opening hours',
    store: {
      findCandidates: async () => [
        {
          company_id: '7',
          document_id: 9,
          chunk_index: 0,
          content: 'opening hours are 8am',
          document: { title: 't', doc_type: 'faq', authority_level: null, jurisdiction: null, is_superseded: false, preferred_weight: 0, source: null },
        },
      ],
    },
  });

  const keys = (r) => Object.keys(r).sort();
  assert.deepEqual(keys(results[0]), keys(reference[0]));
  assert.deepEqual(keys(results[0].metadata), keys(reference[0].metadata));
  assert.equal(results[0].chunk_id, `${results[0].document_id}:${results[0].chunk_index}`);
  assert.equal(results[0].metadata.company_id, '7');
  assert.equal(typeof results[0].score, 'number');
  assert.equal(typeof results[0].text, 'string');
});

test('an empty index returns an empty list, not an error', async () => {
  assert.deepEqual(await retrieveRagChunks({ companyId: 7, query: 'opening hours', documents: [], env: ON }), []);
  assert.deepEqual(await retrieveRagChunks({ companyId: 7, query: 'xyzzy', documents: DOCS, env: ON }), []);
  assert.deepEqual(await retrieveRagChunks({ companyId: 7, query: 'to an', documents: DOCS, env: ON }), []);
  assert.deepEqual(await retrieveRagChunks({ companyId: 7, query: '   ', documents: DOCS, env: ON }), []);
});

test('invalid tenant and document ids are refused', async () => {
  await assert.rejects(
    retrieveRagChunks({ companyId: undefined, query: 'hours', documents: DOCS, env: ON }),
    (err) => err instanceof AiRuntimeError && err.code === 'company_id_required',
  );
  await assert.rejects(
    chunkDocuments('7', [{ documentId: 0, text: 'x' }]),
    (err) => err instanceof AiRuntimeError && err.code === 'input_invalid',
  );
  await assert.rejects(
    chunkDocuments('7', [{ documentId: 3, text: 'a' }, { documentId: 3, text: 'b' }]),
    (err) => err instanceof AiRuntimeError && err.code === 'input_invalid',
  );
});

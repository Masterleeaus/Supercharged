/**
 * SuperchargedAt checklist 9: company-scoped retrieval with source references.
 * Exercises server/services/ai-runtime/retrieval.ts (retrieveChunks) and citation.ts (attachCitations,
 * buildCitation) against an in-memory chunk store. No network, no database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { retrieveChunks } from '../../server/services/ai-runtime/retrieval.ts';
import { attachCitations, buildCitation } from '../../server/services/ai-runtime/citation.ts';

const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';
const QUERY = 'roof repair pricing';

const meta = (title, source) => ({
  title,
  doc_type: 'policy',
  authority_level: 'internal',
  jurisdiction: null,
  is_superseded: false,
  preferred_weight: 0,
  source,
});

// Identical wording in both tenants, so a leak would be visible in the results.
const CHUNKS = [
  { company_id: COMPANY_A, document_id: 1, chunk_index: 0, content: 'Roof repair pricing for company A is 500 dollars.', content_hash: 'h-a1', document: meta('A roof', 'https://a.example.com/roof') },
  { company_id: COMPANY_A, document_id: 2, chunk_index: 3, content: 'Roof repair pricing notes from company A.', content_hash: 'h-a2', document: meta('A notes', 'TitanZero/policies/a-notes') },
  { company_id: COMPANY_B, document_id: 3, chunk_index: 0, content: 'Roof repair pricing for company B is 900 dollars.', content_hash: 'h-b1', document: meta('B roof', 'https://b.example.com/roof') },
  { company_id: COMPANY_B, document_id: 4, chunk_index: 1, content: 'Roof repair pricing notes from company B.', content_hash: 'h-b2', document: meta('B notes', null) },
];

/** In-memory store. Filters by tenant and term, applies the limit without any recency ordering. */
function memoryStore(rows, { leakAcrossTenants = false } = {}) {
  const calls = [];
  return {
    calls,
    async findCandidates(query) {
      calls.push(query);
      const matches = rows.filter((row) => {
        if (!leakAcrossTenants && row.company_id !== query.companyId) return false;
        const text = row.content.toLowerCase();
        return query.terms.some((t) => text.includes(t));
      });
      return matches.slice(0, query.limit);
    },
  };
}

/** Loader for attachCitations. Returns only the rows whose key and tenant match the request. */
function memoryLoader(rows) {
  return async (keys, companyId) =>
    rows
      .filter((row) => row.company_id === companyId)
      .filter((row) => keys.some((k) => k.document_id === row.document_id && k.chunk_index === row.chunk_index))
      .map((row) => ({
        company_id: row.company_id,
        document_id: row.document_id,
        chunk_index: row.chunk_index,
        content: row.content,
        content_hash: row.content_hash,
        document_title: row.document.title,
        document_source: row.document.source,
      }));
}

test('company B never receives company A chunks for an identical query', async () => {
  const store = memoryStore(CHUNKS);
  const resultsB = await retrieveChunks({ companyId: COMPANY_B, query: QUERY, store });

  assert.ok(resultsB.length > 0, 'company B should get its own chunks');
  for (const r of resultsB) {
    assert.ok([3, 4].includes(r.document_id), `document ${r.document_id} belongs to company A`);
    assert.doesNotMatch(r.text, /company A/);
  }

  // Same query from company A returns only A's documents.
  const resultsA = await retrieveChunks({ companyId: COMPANY_A, query: QUERY, store });
  assert.ok(resultsA.length > 0);
  for (const r of resultsA) assert.ok([1, 2].includes(r.document_id));
});

test('retrieveChunks drops cross-tenant candidates even when the store leaks them', async () => {
  const leaky = memoryStore(CHUNKS, { leakAcrossTenants: true });
  const results = await retrieveChunks({ companyId: COMPANY_B, query: QUERY, store: leaky });

  assert.ok(results.length > 0);
  for (const r of results) {
    assert.ok([3, 4].includes(r.document_id), `leaked document ${r.document_id} reached company B`);
  }
});

test('every retrieved chunk carries a document id and a citation with a source reference', async () => {
  const store = memoryStore(CHUNKS);
  const results = await retrieveChunks({ companyId: COMPANY_A, query: QUERY, store });
  assert.ok(results.length > 0);

  for (const r of results) {
    assert.equal(typeof r.document_id, 'number', 'result must carry a document id');
    assert.equal(r.chunk_id, `${r.document_id}:${r.chunk_index}`);
  }

  const outcome = await attachCitations({ companyId: COMPANY_A, results, loadChunks: memoryLoader(CHUNKS) });
  assert.equal(outcome.unresolved.length, 0);
  assert.equal(outcome.citations.length, results.length, 'every result must produce a citation');

  for (const c of outcome.citations) {
    const hasRef = c.source_url !== null || c.module_reference !== null;
    assert.ok(hasRef, `citation for document ${c.document_id} has no source reference`);
    assert.ok(Number.isInteger(c.document_id));
    assert.ok(c.content_hash.length > 0);
  }
});

test('buildCitation gives an http source as source_url and an internal source as module_reference', () => {
  const base = { company_id: COMPANY_A, document_id: 9, chunk_index: 0, content: 'x', content_hash: 'h', document_title: 'T' };
  const web = buildCitation({ ...base, document_source: 'https://a.example.com/doc' });
  assert.equal(web.source_url, 'https://a.example.com/doc');
  assert.equal(web.module_reference, null);

  const internal = buildCitation({ ...base, document_source: 'TitanZero/policies/a' });
  assert.equal(internal.source_url, null);
  assert.equal(internal.module_reference, 'TitanZero/policies/a');
});

test('attachCitations does not cite another tenant\'s chunk for the same document key', async () => {
  // Company B's results point at document 1 / chunk 0, which belongs to company A.
  const resultsForB = [{ chunk_id: '1:0', document_id: 1, chunk_index: 0, text: '', metadata: {}, score: 1 }];
  const outcome = await attachCitations({ companyId: COMPANY_B, results: resultsForB, loadChunks: memoryLoader(CHUNKS) });
  assert.equal(outcome.citations.length, 0);
  assert.deepEqual(outcome.unresolved, ['1:0']);
});

for (const missing of [undefined, null, '']) {
  test(`retrieveChunks fails closed for companyId ${JSON.stringify(missing)}: no chunks, store not called`, async () => {
    const store = memoryStore(CHUNKS, { leakAcrossTenants: true });
    await assert.rejects(
      retrieveChunks({ companyId: missing, query: QUERY, store }),
      (e) => e.code === 'company_id_required',
    );
    assert.equal(store.calls.length, 0, 'store must not be queried without a tenant');
  });
}

test('attachCitations fails closed without a companyId and loads nothing', async () => {
  let loaded = false;
  const results = [{ chunk_id: '1:0', document_id: 1, chunk_index: 0, text: '', metadata: {}, score: 1 }];
  await assert.rejects(
    attachCitations({
      companyId: undefined,
      results,
      loadChunks: async () => {
        loaded = true;
        return [];
      },
    }),
    (e) => e.code === 'company_id_required',
  );
  assert.equal(loaded, false);
});

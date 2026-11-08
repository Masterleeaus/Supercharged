/**
 * Tests for checkRecommendationAgainstRetrieval in server/workforce/runtime/citations.ts. Pure, no network, no database.
 * Run: node --test --experimental-transform-types tests/workforce/citations-retrieval.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const noop = () => {};
console.log = noop;
console.info = noop;
console.warn = noop;

const { checkRecommendationAgainstRetrieval } = await import('../../server/workforce/runtime/citations.ts');
const { retrieveCompanyKnowledge } = await import('../../server/workforce/runtime/knowledge-retrieval.ts');

const COMPANY_A = '11111111-1111-4111-8111-111111111111';
const REF = 'kb:kb-price-list:0';

test('a consequential recommendation with no company is refused even with a retrieved record', () => {
  for (const companyId of [undefined, null, '', 'bad company!']) {
    const result = checkRecommendationAgainstRetrieval({
      consequential: true,
      companyId,
      sources: [{ kind: 'record', recordId: REF }],
      retrievedRecordIds: new Set([REF]),
    });
    assert.deepEqual(result, { ok: false, reason: 'company_required' });
  }
});

test('a record id the company retrieval did not return does not count as verified', () => {
  const result = checkRecommendationAgainstRetrieval({
    consequential: true,
    companyId: COMPANY_A,
    sources: [{ kind: 'record', recordId: 'job-999' }],
    retrievedRecordIds: new Set([REF]),
  });
  assert.deepEqual(result, { ok: false, reason: 'needs_verified_citation' });
});

test('summaries and predictions never satisfy a consequential recommendation', () => {
  const result = checkRecommendationAgainstRetrieval({
    consequential: true,
    companyId: COMPANY_A,
    sources: [{ kind: 'summary' }, { kind: 'prediction' }, { kind: 'record', recordId: 'not-retrieved' }],
    retrievedRecordIds: new Set(['not-retrieved-elsewhere']),
  });
  assert.deepEqual(result, { ok: false, reason: 'needs_verified_citation' });
});

test('a retrieved record from a result passes and is listed, summaries are labelled', () => {
  const result = checkRecommendationAgainstRetrieval({
    consequential: true,
    companyId: COMPANY_A,
    sources: [{ kind: 'summary' }, { kind: 'record', recordId: REF }],
    retrievedRecordIds: [REF],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.citations, ['summary (generated)', `record ${REF}`]);
});

test('a non-consequential recommendation passes with a company and no verified record', () => {
  const result = checkRecommendationAgainstRetrieval({
    consequential: false,
    companyId: COMPANY_A,
    sources: [{ kind: 'prediction' }],
    retrievedRecordIds: [],
  });
  assert.deepEqual(result, { ok: true, citations: ['prediction (generated)'] });
});

test('end to end: a result from company retrieval is the only thing that makes a recommendation pass', async () => {
  const port = {
    async searchChunks() {
      return [
        { knowledgeBaseId: 'kb-price-list', chunkIndex: 0, chunkText: 'Gutter clean 120.', companyId: COMPANY_A, score: 0.7 },
        { knowledgeBaseId: 'kb-price-list', chunkIndex: 1, chunkText: 'Other tenant.', companyId: null, score: 0.9 },
      ];
    },
  };
  const retrieval = await retrieveCompanyKnowledge(port, { companyId: COMPANY_A, userId: 'user-a', query: 'gutter price' });
  assert.equal(retrieval.ok, true);
  const retrieved = new Set(retrieval.results.map((r) => r.sourceRef));

  const sources = [{ kind: 'record', recordId: REF }];
  const passed = checkRecommendationAgainstRetrieval({ consequential: true, companyId: COMPANY_A, sources, retrievedRecordIds: retrieved });
  assert.equal(passed.ok, true);

  const refused = checkRecommendationAgainstRetrieval({
    consequential: true,
    companyId: COMPANY_A,
    sources: [{ kind: 'record', recordId: 'kb-price-list:1' }],
    retrievedRecordIds: retrieved,
  });
  assert.deepEqual(refused, { ok: false, reason: 'needs_verified_citation' });
});

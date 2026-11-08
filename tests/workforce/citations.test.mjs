/**
 * Tests for server/workforce/runtime/citations.ts. Pure functions, no network, no database.
 * Run: node --test --experimental-transform-types tests/workforce/citations.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBasis,
  checkRecommendation,
  formatCitations,
} from '../../server/workforce/runtime/citations.ts';

test('a record without an id is invalid', () => {
  assert.deepEqual(classifyBasis({ kind: 'record' }), { basis: 'invalid' });
  assert.deepEqual(classifyBasis({ kind: 'record', recordId: '' }), { basis: 'invalid' });
  assert.deepEqual(classifyBasis({ kind: 'record', recordId: 'has spaces here' }), { basis: 'invalid' });
});

test('a record with an id is a verified record; summaries and predictions are labelled', () => {
  assert.deepEqual(classifyBasis({ kind: 'record', recordId: 'inv-42' }), { basis: 'verified_record' });
  assert.deepEqual(classifyBasis({ kind: 'summary' }), { basis: 'generated_summary' });
  assert.deepEqual(classifyBasis({ kind: 'prediction' }), { basis: 'prediction' });
  assert.deepEqual(classifyBasis({ kind: 'other' }), { basis: 'invalid' });
});

test('a consequential recommendation with only a summary is refused', () => {
  const result = checkRecommendation({
    consequential: true,
    sources: [{ kind: 'summary' }, { kind: 'prediction' }],
  });
  assert.deepEqual(result, { ok: false, reason: 'needs_verified_citation' });
});

test('a consequential recommendation with an id-less record is refused', () => {
  const result = checkRecommendation({
    consequential: true,
    sources: [{ kind: 'record' }, { kind: 'summary' }],
  });
  assert.deepEqual(result, { ok: false, reason: 'needs_verified_citation' });
});

test('a consequential recommendation with one verified record passes and lists it', () => {
  const result = checkRecommendation({
    consequential: true,
    sources: [{ kind: 'summary' }, { kind: 'record', recordId: 'job-101', sourceUrl: 'https://example.test/j/101' }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.citations, ['summary (generated)', 'record job-101']);
});

test('a non-consequential recommendation with no sources passes', () => {
  assert.deepEqual(checkRecommendation({ consequential: false, sources: [] }), { ok: true, citations: [] });
});

test('a non-consequential recommendation with only a prediction passes', () => {
  const result = checkRecommendation({ consequential: false, sources: [{ kind: 'prediction' }] });
  assert.deepEqual(result, { ok: true, citations: ['prediction (generated)'] });
});

test('formatCitations never includes free text, URLs or invalid sources', () => {
  const sources = [
    { kind: 'record', recordId: 'rec-7', sourceUrl: 'https://secret.test/?token=abc' },
    { kind: 'record', recordId: 'Call Jane: 0412 555 999 about the boiler' },
    { kind: 'record' },
    { kind: 'summary', recordId: 'ignored free text' },
    { kind: 'prediction', sourceUrl: 'https://x.test' },
  ];
  const out = formatCitations(sources);
  assert.deepEqual(out, ['record rec-7', 'summary (generated)', 'prediction (generated)']);
  for (const line of out) {
    assert.doesNotMatch(line, /https?:|token|Jane|555|boiler|ignored/);
  }
});

test('formatCitations returns an empty list for no sources', () => {
  assert.deepEqual(formatCitations([]), []);
});

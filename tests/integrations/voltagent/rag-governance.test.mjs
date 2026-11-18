// Licence: original TitanZero test code. Governance for business knowledge answers (issue #335).
import assert from 'node:assert/strict';
import test from 'node:test';
import { governChunks, redactText, SAFE_UNKNOWN_ANSWER } from '../../../server/integrations/voltagent/rag/governance.ts';
import { createInMemoryVectorStoreForTests } from '../../../server/integrations/voltagent/rag/vector-store.ts';
import { createKnowledgeSearchPort } from '../../../server/integrations/voltagent/rag/knowledge-port.ts';
import { retrieveCompanyKnowledge } from '../../../server/workforce/runtime/knowledge-retrieval.ts';

const NOW = new Date('2026-06-01T00:00:00Z');

function gov(over = {}) {
  return {
    sourceId: 'catalogue', version: 1, approved: true, approvedBy: 'owner-1',
    approvedAt: '2026-01-01T00:00:00Z', expiresAt: null, language: 'en', ...over,
  };
}
function hit(text, governance, extra = {}) {
  return { knowledgeBaseId: 'kb-a', chunkIndex: 0, chunkText: text, score: 1, governance, ...extra };
}

test('provenance: a hit with no record, an unapproved record or no approver is dropped', () => {
  const out = governChunks([
    hit('no record', null),
    hit('not approved', gov({ approved: false })),
    hit('no approver', gov({ approvedBy: null })),
    hit('approved', gov({ sourceId: 'ok' })),
  ], { now: NOW, language: 'en' });
  assert.deepEqual(out.kept.map((h) => h.chunkText), ['approved']);
  assert.equal(out.dropped.unapproved, 3);
});

test('expiry: a hit at or past expiresAt is dropped, and an unreadable expiry fails closed', () => {
  const out = governChunks([
    hit('expired', gov({ sourceId: 'a', expiresAt: '2026-05-31T00:00:00Z' })),
    hit('expires exactly now', gov({ sourceId: 'b', expiresAt: '2026-06-01T00:00:00Z' })),
    hit('bad date', gov({ sourceId: 'c', expiresAt: 'not-a-date' })),
    hit('future', gov({ sourceId: 'd', expiresAt: '2027-01-01T00:00:00Z' })),
    hit('never expires', gov({ sourceId: 'e', expiresAt: null })),
  ], { now: NOW, language: 'en' });
  assert.deepEqual(out.kept.map((h) => h.chunkText).sort(), ['future', 'never expires']);
  assert.equal(out.dropped.expired, 3);
});

test('stale documents: only the highest approved version of a source is kept', () => {
  const out = governChunks([
    hit('price v1', gov({ version: 1 })),
    hit('price v2', gov({ version: 2 })),
    hit('other source', gov({ sourceId: 'faq', version: 1 })),
  ], { now: NOW, language: 'en' });
  assert.deepEqual(out.kept.map((h) => h.chunkText).sort(), ['other source', 'price v2']);
  assert.equal(out.dropped.superseded, 1);
});

test('language: requested language is used; fallback language only when the requested one is absent', () => {
  const requested = governChunks([
    hit('english', gov({ language: 'en-GB' })),
    hit('french', gov({ sourceId: 'fr', language: 'fr' })),
  ], { now: NOW, language: 'en', fallbackLanguage: 'fr' });
  assert.deepEqual(requested.kept.map((h) => h.chunkText), ['english']);
  assert.equal(requested.kept[0].fallbackLanguage, false);

  const fallback = governChunks([hit('french only', gov({ language: 'fr' }))], { now: NOW, language: 'en', fallbackLanguage: 'fr' });
  assert.deepEqual(fallback.kept.map((h) => h.chunkText), ['french only']);
  assert.equal(fallback.kept[0].fallbackLanguage, true);
});

test('language: with no requested or fallback match the answer is unknown, never a guess', () => {
  const out = governChunks([hit('german', gov({ language: 'de' }))], { now: NOW, language: 'en', fallbackLanguage: 'fr' });
  assert.equal(out.unknown, true);
  assert.equal(out.kept.length, 0);
  assert.equal(out.dropped.language_unavailable, 1);
  assert.match(SAFE_UNKNOWN_ANSWER, /don't have approved information/);
});

test('redaction: emails, card numbers and phone numbers are replaced; prices are left alone', () => {
  assert.equal(
    redactText('Mail jo.bloggs@example.com or call +44 20 7946 0958. Card 4111 1111 1111 1111. Call-out fee £120.'),
    'Mail [redacted-email] or call [redacted-phone]. Card [redacted-card]. Call-out fee £120.',
  );
  const out = governChunks([hit('Ring 07700 900123 for bookings', gov())], { now: NOW, language: 'en' });
  assert.equal(out.kept[0].chunkText, 'Ring [redacted-phone] for bookings');
});

test('an empty input is unknown, and nothing is invented', () => {
  const out = governChunks([], { now: NOW, language: 'en' });
  assert.equal(out.unknown, true);
  assert.deepEqual(out.kept, []);
});

test('wiring: the knowledge port drops unapproved, expired and stale chunks before retrieval', async () => {
  const store = createInMemoryVectorStoreForTests();
  await store.upsert([
    { companyId: '7', ownerUserId: 'u1', knowledgeBaseId: 'kb-a', chunkIndex: 0, chunkText: 'approved boiler price', vector: [1, 0], governance: gov({ sourceId: 'boiler', version: 2 }) },
    { companyId: '7', ownerUserId: 'u1', knowledgeBaseId: 'kb-a', chunkIndex: 1, chunkText: 'old boiler price', vector: [1, 0], governance: gov({ sourceId: 'boiler', version: 1 }) },
    { companyId: '7', ownerUserId: 'u1', knowledgeBaseId: 'kb-a', chunkIndex: 2, chunkText: 'draft boiler note', vector: [1, 0], governance: gov({ sourceId: 'draft', approved: false }) },
    { companyId: '7', ownerUserId: 'u1', knowledgeBaseId: 'kb-a', chunkIndex: 3, chunkText: 'expired boiler offer', vector: [1, 0], governance: gov({ sourceId: 'offer', expiresAt: '2020-01-01T00:00:00Z' }) },
    { companyId: '7', ownerUserId: 'u1', knowledgeBaseId: 'kb-a', chunkIndex: 4, chunkText: 'call 07700 900123', vector: [1, 0], governance: gov({ sourceId: 'contact' }) },
  ]);
  const port = createKnowledgeSearchPort({
    store,
    embed: async () => [[1, 0]],
    governance: { now: () => NOW, language: 'en' },
  });
  const outcome = await retrieveCompanyKnowledge(port, { companyId: '7', userId: 'u1', query: 'boiler', maxResults: 10 });
  assert.equal(outcome.ok, true);
  const texts = outcome.results.map((r) => r.snippet).sort();
  assert.deepEqual(texts, ['approved boiler price', 'call [redacted-phone]']);
});

test('wiring: without governance the port still returns the raw scoped hits (tenant rules unchanged)', async () => {
  const store = createInMemoryVectorStoreForTests();
  await store.upsert([
    { companyId: '7', ownerUserId: 'u1', knowledgeBaseId: 'kb-a', chunkIndex: 0, chunkText: 'raw', vector: [1, 0] },
  ]);
  const port = createKnowledgeSearchPort({ store, embed: async () => [[1, 0]] });
  const hits = await port.searchChunks({ companyId: '7', userId: 'u1', query: 'x', limit: 5 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].chunkText, 'raw');
});

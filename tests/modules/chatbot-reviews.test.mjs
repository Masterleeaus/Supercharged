// Reviews: one review per conversation, the once-only rule in storage and in the database index, and the table move.
// Run: NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types tests/modules/chatbot-reviews.test.mjs
// No network and no database. The storage is the in-memory twin; the unique indexes are checked on the Drizzle tables.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  createReviewService,
  createMemoryReviewStorage,
  chatbotReviewRequests,
  chatbotReviews,
  REVIEW_CONSTRAINTS,
} from '../../server/modules/chatbot/reviews/index.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-09T10:00:00Z');

function rig() {
  const storage = createMemoryReviewStorage();
  let n = 0;
  const service = createReviewService({
    storage,
    now: () => NOW,
    newId: () => `id-${(n += 1)}`,
  });
  return { storage, service };
}

const closed = (id = 'conv-1') => ({ id, chatbotId: 'bot-1', channel: 'web', closedAt: new Date(NOW.getTime() - 3_600_000) });
const settings = { reviewEnabled: true, delayMinutes: 0 };

test('reviews: a conversation gets one review; a second submission is refused and the first is kept', async () => {
  const { storage, service } = rig();
  const scheduled = await service.scheduleReviewRequest(CO_A, closed(), settings);
  assert.equal(scheduled.status, 'scheduled');
  const { token } = scheduled;

  const first = await service.submitReview(CO_A, { token, rating: 5, comment: 'Great visit' });
  assert.equal(first.ok, true);

  const second = await service.submitReview(CO_A, { token, rating: 1, comment: 'Changed my mind' });
  assert.deepEqual(second, { ok: false, reason: 'already_reviewed' });

  const kept = await storage.findReviewForConversation(CO_A, 'conv-1');
  assert.equal(kept.rating, 5);
  assert.equal(kept.comment, 'Great visit');
  assert.equal(storage.outboxFor(CO_A).length, 1, 'only the first review writes an outbox event');
});

test('reviews: a second review request for the same conversation is refused', async () => {
  const { service } = rig();
  const first = await service.scheduleReviewRequest(CO_A, closed(), settings);
  assert.equal(first.status, 'scheduled');
  const second = await service.scheduleReviewRequest(CO_A, closed(), settings);
  assert.equal(second.status, 'skipped');
  assert.equal(second.reason, 'already_requested');
});

test('reviews: a review token from one company does not submit for another', async () => {
  const { service } = rig();
  const scheduled = await service.scheduleReviewRequest(CO_A, closed(), settings);
  const other = await service.submitReview(CO_B, { token: scheduled.token, rating: 4 });
  assert.equal(other.ok, false);
  assert.equal(other.reason, 'not_found');
});

test('reviews: rating must be a whole number from 1 to 5, and nothing is stored on a refusal', async () => {
  const { storage, service } = rig();
  const scheduled = await service.scheduleReviewRequest(CO_A, closed(), settings);
  for (const rating of [0, 6, 3.5, '4', null]) {
    const res = await service.submitReview(CO_A, { token: scheduled.token, rating });
    assert.equal(res.ok, false);
  }
  assert.equal(await storage.findReviewForConversation(CO_A, 'conv-1'), null);
  assert.equal(storage.outboxFor(CO_A).length, 0);
});

test('reviews: a valid review after refusals is still accepted once', async () => {
  const { service } = rig();
  const scheduled = await service.scheduleReviewRequest(CO_A, closed(), settings);
  assert.equal((await service.submitReview(CO_A, { token: scheduled.token, rating: 9 })).ok, false);
  assert.equal((await service.submitReview(CO_A, { token: scheduled.token, rating: 3 })).ok, true);
  assert.equal((await service.submitReview(CO_A, { token: scheduled.token, rating: 3 })).ok, false);
});

test('reviews: the database rules are one request and one review per (company, conversation)', () => {
  const requests = getTableConfig(chatbotReviewRequests);
  const reviews = getTableConfig(chatbotReviews);

  const oneRequest = requests.indexes.find((i) => i.config.name === REVIEW_CONSTRAINTS.requestOnePerConversation);
  assert.ok(oneRequest, 'request unique index exists');
  assert.ok(oneRequest.config.unique);
  assert.deepEqual(oneRequest.config.columns.map((c) => c.name), ['company_id', 'conversation_id']);

  const oneReview = reviews.indexes.find((i) => i.config.name === REVIEW_CONSTRAINTS.reviewOnePerConversation);
  assert.ok(oneReview, 'review unique index exists');
  assert.ok(oneReview.config.unique);
  assert.deepEqual(oneReview.config.columns.map((c) => c.name), ['company_id', 'conversation_id']);
});

test('reviews: every review table carries company_id as not null', () => {
  for (const table of [chatbotReviewRequests, chatbotReviews]) {
    const cfg = getTableConfig(table);
    assert.ok(cfg.columns.some((c) => c.name === 'company_id' && c.notNull), cfg.name);
  }
});

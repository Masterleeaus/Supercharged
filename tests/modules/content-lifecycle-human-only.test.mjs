// Human-only gate for publish and rollback in the content lifecycle (node:test). Pure, no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createContentItem,
  submitForReview,
  approve,
  publish,
  rollback,
} from '../../server/modules/marketing/content-lifecycle.ts';

const CO = '11111111-1111-4111-8111-111111111111';
const AUTHOR = 'user-author';
const APPROVER = 'user-approver';
const AGENT = 'agent:content-bot';
const T1 = '2026-11-03T10:00:00Z';
const T2 = '2026-11-03T10:05:00Z';
const T3 = '2026-11-03T10:10:00Z';
const T4 = '2026-11-03T10:15:00Z';

function approvedItem(body = 'Body A') {
  const draft = createContentItem({ companyId: CO, title: 'Spring', body, by: AUTHOR, now: T1 }).item;
  const inReview = submitForReview(draft, AUTHOR, T1).item;
  return approve(inReview, APPROVER, T2).item;
}

// Rollback needs two published versions. The state machine cannot produce a second one from a
// single publish, so this fixture is built directly from the exported item type.
function publishedTwice() {
  const live = publish(approvedItem('Body B'), APPROVER, T3).item;
  return {
    ...live,
    version: 2,
    publishedVersions: [
      { version: 1, body: 'Body A', publishedBy: APPROVER, publishedAt: T1 },
      { version: 2, body: 'Body B', publishedBy: APPROVER, publishedAt: T3 },
    ],
  };
}

test('a human can publish an approved item', () => {
  const r = publish(approvedItem(), APPROVER, T3);
  assert.equal(r.ok, true);
  assert.equal(r.item.status, 'published');
  assert.equal(r.item.history.at(-1).by, APPROVER);
});

test('a human can roll back a published item with a previous version', () => {
  const r = rollback(publishedTwice(), APPROVER, T4);
  assert.equal(r.ok, true);
  assert.equal(r.item.status, 'draft');
  assert.equal(r.item.body, 'Body A');
  assert.equal(r.item.history.at(-1).action, 'rolled_back');
});

test('an agent cannot publish, even from the approved state', () => {
  assert.deepEqual(publish(approvedItem(), AGENT, T3), { ok: false, reason: 'human_only' });
});

test('an agent cannot publish, even when the item is not approved', () => {
  const draft = createContentItem({ companyId: CO, title: 'Spring', body: 'x', by: AUTHOR, now: T1 }).item;
  assert.deepEqual(publish(draft, AGENT, T3), { ok: false, reason: 'human_only' });
});

test('an agent cannot roll back a published item', () => {
  assert.deepEqual(rollback(publishedTwice(), AGENT, T4), { ok: false, reason: 'human_only' });
});

test('an agent cannot approve, so it cannot reach the publish step', () => {
  const inReview = submitForReview(
    createContentItem({ companyId: CO, title: 'Spring', body: 'x', by: AUTHOR, now: T1 }).item,
    AUTHOR,
    T1,
  ).item;
  assert.deepEqual(approve(inReview, AGENT, T2), { ok: false, reason: 'human_only' });
});

test('agent actor ids are refused regardless of case or surrounding whitespace', () => {
  for (const id of [' agent:content-bot', 'Agent:content-bot', 'AGENT:content-bot', '\tagent:x']) {
    assert.deepEqual(publish(approvedItem(), id, T3), { ok: false, reason: 'human_only' }, id);
    assert.deepEqual(rollback(publishedTwice(), id, T4), { ok: false, reason: 'human_only' }, id);
  }
});

test('blank actor ids are refused', () => {
  assert.deepEqual(publish(approvedItem(), '   ', T3), { ok: false, reason: 'human_only' });
  assert.deepEqual(publish(approvedItem(), null, T3), { ok: false, reason: 'human_only' });
});

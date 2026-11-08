// Content lifecycle tests (node:test). Pure state machine, no network, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createContentItem,
  submitForReview,
  approve,
  publish,
  rollback,
  edit,
} from '../../server/modules/marketing/content-lifecycle.ts';

const CO = '11111111-1111-4111-8111-111111111111';
const AUTHOR = 'user-author';
const APPROVER = 'user-approver';
const T1 = '2026-11-03T10:00:00Z';
const T2 = '2026-11-03T10:05:00Z';
const T3 = '2026-11-03T10:10:00Z';

function created(body = 'Hello v1') {
  const r = createContentItem({ companyId: CO, title: 'Spring', body, by: AUTHOR, now: T1 });
  assert.equal(r.ok, true);
  return r.item;
}

function publishedOnce() {
  const draft = created('Body A');
  const inReview = submitForReview(draft, AUTHOR, T1);
  const approved = approve(inReview.item, APPROVER, T2);
  const live = publish(approved.item, APPROVER, T3);
  assert.equal(live.ok, true);
  return live.item;
}

test('full path from draft to published', () => {
  const draft = created();
  assert.equal(draft.status, 'draft');
  assert.equal(draft.version, 1);
  assert.deepEqual(draft.history, [{ version: 1, action: 'created', by: AUTHOR, at: T1 }]);

  const inReview = submitForReview(draft, AUTHOR, T1);
  assert.equal(inReview.ok, true);
  assert.equal(inReview.item.status, 'in_review');

  const approved = approve(inReview.item, APPROVER, T2);
  assert.equal(approved.ok, true);
  assert.equal(approved.item.status, 'approved');

  const live = publish(approved.item, APPROVER, T3);
  assert.equal(live.ok, true);
  assert.equal(live.item.status, 'published');
  assert.equal(live.item.publishedVersions.length, 1);
  assert.equal(live.item.publishedVersions[0].body, 'Hello v1');
});

test('self-approval is refused', () => {
  const inReview = submitForReview(created(), AUTHOR, T1).item;
  assert.deepEqual(approve(inReview, AUTHOR, T2), { ok: false, reason: 'self_approval' });
});

test('agent approval is refused', () => {
  const inReview = submitForReview(created(), AUTHOR, T1).item;
  assert.deepEqual(approve(inReview, 'agent:reviewer-bot', T2), { ok: false, reason: 'human_only' });
});

test('publish from draft is refused', () => {
  const draft = created();
  assert.deepEqual(publish(draft, APPROVER, T1), { ok: false, reason: 'invalid_transition' });
});

test('approve from draft is refused as an invalid transition', () => {
  const draft = created();
  assert.deepEqual(approve(draft, APPROVER, T1), { ok: false, reason: 'invalid_transition' });
});

test('rollback restores the previous published body into a new draft', () => {
  // Two published versions: v1 ('Body A') and v2 ('Body B'). The transitions alone cannot
  // reach this state, because a published item cannot be edited and rollback needs a
  // previous version first, so the state is built from a real v1 publish record.
  const v1 = publishedOnce();
  const v1Snapshot = v1.publishedVersions[0];
  const item = {
    ...v1,
    version: 2,
    body: 'Body B',
    publishedVersions: [v1Snapshot, { version: 2, body: 'Body B', publishedBy: APPROVER, publishedAt: T3 }],
  };

  // Rolling back restores the body of v1 ('Body A'), the version before the current one.
  const rolled = rollback(item, APPROVER, T3);
  assert.equal(rolled.ok, true);
  assert.equal(rolled.item.status, 'draft');
  assert.equal(rolled.item.body, 'Body A');
  assert.equal(rolled.item.version, 3);
  const last = rolled.item.history[rolled.item.history.length - 1];
  assert.equal(last.action, 'rolled_back');
  assert.equal(last.restoredFromVersion, 1);
});

test('rollback with only one published version is refused', () => {
  const live = publishedOnce();
  assert.deepEqual(rollback(live, APPROVER, T3), { ok: false, reason: 'no_previous_version' });
});

test('rollback by an agent is refused', () => {
  const live = publishedOnce();
  assert.deepEqual(rollback(live, 'agent:bot', T3), { ok: false, reason: 'human_only' });
});

test('edit of a published item is refused', () => {
  const live = publishedOnce();
  assert.deepEqual(edit(live, AUTHOR, T3, { body: 'Changed' }), { ok: false, reason: 'not_editable' });
});

test('edit in draft changes the body and records history', () => {
  const draft = created('before');
  const r = edit(draft, AUTHOR, T1, { body: 'after', title: 'New title' });
  assert.equal(r.ok, true);
  assert.equal(r.item.body, 'after');
  assert.equal(r.item.title, 'New title');
  assert.equal(r.item.history.length, 2);
  assert.equal(r.item.history[1].action, 'edited');
});

test('history grows with each transition', () => {
  const draft = created();
  assert.equal(draft.history.length, 1);
  const inReview = submitForReview(draft, AUTHOR, T1).item;
  assert.equal(inReview.history.length, 2);
  const approved = approve(inReview, APPROVER, T2).item;
  assert.equal(approved.history.length, 3);
  const live = publish(approved, APPROVER, T3).item;
  assert.equal(live.history.length, 4);
  assert.deepEqual(
    live.history.map((h) => h.action),
    ['created', 'submitted', 'approved', 'published'],
  );
});

test('non-UUID companyId is refused at creation', () => {
  const r = createContentItem({ companyId: 'not-a-uuid', title: 'T', body: 'B', by: AUTHOR, now: T1 });
  assert.deepEqual(r, { ok: false, reason: 'invalid_company' });
});

test('transitions do not mutate their input', () => {
  const draft = created();
  const before = structuredClone(draft);
  submitForReview(draft, AUTHOR, T1);
  assert.deepEqual(draft, before);

  const inReview = submitForReview(draft, AUTHOR, T1).item;
  const beforeReview = structuredClone(inReview);
  approve(inReview, APPROVER, T2);
  assert.deepEqual(inReview, beforeReview);

  const approved = approve(inReview, APPROVER, T2).item;
  const beforeApproved = structuredClone(approved);
  const live = publish(approved, APPROVER, T3).item;
  assert.deepEqual(approved, beforeApproved);

  const beforeLive = structuredClone(live);
  rollback(live, APPROVER, T3);
  edit(created('x'), AUTHOR, T1, { body: 'y' });
  assert.deepEqual(live, beforeLive);
});

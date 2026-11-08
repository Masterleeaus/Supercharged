// Publish history and rollback to the previous published version (node:test). Pure, no I/O.
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
const T5 = '2026-11-03T10:20:00Z';

// Runs the real draft -> review -> approve -> publish path for one body.
function liveWith(body, now = T1) {
  const draft = createContentItem({ companyId: CO, title: 'Spring', body, by: AUTHOR, now }).item;
  const inReview = submitForReview(draft, AUTHOR, now).item;
  const approved = approve(inReview, APPROVER, T2).item;
  return publish(approved, APPROVER, T3).item;
}

// A second publish cannot be reached from a single publish through the state machine
// (rollback is the only exit from published and needs two records). The two-record starting
// point is therefore built from the exported type, as the existing lifecycle tests do.
function publishedTwice() {
  const first = liveWith('Body A');
  return {
    ...first,
    body: 'Body B',
    version: 2,
    publishedVersions: [
      ...first.publishedVersions,
      { version: 2, body: 'Body B', publishedBy: APPROVER, publishedAt: T4 },
    ],
  };
}

test('each publish appends a version record with its body, actor and time', () => {
  const live = liveWith('Body A');
  assert.deepEqual(live.publishedVersions, [
    { version: 1, body: 'Body A', publishedBy: APPROVER, publishedAt: T3 },
  ]);
});

test('rollback with only one published record is refused', () => {
  const live = liveWith('Body A');
  assert.deepEqual(rollback(live, APPROVER, T4), { ok: false, reason: 'no_previous_version' });
});

test('rollback with two published records restores the previous body and records it', () => {
  const r = rollback(publishedTwice(), APPROVER, T4);
  assert.equal(r.ok, true);
  assert.equal(r.item.status, 'draft');
  assert.equal(r.item.body, 'Body A');
  assert.equal(r.item.version, 3);
  const entry = r.item.history.at(-1);
  assert.equal(entry.action, 'rolled_back');
  assert.equal(entry.by, APPROVER);
  assert.equal(entry.at, T4);
  assert.equal(entry.restoredFromVersion, 1);
});

test('rollback keeps every earlier publish record', () => {
  const before = publishedTwice();
  const r = rollback(before, APPROVER, T4);
  assert.deepEqual(r.item.publishedVersions, before.publishedVersions);
});

test('the restored draft has to be re-reviewed and republished, and that publish is recorded too', () => {
  const rolled = rollback(publishedTwice(), APPROVER, T4).item;
  const inReview = submitForReview(rolled, AUTHOR, T4).item;
  const approved = approve(inReview, APPROVER, T5).item;
  const republished = publish(approved, APPROVER, T5).item;
  assert.equal(republished.status, 'published');
  assert.equal(republished.publishedVersions.length, 3);
  assert.deepEqual(republished.publishedVersions.at(-1), {
    version: 3,
    body: 'Body A',
    publishedBy: APPROVER,
    publishedAt: T5,
  });
});

test('an agent cannot roll back', () => {
  assert.deepEqual(rollback(publishedTwice(), AGENT, T4), { ok: false, reason: 'human_only' });
});

test('rollback does not mutate its input', () => {
  const live = publishedTwice();
  const snapshot = structuredClone(live);
  rollback(live, APPROVER, T4);
  assert.deepEqual(live, snapshot);
});

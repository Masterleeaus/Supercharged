import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sortCockpitItems,
  panelsForMode,
  resolveDeskMode,
  mapWorkforceActivityToItems,
  mapReviewInboxToItems,
  listFromBody,
  canSeeWorkforceActivity,
  sourceNote,
} from '../../client/src/components/cockpit/cockpit-logic.ts';
import { parseDeskMode, DEFAULT_DESK_MODE } from '../../client/src/components/cockpit/desk-mode.ts';

const item = (id, kind, createdAt) => ({
  id, kind, title: id, detail: '', createdAt, openHref: null,
});

const items = [
  item('a', 'reply', '2026-11-01T10:00:00.000Z'),
  item('b', 'call', '2026-11-03T10:00:00.000Z'),
  item('c', 'reply', '2026-11-02T10:00:00.000Z'),
  item('d', 'call', null),
];

test('sort: newest puts the latest first and unknown times last', () => {
  assert.deepEqual(sortCockpitItems(items, 'newest').map((i) => i.id), ['b', 'c', 'a', 'd']);
});

test('sort: oldest puts the earliest first and unknown times last', () => {
  assert.deepEqual(sortCockpitItems(items, 'oldest').map((i) => i.id), ['a', 'c', 'b', 'd']);
});

test('sort: kind is A to Z, newest first within a kind', () => {
  assert.deepEqual(sortCockpitItems(items, 'kind').map((i) => i.id), ['b', 'd', 'c', 'a']);
});

test('sort: returns a copy and leaves the input order unchanged', () => {
  const input = [...items];
  const out = sortCockpitItems(input, 'oldest');
  assert.notEqual(out, input);
  assert.deepEqual(input.map((i) => i.id), ['a', 'b', 'c', 'd']);
});

test('mode: workforce shows the workforce panels', () => {
  assert.deepEqual(panelsForMode('workforce'), ['workforce_activity', 'needs_attention']);
});

test('mode: server comms mode shows the communications panels', () => {
  assert.deepEqual(panelsForMode('comms'), ['inbox', 'campaign_responses']);
});

test('mode: parseDeskMode accepts server values and maps legacy alias', () => {
  assert.equal(parseDeskMode('workforce'), 'workforce');
  assert.equal(parseDeskMode('syncedat'), 'comms');
  assert.equal(parseDeskMode('comms'), 'comms');
  assert.equal(parseDeskMode(undefined), null);
  assert.equal(parseDeskMode(42), null);
});

test('mode: a failed read falls back to workforce and shows a notice', () => {
  const out = resolveDeskMode({ ok: false, reason: 'HTTP 500' });
  assert.equal(out.mode, 'workforce');
  assert.equal(out.mode, DEFAULT_DESK_MODE);
  assert.match(out.notice, /Could not read the desk mode/);
  assert.match(out.notice, /HTTP 500/);
});

test('mode: an invalid body falls back to workforce and shows a notice', () => {
  const out = resolveDeskMode({ ok: true, body: { mode: 'nonsense' } });
  assert.equal(out.mode, 'workforce');
  assert.notEqual(out.notice, null);
});

test('mode: a valid body is used with no notice', () => {
  assert.deepEqual(resolveDeskMode({ ok: true, body: { mode: 'comms' } }), { mode: 'comms', notice: null });
});

test('activity: completed work has no action, approvals carry an approve action', () => {
  const out = mapWorkforceActivityToItems([
    { id: 'r1', kind: 'completed', title: 'Done', detail: 'ok', createdAt: '2026-11-01T00:00:00.000Z' },
    {
      id: 'p1', kind: 'needs_approval', title: 'Approve', detail: 'send', createdAt: '2026-11-01T00:00:00.000Z',
      suggestedAction: { label: 'Approve and run', approvalId: 'ap-1' },
    },
  ]);
  assert.equal(out[0].action, undefined);
  assert.deepEqual(out[1].action, { kind: 'approve', label: 'Approve and run', approvalId: 'ap-1' });
});

test('needs attention: approval items open /app/approvals from a button', () => {
  const [card] = mapReviewInboxToItems([
    { id: 'x', kind: 'approval_pending', reason: 'old', createdAt: '2026-11-01T00:00:00.000Z' },
  ]);
  assert.deepEqual(card.action, { kind: 'open', label: 'Open approvals', href: '/app/approvals' });
});

test('needs attention: a failed run has no Open run button without a run page link', () => {
  const [card] = mapReviewInboxToItems([
    { id: 'run1', kind: 'run_needs_attention', reason: 'failed', createdAt: '2026-11-01T00:00:00.000Z', runId: 'r9' },
  ]);
  assert.equal(card.action, undefined);
  assert.equal(card.openHref, null);
});

test('needs attention: a failed run with a run page link gets Open run', () => {
  const [card] = mapReviewInboxToItems([
    { id: 'run2', kind: 'run_needs_attention', reason: 'failed', createdAt: '2026-11-01T00:00:00.000Z', runHref: '/app/runs/r9' },
  ]);
  assert.deepEqual(card.action, { kind: 'open', label: 'Open run', href: '/app/runs/r9' });
});

test('needs attention: other kinds get no invented action', () => {
  const [card] = mapReviewInboxToItems([
    { id: 't1', kind: 'tool_failed', reason: 'x', createdAt: '2026-11-01T00:00:00.000Z' },
  ]);
  assert.equal(card.action, undefined);
});

test('wire: listFromBody reads items from an object or a bare array, else empty', () => {
  assert.deepEqual(listFromBody({ items: [1, 2] }), [1, 2]);
  assert.deepEqual(listFromBody([3]), [3]);
  assert.deepEqual(listFromBody({ nope: true }), []);
  assert.deepEqual(listFromBody(null), []);
});

test('wire: sourceNote captions a source field when present', () => {
  assert.equal(sourceNote({ runsSource: 'runs_table' }, 'runsSource'), 'Source: runs_table');
  assert.equal(sourceNote({}, 'runsSource'), null);
});

test('roles: only admin and manager may see workforce activity', () => {
  assert.equal(canSeeWorkforceActivity('admin'), true);
  assert.equal(canSeeWorkforceActivity('manager'), true);
  assert.equal(canSeeWorkforceActivity('member'), false);
  assert.equal(canSeeWorkforceActivity(undefined), false);
});

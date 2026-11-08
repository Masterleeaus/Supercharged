/**
 * Tests for server/workforce/runtime/activity-feed.ts. Pure input arrays, no database, no network.
 * Run: node --test --experimental-transform-types tests/workforce/activity-feed.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkforceActivity } from '../../server/workforce/runtime/activity-feed.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-03T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();

const run = (over) => ({ id: 'run-1', companyId: CO_A, status: 'completed', roleId: 'cleaner', finishedAt: ago(HOUR), outcomeText: 'Cleaned level 2', ...over });
const approval = (over) => ({ id: 'ap-1', companyId: CO_A, status: 'pending', action: 'send_quote', requestedAt: ago(2 * HOUR), ...over });
const build = (over = {}) => buildWorkforceActivity({ companyId: CO_A, runs: [], approvals: [], now: NOW, ...over });

test('completed runs become completed items with role and outcome', () => {
  const [item] = build({ runs: [run({ id: 'run-9' })] });
  assert.equal(item.kind, 'completed');
  assert.equal(item.id, 'completed:run-9');
  assert.equal(item.title, 'Work completed by cleaner');
  assert.equal(item.detail, 'Cleaned level 2');
  assert.equal(item.source, 'workforce');
  assert.equal(item.createdAt, ago(HOUR));
  assert.equal('suggestedAction' in item, false);
});

test('pending approvals become needs_approval items with the swipe-right action', () => {
  const [item] = build({ approvals: [approval({ id: 'ap-7', action: 'send_quote' })] });
  assert.equal(item.kind, 'needs_approval');
  assert.equal(item.id, 'needs_approval:ap-7');
  assert.equal(item.title, 'Approval needed: send_quote');
  assert.equal(item.createdAt, ago(2 * HOUR));
  assert.deepEqual(item.suggestedAction, { label: 'Approve and run', approvalId: 'ap-7' });
});

test('failed runs and long-waiting awaiting_approval runs become needs_attention', () => {
  const items = build({
    runs: [
      run({ id: 'run-f', status: 'failed', finishedAt: ago(3 * HOUR) }),
      run({ id: 'run-w', status: 'awaiting_approval', finishedAt: ago(2 * HOUR) }),
    ],
  });
  assert.deepEqual(items.map((i) => i.kind), ['needs_attention', 'needs_attention']);
  assert.deepEqual(items.map((i) => i.id), ['needs_attention:run-w', 'needs_attention:run-f']);
  assert.equal(items[1].title, 'Run failed for cleaner');
});

test('awaiting_approval runs within one hour, and running runs, produce no attention item', () => {
  const items = build({
    runs: [
      run({ id: 'run-recent', status: 'awaiting_approval', finishedAt: ago(30 * 60 * 1000) }),
      run({ id: 'run-live', status: 'running', finishedAt: undefined }),
    ],
  });
  assert.deepEqual(items, []);
});

test('items are ordered newest first across kinds', () => {
  const items = build({
    runs: [
      run({ id: 'old', finishedAt: ago(5 * HOUR) }),
      run({ id: 'new', finishedAt: ago(10 * 60 * 1000) }),
      run({ id: 'fail', status: 'failed', finishedAt: ago(2 * HOUR) }),
    ],
    approvals: [approval({ id: 'mid', requestedAt: ago(HOUR) })],
  });
  assert.deepEqual(items.map((i) => i.id), [
    'completed:new',
    'needs_approval:mid',
    'needs_attention:fail',
    'completed:old',
  ]);
});

test('rows belonging to another company are excluded', () => {
  const items = build({
    runs: [run({ id: 'mine' }), run({ id: 'theirs', companyId: CO_B })],
    approvals: [approval({ id: 'mine-ap' }), approval({ id: 'their-ap', companyId: CO_B })],
  });
  const ids = items.map((i) => i.id);
  assert.deepEqual(ids.sort(), ['completed:mine', 'needs_approval:mine-ap']);
});

test('results are capped at limit, keeping the newest items', () => {
  const runs = Array.from({ length: 5 }, (_, n) => run({ id: `r${n}`, finishedAt: ago((n + 1) * HOUR) }));
  const items = build({ runs, limit: 2 });
  assert.deepEqual(items.map((i) => i.id), ['completed:r0', 'completed:r1']);
  assert.deepEqual(build({ runs, limit: 0 }), []);
});

test('default limit is 50', () => {
  const runs = Array.from({ length: 60 }, (_, n) => run({ id: `r${n}`, finishedAt: ago((n + 1) * 60 * 1000) }));
  assert.equal(build({ runs }).length, 50);
});

test('a non-UUID companyId is refused with invalid_company', () => {
  for (const bad of ['company-a', '', undefined, null, 'z1111111-1111-4111-8111-111111111111']) {
    assert.throws(() => build({ companyId: bad, runs: [run({ companyId: bad })] }), /^Error: invalid_company$/);
  }
});

test('unknown fields and timestamps show as unknown and sort last', () => {
  const items = build({
    runs: [
      run({ id: 'no-time', finishedAt: undefined, roleId: undefined, outcomeText: '' }),
      run({ id: 'bad-time', finishedAt: 'not-a-date' }),
      run({ id: 'dated', finishedAt: ago(HOUR) }),
    ],
    approvals: [approval({ id: 'no-req', requestedAt: undefined, action: undefined })],
  });
  assert.deepEqual(items.map((i) => i.id), [
    'completed:dated',
    'completed:bad-time',
    'completed:no-time',
    'needs_approval:no-req',
  ]);
  const noTime = items.find((i) => i.id === 'completed:no-time');
  assert.equal(noTime.createdAt, 'unknown');
  assert.equal(noTime.title, 'Work completed by unknown');
  assert.equal(noTime.detail, 'unknown');
  const badTime = items.find((i) => i.id === 'completed:bad-time');
  assert.equal(badTime.createdAt, 'unknown');
  const noReq = items.find((i) => i.id === 'needs_approval:no-req');
  assert.equal(noReq.createdAt, 'unknown');
  assert.equal(noReq.title, 'Approval needed: unknown');
  assert.equal(noReq.detail, 'unknown');
  assert.deepEqual(noReq.suggestedAction, { label: 'Approve and run', approvalId: 'no-req' });
  assert.equal(items.at(-1).createdAt, 'unknown');
});

test('an awaiting_approval run with no known timestamp is not flagged', () => {
  const items = build({ runs: [run({ id: 'w', status: 'awaiting_approval', finishedAt: undefined })] });
  assert.deepEqual(items, []);
});

test('a missing or malformed row is skipped without throwing', () => {
  const items = build({ runs: [null, run({ id: 'ok' })], approvals: [undefined] });
  assert.deepEqual(items.map((i) => i.id), ['completed:ok']);
});

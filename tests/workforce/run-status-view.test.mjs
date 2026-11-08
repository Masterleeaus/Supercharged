/**
 * Tests for server/workforce/runtime/run-status-view.ts. Pure: no database, no network, no timers.
 * Run: node --test --experimental-transform-types tests/workforce/run-status-view.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runStatusView, runStatusText, RUN_VIEW_LABELS } from '../../server/workforce/runtime/run-status-view.ts';

// Internal run statuses, as listed in server/workforce/runtime/run.ts (RUN_STATUSES).
const INTERNAL_STATUSES = [
  'queued',
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
  'budget_exhausted',
];

const NOW = new Date('2026-11-03T12:00:00.000Z');
const RECENT = '2026-11-03T11:59:00.000Z';
const OLD = '2026-11-03T08:00:00.000Z';
const APPROVAL = { approvalId: 'appr-1', toolId: 'tool-1', paramsSha256: 'abc', actorKey: 'agent-1' };

function run(status, updatedAt = RECENT, pendingApproval = null) {
  return { status, updatedAt, pendingApproval };
}

test('every internal status maps to one of the user-facing labels', () => {
  for (const status of INTERNAL_STATUSES) {
    const view = runStatusView(run(status, RECENT, status === 'awaiting_approval' ? APPROVAL : null), NOW);
    assert.ok(RUN_VIEW_LABELS.includes(view.label), `${status} -> ${view.label}`);
  }
});

test('the explicit mapping is as specified', () => {
  const expected = {
    queued: 'queued',
    running: 'running',
    completed: 'completed',
    failed: 'failed',
    cancelled: 'cancelled',
    budget_exhausted: 'needs_attention',
  };
  for (const [status, label] of Object.entries(expected)) {
    assert.equal(runStatusView(run(status), NOW).label, label, status);
  }
  assert.equal(runStatusView(run('awaiting_approval', RECENT, APPROVAL), NOW).label, 'awaiting_approval');
});

test('an unknown internal status maps to needs_attention', () => {
  for (const status of ['paused', '', 'RUNNING', 'unknown_thing', undefined, null]) {
    const view = runStatusView(run(status), NOW);
    assert.equal(view.label, 'needs_attention', String(status));
    assert.equal(view.text, runStatusText('needs_attention'));
  }
});

test('an approval waiting longer than staleAfterMs maps to needs_attention', () => {
  const view = runStatusView(run('awaiting_approval', OLD, APPROVAL), NOW, { staleAfterMs: 60 * 60 * 1000 });
  assert.equal(view.label, 'needs_attention');
});

test('a recent approval wait stays awaiting_approval, and exactly at the threshold is not stale', () => {
  const fresh = runStatusView(run('awaiting_approval', RECENT, APPROVAL), NOW, { staleAfterMs: 5 * 60 * 1000 });
  assert.equal(fresh.label, 'awaiting_approval');

  const edge = '2026-11-03T11:00:00.000Z';
  const atLimit = runStatusView(run('awaiting_approval', edge, APPROVAL), NOW, { staleAfterMs: 60 * 60 * 1000 });
  assert.equal(atLimit.label, 'awaiting_approval');
});

test('without staleAfterMs an old approval wait is not stale', () => {
  assert.equal(runStatusView(run('awaiting_approval', OLD, APPROVAL), NOW).label, 'awaiting_approval');
});

test('awaiting approval with no recorded approval, or an unreadable time, needs attention', () => {
  assert.equal(runStatusView(run('awaiting_approval', RECENT, null), NOW).label, 'needs_attention');
  assert.equal(runStatusView(run('awaiting_approval', 'not-a-date', APPROVAL), NOW).label, 'needs_attention');
});

test('every output has a label, a text, and a detail that is a string or null', () => {
  const statuses = [...INTERNAL_STATUSES, 'mystery'];
  for (const status of statuses) {
    const view = runStatusView(run(status, RECENT, APPROVAL), NOW, { staleAfterMs: 1000 });
    assert.deepEqual(Object.keys(view).sort(), ['detail', 'label', 'text']);
    assert.equal(typeof view.text, 'string');
    assert.ok(view.text.length > 0);
    assert.ok(view.detail === null || typeof view.detail === 'string');
  }
});

test('every label has plain English text', () => {
  for (const label of RUN_VIEW_LABELS) {
    assert.equal(typeof runStatusText(label), 'string');
    assert.ok(runStatusText(label).length > 0, label);
  }
});

test('no text ever contains an internal status name', () => {
  const forbidden = [
    ...INTERNAL_STATUSES,
    ...INTERNAL_STATUSES.map((s) => s.replace(/_/g, ' ')),
    ...RUN_VIEW_LABELS,
    ...RUN_VIEW_LABELS.map((s) => s.replace(/_/g, ' ')),
  ];
  const outputs = [];
  for (const status of [...INTERNAL_STATUSES, 'mystery']) {
    outputs.push(runStatusView(run(status, RECENT, APPROVAL), NOW, { staleAfterMs: 1000 }));
    outputs.push(runStatusView(run(status, OLD, null), NOW, { staleAfterMs: 1000 }));
  }
  for (const label of RUN_VIEW_LABELS) outputs.push({ text: runStatusText(label), detail: null });

  for (const out of outputs) {
    const strings = [out.text, out.detail ?? ''];
    for (const s of strings) {
      const lower = s.toLowerCase();
      for (const name of forbidden) {
        assert.equal(lower.includes(name), false, `"${s}" contains "${name}"`);
      }
    }
  }
});

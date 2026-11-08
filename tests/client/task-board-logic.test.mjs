/**
 * Tests for client/src/pages/workforce/task-board-logic.ts (pure helpers behind TaskBoard.tsx and RunHistory.tsx).
 * Checks that the board columns and headings match the server's run-status-view labels and text.
 * Run: node --test --experimental-transform-types tests/client/task-board-logic.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLUMN_HEADINGS,
  COLUMN_ORDER,
  eventLabel,
  formatTime,
  groupByColumn,
  parseRunHistory,
  parseTaskRows,
} from '../../client/src/pages/workforce/task-board-logic.ts';
import { RUN_VIEW_LABELS, runStatusText } from '../../server/workforce/runtime/run-status-view.ts';

// Keep the output stream clean: the test runner reads child stdout over IPC.
console.log = () => {};
console.info = () => {};
console.warn = () => {};

const row = (runId, label, extra = {}) => ({
  runId,
  label,
  text: `text for ${label}`,
  detail: null,
  createdAt: '2026-11-04T09:00:00.000Z',
  updatedAt: '2026-11-04T10:00:00.000Z',
  ...extra,
});

test('column order covers every server run-view label exactly once', () => {
  assert.deepEqual([...COLUMN_ORDER].sort(), [...RUN_VIEW_LABELS].sort());
  assert.equal(new Set(COLUMN_ORDER).size, COLUMN_ORDER.length);
});

test('column headings match the server plain English text for each label', () => {
  for (const label of COLUMN_ORDER) {
    assert.equal(COLUMN_HEADINGS[label], runStatusText(label), `heading for ${label}`);
  }
});

test('parseTaskRows: keeps well-formed rows and drops rows with missing required fields', () => {
  const body = {
    tasks: [
      row('r1', 'running'),
      { runId: 'r2', label: 'running', text: 'In progress' },
      'not an object',
      row('r3', 'queued', { detail: 42 }),
    ],
    truncated: false,
  };
  const rows = parseTaskRows(body);
  assert.deepEqual(rows.map((r) => r.runId), ['r1', 'r3']);
  assert.equal(rows[1].detail, null);
});

test('parseTaskRows: a non-object or missing tasks list gives an empty list', () => {
  assert.deepEqual(parseTaskRows(null), []);
  assert.deepEqual(parseTaskRows({ tasks: 'nope' }), []);
  assert.deepEqual(parseTaskRows([]), []);
});

test('groupByColumn: rows land in their label column, unknown labels go to needs attention', () => {
  const columns = groupByColumn([
    row('a', 'running'),
    row('b', 'running'),
    row('c', 'failed'),
    row('d', 'something_new'),
  ]);
  assert.deepEqual(columns.running.map((r) => r.runId), ['a', 'b']);
  assert.deepEqual(columns.failed.map((r) => r.runId), ['c']);
  assert.deepEqual(columns.needs_attention.map((r) => r.runId), ['d']);
  assert.deepEqual(columns.queued, []);
  assert.deepEqual(Object.keys(columns), [...COLUMN_ORDER]);
});

test('parseRunHistory: keeps events with action and time, drops malformed events', () => {
  const body = {
    runs: [
      {
        runId: 'r1',
        label: 'completed',
        text: 'Finished',
        detail: null,
        createdAt: '2026-11-04T09:00:00.000Z',
        updatedAt: '2026-11-04T10:00:00.000Z',
        outcome: { reason: 'All steps done' },
        events: [
          { action: 'run.started', createdAt: '2026-11-04T09:01:00.000Z' },
          { action: 42, createdAt: '2026-11-04T09:02:00.000Z' },
          { action: 'run.completed' },
        ],
      },
      { runId: 'bad', label: 'running' },
    ],
  };
  const runs = parseRunHistory(body);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].outcome.reason, 'All steps done');
  assert.deepEqual(runs[0].events, [{ action: 'run.started', createdAt: '2026-11-04T09:01:00.000Z' }]);
});

test('parseRunHistory: a run with no outcome reason shows null', () => {
  const runs = parseRunHistory({
    runs: [{ runId: 'r1', label: 'running', text: 'In progress', createdAt: 'x', updatedAt: 'y', events: [] }],
  });
  assert.equal(runs[0].outcome.reason, null);
});

test('formatTime: unreadable or missing times show as unknown', () => {
  assert.equal(formatTime(null), 'Time unknown');
  assert.equal(formatTime('not a date'), 'Time unknown');
  assert.notEqual(formatTime('2026-11-04T09:00:00.000Z'), 'Time unknown');
});

test('eventLabel: turns stored kinds into readable labels', () => {
  assert.equal(eventLabel('run.started'), 'Run started');
  assert.equal(eventLabel('approval_requested'), 'Approval requested');
  assert.equal(eventLabel('  '), 'Event');
});

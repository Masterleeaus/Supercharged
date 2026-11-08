import test from 'node:test';
import assert from 'node:assert/strict';
import {
  kindLabel,
  sortRunHistory,
  toRunHistoryItems,
} from '../../client/src/components/workforce/run-history-logic.ts';

const item = (id, kind, createdAt) => ({
  id, kind, title: id, detail: '', createdAt,
});

test('sort: newest first, unknown times last', () => {
  const items = [
    item('a', 'completed', '2026-11-01T10:00:00.000Z'),
    item('b', 'completed', null),
    item('c', 'completed', '2026-11-03T10:00:00.000Z'),
    item('d', 'completed', 'not a date'),
  ];
  const ids = sortRunHistory(items).map((i) => i.id);
  assert.deepEqual(ids.slice(0, 2), ['c', 'a']);
  assert.deepEqual(ids.slice(2).sort(), ['b', 'd']);
});

test('sort: returns a copy and leaves the input order unchanged', () => {
  const input = [
    item('a', 'completed', '2026-11-01T10:00:00.000Z'),
    item('b', 'completed', '2026-11-03T10:00:00.000Z'),
  ];
  const out = sortRunHistory(input);
  assert.notEqual(out, input);
  assert.deepEqual(input.map((i) => i.id), ['a', 'b']);
});

test('kindLabel: known kinds get fixed labels', () => {
  assert.equal(kindLabel('completed'), 'Completed');
  assert.equal(kindLabel('needs_approval'), 'Needs approval');
  assert.equal(kindLabel('run_needs_attention'), 'Needs attention');
});

test('kindLabel: unknown kinds are title-cased, empty becomes Activity', () => {
  assert.equal(kindLabel('quote_sent'), 'Quote sent');
  assert.equal(kindLabel('  '), 'Activity');
});

test('toRunHistoryItems: drops rows without a string id and fills safe defaults', () => {
  const out = toRunHistoryItems([
    { id: 'x1', kind: 'completed', title: 'Sent invoice', detail: 'Paid', createdAt: '2026-11-03T10:00:00.000Z' },
    { id: '', kind: 'completed' },
    null,
    { kind: 'completed', title: 'no id' },
    { id: 'x2' },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    id: 'x1', kind: 'completed', title: 'Sent invoice', detail: 'Paid', createdAt: '2026-11-03T10:00:00.000Z',
  });
  assert.deepEqual(out[1], {
    id: 'x2', kind: 'activity', title: 'Activity', detail: 'No detail', createdAt: null,
  });
});

test('toRunHistoryItems: non-array input gives an empty list', () => {
  assert.deepEqual(toRunHistoryItems(undefined), []);
  assert.deepEqual(toRunHistoryItems({ items: [] }), []);
});

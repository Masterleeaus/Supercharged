import test from 'node:test';
import assert from 'node:assert/strict';
import { decideSwipe, clampDrag } from '../../client/src/components/activity/swipe-logic.ts';

test('left swipe at or past threshold archives', () => {
  assert.equal(decideSwipe({ dx: -80 }), 'archive');
  assert.equal(decideSwipe({ dx: -160 }), 'archive');
  assert.equal(decideSwipe({ dx: -500 }), 'archive');
});

test('right swipe at or past threshold accepts', () => {
  assert.equal(decideSwipe({ dx: 80 }), 'accept');
  assert.equal(decideSwipe({ dx: 160 }), 'accept');
  assert.equal(decideSwipe({ dx: 500 }), 'accept');
});

test('short drags and zero produce none', () => {
  assert.equal(decideSwipe({ dx: 0 }), 'none');
  assert.equal(decideSwipe({ dx: 79.9 }), 'none');
  assert.equal(decideSwipe({ dx: -79.9 }), 'none');
});

test('custom threshold is respected', () => {
  assert.equal(decideSwipe({ dx: -40, threshold: 40 }), 'archive');
  assert.equal(decideSwipe({ dx: 39, threshold: 40 }), 'none');
});

test('clampDrag limits to +/-160 by default', () => {
  assert.equal(clampDrag(200), 160);
  assert.equal(clampDrag(-200), -160);
  assert.equal(clampDrag(42), 42);
  assert.equal(clampDrag(-160), -160);
});

test('clampDrag accepts a custom max', () => {
  assert.equal(clampDrag(90, 50), 50);
  assert.equal(clampDrag(-90, 50), -50);
});

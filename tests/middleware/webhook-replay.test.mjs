import test from 'node:test';
import assert from 'node:assert/strict';

// Pure logic only. No network, no database, no Express, no timers.
const { createReplayGuard } = await import('../../server/middleware/webhook-replay.ts');

const WINDOW = 5 * 60 * 1000;

function makeClock(start = 1_000_000_000_000) {
  let t = start;
  return {
    now: () => t,
    set: (value) => { t = value; },
    advance: (ms) => { t += ms; },
    get: () => t,
  };
}

function makeGuard(overrides = {}) {
  const clock = makeClock();
  const guard = createReplayGuard({
    now: clock.now,
    windowMs: WINDOW,
    maxEntries: 100,
    ...overrides,
  });
  return { clock, guard };
}

test('first delivery of an event is accepted and a replay is refused', () => {
  const { clock, guard } = makeGuard();
  const input = { provider: 'stripe', eventId: 'evt_1', timestampMs: clock.get() };
  assert.deepEqual(guard.check(input), { accepted: true });
  assert.deepEqual(guard.check(input), { accepted: false, reason: 'replay' });
});

test('the same eventId under another provider is accepted both times', () => {
  const { clock, guard } = makeGuard();
  const ts = clock.get();
  assert.deepEqual(guard.check({ provider: 'stripe', eventId: 'shared', timestampMs: ts }), { accepted: true });
  assert.deepEqual(guard.check({ provider: 'paystack', eventId: 'shared', timestampMs: ts }), { accepted: true });
  assert.deepEqual(guard.check({ provider: 'stripe', eventId: 'shared', timestampMs: ts }), { accepted: false, reason: 'replay' });
  assert.equal(guard.size(), 2);
});

test('timestamp older than the window is refused', () => {
  const { clock, guard } = makeGuard();
  const result = guard.check({ provider: 'p', eventId: 'old', timestampMs: clock.get() - WINDOW - 1 });
  assert.deepEqual(result, { accepted: false, reason: 'timestamp_out_of_window' });
  assert.equal(guard.size(), 0);
});

test('timestamp in the future beyond the window is refused', () => {
  const { clock, guard } = makeGuard();
  const result = guard.check({ provider: 'p', eventId: 'future', timestampMs: clock.get() + WINDOW + 1 });
  assert.deepEqual(result, { accepted: false, reason: 'timestamp_out_of_window' });
});

test('timestamp exactly at the window edge is accepted in both directions', () => {
  const { clock, guard } = makeGuard();
  assert.deepEqual(guard.check({ provider: 'p', eventId: 'edge_past', timestampMs: clock.get() - WINDOW }), { accepted: true });
  assert.deepEqual(guard.check({ provider: 'p', eventId: 'edge_future', timestampMs: clock.get() + WINDOW }), { accepted: true });
});

test('missing event id is refused', () => {
  const { clock, guard } = makeGuard();
  const ts = clock.get();
  assert.deepEqual(guard.check({ provider: 'p', eventId: undefined, timestampMs: ts }), { accepted: false, reason: 'missing_event_id' });
  assert.deepEqual(guard.check({ provider: 'p', eventId: null, timestampMs: ts }), { accepted: false, reason: 'missing_event_id' });
  assert.deepEqual(guard.check({ provider: 'p', eventId: '', timestampMs: ts }), { accepted: false, reason: 'missing_event_id' });
  assert.equal(guard.size(), 0);
});

test('missing timestamp is refused', () => {
  const { guard } = makeGuard();
  assert.deepEqual(guard.check({ provider: 'p', eventId: 'e1', timestampMs: undefined }), { accepted: false, reason: 'missing_timestamp' });
  assert.deepEqual(guard.check({ provider: 'p', eventId: 'e1', timestampMs: null }), { accepted: false, reason: 'missing_timestamp' });
  assert.deepEqual(guard.check({ provider: 'p', eventId: 'e1', timestampMs: NaN }), { accepted: false, reason: 'missing_timestamp' });
  assert.equal(guard.size(), 0);
});

test('a refused check does not record the event', () => {
  const { clock, guard } = makeGuard();
  guard.check({ provider: 'p', eventId: 'later', timestampMs: clock.get() - WINDOW - 1 });
  assert.deepEqual(guard.check({ provider: 'p', eventId: 'later', timestampMs: clock.get() }), { accepted: true });
});

test('entries expire with the clock and the same event is accepted again', () => {
  const { clock, guard } = makeGuard();
  const first = { provider: 'p', eventId: 'expiring', timestampMs: clock.get() };
  assert.deepEqual(guard.check(first), { accepted: true });
  assert.equal(guard.size(), 1);

  clock.advance(WINDOW);
  assert.deepEqual(guard.check({ ...first, timestampMs: clock.get() }), { accepted: false, reason: 'replay' });

  clock.advance(1);
  assert.deepEqual(guard.check({ provider: 'p', eventId: 'expiring', timestampMs: clock.get() }), { accepted: true });
  assert.equal(guard.size(), 1);
});

test('expired entries are swept on check', () => {
  const { clock, guard } = makeGuard();
  guard.check({ provider: 'p', eventId: 'a', timestampMs: clock.get() });
  guard.check({ provider: 'p', eventId: 'b', timestampMs: clock.get() });
  assert.equal(guard.size(), 2);

  clock.advance(WINDOW + 1);
  guard.check({ provider: 'p', eventId: 'c', timestampMs: clock.get() });
  assert.equal(guard.size(), 1);
});

test('maxEntries bound holds and the oldest entry is dropped first', () => {
  const { clock, guard } = makeGuard({ maxEntries: 3 });
  const ts = clock.get();
  for (const id of ['e1', 'e2', 'e3', 'e4']) {
    assert.deepEqual(guard.check({ provider: 'p', eventId: id, timestampMs: ts }), { accepted: true });
    assert.ok(guard.size() <= 3);
  }
  assert.equal(guard.size(), 3);
  // e1 was the oldest and has been evicted, so it is accepted again.
  assert.deepEqual(guard.check({ provider: 'p', eventId: 'e1', timestampMs: ts }), { accepted: true });
  // e4 is still held.
  assert.deepEqual(guard.check({ provider: 'p', eventId: 'e4', timestampMs: ts }), { accepted: false, reason: 'replay' });
});

test('invalid options are rejected at construction', () => {
  const clock = makeClock();
  assert.throws(() => createReplayGuard({ now: clock.now, windowMs: 0, maxEntries: 1 }), RangeError);
  assert.throws(() => createReplayGuard({ now: clock.now, windowMs: WINDOW, maxEntries: 0 }), RangeError);
  assert.throws(() => createReplayGuard({ now: clock.now, windowMs: WINDOW, maxEntries: 1.5 }), RangeError);
});

/**
 * Tests for server/workforce/runtime/freshness.ts. Injected clock only, no real timers, no network, no database.
 * Run: node --test --experimental-transform-types tests/workforce/freshness.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FRESHNESS_LIMITS,
  checkFreshness,
  assertFreshForAction,
} from '../../server/workforce/runtime/freshness.ts';

const NOW = Date.UTC(2026, 10, 3, 9, 0, 0);
const SOURCE = 'test-source';

function item(kind, observedAt, overrides = {}) {
  return { kind, observedAt, source: SOURCE, ...overrides };
}

// ---------- defaults ----------

test('FRESHNESS_LIMITS has the documented default for each kind', () => {
  assert.deepEqual(FRESHNESS_LIMITS, {
    schedule: 24 * 60 * 60 * 1000,
    pricing: 7 * 24 * 60 * 60 * 1000,
    availability: 60 * 60 * 1000,
    policy: 30 * 24 * 60 * 60 * 1000,
    customer_details: 90 * 24 * 60 * 60 * 1000,
  });
  assert.ok(Object.isFrozen(FRESHNESS_LIMITS));
});

// ---------- boundaries, one pair per kind ----------

for (const [kind, maxAge] of Object.entries(FRESHNESS_LIMITS)) {
  test(`${kind}: fresh exactly at the limit, stale one ms past`, () => {
    const atLimit = checkFreshness(item(kind, NOW - maxAge), { now: NOW });
    assert.deepEqual(atLimit, { fresh: true });

    const past = checkFreshness(item(kind, NOW - maxAge - 1), { now: NOW });
    assert.deepEqual(past, { fresh: false, reason: `stale_${kind}`, ageMs: maxAge + 1, maxAgeMs: maxAge });
  });

  test(`${kind}: observed right now is fresh`, () => {
    assert.deepEqual(checkFreshness(item(kind, NOW), { now: NOW }), { fresh: true });
  });
}

// ---------- unknown kind and missing observedAt ----------

test('unknown kind is not fresh, reason unknown_freshness', () => {
  assert.deepEqual(checkFreshness(item('weather', NOW), { now: NOW }), {
    fresh: false,
    reason: 'unknown_freshness',
  });
});

test('kind names that merely look like prototype keys are unknown', () => {
  for (const kind of ['constructor', 'toString', '__proto__', '']) {
    assert.deepEqual(checkFreshness(item(kind, NOW), { now: NOW }), {
      fresh: false,
      reason: 'unknown_freshness',
    });
  }
});

test('missing observedAt is not fresh, reason unknown_freshness', () => {
  const noField = { kind: 'pricing', source: SOURCE };
  assert.deepEqual(checkFreshness(noField, { now: NOW }), { fresh: false, reason: 'unknown_freshness' });
});

test('null, undefined, NaN and non-number observedAt are not fresh', () => {
  for (const observedAt of [null, undefined, Number.NaN, Infinity, '2026-11-03', NOW.toString()]) {
    assert.deepEqual(
      checkFreshness(item('availability', observedAt), { now: NOW }),
      { fresh: false, reason: 'unknown_freshness' },
      String(observedAt),
    );
  }
});

// ---------- future observedAt ----------

test('observedAt in the future is not fresh, reason clock_skew', () => {
  assert.deepEqual(checkFreshness(item('schedule', NOW + 1), { now: NOW }), {
    fresh: false,
    reason: 'clock_skew',
  });
});

test('observedAt exactly at now is fresh, not clock_skew', () => {
  assert.deepEqual(checkFreshness(item('schedule', NOW), { now: NOW }), { fresh: true });
});

// ---------- overrides ----------

test('an override changes the limit for that kind only', () => {
  const limits = { availability: 5 * 60 * 1000 };

  // 10 minutes old: stale under the override, fresh under the default 1h.
  const tenMin = item('availability', NOW - 10 * 60 * 1000);
  assert.deepEqual(checkFreshness(tenMin, { now: NOW, limits }), {
    fresh: false,
    reason: 'stale_availability',
    ageMs: 10 * 60 * 1000,
    maxAgeMs: 5 * 60 * 1000,
  });
  assert.deepEqual(checkFreshness(tenMin, { now: NOW }), { fresh: true });

  // Other kinds keep their defaults.
  const threeDays = item('pricing', NOW - 3 * 24 * 60 * 60 * 1000);
  assert.deepEqual(checkFreshness(threeDays, { now: NOW, limits }), { fresh: true });
});

test('an override can extend a limit', () => {
  const twoDays = item('schedule', NOW - 2 * 24 * 60 * 60 * 1000);
  assert.equal(checkFreshness(twoDays, { now: NOW }).fresh, false);
  assert.deepEqual(checkFreshness(twoDays, { now: NOW, limits: { schedule: 3 * 24 * 60 * 60 * 1000 } }), {
    fresh: true,
  });
});

test('an override does not mutate FRESHNESS_LIMITS', () => {
  checkFreshness(item('policy', NOW), { now: NOW, limits: { policy: 1 } });
  assert.equal(FRESHNESS_LIMITS.policy, 30 * 24 * 60 * 60 * 1000);
});

test('an invalid override throws a TypeError', () => {
  for (const value of [-1, Number.NaN, Infinity, '1000']) {
    assert.throws(
      () => checkFreshness(item('pricing', NOW), { now: NOW, limits: { pricing: value } }),
      TypeError,
      String(value),
    );
  }
  assert.throws(
    () => checkFreshness(item('pricing', NOW), { now: NOW, limits: { pricng: 1 } }),
    TypeError,
  );
});

// ---------- assertFreshForAction ----------

test('assertFreshForAction is ok when every item is fresh', () => {
  const items = [item('schedule', NOW), item('pricing', NOW - 1000), item('policy', NOW)];
  assert.deepEqual(assertFreshForAction(items, { now: NOW }), { ok: true });
});

test('assertFreshForAction is ok for an empty list', () => {
  assert.deepEqual(assertFreshForAction([], { now: NOW }), { ok: true });
});

test('assertFreshForAction lists every stale item, not only the first', () => {
  const hourMs = 60 * 60 * 1000;
  const stale1 = item('availability', NOW - hourMs - 1);
  const fresh = item('policy', NOW);
  const stale2 = item('schedule', NOW - 2 * 24 * hourMs);
  const unknown = item('weather', NOW);
  const future = item('pricing', NOW + 5000);

  const result = assertFreshForAction([stale1, fresh, stale2, unknown, future], { now: NOW });

  assert.equal(result.ok, false);
  assert.equal(result.reasons.length, 4);
  assert.deepEqual(result.reasons[0], {
    item: stale1,
    reason: 'stale_availability',
    ageMs: hourMs + 1,
    maxAgeMs: hourMs,
  });
  assert.deepEqual(result.reasons[1], {
    item: stale2,
    reason: 'stale_schedule',
    ageMs: 2 * 24 * hourMs,
    maxAgeMs: 24 * hourMs,
  });
  assert.deepEqual(result.reasons[2], { item: unknown, reason: 'unknown_freshness' });
  assert.deepEqual(result.reasons[3], { item: future, reason: 'clock_skew' });
});

test('assertFreshForAction honours limit overrides', () => {
  const items = [item('availability', NOW - 10 * 60 * 1000)];
  assert.deepEqual(assertFreshForAction(items, { now: NOW }), { ok: true });
  const result = assertFreshForAction(items, { now: NOW, limits: { availability: 60 * 1000 } });
  assert.equal(result.ok, false);
  assert.equal(result.reasons[0].reason, 'stale_availability');
});

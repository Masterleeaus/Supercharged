/**
 * Tests for server/workforce/portfolio/health.ts. Fake collectors and a fake scheduler only: no network, no
 * provider calls, no database. Console output is silenced because this file imports server code.
 * Run: node --test --experimental-transform-types tests/workforce/portfolio-health.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectHealth,
  evaluateHealth,
  normaliseObservations,
  summarisePortfolio,
} from '../../server/workforce/portfolio/health.ts';

for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
  console[method] = () => {};
}

const NOW = 1_000_000;
const MAX_AGE = 60_000;
const BIZ_A = { id: 'biz-a' };
const BIZ_B = { id: 'biz-b' };

function obs(overrides = {}) {
  return {
    business_id: 'biz-a',
    system: 'website',
    status: 'healthy',
    observed_at: NOW - 1_000,
    source_id: 'fake-source',
    evidence_ref: 'evidence:1',
    ...overrides,
  };
}

function recordOf(records, businessId, system) {
  return records.find((r) => r.business_id === businessId && r.system === system);
}

/** Scheduler that never fires on its own. Tests fire it explicitly to simulate elapsed time. */
function manualScheduler() {
  const timers = [];
  return {
    timers,
    schedule(ms, fn) {
      const timer = { ms, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    fireAll() {
      for (const timer of timers) if (!timer.cancelled) timer.fn();
    },
  };
}

test('a fresh healthy observation is healthy with its evidence reference', () => {
  const { records } = evaluateHealth([obs()], [BIZ_A], { now: NOW, maxAgeMs: MAX_AGE, systems: ['website'] });
  const record = recordOf(records, 'biz-a', 'website');
  assert.equal(record.status, 'healthy');
  assert.equal(record.reason, 'fresh');
  assert.equal(record.evidence_ref, 'evidence:1');
  assert.equal(record.source_id, 'fake-source');
});

test('a stale healthy observation is unknown, never healthy', () => {
  const stale = obs({ observed_at: NOW - MAX_AGE - 1 });
  const { records } = evaluateHealth([stale], [BIZ_A], { now: NOW, maxAgeMs: MAX_AGE, systems: ['website'] });
  const record = recordOf(records, 'biz-a', 'website');
  assert.equal(record.status, 'unknown');
  assert.equal(record.reason, 'stale');
  assert.equal(record.observed_at, NOW - MAX_AGE - 1);
});

test('an observation exactly at the max age is still fresh', () => {
  const edge = obs({ observed_at: NOW - MAX_AGE });
  const { records } = evaluateHealth([edge], [BIZ_A], { now: NOW, maxAgeMs: MAX_AGE, systems: ['website'] });
  assert.equal(recordOf(records, 'biz-a', 'website').status, 'healthy');
});

test('a missing observation is unknown', () => {
  const { records } = evaluateHealth([], [BIZ_A], { now: NOW, maxAgeMs: MAX_AGE, systems: ['website'] });
  const record = recordOf(records, 'biz-a', 'website');
  assert.equal(record.status, 'unknown');
  assert.equal(record.reason, 'missing');
  assert.equal(record.observed_at, null);
});

test('a future-dated observation is not treated as fresh', () => {
  const future = obs({ observed_at: NOW + 5_000 });
  const { records } = evaluateHealth([future], [BIZ_A], { now: NOW, maxAgeMs: MAX_AGE, systems: ['website'] });
  const record = recordOf(records, 'biz-a', 'website');
  assert.equal(record.status, 'unknown');
  assert.equal(record.reason, 'future_timestamp');
});

test('among fresh observations the worst status wins', () => {
  const observations = [
    obs({ status: 'healthy', observed_at: NOW - 10, evidence_ref: 'e-healthy' }),
    obs({ status: 'unavailable', observed_at: NOW - 500, evidence_ref: 'e-down' }),
  ];
  const { records } = evaluateHealth(observations, [BIZ_A], { now: NOW, maxAgeMs: MAX_AGE, systems: ['website'] });
  const record = recordOf(records, 'biz-a', 'website');
  assert.equal(record.status, 'unavailable');
  assert.equal(record.evidence_ref, 'e-down');
});

test('a throwing collector yields unknown for its systems and records only the error class', async () => {
  class ProviderAuthError extends Error {}
  const collector = {
    source_id: 'directadmin-fake',
    systems: ['hosting', 'ssl'],
    collect() {
      throw new ProviderAuthError('token sk-live-should-not-appear');
    },
  };
  const result = await collectHealth([collector], [BIZ_A], {
    timeoutMs: 1_000,
    scheduler: manualScheduler(),
  });
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].error_class, 'ProviderAuthError');
  assert.equal(JSON.stringify(result).includes('sk-live'), false);

  const { records } = evaluateHealth(result.observations, [BIZ_A], {
    now: NOW,
    maxAgeMs: MAX_AGE,
    systems: ['hosting', 'ssl'],
    failures: result.failures,
  });
  for (const system of ['hosting', 'ssl']) {
    const record = recordOf(records, 'biz-a', system);
    assert.equal(record.status, 'unknown');
    assert.equal(record.reason, 'collector_error');
    assert.equal(record.error_class, 'ProviderAuthError');
  }
});

test('a collector that times out yields unknown with reason timeout', async () => {
  const scheduler = manualScheduler();
  const collector = {
    source_id: 'slow-source',
    systems: ['dns'],
    collect() {
      scheduler.fireAll(); // simulated time passes while the collector is still pending
      return new Promise(() => {});
    },
  };
  const result = await collectHealth([collector], [BIZ_A], { timeoutMs: 5_000, scheduler });
  assert.equal(result.failures[0].reason, 'timeout');
  assert.equal(result.failures[0].error_class, 'TimeoutError');

  const { records } = evaluateHealth([], [BIZ_A], {
    now: NOW,
    maxAgeMs: MAX_AGE,
    systems: ['dns'],
    failures: result.failures,
  });
  assert.equal(recordOf(records, 'biz-a', 'dns').status, 'unknown');
  assert.equal(recordOf(records, 'biz-a', 'dns').reason, 'timeout');
});

test('refuses observations with a missing business id or a status outside the three values', () => {
  const raw = [
    obs(),
    obs({ business_id: undefined }),
    obs({ business_id: '   ' }),
    obs({ status: 'ok' }),
    obs({ status: 'unknown' }),
    obs({ system: 'email' }),
    obs({ source_id: '' }),
    obs({ observed_at: 'yesterday' }),
    null,
  ];
  const { accepted, refused } = normaliseObservations(raw, { businessIds: new Set(['biz-a']) });
  assert.equal(accepted.length, 1);
  assert.deepEqual(
    refused.map((r) => r.reason),
    [
      'missing_business_id',
      'missing_business_id',
      'invalid_status',
      'invalid_status',
      'invalid_system',
      'missing_source_id',
      'invalid_observed_at',
      'not_an_object',
    ],
  );
});

test('a collector cannot report for another business or a different source', async () => {
  const collector = {
    source_id: 'honest-source',
    systems: ['website'],
    collect: () => [
      obs({ business_id: 'biz-b', source_id: 'honest-source' }),
      obs({ source_id: 'someone-else' }),
      obs({ source_id: 'honest-source' }),
    ],
  };
  const result = await collectHealth([collector], [BIZ_A], { timeoutMs: 1_000, scheduler: manualScheduler() });
  assert.equal(result.observations.length, 1);
  assert.deepEqual(result.refused.map((r) => r.reason), ['business_not_in_scope', 'source_mismatch']);
});

test('summary keeps unknown separate from healthy and lists businesses needing attention', () => {
  const observations = [
    // biz-a: fresh healthy on both systems in scope
    obs({ business_id: 'biz-a', system: 'website' }),
    obs({ business_id: 'biz-a', system: 'hosting' }),
    // biz-b: website degraded, hosting has no evidence
    obs({ business_id: 'biz-b', system: 'website', status: 'degraded' }),
    // biz-c: no observations at all
  ];
  const businesses = [BIZ_A, BIZ_B, { id: 'biz-c' }];
  const summary = summarisePortfolio(observations, businesses, NOW, {
    maxAgeMs: MAX_AGE,
    systems: ['website', 'hosting'],
  });

  assert.deepEqual(summary.businesses, { total: 3, healthy: 1, degraded: 1, unavailable: 0, unknown: 1 });
  assert.equal(summary.systems.healthy, 2);
  assert.equal(summary.systems.degraded, 1);
  assert.equal(summary.systems.unknown, 3);
  assert.equal(summary.systems.total, 6);

  const attentionIds = summary.attention.map((a) => a.business_id);
  assert.deepEqual(attentionIds, ['biz-b', 'biz-c'], 'degraded before unknown, and the healthy business is absent');
  assert.equal(summary.attention[1].status, 'unknown');
});

test('a business with no observations is listed as unknown', () => {
  const summary = summarisePortfolio([], [{ id: 'biz-new' }], NOW, { maxAgeMs: MAX_AGE, systems: ['backup'] });
  assert.equal(summary.businesses.unknown, 1);
  assert.equal(summary.businesses.healthy, 0);
  assert.equal(summary.attention.length, 1);
  assert.equal(summary.attention[0].business_id, 'biz-new');
  assert.equal(summary.attention[0].systems[0].reason, 'missing');
});

test('one business healthy evidence does not leak into another business', () => {
  const summary = summarisePortfolio([obs({ business_id: 'biz-a' })], [BIZ_A, BIZ_B], NOW, {
    maxAgeMs: MAX_AGE,
    systems: ['website'],
  });
  assert.equal(summary.businesses.healthy, 1);
  assert.equal(summary.businesses.unknown, 1);
  assert.equal(summary.attention[0].business_id, 'biz-b');
});

test('missing or invalid configuration is refused, not guessed', () => {
  assert.throws(() => evaluateHealth([], [BIZ_A], { now: NOW }), TypeError);
  assert.throws(() => evaluateHealth([], [BIZ_A], { now: NOW, maxAgeMs: 0 }), TypeError);
  assert.throws(() => evaluateHealth([], [{ id: '' }], { now: NOW, maxAgeMs: MAX_AGE }), TypeError);
  assert.throws(() => evaluateHealth([], [BIZ_A, { id: 'biz-a' }], { now: NOW, maxAgeMs: MAX_AGE }), TypeError);
  assert.throws(() => evaluateHealth([], [BIZ_A], { now: NOW, maxAgeMs: MAX_AGE, systems: ['email'] }), TypeError);
});

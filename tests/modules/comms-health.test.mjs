import test from 'node:test';
import assert from 'node:assert/strict';
import {
  percentile,
  summarizeLatency,
  summarizeProviders,
  summarizeCommsHealth,
} from '../../server/modules/comms/comms-health.ts';

const baseSnapshot = () => ({
  queuedJobs: 3,
  deadLettered: 1,
  deliveryLatenciesMs: [100, 200, 300, 400, 500],
  providers: {
    sms: { errors: 2, total: 8 },
    email: { errors: 0, total: 4 },
  },
  retries: 5,
  suppressions: 2,
  consentRefusals: 1,
});

test('percentile uses nearest-rank and returns null when empty', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([], 95), null);
  assert.equal(percentile([42], 50), 42);
  assert.equal(percentile([42], 95), 42);
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(ten, 50), 5);
  assert.equal(percentile(ten, 95), 10);
});

test('summarizeLatency gives p50 and p95 on fixed numbers', () => {
  assert.deepEqual(summarizeLatency([100, 200, 300, 400, 500]), {
    count: 5,
    p50: 300,
    p95: 500,
  });
});

test('summarizeLatency sorts unsorted input before ranking', () => {
  assert.deepEqual(summarizeLatency([500, 100, 300, 200, 400]), {
    count: 5,
    p50: 300,
    p95: 500,
  });
});

test('summarizeLatency returns null percentiles for empty input', () => {
  assert.deepEqual(summarizeLatency([]), { count: 0, p50: null, p95: null });
});

test('summarizeProviders computes error rate and null when no attempts', () => {
  assert.deepEqual(
    summarizeProviders({
      sms: { errors: 2, total: 8 },
      email: { errors: 0, total: 0 },
    }),
    [
      { provider: 'email', errors: 0, total: 0, errorRate: null },
      { provider: 'sms', errors: 2, total: 8, errorRate: 0.25 },
    ],
  );
});

test('summarizeCommsHealth combines all fields from a fixed snapshot', () => {
  assert.deepEqual(summarizeCommsHealth(baseSnapshot()), {
    queuedJobs: 3,
    deadLettered: 1,
    latency: { count: 5, p50: 300, p95: 500 },
    providers: [
      { provider: 'email', errors: 0, total: 4, errorRate: 0 },
      { provider: 'sms', errors: 2, total: 8, errorRate: 0.25 },
    ],
    retries: 5,
    suppressions: 2,
    consentRefusals: 1,
  });
});

test('summarizeCommsHealth accepts zero counts and empty latency', () => {
  const result = summarizeCommsHealth({
    queuedJobs: 0,
    deadLettered: 0,
    deliveryLatenciesMs: [],
    providers: {},
    retries: 0,
    suppressions: 0,
    consentRefusals: 0,
  });
  assert.deepEqual(result.latency, { count: 0, p50: null, p95: null });
  assert.deepEqual(result.providers, []);
});

test('refuses negative counts', () => {
  const snap = baseSnapshot();
  snap.queuedJobs = -1;
  assert.throws(() => summarizeCommsHealth(snap), RangeError);
});

test('refuses non-finite counts', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    const snap = baseSnapshot();
    snap.retries = bad;
    assert.throws(() => summarizeCommsHealth(snap), RangeError);
  }
});

test('refuses negative or non-finite latencies', () => {
  assert.throws(() => summarizeLatency([100, -1]), RangeError);
  assert.throws(() => summarizeLatency([100, NaN]), RangeError);
  assert.throws(() => summarizeLatency([Infinity]), RangeError);
});

test('refuses provider errors above total attempts', () => {
  assert.throws(() => summarizeProviders({ sms: { errors: 9, total: 8 } }), RangeError);
});

test('refuses negative or non-finite provider counts', () => {
  assert.throws(() => summarizeProviders({ sms: { errors: -1, total: 8 } }), RangeError);
  assert.throws(() => summarizeProviders({ sms: { errors: 0, total: NaN } }), RangeError);
});

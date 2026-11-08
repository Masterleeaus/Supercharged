/**
 * Tests for server/workforce/portfolio/incidents.ts. Pure functions, injected time, no network, no database.
 * Run: node --test --experimental-transform-types tests/workforce/portfolio-incidents.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Test output must not go to stdout, or the test runner's IPC breaks. Silence before the server module loads.
for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
  console[method] = () => {};
}

const { classify, deduplicate, openOrUpdate, prioritise } = await import(
  '../../server/workforce/portfolio/incidents.ts'
);

const NOW = Date.UTC(2026, 10, 4, 9, 0, 0);
const HOUR = 60 * 60 * 1000;
const SYSTEMS = ['website', 'hosting', 'ssl', 'dns', 'backup', 'integration', 'security', 'data', 'maintenance'];

function obs(system, status, overrides = {}) {
  return { business_id: 'biz-a', system, status, observed_at: NOW, evidence: ['check-1'], ...overrides };
}

function caseRow(overrides = {}) {
  return {
    id: 'case-1',
    business_id: 'biz-a',
    system: 'website',
    category: 'outage',
    priority: 'critical',
    state: 'open',
    started_at: NOW,
    last_seen_at: NOW,
    resolved_at: null,
    observation_count: 1,
    evidence: ['e1'],
    updated_at: NOW,
    ...overrides,
  };
}

function signal(overrides = {}) {
  return {
    id: 'new-id',
    business_id: 'biz-a',
    system: 'website',
    category: 'outage',
    priority: 'critical',
    evidence: ['e-new'],
    observed_at: NOW,
    recovered: false,
    ...overrides,
  };
}

// ---------- classify ----------

test('unavailable live website is critical and an outage', () => {
  const c = classify(obs('website', 'unavailable'));
  assert.equal(c.priority, 'critical');
  assert.equal(c.category, 'outage');
});

test('unavailable security system is critical and a security case', () => {
  const c = classify(obs('security', 'unavailable'));
  assert.equal(c.priority, 'critical');
  assert.equal(c.category, 'security');
});

test('unavailable data or backup system is critical and a data-integrity case', () => {
  for (const system of ['data', 'backup']) {
    const c = classify(obs(system, 'unavailable'));
    assert.equal(c.priority, 'critical', system);
    assert.equal(c.category, 'data_integrity', system);
  }
});

test('degraded service is high or medium, never critical', () => {
  for (const system of SYSTEMS) {
    const c = classify(obs(system, 'degraded'));
    assert.notEqual(c.priority, 'critical', system);
    assert.ok(['high', 'medium'].includes(c.priority), system);
  }
  assert.equal(classify(obs('website', 'degraded')).priority, 'high');
  assert.equal(classify(obs('integration', 'degraded')).priority, 'medium');
  assert.equal(classify(obs('website', 'degraded')).category, 'degraded_service');
});

test('unavailable integration is high, not critical', () => {
  const c = classify(obs('integration', 'unavailable'));
  assert.equal(c.priority, 'high');
  assert.equal(c.category, 'outage');
});

test('healthy produces no case', () => {
  for (const system of SYSTEMS) {
    assert.equal(classify(obs(system, 'healthy')), null, system);
  }
});

test('unknown is a monitoring gap, not an outage or degraded service, and never critical', () => {
  for (const system of SYSTEMS) {
    const c = classify(obs(system, 'unknown'));
    assert.equal(c.category, 'monitoring_gap', system);
    assert.notEqual(c.category, 'outage', system);
    assert.notEqual(c.category, 'degraded_service', system);
    assert.notEqual(c.priority, 'critical', system);
  }
});

test('an unrecognised status is treated as a monitoring gap, never healthy or a failure', () => {
  const c = classify(obs('website', 'weird'));
  assert.equal(c.category, 'monitoring_gap');
  assert.equal(c.reason, 'unrecognised_status');
});

// ---------- deduplicate ----------

test('duplicates with the same business, system and category merge inside the window', () => {
  const first = caseRow({ id: 'b', started_at: NOW, last_seen_at: NOW, observation_count: 2, evidence: ['old'], priority: 'high' });
  const second = caseRow({
    id: 'a',
    started_at: NOW + HOUR / 2,
    last_seen_at: NOW + HOUR / 2,
    observation_count: 3,
    evidence: ['latest'],
    priority: 'critical',
  });
  const merged = deduplicate([second, first], NOW + HOUR, HOUR);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'b', 'the earliest-start case keeps its id');
  assert.equal(merged[0].started_at, NOW);
  assert.equal(merged[0].observation_count, 5);
  assert.deepEqual(merged[0].evidence, ['latest']);
  assert.equal(merged[0].priority, 'critical');
});

test('duplicates outside the window do not merge', () => {
  const early = caseRow({ id: 'early', started_at: NOW });
  const late = caseRow({ id: 'late', started_at: NOW + 2 * HOUR, last_seen_at: NOW + 2 * HOUR });
  const result = deduplicate([early, late], NOW + 3 * HOUR, HOUR);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((c) => c.id), ['early', 'late']);
});

test('cases with a different business, system or category do not merge', () => {
  const a = caseRow({ id: 'a' });
  const otherBusiness = caseRow({ id: 'b', business_id: 'biz-b' });
  const otherSystem = caseRow({ id: 'c', system: 'hosting' });
  const otherCategory = caseRow({ id: 'd', category: 'degraded_service' });
  const result = deduplicate([a, otherBusiness, otherSystem, otherCategory], NOW, HOUR);
  assert.equal(result.length, 4);
});

test('a case dated after now is not merged and passes through unchanged', () => {
  const past = caseRow({ id: 'past', started_at: NOW });
  const future = caseRow({ id: 'future', started_at: NOW + 60_000 });
  const result = deduplicate([past, future], NOW, HOUR);
  assert.equal(result.length, 2);
  assert.equal(result.find((c) => c.id === 'future').observation_count, 1);
});

test('deduplicate refuses a negative or non-finite window', () => {
  assert.throws(() => deduplicate([], NOW, -1), TypeError);
  assert.throws(() => deduplicate([], NOW, Number.NaN), TypeError);
});

// ---------- openOrUpdate ----------

test('a new failure with no existing case creates an open case', () => {
  const result = openOrUpdate(null, signal({ id: 'case-9' }), NOW);
  assert.equal(result.action, 'create');
  assert.equal(result.case.id, 'case-9');
  assert.equal(result.case.state, 'open');
  assert.equal(result.case.observation_count, 1);
  assert.equal(result.case.started_at, NOW);
});

test('a recovery with no existing case creates nothing', () => {
  const result = openOrUpdate(null, signal({ recovered: true }), NOW);
  assert.equal(result.action, 'none');
});

test('the same failure while open updates the case and keeps its start and state', () => {
  const existing = caseRow({ started_at: NOW - HOUR, last_seen_at: NOW - HOUR, observation_count: 2, priority: 'high', state: 'acknowledged' });
  const result = openOrUpdate(existing, signal({ priority: 'critical', observed_at: NOW }), NOW);
  assert.equal(result.action, 'update');
  assert.equal(result.case.state, 'acknowledged');
  assert.equal(result.case.started_at, NOW - HOUR);
  assert.equal(result.case.observation_count, 3);
  assert.equal(result.case.priority, 'critical');
  assert.deepEqual(result.case.evidence, ['e-new']);
});

test('a recovery resolves an open case', () => {
  const result = openOrUpdate(caseRow({ state: 'open' }), signal({ recovered: true, evidence: ['up'] }), NOW + HOUR);
  assert.equal(result.action, 'update');
  assert.equal(result.case.state, 'resolved');
  assert.equal(result.case.resolved_at, NOW + HOUR);
});

test('a resolved case reopens when the same failure reappears', () => {
  const resolved = caseRow({ state: 'resolved', resolved_at: NOW, started_at: NOW - 2 * HOUR, observation_count: 4 });
  const result = openOrUpdate(resolved, signal({ observed_at: NOW + HOUR }), NOW + HOUR);
  assert.equal(result.action, 'update');
  assert.equal(result.case.state, 'open');
  assert.equal(result.case.resolved_at, null);
  assert.equal(result.case.started_at, NOW + HOUR, 'a reopened case starts a new episode');
  assert.equal(result.case.observation_count, 5);
});

test('a failure observed before the resolution does not reopen the case', () => {
  const resolved = caseRow({ state: 'resolved', resolved_at: NOW });
  const result = openOrUpdate(resolved, signal({ observed_at: NOW - 1000 }), NOW);
  assert.equal(result.action, 'none');
  assert.equal(result.case.state, 'resolved');
});

test('an existing case and a signal for a different key are refused', () => {
  assert.throws(() => openOrUpdate(caseRow({ system: 'hosting' }), signal({ system: 'website' }), NOW), TypeError);
});

// ---------- prioritise ----------

test('prioritise orders critical, high, medium, low, then business, then start time', () => {
  const rows = [
    caseRow({ id: 'low-1', priority: 'low', business_id: 'biz-a', started_at: NOW }),
    caseRow({ id: 'high-b', priority: 'high', business_id: 'biz-b', started_at: NOW }),
    caseRow({ id: 'crit-b', priority: 'critical', business_id: 'biz-b', started_at: NOW + 5 }),
    caseRow({ id: 'crit-a-late', priority: 'critical', business_id: 'biz-a', started_at: NOW + 9 }),
    caseRow({ id: 'crit-a-early', priority: 'critical', business_id: 'biz-a', started_at: NOW + 1 }),
    caseRow({ id: 'med-a', priority: 'medium', business_id: 'biz-a', started_at: NOW }),
  ];
  const ids = prioritise(rows).map((c) => c.id);
  assert.deepEqual(ids, ['crit-a-early', 'crit-a-late', 'crit-b', 'high-b', 'med-a', 'low-1']);
});

test('prioritise is stable for equal keys and does not change its input', () => {
  const rows = [
    caseRow({ id: 'first', business_id: 'biz-a', started_at: NOW, priority: 'high' }),
    caseRow({ id: 'second', business_id: 'biz-a', started_at: NOW, priority: 'high' }),
    caseRow({ id: 'third', business_id: 'biz-a', started_at: NOW, priority: 'high' }),
  ];
  const snapshot = rows.map((c) => c.id);
  const ids = prioritise(rows).map((c) => c.id);
  assert.deepEqual(ids, ['first', 'second', 'third']);
  assert.deepEqual(prioritise(rows).map((c) => c.id), ids, 'repeated calls give the same order');
  assert.deepEqual(rows.map((c) => c.id), snapshot);
});

/**
 * Tests for server/workforce/portfolio/briefing.ts. Fake records only, injected clock, no network, no database.
 * Run: node --test --experimental-transform-types tests/workforce/portfolio-briefing.test.mjs
 */
// Silence console output: the test runner's IPC breaks if a test writes to stdout.
for (const m of ['log', 'info', 'warn', 'error']) console[m] = () => {};

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDirectorBriefing } from '../../server/workforce/portfolio/briefing.ts';
import { BRIEFING_SECTION_KEYS } from '../../server/workforce/portfolio/briefing-types.ts';

const NOW = new Date('2026-11-04T10:00:00.000Z');
const EMPTY = {
  health: [],
  cases: [],
  decisions: [],
  receipts: [],
  workforceRuns: [],
  supportRequests: [],
  setups: [],
  improvements: [],
  commercialFigures: [],
};

const section = (briefing, key) => briefing.sections.find((s) => s.key === key);
const itemsOf = (briefing, key) => section(briefing, key).items;

test('sections appear in the required order with the required keys', () => {
  const briefing = buildDirectorBriefing({ now: NOW, ...EMPTY });
  assert.deepEqual(
    briefing.sections.map((s) => s.key),
    [
      'portfolio_health',
      'critical_exceptions',
      'approvals',
      'customer_support',
      'customer_success',
      'improvement_opportunities',
      'workforce_performance',
      'commercial_health',
    ],
  );
  assert.deepEqual(
    briefing.sections.map((s) => s.key),
    [...BRIEFING_SECTION_KEYS],
  );
  assert.deepEqual(
    briefing.sections.map((s) => s.title),
    [
      'Portfolio Health',
      'Critical Exceptions',
      'Approvals',
      'Customer Support',
      'Customer Success',
      'Improvement Opportunities',
      'Workforce Performance',
      'Commercial Health',
    ],
  );
});

test('unknown health is counted separately and never folded into healthy', () => {
  const briefing = buildDirectorBriefing({
    now: NOW,
    ...EMPTY,
    health: [
      { id: 'sys-1', status: 'healthy' },
      { id: 'sys-2', status: 'unknown' },
      { id: 'sys-3', status: 'stale-telemetry-value' },
      { id: 'sys-4', status: 'degraded', reason: 'SSL expires in 3 days' },
      { id: 'sys-5', status: 'unavailable', reason: 'Booking provider timeout' },
      { id: 'sys-6', status: '' },
    ],
  });
  const health = section(briefing, 'portfolio_health');
  assert.equal(health.state, 'populated');
  assert.deepEqual(
    { healthy: health.counts.healthy, unknown: health.counts.unknown, degraded: health.counts.degraded, unavailable: health.counts.unavailable },
    { healthy: 1, unknown: 3, degraded: 1, unavailable: 1 },
  );
  const unknownIds = health.items.filter((i) => i.flag === 'unknown').map((i) => i.recordId);
  assert.deepEqual(unknownIds, ['sys-2', 'sys-3', 'sys-6']);
  assert.equal(health.items.some((i) => i.recordId === 'sys-1'), false, 'a healthy system is not listed as an item');
  assert.match(health.summary, /Unknown systems are not counted as healthy/);
});

test('a completed run without a verified receipt is not reported as completed', () => {
  const briefing = buildDirectorBriefing({
    now: NOW,
    ...EMPTY,
    workforceRuns: [
      { id: 'run-1', status: 'completed' },
      { id: 'run-2', status: 'completed' },
    ],
    receipts: [
      { id: 'rcpt-2', runId: 'run-2', outcome: 'succeeded', verified: true },
      { id: 'rcpt-3', runId: 'run-3', outcome: 'succeeded', verified: false },
    ],
  });
  const perf = section(briefing, 'workforce_performance');
  assert.equal(perf.counts.completed, 1, 'only the verified receipt counts as completed');
  assert.equal(perf.counts.notVerified, 2, 'run-1 and rcpt-3 are not verified');

  const unverifiedRun = perf.items.find((i) => i.recordId === 'run-1');
  assert.equal(unverifiedRun.flag, 'not_verified');
  assert.doesNotMatch(unverifiedRun.text, /Action completed/);

  const completed = perf.items.filter((i) => i.text === 'Action completed (verified receipt)');
  assert.deepEqual(completed.map((i) => i.recordId), ['rcpt-2']);
  assert.equal(
    perf.items.some((i) => i.recordId === 'rcpt-3' && i.text.startsWith('Action completed')),
    false,
    'an unverified success receipt is not reported as completed',
  );
});

test('a failed action shows its failure reason', () => {
  const briefing = buildDirectorBriefing({
    now: NOW,
    ...EMPTY,
    workforceRuns: [
      { id: 'run-f', status: 'failed' },
      { id: 'run-g', status: 'failed', reason: 'Missing DirectAdmin credentials' },
    ],
    receipts: [{ id: 'rcpt-f', runId: 'run-f', outcome: 'failed', verified: true, reason: 'Provider timeout after 30s' }],
  });
  const perf = section(briefing, 'workforce_performance');
  assert.equal(perf.counts.failed, 2);

  const fromReceipt = perf.items.find((i) => i.recordId === 'rcpt-f');
  assert.equal(fromReceipt.flag, 'failed');
  assert.match(fromReceipt.detail, /Provider timeout after 30s/);

  const fromRun = perf.items.find((i) => i.recordId === 'run-g');
  assert.equal(fromRun.flag, 'failed');
  assert.match(fromRun.detail, /Missing DirectAdmin credentials/);

  assert.equal(perf.items.some((i) => i.recordId === 'run-f'), false, 'a run already covered by a failed receipt is not listed twice');
});

test('overdue support requests are decided by the injected clock', () => {
  const requests = [
    { id: 'req-1', title: 'Cannot log in', status: 'open', dueAt: '2026-11-04T09:00:00.000Z' },
    { id: 'req-2', title: 'Invoice question', status: 'open', dueAt: '2026-11-04T12:00:00.000Z' },
    { id: 'req-3', title: 'Closed already', status: 'resolved', dueAt: '2026-11-01T00:00:00.000Z' },
    { id: 'req-4', title: 'Bad due time', status: 'open', dueAt: 'not-a-date' },
  ];

  const before = buildDirectorBriefing({ now: new Date('2026-11-04T08:00:00.000Z'), ...EMPTY, supportRequests: requests });
  assert.equal(section(before, 'customer_support').counts.overdue, 0);

  const after = buildDirectorBriefing({ now: new Date('2026-11-04T10:00:00.000Z'), ...EMPTY, supportRequests: requests });
  const support = section(after, 'customer_support');
  assert.equal(support.counts.unresolved, 3, 'resolved requests are excluded');
  assert.equal(support.counts.overdue, 1);
  assert.equal(support.counts.dueUnreadable, 1);

  const overdue = support.items.find((i) => i.flag === 'overdue');
  assert.equal(overdue.recordId, 'req-1');
  assert.equal(support.items[0].recordId, 'req-1', 'overdue requests are listed first');

  const unreadable = support.items.find((i) => i.recordId === 'req-4');
  assert.equal(unreadable.flag, 'unknown', 'an unreadable due time is not treated as overdue');
});

test('empty input is labelled empty and shows no counts', () => {
  const briefing = buildDirectorBriefing({ now: NOW, ...EMPTY });
  assert.equal(briefing.isEmpty, true);
  assert.match(briefing.notice, /^Empty input: no records were supplied/);
  for (const s of briefing.sections) {
    assert.equal(s.state, 'empty', `${s.key} should be empty`);
    assert.deepEqual(s.counts, {});
    assert.deepEqual(s.items, []);
    assert.match(s.summary, /Nothing is verified/);
  }
});

test('input with no arrays at all is empty and not available, not zero', () => {
  const briefing = buildDirectorBriefing({ now: NOW });
  assert.equal(briefing.isEmpty, true);
  assert.ok(briefing.sections.every((s) => s.state === 'not_available'));
  assert.ok(briefing.sections.every((s) => Object.keys(s.counts).length === 0));
});

test('a missing input array is reported as not available for its section only', () => {
  const { supportRequests, ...rest } = EMPTY;
  const briefing = buildDirectorBriefing({
    now: NOW,
    ...rest,
    health: [{ id: 'sys-1', status: 'healthy' }],
  });
  assert.equal(briefing.isEmpty, false);
  assert.equal(section(briefing, 'customer_support').state, 'not_available');
  assert.equal(section(briefing, 'portfolio_health').state, 'populated');
  assert.match(briefing.notice, /Not available from current data: Customer Support\./);
});

test('every item carries the id of a source record', () => {
  const briefing = buildDirectorBriefing({
    now: NOW,
    health: [
      { id: 'sys-a', status: 'unavailable', reason: 'down' },
      { id: 'sys-b', status: 'mystery' },
    ],
    cases: [{ id: 'case-1', title: 'Gateway down', severity: 'high', state: 'open', category: 'outage' }],
    decisions: [{ id: 'dec-1', status: 'awaiting_approval', priority: 'high', issue: 'Reconnect booking', approvalAuthority: 'managed_service_operator' }],
    receipts: [{ id: 'rcpt-1', runId: 'run-1', outcome: 'succeeded', verified: true }],
    workforceRuns: [{ id: 'run-1', status: 'completed' }, { id: 'run-2', status: 'retried' }],
    supportRequests: [{ id: 'req-1', title: 'Help', status: 'open', dueAt: '2026-11-03T00:00:00.000Z' }],
    setups: [{ id: 'biz-1', setupComplete: false }],
    improvements: [{ id: 'imp-1', title: 'Raise weekend rate', category: 'pricing' }],
    commercialFigures: [{ id: 'fig-1', label: 'Hosting cost', value: 120, risk: 'Above plan' }],
  });
  const knownIds = new Set(['sys-a', 'sys-b', 'case-1', 'dec-1', 'rcpt-1', 'run-1', 'run-2', 'req-1', 'biz-1', 'imp-1', 'fig-1']);
  let count = 0;
  for (const s of briefing.sections) {
    for (const item of s.items) {
      count += 1;
      assert.equal(typeof item.recordId, 'string');
      assert.ok(knownIds.has(item.recordId), `unknown recordId ${item.recordId} in ${s.key}`);
    }
  }
  assert.ok(count >= 10, 'the fixture should produce items in most sections');
});

test('records without a usable id are excluded and the exclusion is stated', () => {
  const briefing = buildDirectorBriefing({
    now: NOW,
    ...EMPTY,
    health: [{ status: 'healthy' }, { id: '   ', status: 'degraded' }, { id: 'sys-ok', status: 'healthy' }],
  });
  const health = section(briefing, 'portfolio_health');
  assert.equal(health.counts.total, 1);
  assert.equal(health.counts.healthy, 1);
  assert.match(briefing.notice, /2 record\(s\) without a usable id were excluded\./);
});

test('critical exceptions include open critical-category cases and exclude finished ones', () => {
  const briefing = buildDirectorBriefing({
    now: NOW,
    ...EMPTY,
    cases: [
      { id: 'case-1', title: 'Site down', severity: 'low', state: 'open', category: 'outage' },
      { id: 'case-2', title: 'Backup failed', severity: 'medium', state: 'open', category: 'data_integrity' },
      { id: 'case-3', title: 'Old outage', severity: 'critical', state: 'resolved', category: 'outage' },
      { id: 'case-4', title: 'Minor typo', severity: 'low', state: 'open', category: 'content' },
    ],
  });
  const exceptions = section(briefing, 'critical_exceptions');
  assert.deepEqual(exceptions.items.map((i) => i.recordId), ['case-1', 'case-2']);
  assert.equal(exceptions.counts.active, 3);
});

test('approvals list only awaiting decisions, by priority, without claiming approval', () => {
  const briefing = buildDirectorBriefing({
    now: NOW,
    ...EMPTY,
    decisions: [
      { id: 'dec-low', status: 'awaiting_approval', priority: 'low', issue: 'Low' },
      { id: 'dec-done', status: 'approved', priority: 'critical', issue: 'Done' },
      { id: 'dec-high', status: 'awaiting_approval', priority: 'high', issue: 'High' },
    ],
  });
  const approvals = section(briefing, 'approvals');
  assert.deepEqual(approvals.items.map((i) => i.recordId), ['dec-high', 'dec-low']);
  assert.equal(approvals.counts.awaiting, 2);
  assert.match(approvals.summary, /Listing a decision does not approve it/);
});

test('an invalid clock is refused', () => {
  assert.throws(() => buildDirectorBriefing({ now: new Date('nope'), ...EMPTY }), TypeError);
});

// Segment module tests (node:test). Pure functions only: no database, no network, no clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defineSegment, evaluateSegment } from '../../server/modules/comms/segments.ts';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-11-03T12:00:00Z';
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.parse(NOW) - n * DAY).toISOString();

const contact = (overrides = {}) => ({
  id: 'c1',
  companyId: COMPANY,
  tags: ['vip', 'pool'],
  lifecycle: 'customer',
  lastEngagementAt: daysAgo(3),
  consent: { email: true, sms: false },
  ...overrides,
});

function seg(rules, companyId = COMPANY) {
  const r = defineSegment({ companyId, name: 'test segment', rules });
  assert.equal(r.ok, true, `expected segment to define: ${r.message ?? ''}`);
  return r.segment;
}

function ids(list) {
  return list.map((c) => c.id);
}

test('defineSegment accepts a valid segment and returns it frozen', () => {
  const r = defineSegment({ companyId: COMPANY, name: 'Active', rules: [{ field: 'tag', op: 'has', value: 'vip' }] });
  assert.equal(r.ok, true);
  assert.equal(r.segment.companyId, COMPANY);
  assert.equal(Object.isFrozen(r.segment), true);
  assert.equal(Object.isFrozen(r.segment.rules), true);
});

test('tag has rule matches contacts carrying the tag and rejects others', () => {
  const s = seg([{ field: 'tag', op: 'has', value: 'vip' }]);
  const out = evaluateSegment(s, [contact({ id: 'yes' }), contact({ id: 'no', tags: ['pool'] })], { now: NOW });
  assert.deepEqual(ids(out), ['yes']);
});

test('lifecycle eq rule matches only the exact stage', () => {
  const s = seg([{ field: 'lifecycle', op: 'eq', value: 'customer' }]);
  const out = evaluateSegment(s, [contact({ id: 'yes' }), contact({ id: 'no', lifecycle: 'lead' })], { now: NOW });
  assert.deepEqual(ids(out), ['yes']);
});

test('lastEngagementDays lte matches engagement within the window, measured from now', () => {
  const s = seg([{ field: 'lastEngagementDays', op: 'lte', value: 7 }]);
  const list = [
    contact({ id: 'recent', lastEngagementAt: daysAgo(2) }),
    contact({ id: 'edge', lastEngagementAt: daysAgo(7) }),
    contact({ id: 'stale', lastEngagementAt: daysAgo(30) }),
  ];
  assert.deepEqual(ids(evaluateSegment(s, list, { now: NOW })), ['recent', 'edge']);
});

test('lastEngagementDays gte matches engagement at least that old', () => {
  const s = seg([{ field: 'lastEngagementDays', op: 'gte', value: 30 }]);
  const list = [
    contact({ id: 'recent', lastEngagementAt: daysAgo(2) }),
    contact({ id: 'lapsed', lastEngagementAt: daysAgo(45) }),
  ];
  assert.deepEqual(ids(evaluateSegment(s, list, { now: NOW })), ['lapsed']);
});

test('engagement days move with the now passed in', () => {
  const s = seg([{ field: 'lastEngagementDays', op: 'lte', value: 7 }]);
  const c = contact({ id: 'x', lastEngagementAt: daysAgo(3) });
  assert.equal(evaluateSegment(s, [c], { now: NOW }).length, 1);
  const later = new Date(Date.parse(NOW) + 10 * DAY);
  assert.equal(evaluateSegment(s, [c], { now: later }).length, 0);
});

test('consent opted_in rule matches only a true consent for the named channel', () => {
  const email = seg([{ field: 'consent', op: 'opted_in', channel: 'email' }]);
  const sms = seg([{ field: 'consent', op: 'opted_in', channel: 'sms' }]);
  const list = [contact({ id: 'c' })];
  assert.deepEqual(ids(evaluateSegment(email, list, { now: NOW })), ['c']);
  assert.deepEqual(ids(evaluateSegment(sms, list, { now: NOW })), []);
});

test('all rules must match for a contact to be included', () => {
  const s = seg([
    { field: 'tag', op: 'has', value: 'vip' },
    { field: 'lifecycle', op: 'eq', value: 'customer' },
    { field: 'lastEngagementDays', op: 'lte', value: 7 },
    { field: 'consent', op: 'opted_in', channel: 'email' },
  ]);
  const list = [
    contact({ id: 'all' }),
    contact({ id: 'no-tag', tags: ['pool'] }),
    contact({ id: 'wrong-stage', lifecycle: 'lead' }),
    contact({ id: 'stale', lastEngagementAt: daysAgo(20) }),
    contact({ id: 'no-consent', consent: { email: false } }),
  ];
  assert.deepEqual(ids(evaluateSegment(s, list, { now: NOW })), ['all']);
});

test('contacts from another company are excluded even when every rule matches', () => {
  const s = seg([{ field: 'tag', op: 'has', value: 'vip' }]);
  const list = [contact({ id: 'mine' }), contact({ id: 'theirs', companyId: OTHER })];
  assert.deepEqual(ids(evaluateSegment(s, list, { now: NOW })), ['mine']);
});

test('a missing tags field fails the tag rule', () => {
  const s = seg([{ field: 'tag', op: 'has', value: 'vip' }]);
  const { tags, ...noTags } = contact({ id: 'x' });
  assert.deepEqual(ids(evaluateSegment(s, [noTags], { now: NOW })), []);
});

test('a missing lifecycle fails the lifecycle rule', () => {
  const s = seg([{ field: 'lifecycle', op: 'eq', value: 'customer' }]);
  const { lifecycle, ...noStage } = contact({ id: 'x' });
  assert.deepEqual(ids(evaluateSegment(s, [noStage], { now: NOW })), []);
});

test('a missing lastEngagementAt fails both lte and gte engagement rules', () => {
  const { lastEngagementAt, ...noEngagement } = contact({ id: 'x' });
  const lte = seg([{ field: 'lastEngagementDays', op: 'lte', value: 1000 }]);
  const gte = seg([{ field: 'lastEngagementDays', op: 'gte', value: 0 }]);
  assert.deepEqual(ids(evaluateSegment(lte, [noEngagement], { now: NOW })), []);
  assert.deepEqual(ids(evaluateSegment(gte, [noEngagement], { now: NOW })), []);
});

test('an unreadable lastEngagementAt fails the engagement rule', () => {
  const s = seg([{ field: 'lastEngagementDays', op: 'lte', value: 1000 }]);
  assert.deepEqual(ids(evaluateSegment(s, [contact({ id: 'x', lastEngagementAt: 'not a date' })], { now: NOW })), []);
});

test('a missing consent map or missing channel fails the consent rule', () => {
  const s = seg([{ field: 'consent', op: 'opted_in', channel: 'whatsapp' }]);
  const list = [contact({ id: 'no-map', consent: undefined }), contact({ id: 'no-channel' })];
  assert.deepEqual(ids(evaluateSegment(s, list, { now: NOW })), []);
});

test('defineSegment refuses a segment with no rules', () => {
  const empty = defineSegment({ companyId: COMPANY, name: 'x', rules: [] });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'invalid_segment');
  assert.equal(defineSegment({ companyId: COMPANY, name: 'x' }).reason, 'invalid_segment');
});

test('defineSegment refuses an unknown field', () => {
  const r = defineSegment({ companyId: COMPANY, name: 'x', rules: [{ field: 'postcode', op: 'eq', value: '3000' }] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid_segment');
});

test('defineSegment refuses an unknown op for a known field', () => {
  const cases = [
    { field: 'tag', op: 'eq', value: 'vip' },
    { field: 'lifecycle', op: 'has', value: 'customer' },
    { field: 'lastEngagementDays', op: 'eq', value: 5 },
    { field: 'consent', op: 'opted_out', channel: 'email' },
  ];
  for (const rule of cases) {
    const r = defineSegment({ companyId: COMPANY, name: 'x', rules: [rule] });
    assert.equal(r.reason, 'invalid_segment', JSON.stringify(rule));
  }
});

test('defineSegment refuses malformed rule values and channels', () => {
  const bad = [
    { field: 'tag', op: 'has', value: '' },
    { field: 'lifecycle', op: 'eq', value: 42 },
    { field: 'lastEngagementDays', op: 'lte', value: -1 },
    { field: 'lastEngagementDays', op: 'gte', value: Number.NaN },
    { field: 'consent', op: 'opted_in', channel: 'pigeon' },
    null,
  ];
  for (const rule of bad) {
    const r = defineSegment({ companyId: COMPANY, name: 'x', rules: [rule] });
    assert.equal(r.reason, 'invalid_segment', JSON.stringify(rule));
  }
});

test('defineSegment refuses a segment with no name', () => {
  const r = defineSegment({ companyId: COMPANY, name: '  ', rules: [{ field: 'tag', op: 'has', value: 'vip' }] });
  assert.equal(r.reason, 'invalid_segment');
});

test('defineSegment refuses a non-UUID companyId', () => {
  const rules = [{ field: 'tag', op: 'has', value: 'vip' }];
  for (const companyId of ['acme', '', 42, null, undefined, '11111111-1111-4111-8111-11111111111']) {
    const r = defineSegment({ companyId, name: 'x', rules });
    assert.equal(r.ok, false, String(companyId));
    assert.equal(r.reason, 'invalid_company', String(companyId));
  }
  assert.equal(defineSegment(undefined).reason, 'invalid_company');
});

test('evaluateSegment returns nothing for a segment not made by defineSegment', () => {
  const hand = { companyId: COMPANY, name: 'x', rules: [{ field: 'tag', op: 'has', value: 'vip' }] };
  assert.deepEqual(evaluateSegment(hand, [contact({ id: 'x' })], { now: NOW }), []);
});

test('evaluateSegment returns nothing for an unreadable now', () => {
  const s = seg([{ field: 'tag', op: 'has', value: 'vip' }]);
  assert.deepEqual(evaluateSegment(s, [contact({ id: 'x' })], { now: 'soon' }), []);
});

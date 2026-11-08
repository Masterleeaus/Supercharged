import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseAssignee, WORKLOAD_REASON } from '../../server/modules/comms/workload.ts';

// Pure logic only. No network, no database.

const CO = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const person = (id, overrides = {}) => ({
  id,
  companyId: CO,
  available: true,
  maxOpen: 5,
  channels: ['email'],
  ...overrides,
});

const thread = (id, assigneeId, overrides = {}) => ({
  id,
  companyId: CO,
  assigneeId,
  channel: 'email',
  ...overrides,
});

test('the least-loaded candidate is chosen', () => {
  const result = chooseAssignee({
    companyId: CO,
    staff: [person('s-a'), person('s-b'), person('s-c')],
    openThreads: [thread('t1', 's-a'), thread('t2', 's-a'), thread('t3', 's-b')],
  });
  assert.deepEqual(result, { ok: true, assigneeId: 's-c', reason: WORKLOAD_REASON.leastLoaded });
});

test('an unavailable person is skipped even when they carry no load', () => {
  const result = chooseAssignee({
    companyId: CO,
    staff: [person('s-a', { available: false }), person('s-b')],
    openThreads: [thread('t1', 's-b')],
  });
  assert.equal(result.ok, true);
  assert.equal(result.assigneeId, 's-b');
});

test('a person at maxOpen is skipped', () => {
  const result = chooseAssignee({
    companyId: CO,
    staff: [person('s-a', { maxOpen: 2 }), person('s-b', { maxOpen: 2 })],
    openThreads: [thread('t1', 's-a'), thread('t2', 's-a'), thread('t3', 's-b')],
  });
  assert.equal(result.ok, true);
  assert.equal(result.assigneeId, 's-b');
});

test('a person with one slot left is still a candidate', () => {
  const result = chooseAssignee({
    companyId: CO,
    staff: [person('s-a', { maxOpen: 2 }), person('s-b', { maxOpen: 9 })],
    openThreads: [thread('t1', 's-a'), thread('t2', 's-b'), thread('t3', 's-b')],
  });
  assert.equal(result.assigneeId, 's-a');
});

test('channel preference: a staff member with the channel is chosen over a less-loaded one without it', () => {
  const result = chooseAssignee({
    companyId: CO,
    channel: 'sms',
    staff: [person('s-a', { channels: ['email'] }), person('s-b', { channels: ['email', 'sms'] })],
    openThreads: [thread('t1', 's-b')],
  });
  assert.deepEqual(result, { ok: true, assigneeId: 's-b', reason: WORKLOAD_REASON.channelMatch });
});

test('channel preference is applied before load: a full channel-holder is not chosen', () => {
  const result = chooseAssignee({
    companyId: CO,
    channel: 'sms',
    staff: [person('s-a', { channels: ['sms'], maxOpen: 1 }), person('s-b', { channels: ['email'] })],
    openThreads: [thread('t1', 's-a')],
  });
  assert.equal(result.ok, true);
  assert.equal(result.assigneeId, 's-b');
  assert.equal(result.reason, WORKLOAD_REASON.channelFallback);
});

test('channel fallback: no one has the channel, so any candidate is chosen and the reason says so', () => {
  const result = chooseAssignee({
    companyId: CO,
    channel: 'whatsapp',
    staff: [person('s-a', { channels: ['email'] }), person('s-b', { channels: ['sms'] })],
    openThreads: [thread('t1', 's-a')],
  });
  assert.deepEqual(result, { ok: true, assigneeId: 's-b', reason: WORKLOAD_REASON.channelFallback });
  assert.match(result.reason, /fallback/);
});

test('no channel given: no channel reason is reported', () => {
  const result = chooseAssignee({
    companyId: CO,
    staff: [person('s-a')],
    openThreads: [],
  });
  assert.deepEqual(result, { ok: true, assigneeId: 's-a', reason: WORKLOAD_REASON.leastLoaded });
});

test('deterministic tie-break: equal load goes to the smaller id, regardless of list order', () => {
  const ordered = chooseAssignee({
    companyId: CO,
    staff: [person('s-b'), person('s-a'), person('s-c')],
    openThreads: [],
  });
  const reversed = chooseAssignee({
    companyId: CO,
    staff: [person('s-c'), person('s-a'), person('s-b')],
    openThreads: [],
  });
  assert.equal(ordered.assigneeId, 's-a');
  assert.equal(reversed.assigneeId, 's-a');
});

test('deterministic tie-break applies within the channel pool too', () => {
  const result = chooseAssignee({
    companyId: CO,
    channel: 'email',
    staff: [person('s-z'), person('s-m'), person('s-x', { channels: ['sms'] })],
    openThreads: [],
  });
  assert.equal(result.assigneeId, 's-m');
});

test('another company is ignored: its staff are not candidates and its threads do not add load', () => {
  const result = chooseAssignee({
    companyId: CO,
    staff: [
      person('s-a'),
      person('s-foreign', { companyId: OTHER }),
    ],
    openThreads: [
      thread('t1', 's-a'),
      thread('t2', 's-a', { companyId: OTHER }),
      thread('t3', 's-a', { companyId: OTHER }),
    ],
  });
  assert.deepEqual(result, { ok: true, assigneeId: 's-a', reason: WORKLOAD_REASON.leastLoaded });
});

test('another company is ignored: a foreign thread assigned to a local person does not count against them', () => {
  const result = chooseAssignee({
    companyId: CO,
    staff: [person('s-a'), person('s-b')],
    openThreads: [
      thread('t1', 's-a'),
      thread('t2', 's-a', { companyId: OTHER }),
      thread('t3', 's-a', { companyId: OTHER }),
    ],
  });
  assert.equal(result.assigneeId, 's-b');
});

test('no candidates returns no_available_staff', () => {
  assert.deepEqual(
    chooseAssignee({
      companyId: CO,
      staff: [person('s-a', { available: false }), person('s-b', { maxOpen: 1 }), person('s-c', { companyId: OTHER })],
      openThreads: [thread('t1', 's-b')],
    }),
    { ok: false, reason: 'no_available_staff' },
  );
});

test('empty staff list returns no_available_staff', () => {
  assert.deepEqual(
    chooseAssignee({ companyId: CO, staff: [], openThreads: [] }),
    { ok: false, reason: 'no_available_staff' },
  );
});

test('invalid company is refused', () => {
  const staff = [person('s-a')];
  for (const bad of ['not-a-uuid', '', 'CO-1', '11111111-1111-4111-8111-11111111111', undefined, null, 42]) {
    assert.deepEqual(
      chooseAssignee({ companyId: bad, staff, openThreads: [] }),
      { ok: false, reason: 'invalid_company' },
      `companyId ${String(bad)} should be refused`,
    );
  }
});

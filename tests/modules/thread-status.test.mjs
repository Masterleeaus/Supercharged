// Thread status transition tests (node:test). Pure functions: no store, no clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  transitionThread,
  autoWake,
  SYSTEM_ACTOR_ID,
} from '../../server/modules/inbox/thread-status.ts';

const CO = '11111111-1111-4111-8111-111111111111';
const HUMAN = 'staff-1';
const AGENT = 'agent:triage';
const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-11-03T10:00:00Z');
const LATER = new Date(NOW.getTime() + HOUR);
const PAST = new Date(NOW.getTime() - HOUR);

function thread(overrides = {}) {
  return {
    companyId: CO,
    id: 't-1',
    channel: 'email',
    subject: 'Quote request',
    status: 'open',
    assignee: null,
    lastMessageAt: NOW,
    createdAt: PAST,
    updatedAt: PAST,
    snoozeUntil: null,
    statusHistory: [],
    ...overrides,
  };
}

function snoozed(overrides = {}) {
  return thread({ status: 'snoozed', snoozeUntil: LATER, ...overrides });
}

function closed(overrides = {}) {
  return thread({ status: 'closed', ...overrides });
}

test('open to snoozed by a human with a future snoozeUntil', () => {
  const r = transitionThread({ thread: thread(), to: 'snoozed', actorId: HUMAN, now: NOW, snoozeUntil: LATER });
  assert.equal(r.ok, true);
  assert.equal(r.thread.status, 'snoozed');
  assert.equal(r.thread.snoozeUntil.getTime(), LATER.getTime());
});

test('open to closed by a human', () => {
  const r = transitionThread({ thread: thread(), to: 'closed', actorId: HUMAN, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.thread.status, 'closed');
  assert.equal(r.thread.snoozeUntil, null);
});

test('snoozed to open by a human (manual wake) clears snoozeUntil', () => {
  const r = transitionThread({ thread: snoozed(), to: 'open', actorId: HUMAN, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.thread.status, 'open');
  assert.equal(r.thread.snoozeUntil, null);
});

test('snoozed to closed by a human', () => {
  const r = transitionThread({ thread: snoozed(), to: 'closed', actorId: HUMAN, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.thread.status, 'closed');
  assert.equal(r.thread.snoozeUntil, null);
});

test('closed to open by a human (reopen)', () => {
  const r = transitionThread({ thread: closed(), to: 'open', actorId: HUMAN, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.thread.status, 'open');
});

test('refuses pairs outside the table as invalid_transition', () => {
  const cases = [
    [thread({ status: 'open' }), 'open'],
    [snoozed(), 'snoozed'],
    [closed(), 'closed'],
    [closed(), 'snoozed'],
  ];
  for (const [t, to] of cases) {
    const r = transitionThread({ thread: t, to, actorId: HUMAN, now: NOW, snoozeUntil: LATER });
    assert.deepEqual(r, { ok: false, reason: 'invalid_transition' }, `${t.status} -> ${to}`);
  }
});

test('snooze must be in the future', () => {
  const past = transitionThread({ thread: thread(), to: 'snoozed', actorId: HUMAN, now: NOW, snoozeUntil: PAST });
  assert.deepEqual(past, { ok: false, reason: 'invalid_snooze' });

  const equal = transitionThread({ thread: thread(), to: 'snoozed', actorId: HUMAN, now: NOW, snoozeUntil: NOW });
  assert.deepEqual(equal, { ok: false, reason: 'invalid_snooze' });
});

test('snooze without snoozeUntil is invalid_snooze', () => {
  const r = transitionThread({ thread: thread(), to: 'snoozed', actorId: HUMAN, now: NOW });
  assert.deepEqual(r, { ok: false, reason: 'invalid_snooze' });
});

test('agent cannot close', () => {
  const r = transitionThread({ thread: thread(), to: 'closed', actorId: AGENT, now: NOW });
  assert.deepEqual(r, { ok: false, reason: 'human_only' });
});

test('agent cannot snooze', () => {
  const r = transitionThread({ thread: thread(), to: 'snoozed', actorId: AGENT, now: NOW, snoozeUntil: LATER });
  assert.deepEqual(r, { ok: false, reason: 'human_only' });
});

test('agent reopen is allowed when the reason is inbound', () => {
  const r = transitionThread({ thread: closed(), to: 'open', actorId: AGENT, now: NOW, reason: 'inbound' });
  assert.equal(r.ok, true);
  assert.equal(r.thread.status, 'open');
  assert.equal(r.thread.statusHistory[0].reason, 'inbound');
  assert.equal(r.thread.statusHistory[0].actorId, AGENT);
});

test('agent reopen with a manual reason is refused', () => {
  const r = transitionThread({ thread: closed(), to: 'open', actorId: AGENT, now: NOW, reason: 'manual' });
  assert.deepEqual(r, { ok: false, reason: 'human_only' });
});

test('agent reopen with the default reason is refused', () => {
  const r = transitionThread({ thread: closed(), to: 'open', actorId: AGENT, now: NOW });
  assert.deepEqual(r, { ok: false, reason: 'human_only' });
});

test('agent may wake a snoozed thread when the snooze expired', () => {
  const r = transitionThread({ thread: snoozed(), to: 'open', actorId: AGENT, now: NOW, reason: 'snooze_expired' });
  assert.equal(r.ok, true);
  assert.equal(r.thread.status, 'open');
});

test('empty actorId is invalid_actor', () => {
  const r = transitionThread({ thread: thread(), to: 'closed', actorId: '', now: NOW });
  assert.deepEqual(r, { ok: false, reason: 'invalid_actor' });
});

test('autoWake opens a snoozed thread whose snoozeUntil has passed', () => {
  const t = snoozed({ snoozeUntil: PAST });
  const w = autoWake(t, NOW);
  assert.equal(w.status, 'open');
  assert.equal(w.snoozeUntil, null);
  assert.equal(w.statusHistory.length, 1);
  assert.deepEqual(
    { from: w.statusHistory[0].from, to: w.statusHistory[0].to, actorId: w.statusHistory[0].actorId, reason: w.statusHistory[0].reason },
    { from: 'snoozed', to: 'open', actorId: SYSTEM_ACTOR_ID, reason: 'snooze_expired' },
  );
});

test('autoWake wakes a thread whose snoozeUntil equals now', () => {
  const w = autoWake(snoozed({ snoozeUntil: NOW }), NOW);
  assert.equal(w.status, 'open');
});

test('autoWake leaves a snooze that has not passed unchanged', () => {
  const t = snoozed({ snoozeUntil: LATER });
  assert.equal(autoWake(t, NOW), t);
});

test('autoWake leaves open and closed threads unchanged', () => {
  const o = thread();
  const c = closed();
  assert.equal(autoWake(o, LATER), o);
  assert.equal(autoWake(c, LATER), c);
});

test('history grows by one entry per transition and records each step', () => {
  let t = thread();
  const steps = [
    { to: 'snoozed', actorId: HUMAN, snoozeUntil: LATER },
    { to: 'open', actorId: HUMAN },
    { to: 'closed', actorId: HUMAN },
    { to: 'open', actorId: AGENT, reason: 'inbound' },
  ];
  steps.forEach((step, i) => {
    const r = transitionThread({ thread: t, now: NOW, ...step });
    assert.equal(r.ok, true, `step ${i}`);
    assert.equal(r.thread.statusHistory.length, i + 1);
    t = r.thread;
  });
  assert.deepEqual(
    t.statusHistory.map((h) => [h.from, h.to]),
    [['open', 'snoozed'], ['snoozed', 'open'], ['open', 'closed'], ['closed', 'open']],
  );
  assert.equal(t.statusHistory[3].reason, 'inbound');
});

test('transitionThread does not mutate its input', () => {
  const t = thread({ statusHistory: [] });
  const before = structuredClone(t);
  const input = { thread: t, to: 'snoozed', actorId: HUMAN, now: NOW, snoozeUntil: LATER };
  const r = transitionThread(input);

  assert.equal(r.ok, true);
  assert.notEqual(r.thread, t);
  assert.deepEqual(t, before);
  assert.equal(t.status, 'open');
  assert.equal(t.statusHistory.length, 0);
  assert.equal(r.thread.statusHistory.length, 1);
});

test('autoWake does not mutate its input', () => {
  const t = snoozed({ snoozeUntil: PAST });
  const before = structuredClone(t);
  const w = autoWake(t, NOW);

  assert.notEqual(w, t);
  assert.deepEqual(t, before);
  assert.equal(t.status, 'snoozed');
});

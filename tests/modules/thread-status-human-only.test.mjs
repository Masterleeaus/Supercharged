// Human-only rules for thread status: an agent cannot close or snooze, a human can,
// and transitions outside the table are refused. node:test, pure functions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { transitionThread, isAgentActor } from '../../server/modules/inbox/thread-status.ts';

const CO = '11111111-1111-4111-8111-111111111111';
const HUMAN = 'human:staff-1';
const BARE_HUMAN = 'staff-1';
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

const snoozed = () => thread({ status: 'snoozed', snoozeUntil: LATER });
const closed = () => thread({ status: 'closed' });

test('agent cannot close an open thread', () => {
  const r = transitionThread({ thread: thread(), to: 'closed', actorId: AGENT, now: NOW });
  assert.deepEqual(r, { ok: false, reason: 'human_only' });
});

test('agent cannot close a snoozed thread', () => {
  const r = transitionThread({ thread: snoozed(), to: 'closed', actorId: AGENT, now: NOW });
  assert.deepEqual(r, { ok: false, reason: 'human_only' });
});

test('agent cannot snooze, even with a valid future snoozeUntil', () => {
  const r = transitionThread({ thread: thread(), to: 'snoozed', actorId: AGENT, now: NOW, snoozeUntil: LATER });
  assert.deepEqual(r, { ok: false, reason: 'human_only' });
});

test('agent-prefixed actors in other casing or with whitespace are still refused', () => {
  for (const actorId of ['Agent:triage', 'AGENT:triage', '  agent:triage']) {
    assert.equal(isAgentActor(actorId), true, actorId);
    const closeR = transitionThread({ thread: thread(), to: 'closed', actorId, now: NOW });
    assert.deepEqual(closeR, { ok: false, reason: 'human_only' }, `close by ${actorId}`);
    const snoozeR = transitionThread({ thread: thread(), to: 'snoozed', actorId, now: NOW, snoozeUntil: LATER });
    assert.deepEqual(snoozeR, { ok: false, reason: 'human_only' }, `snooze by ${actorId}`);
  }
});

test('a human can close an open thread', () => {
  const r = transitionThread({ thread: thread(), to: 'closed', actorId: HUMAN, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.thread.status, 'closed');
  assert.equal(r.thread.statusHistory[0].actorId, HUMAN);
});

test('a human can snooze an open thread', () => {
  const r = transitionThread({ thread: thread(), to: 'snoozed', actorId: HUMAN, now: NOW, snoozeUntil: LATER });
  assert.equal(r.ok, true);
  assert.equal(r.thread.status, 'snoozed');
  assert.equal(r.thread.snoozeUntil.getTime(), LATER.getTime());
});

test('a bare staff id (no prefix) is treated as a human and can close and snooze', () => {
  const closeR = transitionThread({ thread: thread(), to: 'closed', actorId: BARE_HUMAN, now: NOW });
  assert.equal(closeR.ok, true);
  const snoozeR = transitionThread({ thread: thread(), to: 'snoozed', actorId: BARE_HUMAN, now: NOW, snoozeUntil: LATER });
  assert.equal(snoozeR.ok, true);
});

test('an invalid transition is refused as invalid_transition for a human', () => {
  const r = transitionThread({ thread: closed(), to: 'snoozed', actorId: HUMAN, now: NOW, snoozeUntil: LATER });
  assert.deepEqual(r, { ok: false, reason: 'invalid_transition' });
});

test('an invalid transition is refused as invalid_transition for an agent too', () => {
  const r = transitionThread({ thread: closed(), to: 'snoozed', actorId: AGENT, now: NOW, snoozeUntil: LATER });
  assert.deepEqual(r, { ok: false, reason: 'invalid_transition' });
});

test('a blank actor is refused as invalid_actor, not treated as a human', () => {
  const r = transitionThread({ thread: thread(), to: 'closed', actorId: '   ', now: NOW });
  assert.deepEqual(r, { ok: false, reason: 'invalid_actor' });
});

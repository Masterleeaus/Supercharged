// Thread matching tests (node:test). Pure function: no store, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchThread, matchEmailThread, normaliseAddress } from '../../server/modules/comms/thread-match.ts';

// Silence logging: the runner's IPC breaks if a test file writes to stdout.
console.log = () => {};
console.info = () => {};
console.warn = () => {};

const CO = '11111111-1111-4111-8111-111111111111';
const CO_OTHER = '22222222-2222-4222-8222-222222222222';
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-03T10:00:00Z');

function inbound(overrides = {}) {
  return {
    companyId: CO,
    channel: 'email',
    fromAddress: 'pat@example.com',
    receivedAt: NOW,
    ...overrides,
  };
}

function thread(overrides = {}) {
  return {
    id: 'thread-1',
    companyId: CO,
    channel: 'email',
    participantAddress: 'pat@example.com',
    providerThreadId: null,
    messageIds: [],
    lastMessageAt: new Date(NOW.getTime() - 2 * DAY),
    ...overrides,
  };
}

test('rule 1: providerThreadId equal matches', () => {
  const threads = [thread({ id: 'a', providerThreadId: 'gt-1' })];
  const result = matchThread({ inbound: inbound({ providerThreadId: 'gt-1' }), threads });
  assert.deepEqual(result, { matched: true, threadId: 'a', rule: 'provider_thread' });
});

test('rule 2: inReplyTo found in messageIds matches', () => {
  const threads = [thread({ id: 'b', participantAddress: 'other@example.com', messageIds: ['<m1@x>', '<m2@x>'] })];
  const result = matchThread({ inbound: inbound({ inReplyTo: '<m2@x>' }), threads });
  assert.deepEqual(result, { matched: true, threadId: 'b', rule: 'in_reply_to' });
});

test('rule 3: same address within 30 days matches', () => {
  const threads = [thread({ id: 'c' })];
  const result = matchThread({ inbound: inbound(), threads });
  assert.deepEqual(result, { matched: true, threadId: 'c', rule: 'participant_recent' });
});

test('rule 4: no rule hits returns new_thread', () => {
  const threads = [thread({ id: 'd', participantAddress: 'someone@else.com', messageIds: ['<z@x>'] })];
  const result = matchThread({ inbound: inbound({ inReplyTo: '<nope@x>' }), threads });
  assert.deepEqual(result, { matched: false, reason: 'new_thread' });
});

test('empty thread list returns new_thread', () => {
  assert.deepEqual(matchThread({ inbound: inbound(), threads: [] }), { matched: false, reason: 'new_thread' });
});

test('cross-channel candidate is never matched by any rule', () => {
  const threads = [
    thread({ id: 'sms-1', channel: 'sms', providerThreadId: 'p-1', messageIds: ['<m@x>'] }),
  ];
  const result = matchThread({
    inbound: inbound({ channel: 'email', providerThreadId: 'p-1', inReplyTo: '<m@x>' }),
    threads,
  });
  assert.deepEqual(result, { matched: false, reason: 'new_thread' });
});

test('cross-channel candidate is skipped even when another same-channel thread exists', () => {
  const threads = [
    thread({ id: 'wa', channel: 'whatsapp', providerThreadId: 'p-1' }),
    thread({ id: 'em', channel: 'email', providerThreadId: 'p-1' }),
  ];
  const result = matchThread({ inbound: inbound({ providerThreadId: 'p-1' }), threads });
  assert.deepEqual(result, { matched: true, threadId: 'em', rule: 'provider_thread' });
});

test('other company candidate is never matched', () => {
  const threads = [thread({ id: 'x', companyId: CO_OTHER, providerThreadId: 'p-1' })];
  const result = matchThread({ inbound: inbound({ providerThreadId: 'p-1' }), threads });
  assert.deepEqual(result, { matched: false, reason: 'new_thread' });
});

test('old thread over 30 days is not matched by rule 3', () => {
  const threads = [thread({ id: 'old', lastMessageAt: new Date(NOW.getTime() - 31 * DAY) })];
  const result = matchThread({ inbound: inbound(), threads });
  assert.deepEqual(result, { matched: false, reason: 'new_thread' });
});

test('thread exactly 30 days old is still matched by rule 3', () => {
  const threads = [thread({ id: 'edge', lastMessageAt: new Date(NOW.getTime() - 30 * DAY) })];
  const result = matchThread({ inbound: inbound(), threads });
  assert.deepEqual(result, { matched: true, threadId: 'edge', rule: 'participant_recent' });
});

test('old thread is still matched by rule 1 or 2 regardless of age', () => {
  const old = new Date(NOW.getTime() - 400 * DAY);
  const byProvider = matchThread({
    inbound: inbound({ providerThreadId: 'p-old' }),
    threads: [thread({ id: 'o1', providerThreadId: 'p-old', lastMessageAt: old })],
  });
  assert.deepEqual(byProvider, { matched: true, threadId: 'o1', rule: 'provider_thread' });
  const byReply = matchThread({
    inbound: inbound({ inReplyTo: '<old@x>' }),
    threads: [thread({ id: 'o2', messageIds: ['<old@x>'], lastMessageAt: old })],
  });
  assert.deepEqual(byReply, { matched: true, threadId: 'o2', rule: 'in_reply_to' });
});

test('case-insensitive and trimmed address match', () => {
  const threads = [thread({ id: 'ci', participantAddress: '  Pat@Example.COM ' })];
  const result = matchThread({ inbound: inbound({ fromAddress: 'pat@example.com ' }), threads });
  assert.deepEqual(result, { matched: true, threadId: 'ci', rule: 'participant_recent' });
});

test('normaliseAddress lowercases and trims only', () => {
  assert.equal(normaliseAddress('  A.B+Tag@Mail.COM '), 'a.b+tag@mail.com');
  assert.equal(normaliseAddress(null), '');
});

test('first rule wins: provider thread beats in-reply-to and address', () => {
  const threads = [
    thread({ id: 'by-address', participantAddress: 'pat@example.com' }),
    thread({ id: 'by-reply', participantAddress: 'x@example.com', messageIds: ['<r@x>'] }),
    thread({ id: 'by-provider', participantAddress: 'y@example.com', providerThreadId: 'p-9' }),
  ];
  const result = matchThread({
    inbound: inbound({ providerThreadId: 'p-9', inReplyTo: '<r@x>' }),
    threads,
  });
  assert.deepEqual(result, { matched: true, threadId: 'by-provider', rule: 'provider_thread' });
});

test('first rule wins: in-reply-to beats address', () => {
  const threads = [
    thread({ id: 'by-address' }),
    thread({ id: 'by-reply', participantAddress: 'x@example.com', messageIds: ['<r@x>'] }),
  ];
  const result = matchThread({ inbound: inbound({ inReplyTo: '<r@x>' }), threads });
  assert.deepEqual(result, { matched: true, threadId: 'by-reply', rule: 'in_reply_to' });
});

test('within one rule the most recent thread wins', () => {
  const threads = [
    thread({ id: 'older', lastMessageAt: new Date(NOW.getTime() - 10 * DAY) }),
    thread({ id: 'newer', lastMessageAt: new Date(NOW.getTime() - 1 * DAY) }),
  ];
  const result = matchThread({ inbound: inbound(), threads });
  assert.deepEqual(result, { matched: true, threadId: 'newer', rule: 'participant_recent' });
});

test('empty providerThreadId on inbound does not match a thread with an empty one', () => {
  const threads = [thread({ id: 'blank', providerThreadId: '', participantAddress: 'other@example.com' })];
  const result = matchThread({ inbound: inbound({ providerThreadId: '' }), threads });
  assert.deepEqual(result, { matched: false, reason: 'new_thread' });
});

function emailInput(overrides = {}) {
  return {
    companyId: CO,
    inbound: { fromAddress: 'pat@example.com', receivedAt: NOW },
    referenceIds: [],
    threads: [],
    ...overrides,
  };
}

test('matchEmailThread: an older ancestor in References beats the participant rule', () => {
  const threads = [
    thread({ id: 'by-address', participantAddress: 'pat@example.com', lastMessageAt: new Date(NOW.getTime() - DAY) }),
    thread({ id: 'by-ancestor', participantAddress: 'x@example.com', messageIds: ['<root@x>'], lastMessageAt: new Date(NOW.getTime() - 20 * DAY) }),
  ];
  const result = matchEmailThread(emailInput({ referenceIds: ['<root@x>'], threads }));
  assert.deepEqual(result, { matched: true, threadId: 'by-ancestor', rule: 'in_reply_to' });
});

test('matchEmailThread: a reference id matches a stored id whatever its bracket form', () => {
  const threads = [thread({ id: 'bare', participantAddress: 'x@example.com', messageIds: ['abc@x'] })];
  assert.deepEqual(
    matchEmailThread(emailInput({ referenceIds: ['<abc@x>'], threads })),
    { matched: true, threadId: 'bare', rule: 'in_reply_to' },
  );
  const bracketed = [thread({ id: 'br', participantAddress: 'x@example.com', messageIds: ['<abc@x>'] })];
  assert.deepEqual(
    matchEmailThread(emailInput({ referenceIds: ['abc@x'], threads: bracketed })),
    { matched: true, threadId: 'br', rule: 'in_reply_to' },
  );
});

test('matchEmailThread: a reference id in another company or channel is never matched', () => {
  const threads = [
    thread({ id: 'foreign', companyId: CO_OTHER, messageIds: ['<m@x>'], participantAddress: 'x@example.com' }),
    thread({ id: 'sms', channel: 'sms', messageIds: ['<m@x>'], participantAddress: 'x@example.com' }),
  ];
  assert.deepEqual(
    matchEmailThread(emailInput({ referenceIds: ['<m@x>'], threads })),
    { matched: false, reason: 'new_thread' },
  );
});

test('matchEmailThread: with no reference id it falls back to the participant rule', () => {
  const threads = [thread({ id: 'recent' })];
  assert.deepEqual(
    matchEmailThread(emailInput({ referenceIds: [], threads })),
    { matched: true, threadId: 'recent', rule: 'participant_recent' },
  );
});

test('matchEmailThread: no reference hit and no recent participant is a new thread', () => {
  const threads = [thread({ id: 'stale', lastMessageAt: new Date(NOW.getTime() - 60 * DAY) })];
  assert.deepEqual(
    matchEmailThread(emailInput({ referenceIds: ['<nope@x>'], threads })),
    { matched: false, reason: 'new_thread' },
  );
});

test('matchEmailThread: the input threads are not mutated', () => {
  const threads = [thread({ id: 't', messageIds: ['bare@x'], participantAddress: 'x@example.com' })];
  matchEmailThread(emailInput({ referenceIds: ['<bare@x>'], threads }));
  assert.deepEqual(threads[0].messageIds, ['bare@x']);
});

// Inbound email parsing tests (node:test). Pure function: no store, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInboundEmail,
  stripQuotedText,
  normaliseMessageId,
  inboundReferenceIds,
  MAX_BODY_LENGTH,
  MAX_SUBJECT_LENGTH,
} from '../../server/modules/comms/email-inbound.ts';
import { matchThread, matchEmailThread } from '../../server/modules/comms/thread-match.ts';

// Silence logging: the runner's IPC breaks if a test file writes to stdout.
console.log = () => {};
console.info = () => {};
console.warn = () => {};

const CO = '11111111-1111-4111-8111-111111111111';
const DATE = '2026-11-03T10:00:00Z';

function payload(overrides = {}) {
  return {
    from: '  Pat@Example.com ',
    to: 'desk@company.test',
    subject: '  Re: Quote for gutter clean  ',
    text: 'Yes please, Thursday works.',
    messageId: '<abc123@example.com>',
    date: DATE,
    ...overrides,
  };
}

test('valid payload parses into the thread-match inbound shape', () => {
  const result = parseInboundEmail(payload({ inReplyTo: '<prev@example.com>' }), { companyId: CO });
  assert.equal(result.ok, true);
  assert.deepEqual(result.inbound, {
    channel: 'email',
    fromAddress: 'pat@example.com',
    subject: 'Re: Quote for gutter clean',
    inReplyTo: '<prev@example.com>',
    messageId: '<abc123@example.com>',
    receivedAt: Date.parse(DATE),
    body: 'Yes please, Thursday works.',
  });
});

test('parsed output feeds matchThread and matches the earlier message by inReplyTo', () => {
  const parsed = parseInboundEmail(payload({ inReplyTo: '<quote1@desk.test>' }), { companyId: CO });
  assert.equal(parsed.ok, true);
  const inbound = { ...parsed.inbound, companyId: CO, receivedAt: new Date(parsed.inbound.receivedAt) };
  const result = matchThread({
    inbound,
    threads: [
      {
        id: 'thread-1',
        companyId: CO,
        channel: 'email',
        participantAddress: 'someone-else@example.com',
        messageIds: ['<quote1@desk.test>'],
        lastMessageAt: new Date(Date.parse(DATE) - 60_000),
      },
    ],
  });
  assert.deepEqual(result, { matched: true, threadId: 'thread-1', rule: 'in_reply_to' });
});

test('quoted reply lines are removed from the body', () => {
  const text = 'Thanks, see you then.\n> On Mon, Desk wrote:\n> Are you free Thursday?\nBest, Pat';
  assert.equal(stripQuotedText(text), 'Thanks, see you then.\nBest, Pat');

  const result = parseInboundEmail(payload({ text }), { companyId: CO });
  assert.equal(result.ok, true);
  assert.equal(result.inbound.body, 'Thanks, see you then.\nBest, Pat');
});

test('signature separator "-- " removes everything after it', () => {
  const text = 'Booking confirmed.\n-- \nPat Smith\n0400 000 000';
  assert.equal(stripQuotedText(text), 'Booking confirmed.');
});

test('inReplyTo falls back to the last of references', () => {
  const result = parseInboundEmail(
    payload({ references: ['<root@x.test>', '<mid@x.test>', '<last@x.test>'] }),
    { companyId: CO },
  );
  assert.equal(result.ok, true);
  assert.equal(result.inbound.inReplyTo, '<last@x.test>');
});

test('inReplyTo falls back to the last of a whitespace-separated references string', () => {
  const result = parseInboundEmail(payload({ references: '<root@x.test> <last@x.test>' }), {
    companyId: CO,
  });
  assert.equal(result.inbound.inReplyTo, '<last@x.test>');
});

test('inReplyTo is undefined when neither inReplyTo nor references is present', () => {
  const result = parseInboundEmail(payload(), { companyId: CO });
  assert.equal(result.ok, true);
  assert.equal(result.inbound.inReplyTo, undefined);
});

test('a missing message id is refused', () => {
  for (const messageId of ['', '   ', undefined]) {
    const result = parseInboundEmail(payload({ messageId }), { companyId: CO });
    assert.deepEqual(result, { ok: false, reason: 'missing_message_id' });
  }
});

test('an invalid from address is refused', () => {
  for (const from of ['', 'not-an-address', '   ', undefined]) {
    const result = parseInboundEmail(payload({ from }), { companyId: CO });
    assert.deepEqual(result, { ok: false, reason: 'invalid_from' });
  }
});

test('an invalid date is refused', () => {
  for (const date of ['not a date', undefined, null]) {
    const result = parseInboundEmail(payload({ date }), { companyId: CO });
    assert.deepEqual(result, { ok: false, reason: 'invalid_date' });
  }
});

test('the body is capped at the body limit', () => {
  const text = 'a'.repeat(MAX_BODY_LENGTH + 5000);
  const result = parseInboundEmail(payload({ text }), { companyId: CO });
  assert.equal(result.ok, true);
  assert.equal(result.inbound.body.length, MAX_BODY_LENGTH);
});

test('the subject is trimmed and capped at 300 characters', () => {
  const subject = `  ${'s'.repeat(MAX_SUBJECT_LENGTH + 50)}  `;
  const result = parseInboundEmail(payload({ subject }), { companyId: CO });
  assert.equal(result.ok, true);
  assert.equal(result.inbound.subject.length, MAX_SUBJECT_LENGTH);
  assert.equal(result.inbound.subject, 's'.repeat(MAX_SUBJECT_LENGTH));
});

test('an invalid company is refused', () => {
  for (const companyId of ['', '   ', undefined, null]) {
    const result = parseInboundEmail(payload(), { companyId });
    assert.deepEqual(result, { ok: false, reason: 'invalid_company' });
  }
});

test('normaliseMessageId brackets bare ids and trims whitespace, keeping case', () => {
  assert.equal(normaliseMessageId('  ABC@Mail.Example  '), '<ABC@Mail.Example>');
  assert.equal(normaliseMessageId('<ABC@Mail.Example>'), '<ABC@Mail.Example>');
  assert.equal(normaliseMessageId(' < x@y > '), '<x@y>');
  assert.equal(normaliseMessageId('   '), '');
  assert.equal(normaliseMessageId('<>'), '');
  assert.equal(normaliseMessageId(undefined), '');
});

test('inboundReferenceIds lists In-Reply-To first, then References newest first, without duplicates', () => {
  const ids = inboundReferenceIds({
    inReplyTo: '<mid@x>',
    references: '<root@x> <mid@x> <last@x>',
  });
  assert.deepEqual(ids, ['<mid@x>', '<last@x>', '<root@x>']);
});

test('inboundReferenceIds accepts list values and skips empty entries', () => {
  const ids = inboundReferenceIds({
    inReplyTo: null,
    references: ['<a@x>', '', '  ', '<b@x>'],
  });
  assert.deepEqual(ids, ['<b@x>', '<a@x>']);
  assert.deepEqual(inboundReferenceIds(undefined), []);
});

test('a parsed reply with a bare-form reference threads to the stored bracketed id', () => {
  const parsed = parseInboundEmail(payload({ references: 'ext-9@campaigns.invalid' }), { companyId: CO });
  const inbound = { ...parsed.inbound, companyId: CO, receivedAt: new Date(parsed.inbound.receivedAt) };
  const result = matchEmailThread({
    companyId: CO,
    inbound: { fromAddress: inbound.fromAddress, receivedAt: inbound.receivedAt },
    referenceIds: inboundReferenceIds(payload({ references: 'ext-9@campaigns.invalid' })),
    threads: [
      {
        id: 'campaign-thread',
        companyId: CO,
        channel: 'email',
        participantAddress: 'someone-else@example.com',
        messageIds: ['<ext-9@campaigns.invalid>'],
        lastMessageAt: new Date(Date.parse(DATE) - 60_000),
      },
    ],
  });
  assert.deepEqual(result, { matched: true, threadId: 'campaign-thread', rule: 'in_reply_to' });
});

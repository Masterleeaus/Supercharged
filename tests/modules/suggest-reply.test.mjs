// Suggest-reply tests (node:test). Pure function: no storage, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestReply, gateCommsAction, COMMS_ACTIONS, COMMS_ACTION_RISK } from '../../server/modules/comms/suggest-reply.ts';

// Keep stdout clean: the test runner's IPC breaks on stray writes.
for (const level of ['log', 'info', 'warn']) console[level] = () => {};

const COMPANY_A = '11111111-1111-4111-8111-111111111111';
const COMPANY_B = '22222222-2222-4222-8222-222222222222';

const reply = (overrides = {}) => ({
  id: overrides.id ?? 'r-' + Math.random().toString(36).slice(2),
  companyId: COMPANY_A,
  title: 'Reply',
  body: 'Generic body.',
  channel: 'email',
  variables: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

test('the best matching reply wins', () => {
  const pricing = reply({ id: 'pricing', title: 'Pricing', body: 'Our pricing starts at forty dollars per visit.' });
  const hours = reply({ id: 'hours', title: 'Opening hours', body: 'We are open nine to five on weekdays.' });
  const result = suggestReply({
    companyId: COMPANY_A,
    thread: { threadId: 'thread-1', inboundMessageId: 'msg-1', channel: 'email', lastInboundText: 'What is your pricing per visit?' },
    savedReplies: [hours, pricing],
  });
  assert.equal(result.ok, true);
  assert.equal(result.replyId, 'pricing');
  assert.equal(result.title, 'Pricing');
  assert.equal(result.body, 'Our pricing starts at forty dollars per visit.');
  assert.equal(typeof result.reason, 'string');
});

test('topicKeywords add to the score', () => {
  const plumbing = reply({ id: 'plumbing', title: 'Plumbing', body: 'We can fix that leak quickly.' });
  const boiler = reply({ id: 'boiler', title: 'Boiler', body: 'Boiler servicing is booked weekly.' });
  const result = suggestReply({
    companyId: COMPANY_A,
    thread: { threadId: 'thread-1', inboundMessageId: 'msg-1', channel: 'email', lastInboundText: 'hello there', topicKeywords: ['boiler', 'servicing'] },
    savedReplies: [plumbing, boiler],
  });
  assert.equal(result.ok, true);
  assert.equal(result.replyId, 'boiler');
});

test('channel filter: replies for other channels are not candidates', () => {
  const smsOnly = reply({ id: 'sms', channel: 'sms', body: 'Pricing details by text message.' });
  const emailOnly = reply({ id: 'email', channel: 'email', body: 'Pricing details by email.' });
  const result = suggestReply({
    companyId: COMPANY_A,
    thread: { threadId: 'thread-1', inboundMessageId: 'msg-1', channel: 'email', lastInboundText: 'pricing details please' },
    savedReplies: [smsOnly, emailOnly],
  });
  assert.equal(result.ok, true);
  assert.equal(result.replyId, 'email');

  const none = suggestReply({
    companyId: COMPANY_A,
    thread: { threadId: 'thread-1', inboundMessageId: 'msg-1', channel: 'whatsapp', lastInboundText: 'pricing details please' },
    savedReplies: [smsOnly, emailOnly],
  });
  assert.deepEqual(none, { ok: false, reason: 'no_match' });
});

test('channel "any" replies are candidates on every channel', () => {
  const anyReply = reply({ id: 'any', channel: 'any', body: 'Pricing details are attached.' });
  const result = suggestReply({
    companyId: COMPANY_A,
    thread: { threadId: 'thread-1', inboundMessageId: 'msg-1', channel: 'telegram', lastInboundText: 'send pricing details' },
    savedReplies: [anyReply],
  });
  assert.equal(result.ok, true);
  assert.equal(result.replyId, 'any');
});

test('another company is excluded even with a better match', () => {
  const other = reply({ id: 'other', companyId: COMPANY_B, body: 'Pricing details for company B.', title: 'Pricing' });
  const mine = reply({ id: 'mine', companyId: COMPANY_A, body: 'Pricing details for company A.', title: 'Pricing' });
  const result = suggestReply({
    companyId: COMPANY_A,
    thread: { threadId: 'thread-1', inboundMessageId: 'msg-1', channel: 'email', lastInboundText: 'pricing details pricing details pricing' },
    savedReplies: [other, mine],
  });
  assert.equal(result.ok, true);
  assert.equal(result.replyId, 'mine');

  const onlyOther = suggestReply({
    companyId: COMPANY_A,
    thread: { threadId: 'thread-1', inboundMessageId: 'msg-1', channel: 'email', lastInboundText: 'pricing details' },
    savedReplies: [other],
  });
  assert.deepEqual(onlyOther, { ok: false, reason: 'no_match' });
});

test('a zero score is no_match', () => {
  const result = suggestReply({
    companyId: COMPANY_A,
    thread: { threadId: 'thread-1', inboundMessageId: 'msg-1', channel: 'email', lastInboundText: 'quantum entanglement', topicKeywords: ['spacecraft'] },
    savedReplies: [reply({ title: 'Pricing', body: 'Our pricing starts at forty dollars.' })],
  });
  assert.deepEqual(result, { ok: false, reason: 'no_match' });
});

test('no saved replies is no_match', () => {
  const result = suggestReply({
    companyId: COMPANY_A,
    thread: { threadId: 'thread-1', inboundMessageId: 'msg-1', channel: 'email', lastInboundText: 'pricing' },
    savedReplies: [],
  });
  assert.deepEqual(result, { ok: false, reason: 'no_match' });
});

test('tie-break: the earlier-created reply wins', () => {
  const later = reply({ id: 'later', body: 'Booking confirmed for Tuesday.', createdAt: '2026-03-02T00:00:00.000Z' });
  const earlier = reply({ id: 'earlier', body: 'Booking confirmed for Monday.', createdAt: '2026-03-01T00:00:00.000Z' });
  const thread = { threadId: 'thread-1', inboundMessageId: 'msg-1', channel: 'email', lastInboundText: 'booking confirmed' };

  const first = suggestReply({ companyId: COMPANY_A, thread, savedReplies: [later, earlier] });
  assert.equal(first.ok, true);
  assert.equal(first.replyId, 'earlier');

  const second = suggestReply({ companyId: COMPANY_A, thread, savedReplies: [earlier, later] });
  assert.equal(second.replyId, 'earlier');
});

test('stop words do not score', () => {
  const stopOnly = reply({ id: 'stop', body: 'Thank you and we will be there at the time.' });
  const none = suggestReply({
    companyId: COMPANY_A,
    thread: { threadId: 'thread-1', inboundMessageId: 'msg-1', channel: 'email', lastInboundText: 'what would you and they have been with?' },
    savedReplies: [stopOnly],
  });
  assert.deepEqual(none, { ok: false, reason: 'no_match' });

  const real = reply({ id: 'real', body: 'Parking is free on site.' });
  const picked = suggestReply({
    companyId: COMPANY_A,
    thread: { threadId: 'thread-1', inboundMessageId: 'msg-1', channel: 'email', lastInboundText: 'is the parking free? the answer please' },
    savedReplies: [stopOnly, real],
  });
  assert.equal(picked.ok, true);
  assert.equal(picked.replyId, 'real');
});

test('words under three letters do not score', () => {
  const short = reply({ id: 'short', body: 'Yes, ok, we can do it.' });
  const result = suggestReply({
    companyId: COMPANY_A,
    thread: { threadId: 'thread-1', inboundMessageId: 'msg-1', channel: 'email', lastInboundText: 'ok do it so' },
    savedReplies: [short],
  });
  assert.deepEqual(result, { ok: false, reason: 'no_match' });
});

test('the returned body is exactly the saved body', () => {
  const body = 'Line one.\n\nLine two with {{name}} kept as written.';
  const saved = reply({ id: 'exact', title: 'Exact', body, variables: ['name'] });
  const result = suggestReply({
    companyId: COMPANY_A,
    thread: { threadId: 'thread-1', inboundMessageId: 'msg-1', channel: 'email', lastInboundText: 'line one please' },
    savedReplies: [saved],
  });
  assert.equal(result.ok, true);
  assert.equal(result.body, body);
});

test('invalid company is refused', () => {
  const saved = reply({ body: 'Pricing details.' });
  for (const companyId of ['', 'not-a-uuid', 'company-a', 42, undefined]) {
    const result = suggestReply({
      companyId,
      thread: { threadId: 'thread-1', inboundMessageId: 'msg-1', channel: 'email', lastInboundText: 'pricing details' },
      savedReplies: [saved],
    });
    assert.deepEqual(result, { ok: false, reason: 'invalid_company' }, `companyId ${String(companyId)}`);
  }
});

test('a suggestion is Suggest-tier output and never sends', () => {
  const saved = reply({ id: 'pricing', body: 'Pricing details by email.' });
  const result = suggestReply({
    companyId: COMPANY_A,
    thread: { threadId: 'thread-9', inboundMessageId: 'msg-42', channel: 'email', lastInboundText: 'pricing details' },
    savedReplies: [saved],
  });
  assert.equal(result.ok, true);
  assert.equal(result.tier, 'suggest');
  assert.equal(result.sends, false);
  assert.deepEqual(result.sources, { savedReplyId: 'pricing', threadId: 'thread-9', inboundMessageId: 'msg-42' });
});

test('missing thread or inbound message id fails closed with missing_source', () => {
  const saved = reply({ body: 'Pricing details.' });
  const bad = [
    { channel: 'email', lastInboundText: 'pricing details' },
    { threadId: '', inboundMessageId: 'msg-1', channel: 'email', lastInboundText: 'pricing details' },
    { threadId: 'thread-1', inboundMessageId: '   ', channel: 'email', lastInboundText: 'pricing details' },
    { threadId: 'thread-1', inboundMessageId: 42, channel: 'email', lastInboundText: 'pricing details' },
  ];
  for (const thread of bad) {
    const result = suggestReply({ companyId: COMPANY_A, thread, savedReplies: [saved] });
    assert.deepEqual(result, { ok: false, reason: 'missing_source' });
  }
});

const GATE_COMPANY = COMPANY_A;
const NOW = '2026-11-04T10:00:00.000Z';
// Fake recipient: consented to email, not suppressed, no quiet hours.
const CLEAR_RECIPIENT = {
  channel: 'email',
  contact: { handles: { email: 'fake.person@example.test' }, consents: [{ channel: 'email', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }] },
  now: NOW,
  suppressed: false,
};
const OPTED_OUT_RECIPIENT = {
  ...CLEAR_RECIPIENT,
  contact: { handles: { email: 'fake.person@example.test' }, consents: [
    { channel: 'email', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' },
    { channel: 'email', action: 'opt_out', at: '2026-02-01T00:00:00Z', source: 'contact' },
  ] },
};

test('gate: an agent-proposed customer send to an opted-out contact is refused, even when approved', () => {
  for (const autonomy of ['auto', 'predictive', 'user_only']) {
    const r = gateCommsAction({
      companyId: GATE_COMPANY, action: 'customer_send', autonomy,
      actorIsHuman: autonomy === 'user_only', humanApproved: true, outbound: OPTED_OUT_RECIPIENT,
    });
    assert.equal(r.decision, 'deny', autonomy);
    assert.match(r.reason, /opted_out/);
  }
});

test('gate: customer send to a suppressed address, or with no recipient context, is refused', () => {
  const suppressed = gateCommsAction({ companyId: GATE_COMPANY, action: 'customer_send', autonomy: 'predictive', humanApproved: true, outbound: { ...CLEAR_RECIPIENT, suppressed: true } });
  assert.equal(suppressed.decision, 'deny');
  const missing = gateCommsAction({ companyId: GATE_COMPANY, action: 'customer_send', autonomy: 'predictive', humanApproved: true });
  assert.equal(missing.decision, 'deny');
  const noState = gateCommsAction({ companyId: GATE_COMPANY, action: 'customer_send', autonomy: 'predictive', humanApproved: true, outbound: { ...CLEAR_RECIPIENT, suppressed: undefined } });
  assert.equal(noState.decision, 'deny');
});

test('gate: Assist and Suggest are refused for every comms write, approved or not', () => {
  for (const action of COMMS_ACTIONS) {
    for (const autonomy of ['assist', 'suggest']) {
      for (const humanApproved of [false, true]) {
        const r = gateCommsAction({ companyId: GATE_COMPANY, action, autonomy, humanApproved });
        assert.equal(r.decision, 'deny', `${action} ${autonomy} approved=${humanApproved}`);
      }
    }
  }
});

test('gate: customer sends, money and deletes need approval under auto and predictive', () => {
  for (const action of ['customer_send', 'money_movement', 'record_delete']) {
    assert.equal(COMMS_ACTION_RISK[action], 'critical');
    for (const autonomy of ['auto', 'predictive']) {
      const unapproved = gateCommsAction({ companyId: GATE_COMPANY, action, autonomy, humanApproved: false, outbound: CLEAR_RECIPIENT });
      assert.equal(unapproved.decision, 'require_approval', `${action} ${autonomy}`);
      const approved = gateCommsAction({ companyId: GATE_COMPANY, action, autonomy, humanApproved: true, outbound: CLEAR_RECIPIENT });
      assert.equal(approved.decision, 'allow', `${action} ${autonomy} approved`);
    }
  }
});

test('gate: a verified human still needs approval for critical actions', () => {
  const r = gateCommsAction({ companyId: GATE_COMPANY, action: 'customer_send', autonomy: 'user_only', actorIsHuman: true, outbound: CLEAR_RECIPIENT });
  assert.equal(r.decision, 'require_approval');
  const approved = gateCommsAction({ companyId: GATE_COMPANY, action: 'customer_send', autonomy: 'user_only', actorIsHuman: true, humanApproved: true, outbound: CLEAR_RECIPIENT });
  assert.equal(approved.decision, 'allow');
});

test('gate: an agent claiming the human actor is refused', () => {
  const r = gateCommsAction({ companyId: GATE_COMPANY, action: 'bulk_campaign', autonomy: 'user_only', actorIsHuman: false, humanApproved: true });
  assert.equal(r.decision, 'deny');
});

test('gate: bulk campaigns, exports and account changes run under auto without approval', () => {
  for (const action of ['bulk_campaign', 'contact_export', 'account_change']) {
    assert.equal(COMMS_ACTION_RISK[action], 'high');
    const r = gateCommsAction({ companyId: GATE_COMPANY, action, autonomy: 'auto', humanApproved: false });
    // High risk under auto needs approval, per the authority ladder.
    assert.equal(r.decision, 'require_approval', action);
  }
});

test('gate: missing or invalid company, unknown action and unknown tier all deny', () => {
  assert.equal(gateCommsAction({ companyId: '', action: 'customer_send', autonomy: 'predictive', humanApproved: true }).decision, 'deny');
  assert.equal(gateCommsAction({ companyId: 'nope', action: 'customer_send', autonomy: 'predictive', humanApproved: true }).decision, 'deny');
  assert.equal(gateCommsAction({ companyId: GATE_COMPANY, action: 'wire_money', autonomy: 'predictive', humanApproved: true }).decision, 'deny');
  assert.equal(gateCommsAction({ companyId: GATE_COMPANY, action: 'customer_send', autonomy: 'root', humanApproved: true }).decision, 'deny');
  assert.equal(gateCommsAction(null).decision, 'deny');
});

test('gate: a string "true" is not an approval', () => {
  const r = gateCommsAction({ companyId: GATE_COMPANY, action: 'customer_send', autonomy: 'predictive', humanApproved: 'true', outbound: CLEAR_RECIPIENT });
  assert.equal(r.decision, 'require_approval');
});

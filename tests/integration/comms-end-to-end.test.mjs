/**
 * Comms end-to-end flow, with fakes only (no database, no network, no timers, no provider calls):
 *   inbound SMS recorded once (duplicate webhook) -> thread match -> assignment -> agent reply proposed and refused
 *   without approval -> approved reply sent once -> contact STOP blocks the next send -> another company sees nothing.
 *
 * Modules: inbound-dedupe, thread-match, workload, suggest-reply (suggestReply, gateCommsAction),
 * sms-provider-adapter, consent, suppression, inbound-optout.
 * Run: cd /home/claude/desk-review && node --test --experimental-transform-types tests/integration/comms-end-to-end.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordInboundMessage } from '../../server/modules/comms/inbound-dedupe.ts';
import { matchThread } from '../../server/modules/comms/thread-match.ts';
import { chooseAssignee } from '../../server/modules/comms/workload.ts';
import { suggestReply, gateCommsAction } from '../../server/modules/comms/suggest-reply.ts';
import { createSmsProviderAdapter } from '../../server/modules/comms/sms-provider-adapter.ts';
import { consentEventForInboundKeyword } from '../../server/modules/comms/inbound-optout.ts';
import { handleInboundOptOut } from '../../server/modules/comms/inbound-optout.ts';
import { createSuppressionList } from '../../server/modules/comms/suppression.ts';

// Keep stdout clean: the test runner's IPC breaks on stray writes.
for (const level of ['log', 'info', 'warn']) console[level] = () => {};

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const CONTACT_PHONE = '+61400000001';
const COMPANY_FROM = '+61400000999';
const NOW = new Date('2026-11-04T09:00:00Z');
const PROVIDER = 'plivo';

// ---- fakes -------------------------------------------------------------------------------------

/** In-memory dedupe store with a unique key on (companyId, provider, providerMessageId). */
function createFakeDedupeStore() {
  const rows = new Set();
  const store = {
    rows,
    async insert({ companyId, provider, providerMessageId }) {
      const key = JSON.stringify([companyId, provider, providerMessageId]);
      if (rows.has(key)) {
        const err = new Error('duplicate key value violates unique constraint');
        err.code = '23505';
        throw err;
      }
      rows.add(key);
    },
  };
  return store;
}

/** Contact that owns CONTACT_PHONE in company A, opted in to SMS by the contact. */
function contactA(overrides = {}) {
  return {
    handles: { phone: CONTACT_PHONE },
    consents: [{ channel: 'sms', action: 'opt_in', at: '2026-10-01T00:00:00Z', source: 'contact' }],
    timezone: 'Australia/Melbourne',
    ...overrides,
  };
}

/** Fake Plivo HTTP client. Counts every request; answers 202 with one message uuid. */
function createFakeHttp() {
  const calls = [];
  const http = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 202, json: async () => ({ message_uuid: [`uuid-${calls.length}`] }) };
  };
  return { http, calls };
}

/** SMS adapter for company A only. Company B resolves to nothing, so it fails closed. */
function createAdapter({ http, suppression, contacts = { [CO_A]: contactA() } }) {
  return createSmsProviderAdapter({
    accountId: 'fake-account-id',
    authToken: 'fake-auth-token',
    fromNumber: COMPANY_FROM,
    http,
    resolveCompany: (companyId) => (companyId === CO_A ? { quietHours: null } : null),
    resolveContact: (companyId, phone) => {
      const contact = contacts[companyId];
      return contact && contact.handles.phone === phone ? contact : null;
    },
    now: () => NOW.getTime(),
    ...(suppression ? { suppression } : {}),
  });
}

/** The inbound SMS as the provider delivers it (one provider message id). */
function inboundSms(overrides = {}) {
  return {
    companyId: CO_A,
    provider: PROVIDER,
    providerMessageId: 'sms-in-0001',
    channel: 'sms',
    fromAddress: CONTACT_PHONE,
    body: 'What are your opening hours?',
    receivedAt: NOW,
    ...overrides,
  };
}

/** The existing company A thread the inbound should land in. */
function threadA(overrides = {}) {
  return {
    id: 'thread-a-1',
    companyId: CO_A,
    channel: 'sms',
    participantAddress: CONTACT_PHONE,
    providerThreadId: null,
    messageIds: ['sms-in-0000'],
    lastMessageAt: new Date('2026-11-02T10:00:00Z'),
    ...overrides,
  };
}

/** Staff in company A plus one staff member in company B. */
const STAFF = [
  { id: 'staff-a1', companyId: CO_A, available: true, maxOpen: 5, channels: ['sms', 'email'] },
  { id: 'staff-a2', companyId: CO_A, available: true, maxOpen: 5, channels: ['email'] },
  { id: 'staff-b1', companyId: CO_B, available: true, maxOpen: 5, channels: ['sms'] },
];

/** The owner's saved reply for company A, the one the agent proposes from. */
const SAVED_REPLY_A = {
  id: 'reply-hours-a',
  companyId: CO_A,
  title: 'Opening hours',
  body: 'We are open nine to five on weekdays. Reply here with any other question.',
  channel: 'sms',
  variables: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/** Gate context for a customer_send to the contact. */
function outboundFor(contact, { suppressed = false } = {}) {
  return {
    channel: 'sms',
    contact,
    now: NOW,
    suppressed,
    quietHours: null,
    timezone: 'Australia/Melbourne',
  };
}

// ---- flow step groups --------------------------------------------------------------------------

test('step 1 inbound receipt: a message delivered twice is recorded once', async () => {
  const store = createFakeDedupeStore();
  const msg = inboundSms();

  const first = await recordInboundMessage(store, msg);
  const second = await recordInboundMessage(store, { ...msg });

  assert.equal(first, 'new');
  assert.equal(second, 'duplicate');
  assert.equal(store.rows.size, 1);
});

test('step 2 thread matching: the inbound lands in the existing thread, and only that thread', () => {
  const result = matchThread({
    inbound: {
      companyId: CO_A,
      channel: 'sms',
      fromAddress: CONTACT_PHONE,
      inReplyTo: null,
      providerThreadId: null,
      receivedAt: NOW,
    },
    threads: [threadA()],
  });

  assert.deepEqual(result, { matched: true, threadId: 'thread-a-1', rule: 'participant_recent' });

  // Outside the 30-day window the same sender starts a new thread.
  const stale = matchThread({
    inbound: { companyId: CO_A, channel: 'sms', fromAddress: CONTACT_PHONE, receivedAt: NOW },
    threads: [threadA({ lastMessageAt: new Date('2026-09-01T00:00:00Z') })],
  });
  assert.deepEqual(stale, { matched: false, reason: 'new_thread' });
});

test('step 3 assignment: the matched thread goes to an available company A staff member', () => {
  // staff-a1 has one open thread, staff-a2 has none. Both are company A. staff-b1 is company B.
  const result = chooseAssignee({
    companyId: CO_A,
    staff: STAFF,
    openThreads: [
      { id: 'thread-x', companyId: CO_A, assigneeId: 'staff-a1', channel: 'email' },
      { id: 'thread-y', companyId: CO_B, assigneeId: 'staff-b1', channel: 'sms' },
    ],
    channel: 'sms',
  });

  // staff-a2 has no sms channel, so the channel rule narrows the pool to staff-a1 even though staff-a2 is
  // less loaded. staff-b1 is excluded by company. Only company A staff remain.
  assert.equal(result.ok, true);
  assert.equal(result.assigneeId, 'staff-a1');
  assert.equal(result.reason, 'channel_match');
});

test('step 4 reply approval: an agent-proposed reply is refused without owner approval', () => {
  const suggestion = suggestReply({
    companyId: CO_A,
    thread: {
      threadId: 'thread-a-1',
      inboundMessageId: 'sms-in-0001',
      channel: 'sms',
      lastInboundText: 'What are your opening hours on weekdays?',
    },
    savedReplies: [SAVED_REPLY_A],
  });
  assert.equal(suggestion.ok, true);
  assert.equal(suggestion.sends, false, 'a suggestion never sends by itself');

  const contact = contactA();
  const base = {
    companyId: CO_A,
    action: 'customer_send',
    outbound: outboundFor(contact),
    actorIsHuman: false,
  };

  // A suggest-tier agent cannot send at all.
  const suggestTier = gateCommsAction({ ...base, autonomy: 'suggest' });
  assert.equal(suggestTier.decision, 'deny');

  // An auto-tier agent reaches the critical cell and needs approval. Without it, no send.
  const autoNoApproval = gateCommsAction({ ...base, autonomy: 'auto' });
  assert.equal(autoNoApproval.decision, 'require_approval');
  assert.notEqual(autoNoApproval.decision, 'allow');

  // An agent cannot claim to be the verified human.
  const agentClaimsHuman = gateCommsAction({ ...base, autonomy: 'user_only' });
  assert.equal(agentClaimsHuman.decision, 'deny');
});

test('step 5 outbound delivery: an approved reply is sent exactly once', async () => {
  const contact = contactA();
  const gate = gateCommsAction({
    companyId: CO_A,
    action: 'customer_send',
    autonomy: 'auto',
    humanApproved: true,
    actorIsHuman: true,
    outbound: outboundFor(contact),
  });
  assert.equal(gate.decision, 'allow');

  const { http, calls } = createFakeHttp();
  const adapter = createAdapter({ http });
  const result = await adapter.send({ companyId: CO_A, to: CONTACT_PHONE, body: SAVED_REPLY_A.body });

  assert.deepEqual(result, { ok: true, externalId: 'uuid-1', auditRecorded: false });
  assert.equal(calls.length, 1, 'one approved reply makes one provider request');
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.dst, CONTACT_PHONE.replace(/^\+/, ''));
  assert.equal(sent.src, COMPANY_FROM.replace(/^\+/, ''));
  // Result carries no credentials or recipient number.
  assert.equal(JSON.stringify(result).includes('fake-auth-token'), false);
});

test('step 6 opt-out suppression: a contact STOP blocks the next send', async () => {
  const auditEntries = [];
  const suppression = createSuppressionList({
    audit: (entry) => auditEntries.push(entry),
    clock: () => NOW.toISOString(),
  });

  // The inbound STOP, as the inbound route would handle it.
  const stop = inboundSms({ providerMessageId: 'sms-in-stop', body: 'STOP' });
  const optOut = handleInboundOptOut({
    companyId: CO_A,
    channel: 'sms',
    from: CONTACT_PHONE,
    body: stop.body,
    suppression,
  });
  assert.deepEqual(optOut, { action: 'suppressed' });
  assert.equal(auditEntries.length, 1);
  assert.equal(auditEntries[0].change, 'suppressed');
  assert.equal(auditEntries[0].reason, 'unsubscribed');
  assert.equal(JSON.stringify(auditEntries[0]).includes(CONTACT_PHONE), false, 'audit holds a hash, not the number');

  // The contact record also gets the opt-out event, so consent alone refuses too.
  const contact = contactA();
  const event = consentEventForInboundKeyword({ channel: 'sms', body: 'STOP', contact, at: NOW });
  assert.deepEqual(event, { channel: 'sms', action: 'opt_out', at: NOW, source: 'contact' });
  const contactAfterStop = { ...contact, consents: [...contact.consents, event] };

  // Layer 1: the approval gate refuses before any approval is considered.
  const gate = gateCommsAction({
    companyId: CO_A,
    action: 'customer_send',
    autonomy: 'auto',
    humanApproved: true,
    actorIsHuman: true,
    outbound: outboundFor(contactAfterStop, { suppressed: suppression.isSuppressed(CO_A, { address: CONTACT_PHONE, channel: 'sms' }) }),
  });
  assert.equal(gate.decision, 'deny');
  assert.equal(gate.reason, 'recipient is on the suppression list');

  // Layer 2: the SMS adapter with the suppression list wired never reaches HTTP.
  const { http, calls } = createFakeHttp();
  const adapterWithSuppression = createAdapter({
    http,
    suppression,
    contacts: { [CO_A]: contactAfterStop },
  });
  const blocked = await adapterWithSuppression.send({ companyId: CO_A, to: CONTACT_PHONE, body: 'Hello again' });
  assert.deepEqual(blocked, { ok: false, reason: 'suppressed' });
  assert.equal(calls.length, 0, 'no provider request after STOP');

  // Layer 3: even without the suppression list, the contact's opt-out still blocks through consent.
  const { http: http2, calls: calls2 } = createFakeHttp();
  const adapterConsentOnly = createAdapter({ http: http2, contacts: { [CO_A]: contactAfterStop } });
  const consentBlocked = await adapterConsentOnly.send({ companyId: CO_A, to: CONTACT_PHONE, body: 'Hello again' });
  assert.deepEqual(consentBlocked, { ok: false, reason: 'opted_out' });
  assert.equal(calls2.length, 0);
});

test('step 7 tenant isolation: company B cannot match, assign, dedupe-collide, send to or suppress company A', async () => {
  // Matching: company A's thread is invisible to a company B inbound from the same number.
  const crossMatch = matchThread({
    inbound: { companyId: CO_B, channel: 'sms', fromAddress: CONTACT_PHONE, receivedAt: NOW },
    threads: [threadA()],
  });
  assert.deepEqual(crossMatch, { matched: false, reason: 'new_thread' });

  // Assignment: with only company A's thread open, company B staff are not a candidate for A's pool, and
  // a company B request with no company B staff available fails closed.
  const crossAssign = chooseAssignee({
    companyId: CO_B,
    staff: [STAFF[0], STAFF[1]],
    openThreads: [{ id: 'thread-a-1', companyId: CO_A, assigneeId: 'staff-a1', channel: 'sms' }],
    channel: 'sms',
  });
  assert.deepEqual(crossAssign, { ok: false, reason: 'no_available_staff' });

  // Dedupe: the same provider message id is new for company B, because the key includes company.
  const store = createFakeDedupeStore();
  assert.equal(await recordInboundMessage(store, inboundSms()), 'new');
  assert.equal(await recordInboundMessage(store, inboundSms({ companyId: CO_B })), 'new');

  // Suppression: company A's STOP does not suppress the same number for company B.
  const suppression = createSuppressionList({ audit: () => {}, clock: () => NOW.toISOString() });
  handleInboundOptOut({ companyId: CO_A, channel: 'sms', from: CONTACT_PHONE, body: 'STOP', suppression });
  assert.equal(suppression.isSuppressed(CO_A, { address: CONTACT_PHONE, channel: 'sms' }), true);
  assert.equal(suppression.isSuppressed(CO_B, { address: CONTACT_PHONE, channel: 'sms' }), false);

  // Sending: a company B send is refused at company resolution and never reaches HTTP.
  const { http, calls } = createFakeHttp();
  const adapter = createAdapter({ http });
  const crossSend = await adapter.send({ companyId: CO_B, to: CONTACT_PHONE, body: 'Hi' });
  assert.deepEqual(crossSend, { ok: false, reason: 'invalid_company' });
  assert.equal(calls.length, 0);

  // Gate: a company with no valid id is refused outright.
  const badGate = gateCommsAction({
    companyId: 'not-a-company',
    action: 'customer_send',
    autonomy: 'auto',
    humanApproved: true,
    actorIsHuman: true,
    outbound: outboundFor(contactA()),
  });
  assert.equal(badGate.decision, 'deny');
});

// Plivo SMS delivery-receipt and inbound STOP / START handlers (node:test). Fakes only: no database, network or logger.
// Silence the console first so the test runner's IPC is not disturbed.
for (const level of ['log', 'info', 'warn', 'error', 'debug']) console[level] = () => {};

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSmsInboundHandler,
  createSmsStatusHandler,
  processPlivoDeliveryReceipt,
  processPlivoInboundSms,
} from '../../server/modules/comms/sms-inbound-route.ts';
import { createSuppressionList } from '../../server/modules/comms/suppression.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const LINE_A = '61400000001'; // Plivo sends digits with no plus: our line for company A
const LINE_B = '61400000002';
const CUSTOMER = '+61400000000'; // E.164 phone held on the contact
const CUSTOMER_PLIVO = '61400000000';
const NOW = new Date('2026-11-04T12:00:00Z'); // 22:00 Melbourne, outside any quiet hours used here

function fakeMessages(rows, { failLookup = false, casResult = null } = {}) {
  const map = new Map(Object.entries(rows).map(([k, v]) => [k, v]));
  const writes = [];
  return {
    writes,
    store: {
      async lookupDeliveryStatus(companyId, externalId) {
        if (failLookup) throw new Error('db down: postgres://user:secret@host');
        const key = `${companyId}|${externalId}`;
        if (!map.has(key)) return { found: false };
        return { found: true, status: map.get(key) };
      },
      async compareAndSetDeliveryStatus({ companyId, externalId, expected, next, errorCode }) {
        if (casResult !== null) return casResult;
        const key = `${companyId}|${externalId}`;
        if (!map.has(key)) return false;
        if ((map.get(key) ?? null) !== expected) return false;
        map.set(key, next);
        writes.push({ companyId, externalId, next, errorCode });
        return true;
      },
    },
    get(companyId, externalId) {
      return map.get(`${companyId}|${externalId}`);
    },
  };
}

function fakeContacts(records, { failAppend = false, failFind = false } = {}) {
  const appended = [];
  return {
    appended,
    store: {
      async findByPhone(companyId, phone) {
        if (failFind) throw new Error('timeout');
        const hit = records.find((r) => r.companyId === companyId && r.contact.handles?.phone === phone);
        return hit ? { id: hit.id, contact: hit.contact } : null;
      },
      async appendConsentEvent(companyId, contactId, event) {
        if (failAppend) return false;
        const hit = records.find((r) => r.companyId === companyId && r.id === contactId);
        if (!hit) return false;
        hit.contact.consents = [...(hit.contact.consents ?? []), event];
        appended.push({ companyId, contactId, event });
        return true;
      },
    },
  };
}

function deps({ messages, contacts, suppression = createSuppressionList(), lines = { [LINE_A]: CO_A, [LINE_B]: CO_B } }) {
  return {
    resolveCompanyForNumber: (phone) => {
      const digits = phone.replace(/^\+/, '');
      return lines[digits] ?? null;
    },
    messages: messages.store,
    contacts: contacts.store,
    suppression,
    now: () => NOW,
  };
}

function freshContacts(extra = {}) {
  return [
    {
      id: 'c-a',
      companyId: CO_A,
      contact: { handles: { phone: CUSTOMER }, consents: [{ channel: 'sms', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }], ...extra },
    },
    {
      id: 'c-b',
      companyId: CO_B,
      contact: { handles: { phone: CUSTOMER }, consents: [{ channel: 'sms', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }] },
    },
  ];
}

const receipt = (overrides = {}) => ({
  MessageUUID: 'SM-1',
  Status: 'delivered',
  From: LINE_A,
  To: CUSTOMER_PLIVO,
  ...overrides,
});

const inboundText = (text, overrides = {}) => ({
  MessageUUID: 'IN-1',
  From: CUSTOMER_PLIVO,
  To: LINE_A,
  Text: text,
  ...overrides,
});

// ---------- Delivery receipts ----------

test('a receipt writes only to the row matching the resolved company and MessageUUID', async () => {
  const messages = fakeMessages({ [`${CO_A}|SM-1`]: 'queued', [`${CO_B}|SM-1`]: 'queued' });
  const out = await processPlivoDeliveryReceipt(deps({ messages, contacts: fakeContacts([]) }), receipt());
  assert.deepEqual(out, { code: 200 });
  assert.equal(messages.get(CO_A, 'SM-1'), 'delivered');
  assert.equal(messages.get(CO_B, 'SM-1'), 'queued');
  assert.equal(messages.writes.length, 1);
});

test('the company in the callback body is ignored; only the sender number decides', async () => {
  const messages = fakeMessages({ [`${CO_A}|SM-1`]: 'sent', [`${CO_B}|SM-1`]: 'sent' });
  const out = await processPlivoDeliveryReceipt(
    deps({ messages, contacts: fakeContacts([]) }),
    receipt({ companyId: CO_B, company_id: CO_B }),
  );
  assert.deepEqual(out, { code: 200 });
  assert.equal(messages.get(CO_A, 'SM-1'), 'delivered');
  assert.equal(messages.get(CO_B, 'SM-1'), 'sent');
});

test('an unknown sender number fails closed: 404, no lookup and no write', async () => {
  const messages = fakeMessages({ [`${CO_A}|SM-1`]: 'queued' });
  const out = await processPlivoDeliveryReceipt(
    deps({ messages, contacts: fakeContacts([]) }),
    receipt({ From: '61499999999' }),
  );
  assert.deepEqual(out, { code: 404 });
  assert.equal(messages.writes.length, 0);
});

test('a resolver that returns a non-UUID company is treated as unresolved', async () => {
  const messages = fakeMessages({ [`${CO_A}|SM-1`]: 'queued' });
  const d = deps({ messages, contacts: fakeContacts([]), lines: { [LINE_A]: 'not-a-company' } });
  const out = await processPlivoDeliveryReceipt(d, receipt());
  assert.deepEqual(out, { code: 404 });
  assert.equal(messages.writes.length, 0);
});

test('a receipt for a MessageUUID with no row in this company is 404 and writes nothing', async () => {
  const messages = fakeMessages({ [`${CO_B}|SM-1`]: 'queued' });
  const out = await processPlivoDeliveryReceipt(deps({ messages, contacts: fakeContacts([]) }), receipt());
  assert.deepEqual(out, { code: 404 });
  assert.equal(messages.get(CO_B, 'SM-1'), 'queued');
  assert.equal(messages.writes.length, 0);
});

test('a final status is not replaced by a later failure', async () => {
  const messages = fakeMessages({ [`${CO_A}|SM-1`]: 'delivered' });
  const out = await processPlivoDeliveryReceipt(
    deps({ messages, contacts: fakeContacts([]) }),
    receipt({ Status: 'failed' }),
  );
  assert.deepEqual(out, { code: 200 });
  assert.equal(messages.get(CO_A, 'SM-1'), 'delivered');
  assert.equal(messages.writes.length, 0);
});

test('an out-of-order queued receipt after sent is not written', async () => {
  const messages = fakeMessages({ [`${CO_A}|SM-1`]: 'sent' });
  const out = await processPlivoDeliveryReceipt(
    deps({ messages, contacts: fakeContacts([]) }),
    receipt({ Status: 'queued' }),
  );
  assert.deepEqual(out, { code: 200 });
  assert.equal(messages.get(CO_A, 'SM-1'), 'sent');
  assert.equal(messages.writes.length, 0);
});

test('an unknown provider status is acknowledged with no write', async () => {
  const messages = fakeMessages({ [`${CO_A}|SM-1`]: 'queued' });
  const out = await processPlivoDeliveryReceipt(
    deps({ messages, contacts: fakeContacts([]) }),
    receipt({ Status: 'rejected' }),
  );
  assert.deepEqual(out, { code: 200 });
  assert.equal(messages.writes.length, 0);
});

test('a receipt without a MessageUUID is malformed: 400, no write', async () => {
  const messages = fakeMessages({ [`${CO_A}|SM-1`]: 'queued' });
  const out = await processPlivoDeliveryReceipt(
    deps({ messages, contacts: fakeContacts([]) }),
    receipt({ MessageUUID: '' }),
  );
  assert.deepEqual(out, { code: 400 });
  assert.equal(messages.writes.length, 0);
});

test('a numeric ErrorCode is kept and a non-numeric one is dropped', async () => {
  const messages = fakeMessages({ [`${CO_A}|SM-1`]: 'sent' });
  await processPlivoDeliveryReceipt(
    deps({ messages, contacts: fakeContacts([]) }),
    receipt({ Status: 'undelivered', ErrorCode: '30003' }),
  );
  assert.equal(messages.writes[0].errorCode, '30003');

  const other = fakeMessages({ [`${CO_A}|SM-2`]: 'sent' });
  await processPlivoDeliveryReceipt(
    deps({ messages: other, contacts: fakeContacts([]) }),
    receipt({ MessageUUID: 'SM-2', Status: 'failed', ErrorCode: 'token=abc' }),
  );
  assert.equal(other.writes[0].errorCode, undefined);
});

test('a concurrent change between read and write answers 409 and does not overwrite', async () => {
  const messages = fakeMessages({ [`${CO_A}|SM-1`]: 'sent' }, { casResult: false });
  const out = await processPlivoDeliveryReceipt(deps({ messages, contacts: fakeContacts([]) }), receipt());
  assert.deepEqual(out, { code: 409 });
  assert.equal(messages.writes.length, 0);
});

test('a store failure answers 503 with no detail', async () => {
  const messages = fakeMessages({}, { failLookup: true });
  const res = [];
  await createSmsStatusHandler(deps({ messages, contacts: fakeContacts([]) }))(
    { body: receipt() },
    { sendStatus: (code) => res.push(code) },
  );
  assert.deepEqual(res, [503]);
});

test('the status handler sends only a numeric status code, never a body', async () => {
  const messages = fakeMessages({ [`${CO_A}|SM-1`]: 'queued' });
  const calls = [];
  const res = { sendStatus: (code) => calls.push(['sendStatus', code]), json: (b) => calls.push(['json', b]) };
  await createSmsStatusHandler(deps({ messages, contacts: fakeContacts([]) }))({ body: receipt() }, res);
  assert.deepEqual(calls, [['sendStatus', 200]]);
});

// ---------- Inbound STOP / START ----------

test('STOP suppresses the sender on SMS and appends an SMS-only opt-out, for this company only', async () => {
  const records = freshContacts();
  const contacts = fakeContacts(records);
  const suppression = createSuppressionList();
  const out = await processPlivoInboundSms(
    deps({ messages: fakeMessages({}), contacts, suppression }),
    inboundText('STOP'),
  );
  assert.deepEqual(out, { code: 200 });

  assert.equal(suppression.isSuppressed(CO_A, { address: CUSTOMER, channel: 'sms' }), true);
  assert.equal(suppression.isSuppressed(CO_B, { address: CUSTOMER, channel: 'sms' }), false);
  // An SMS STOP does not reach email: the same person's email address stays clear.
  assert.equal(suppression.isSuppressed(CO_A, { address: 'ada@example.com', channel: 'email' }), false);

  assert.equal(contacts.appended.length, 1);
  assert.equal(contacts.appended[0].companyId, CO_A);
  assert.deepEqual(
    { channel: contacts.appended[0].event.channel, action: contacts.appended[0].event.action, source: contacts.appended[0].event.source },
    { channel: 'sms', action: 'opt_out', source: 'contact' },
  );
  // Company B's contact with the same number keeps its single opt-in record.
  assert.equal(records[1].contact.consents.length, 1);
  assert.equal(records[1].contact.consents[0].action, 'opt_in');
});

test('STOP from a number with no contact is still suppressed, with no consent event written', async () => {
  const contacts = fakeContacts([]);
  const suppression = createSuppressionList();
  const out = await processPlivoInboundSms(
    deps({ messages: fakeMessages({}), contacts, suppression }),
    inboundText('stop'),
  );
  assert.deepEqual(out, { code: 200 });
  assert.equal(suppression.isSuppressed(CO_A, { address: CUSTOMER, channel: 'sms' }), true);
  assert.equal(contacts.appended.length, 0);
});

test('an inbound to a number that maps to no company is 404: no suppression and no consent event', async () => {
  const contacts = fakeContacts(freshContacts());
  const suppression = createSuppressionList();
  const out = await processPlivoInboundSms(
    deps({ messages: fakeMessages({}), contacts, suppression, lines: {} }),
    inboundText('STOP', { To: '61400009999' }),
  );
  assert.deepEqual(out, { code: 404 });
  assert.equal(suppression.isSuppressed(CO_A, { address: CUSTOMER, channel: 'sms' }), false);
  assert.equal(contacts.appended.length, 0);
});

test('a body that is not exactly a keyword changes nothing', async () => {
  const contacts = fakeContacts(freshContacts());
  const suppression = createSuppressionList();
  const out = await processPlivoInboundSms(
    deps({ messages: fakeMessages({}), contacts, suppression }),
    inboundText('stop it please'),
  );
  assert.deepEqual(out, { code: 200 });
  assert.equal(suppression.isSuppressed(CO_A, { address: CUSTOMER, channel: 'sms' }), false);
  assert.equal(contacts.appended.length, 0);
});

test('START lifts an unsubscribed SMS suppression and appends an SMS opt-in', async () => {
  const contacts = fakeContacts(freshContacts());
  const suppression = createSuppressionList();
  const d = deps({ messages: fakeMessages({}), contacts, suppression });
  await processPlivoInboundSms(d, inboundText('STOP'));
  const out = await processPlivoInboundSms(d, inboundText('START', { MessageUUID: 'IN-2' }));
  assert.deepEqual(out, { code: 200 });
  assert.equal(suppression.isSuppressed(CO_A, { address: CUSTOMER, channel: 'sms' }), false);
  const last = contacts.appended.at(-1).event;
  assert.deepEqual({ channel: last.channel, action: last.action, source: last.source }, { channel: 'sms', action: 'opt_in', source: 'contact' });
});

test('START with no opt-out on record grants nothing', async () => {
  const contacts = fakeContacts(freshContacts().map((r) => ({ ...r, contact: { ...r.contact, consents: [] } })));
  const suppression = createSuppressionList();
  const out = await processPlivoInboundSms(
    deps({ messages: fakeMessages({}), contacts, suppression }),
    inboundText('YES'),
  );
  assert.deepEqual(out, { code: 200 });
  assert.equal(contacts.appended.length, 0);
  assert.equal(suppression.isSuppressed(CO_A, { address: CUSTOMER, channel: 'sms' }), false);
});

test('START does not lift a bounce suppression, even when a consent opt-out is on record', async () => {
  const contacts = fakeContacts(
    freshContacts({ consents: [{ channel: 'sms', action: 'opt_out', at: '2026-10-01T00:00:00Z', source: 'contact' }] }),
  );
  const suppression = createSuppressionList();
  suppression.suppress(CO_A, { address: CUSTOMER, channel: 'sms', reason: 'bounce_hard' });
  const out = await processPlivoInboundSms(
    deps({ messages: fakeMessages({}), contacts, suppression }),
    inboundText('START'),
  );
  assert.deepEqual(out, { code: 200 });
  assert.equal(suppression.reasonFor(CO_A, { address: CUSTOMER, channel: 'sms' }), 'bounce_hard');
});

test('START after a restart (consent opt-out on record, suppression list empty) records the opt-in', async () => {
  const contacts = fakeContacts(
    freshContacts({ consents: [{ channel: 'sms', action: 'opt_out', at: '2026-10-01T00:00:00Z', source: 'contact' }] }),
  );
  const out = await processPlivoInboundSms(
    deps({ messages: fakeMessages({}), contacts, suppression: createSuppressionList() }),
    inboundText('START'),
  );
  assert.deepEqual(out, { code: 200 });
  assert.equal(contacts.appended.length, 1);
  assert.equal(contacts.appended[0].event.action, 'opt_in');
});

test('a contact whose stored phone does not match the sender gets no consent event', async () => {
  const contacts = fakeContacts([
    { id: 'c-a', companyId: CO_A, contact: { handles: { phone: '+61499999999' }, consents: [] } },
  ]);
  const suppression = createSuppressionList();
  const out = await processPlivoInboundSms(
    deps({ messages: fakeMessages({}), contacts, suppression }),
    inboundText('STOP'),
  );
  assert.deepEqual(out, { code: 200 });
  assert.equal(contacts.appended.length, 0);
  assert.equal(suppression.isSuppressed(CO_A, { address: CUSTOMER, channel: 'sms' }), true);
});

test('when the consent write fails the handler answers 503, and a retry converges', async () => {
  const failing = fakeContacts(freshContacts(), { failAppend: true });
  const suppression = createSuppressionList();
  const first = await processPlivoInboundSms(
    deps({ messages: fakeMessages({}), contacts: failing, suppression }),
    inboundText('STOP'),
  );
  assert.deepEqual(first, { code: 503 });
  // Suppression is applied first, so the sender is blocked even before the retry lands.
  assert.equal(suppression.isSuppressed(CO_A, { address: CUSTOMER, channel: 'sms' }), true);

  const working = fakeContacts(freshContacts());
  const retry = await processPlivoInboundSms(
    deps({ messages: fakeMessages({}), contacts: working, suppression }),
    inboundText('STOP', { MessageUUID: 'IN-retry' }),
  );
  assert.deepEqual(retry, { code: 200 });
  assert.equal(working.appended.length, 1);
  assert.equal(working.appended[0].event.action, 'opt_out');
});

test('a START retried after its consent write failed still records the opt-in', async () => {
  const records = freshContacts({ consents: [{ channel: 'sms', action: 'opt_out', at: '2026-10-01T00:00:00Z', source: 'contact' }] });
  const suppression = createSuppressionList();
  suppression.suppress(CO_A, { address: CUSTOMER, channel: 'sms', reason: 'unsubscribed' });
  const failing = fakeContacts(records, { failAppend: true });
  const first = await processPlivoInboundSms(
    deps({ messages: fakeMessages({}), contacts: failing, suppression }),
    inboundText('START'),
  );
  assert.deepEqual(first, { code: 503 });
  assert.equal(suppression.isSuppressed(CO_A, { address: CUSTOMER, channel: 'sms' }), false);

  const working = fakeContacts(records);
  const retry = await processPlivoInboundSms(
    deps({ messages: fakeMessages({}), contacts: working, suppression }),
    inboundText('START', { MessageUUID: 'IN-retry' }),
  );
  assert.deepEqual(retry, { code: 200 });
  assert.equal(working.appended.length, 1);
  assert.equal(working.appended[0].event.action, 'opt_in');
});

test('a failed contact lookup on STOP answers 503 and the STOP is still suppressed', async () => {
  const suppression = createSuppressionList();
  const out = await processPlivoInboundSms(
    deps({ messages: fakeMessages({}), contacts: fakeContacts(freshContacts(), { failFind: true }), suppression }),
    inboundText('STOP'),
  );
  assert.deepEqual(out, { code: 503 });
  assert.equal(suppression.isSuppressed(CO_A, { address: CUSTOMER, channel: 'sms' }), true);
});

test('an inbound without a MessageUUID is malformed: 400, nothing changes', async () => {
  const contacts = fakeContacts(freshContacts());
  const suppression = createSuppressionList();
  const out = await processPlivoInboundSms(
    deps({ messages: fakeMessages({}), contacts, suppression }),
    inboundText('STOP', { MessageUUID: undefined }),
  );
  assert.deepEqual(out, { code: 400 });
  assert.equal(suppression.isSuppressed(CO_A, { address: CUSTOMER, channel: 'sms' }), false);
});

test('the inbound handler answers with a numeric code only and never echoes the message body', async () => {
  const calls = [];
  const res = { sendStatus: (code) => calls.push(['sendStatus', code]), json: (b) => calls.push(['json', b]) };
  const handler = createSmsInboundHandler(
    deps({ messages: fakeMessages({}), contacts: fakeContacts(freshContacts()), suppression: createSuppressionList() }),
  );
  await handler({ body: inboundText('STOP please, my token is abc123') }, res);
  assert.deepEqual(calls, [['sendStatus', 200]]);
});

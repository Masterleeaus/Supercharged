// Quote, invoice and lead follow-up (#361): schedule validation, the planned sequence over
// simulated time, payment demands held for approval, escalation and expiry. In-memory ports only.
// The transport is a recording fake and never sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreSendGate } from '../../server/modules/comms/presend-gate.ts';
import { createSuppressionList } from '../../server/modules/comms/suppression.ts';
import { DEFAULT_SCHEDULES, parseSchedule } from '../../server/modules/marketing/workflows/follow-up-schedule.ts';
import { planFollowUp, runFollowUpPass } from '../../server/modules/marketing/workflows/follow-up-runner.ts';

const CO = '11111111-1111-4111-8111-111111111111';
const DAY = 24 * 3_600_000;
const T0 = Date.parse('2026-10-01T00:00:00Z');
const at = (days) => new Date(T0 + days * DAY);

function world({ contacts = {} } = {}) {
  let clock = T0;
  const items = new Map();
  const sent = [];
  const escalations = [];
  const approvalRequests = [];
  const approved = new Set();
  const gate = createPreSendGate({
    suppression: createSuppressionList(),
    async loadContact(_c, _ch, address) {
      return contacts[address] ?? null;
    },
    async loadQuietHours() {
      return null;
    },
    now: () => new Date(clock),
    async recordBlocked() {},
  });
  const deps = {
    gate,
    transport: {
      async send(message) {
        sent.push(message);
        return { externalId: `ext-${sent.length}` };
      },
    },
    store: {
      async update(companyId, id, patch) {
        const item = items.get(`${companyId}|${id}`);
        Object.assign(item, patch);
      },
    },
    approvals: {
      async isApproved(companyId, itemId, stepIndex) {
        return approved.has(`${companyId}|${itemId}|${stepIndex}`);
      },
      async request(companyId, itemId, stepIndex) {
        approvalRequests.push({ companyId, itemId, stepIndex });
      },
    },
    escalations: {
      async escalate(companyId, itemId, reason) {
        escalations.push({ itemId, reason });
      },
    },
    now: () => new Date(clock),
  };
  return {
    deps,
    items,
    sent,
    escalations,
    approvalRequests,
    approve(itemId, stepIndex) {
      approved.add(`${CO}|${itemId}|${stepIndex}`);
    },
    setDay(day) {
      clock = T0 + day * DAY;
    },
    add(item) {
      items.set(`${CO}|${item.id}`, { companyId: CO, expired: false, escalated: false, attempts: 0, ...item });
    },
    /** Runs one pass at the given day, using the current stored state of every item. */
    async pass(day) {
      this.setDay(day);
      const list = [...items.values()].map((i) => ({ ...i }));
      return runFollowUpPass(deps, list, DEFAULT_SCHEDULES);
    },
  };
}

const consented = (address) => ({
  handles: { email: address },
  consents: [{ channel: 'email', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }],
  timezone: 'Australia/Melbourne',
});

test('schedule: defaults are valid and a company override is merged and checked', () => {
  for (const kind of ['quote', 'invoice', 'lead']) {
    assert.equal(parseSchedule(kind, undefined).ok, true);
  }
  const ok = parseSchedule('quote', { steps: [{ afterHours: 48, kind: 'reminder' }], escalateAfterAttempts: 1 });
  assert.equal(ok.ok, true);
  assert.equal(ok.schedule.steps.length, 1);
  assert.equal(ok.schedule.expireAfterHours, DEFAULT_SCHEDULES.quote.expireAfterHours);
});

test('schedule: bad overrides are rejected with every error listed', () => {
  const bad = parseSchedule('lead', {
    steps: [{ afterHours: 24, kind: 'reminder' }, { afterHours: 2, kind: 'payment_demand' }],
    escalateAfterAttempts: 0,
    expireAfterHours: 48,
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length >= 3);
  assert.ok(bad.errors.some((e) => /later than the step before/.test(e)));
  assert.ok(bad.errors.some((e) => /lead cannot receive a payment demand/.test(e)));
  assert.ok(bad.errors.some((e) => /only quotes can expire/.test(e)));
});

test('unpaid invoice: reminders at 7 and 14 days, payment demand at 30 days only after approval, then a person takes over', async () => {
  const w = world({ contacts: { 'pay@example.com': consented('pay@example.com') } });
  w.add({
    id: 'inv-1',
    kind: 'invoice',
    anchorAt: at(0).toISOString(),
    channel: 'email',
    address: 'pay@example.com',
    resolved: false,
    subject: 'Invoice 1001',
    body: 'Your invoice is unpaid.',
  });

  assert.deepEqual((await w.pass(6)).map((r) => r.outcome), ['waiting']);
  assert.deepEqual((await w.pass(7)).map((r) => r.outcome), ['send']);
  assert.deepEqual((await w.pass(9)).map((r) => r.outcome), ['waiting']);
  assert.deepEqual((await w.pass(14)).map((r) => r.outcome), ['send']);

  // Day 30: a payment demand. Without approval nothing is sent and a request is raised.
  assert.deepEqual((await w.pass(30)).map((r) => r.outcome), ['approval']);
  assert.equal(w.sent.length, 2);
  assert.equal(w.approvalRequests.length, 1);

  // Approved: the demand goes out and the item has used its three attempts.
  w.approve('inv-1', 2);
  assert.deepEqual((await w.pass(30)).map((r) => r.outcome), ['send']);
  assert.equal(w.sent.length, 3);

  // Next pass: attempts used up, so a person takes over and no more messages go out.
  const last = await w.pass(31);
  assert.equal(last[0].outcome, 'escalated');
  assert.equal(w.escalations[0].reason, 'attempts_exhausted');
  assert.equal(w.sent.length, 3);
});

test('a payment demand is never sent without approval, even though the gate would allow it', async () => {
  const w = world({ contacts: { 'pay@example.com': consented('pay@example.com') } });
  w.add({
    id: 'inv-2',
    kind: 'invoice',
    anchorAt: at(0).toISOString(),
    channel: 'email',
    address: 'pay@example.com',
    resolved: false,
    attempts: 2,
    subject: null,
    body: 'Please pay.',
  });
  const r = await w.pass(30);
  assert.equal(r[0].outcome, 'approval');
  assert.equal(w.sent.length, 0);
});

test('unanswered quote: reminders at 3, 7 and 14 days, a person takes over, and the quote expires at 30 days', async () => {
  const w = world({ contacts: { 'q@example.com': consented('q@example.com') } });
  w.add({
    id: 'quote-1',
    kind: 'quote',
    anchorAt: at(0).toISOString(),
    channel: 'email',
    address: 'q@example.com',
    resolved: false,
    subject: 'Your quote',
    body: 'Still interested?',
  });
  assert.equal((await w.pass(2))[0].outcome, 'waiting');
  assert.equal((await w.pass(3))[0].outcome, 'send');
  assert.equal((await w.pass(7))[0].outcome, 'send');
  assert.equal((await w.pass(14))[0].outcome, 'send');
  assert.equal(w.sent.length, 3);
  assert.equal((await w.pass(20))[0].outcome, 'escalated');
  assert.equal((await w.pass(30))[0].outcome, 'expired');
  // An expired quote gets nothing more.
  assert.equal((await w.pass(40))[0].reason, 'expired');
  assert.equal(w.sent.length, 3);
});

test('a resolved quote or invoice gets no further messages', async () => {
  const w = world({ contacts: { 'q@example.com': consented('q@example.com') } });
  w.add({
    id: 'quote-2',
    kind: 'quote',
    anchorAt: at(0).toISOString(),
    channel: 'email',
    address: 'q@example.com',
    resolved: true,
    subject: null,
    body: 'x',
  });
  const r = await w.pass(10);
  assert.equal(r[0].outcome, 'none');
  assert.equal(r[0].reason, 'resolved');
  assert.equal(w.sent.length, 0);
});

test('consent denied: no send, and the client is handed to a person as not contactable', async () => {
  const w = world({ contacts: {} });
  w.add({
    id: 'lead-1',
    kind: 'lead',
    anchorAt: at(0).toISOString(),
    channel: 'email',
    address: 'nobody@example.com',
    resolved: false,
    subject: null,
    body: 'Hi',
  });
  const r = await w.pass(0.1);
  assert.equal(r[0].outcome, 'blocked');
  assert.equal(r[0].reason, 'no_consent');
  assert.equal(w.sent.length, 0);
  assert.equal(w.escalations[0].reason, 'not_contactable:no_consent');
});

test('quiet hours defer a reminder without counting an attempt', async () => {
  const w = world({ contacts: { 'late@example.com': { ...consented('late@example.com'), timezone: 'Australia/Melbourne' } } });
  // Replace the gate's quiet hours with a window that covers the clock time used here.
  const quietGate = createPreSendGate({
    suppression: createSuppressionList(),
    async loadContact() {
      return { ...consented('late@example.com') };
    },
    async loadQuietHours() {
      return { startHour: 0, endHour: 23 };
    },
    now: () => new Date(T0 + 7 * DAY),
    async recordBlocked() {},
  });
  w.deps.gate = quietGate;
  w.add({
    id: 'inv-q',
    kind: 'invoice',
    anchorAt: at(0).toISOString(),
    channel: 'email',
    address: 'late@example.com',
    resolved: false,
    subject: null,
    body: 'Reminder',
  });
  const r = await w.pass(7);
  assert.equal(r[0].outcome, 'deferred');
  assert.equal(w.sent.length, 0);
  assert.equal(w.items.get(`${CO}|inv-q`).attempts, 0);
});

test('planFollowUp refuses a schedule for another kind', () => {
  assert.throws(() =>
    planFollowUp(
      { companyId: CO, id: 'x', kind: 'quote', anchorAt: at(0).toISOString(), channel: 'email', address: 'a@b.co', resolved: false, attempts: 0, expired: false, escalated: false, subject: null, body: '' },
      DEFAULT_SCHEDULES.invoice,
      at(5),
    ),
  RangeError);
});

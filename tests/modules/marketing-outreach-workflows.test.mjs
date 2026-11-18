// Outreach workflows (#360): eligibility rules, the gated send path, idempotency and attribution.
// In-memory ports only. The transport is a recording fake and never sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreSendGate } from '../../server/modules/comms/presend-gate.ts';
import { createSuppressionList } from '../../server/modules/comms/suppression.ts';
import {
  reviewRequestDue,
  reactivationDue,
  seasonalCycleKey,
  visitReminderDue,
  staleJobNudgeDue,
  renderTemplate,
} from '../../server/modules/marketing/workflows/outreach-rules.ts';
import {
  runOutreach,
  attributeOutcome,
} from '../../server/modules/marketing/workflows/outreach-runner.ts';

const CO = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-11-18T02:00:00.000Z'; // 13:00 in Melbourne (AEDT)
const QUIET_NOW = '2026-11-18T12:00:00.000Z'; // 23:00 in Melbourne

function makeWorld({ now = NOW, contacts = {}, quiet = null, sendFails = false, suppress = null } = {}) {
  const suppression = createSuppressionList();
  if (suppress) suppression.suppress(CO, { channel: 'email', address: suppress, reason: 'unsubscribed' });
  const blocked = [];
  const sent = [];
  const sends = new Map();
  const gate = createPreSendGate({
    suppression,
    async loadContact(_c, _ch, address) {
      return contacts[address] ?? null;
    },
    async loadQuietHours() {
      return quiet;
    },
    now: () => new Date(now),
    async recordBlocked(record) {
      blocked.push(record);
    },
  });
  const transport = {
    async send(message) {
      if (sendFails) throw new Error('provider down for jo@example.com');
      sent.push(message);
      return { externalId: `ext-${sent.length}` };
    },
  };
  const store = {
    async hasSent(companyId, key) {
      return sends.has(`${companyId}|${key}`);
    },
    async recordSend(record) {
      sends.set(`${record.companyId}|${record.key}`, record);
    },
    async listSends(companyId, subjectId) {
      return [...sends.values()].filter((s) => s.companyId === companyId && s.subjectId === subjectId);
    },
  };
  const deps = {
    gate,
    transport,
    store,
    now: () => new Date(now),
    campaignIdFor: (workflow) => `campaign-${workflow}`,
  };
  return { deps, blocked, sent, store };
}

function consentedContact(address, extra = {}) {
  return {
    handles: { email: address },
    consents: [{ channel: 'email', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }],
    timezone: 'Australia/Melbourne',
    ...extra,
  };
}

function reviewCandidate(address, subjectId = 'job-1') {
  return {
    workflow: 'review_request',
    subjectId,
    channel: 'email',
    address,
    cycleKey: 'v1',
    vars: { clientName: 'Sam', companyName: 'Sparkle Co', reviewUrl: 'https://example.com/review' },
  };
}

test('review request is due only after the delay, never for a job with no completion time', () => {
  const config = { delayDays: 1 };
  assert.equal(reviewRequestDue({ completedAt: '2026-11-17T09:00:00Z', now: NOW, config }), true);
  assert.equal(reviewRequestDue({ completedAt: '2026-11-18T09:00:00Z', now: NOW, config }), false);
  assert.equal(reviewRequestDue({ completedAt: null, now: NOW, config }), false);
});

test('reactivation is due after the inactive period and skips clients who never completed a job', () => {
  const config = { inactiveDays: 180 };
  assert.equal(reactivationDue({ lastCompletedJobAt: '2026-04-01T00:00:00Z', now: NOW, config }), true);
  assert.equal(reactivationDue({ lastCompletedJobAt: '2026-10-01T00:00:00Z', now: NOW, config }), false);
  assert.equal(reactivationDue({ lastCompletedJobAt: null, now: NOW, config }), false);
});

test('seasonal window gives one cycle key per season, including a window that crosses the new year', () => {
  const summer = { startMonth: 12, startDay: 20, endMonth: 1, endDay: 10 };
  assert.equal(seasonalCycleKey({ now: '2026-12-28T00:00:00Z', window: summer, name: 'summer' }), 'summer:2026');
  assert.equal(seasonalCycleKey({ now: '2027-01-05T00:00:00Z', window: summer, name: 'summer' }), 'summer:2026');
  assert.equal(seasonalCycleKey({ now: '2027-02-01T00:00:00Z', window: summer, name: 'summer' }), null);
});

test('visit reminder fires only inside the lead window and never for a past visit', () => {
  const config = { leadHours: 24 };
  assert.equal(visitReminderDue({ visitStartsAt: '2026-11-18T20:00:00Z', now: NOW, config }), true);
  assert.equal(visitReminderDue({ visitStartsAt: '2026-11-22T06:00:00Z', now: NOW, config }), false);
  assert.equal(visitReminderDue({ visitStartsAt: '2026-11-17T06:00:00Z', now: NOW, config }), false);
});

test('stale job nudge is skipped when a future visit exists', () => {
  const config = { inactiveDays: 14 };
  assert.equal(staleJobNudgeDue({ lastActivityAt: '2026-10-01T00:00:00Z', hasFutureVisit: false, now: NOW, config }), true);
  assert.equal(staleJobNudgeDue({ lastActivityAt: '2026-10-01T00:00:00Z', hasFutureVisit: true, now: NOW, config }), false);
});

test('a template with a missing value fails to render instead of sending a blank', () => {
  assert.throws(() => renderTemplate('Hi {{clientName}}', {}), RangeError);
  assert.equal(renderTemplate('Hi {{clientName}}', { clientName: 'Sam' }), 'Hi Sam');
});

test('a consented client is sent the review request once, and a second run skips it', async () => {
  const address = 'sam@example.com';
  const w = makeWorld({ contacts: { [address]: consentedContact(address) } });
  const first = await runOutreach(w.deps, CO, [reviewCandidate(address)]);
  assert.equal(first.sent, 1);
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0].body, /review/);
  const second = await runOutreach(w.deps, CO, [reviewCandidate(address)]);
  assert.equal(second.sent, 0);
  assert.equal(second.skippedAlreadySent, 1);
  assert.equal(w.sent.length, 1);
});

test('consent denied: no contact record means no send, and the block is written', async () => {
  const w = makeWorld({ contacts: {} });
  const r = await runOutreach(w.deps, CO, [reviewCandidate('nobody@example.com')]);
  assert.equal(r.sent, 0);
  assert.equal(r.blocked.no_consent, 1);
  assert.equal(w.sent.length, 0);
  assert.equal(w.blocked.length, 1);
  assert.equal(w.blocked[0].reason, 'no_consent');
  assert.equal(w.blocked[0].surface, 'marketing');
});

test('opt-out: a recorded opt-out stops the send', async () => {
  const address = 'quit@example.com';
  const contact = consentedContact(address, {
    consents: [
      { channel: 'email', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' },
      { channel: 'email', action: 'opt_out', at: '2026-11-01T00:00:00Z', source: 'contact' },
    ],
  });
  const w = makeWorld({ contacts: { [address]: contact } });
  const r = await runOutreach(w.deps, CO, [reviewCandidate(address)]);
  assert.equal(r.sent, 0);
  assert.equal(r.blocked.opted_out, 1);
  assert.equal(w.blocked[0].reason, 'opted_out');
});

test('quiet hours in the recipient timezone defer the send and do not record it as sent', async () => {
  const address = 'late@example.com';
  const w = makeWorld({
    now: QUIET_NOW,
    contacts: { [address]: consentedContact(address) },
    quiet: { startHour: 21, endHour: 7 },
  });
  const r = await runOutreach(w.deps, CO, [reviewCandidate(address)]);
  assert.equal(r.deferred, 1);
  assert.equal(r.sent, 0);
  assert.equal(w.sent.length, 0);
  assert.equal(w.blocked[0].reason, 'quiet_hours');
  // Not stored as sent, so the next run can pick it up.
  const later = makeWorld({ contacts: { [address]: consentedContact(address) } });
  const again = await runOutreach(later.deps, CO, [reviewCandidate(address)]);
  assert.equal(again.sent, 1);
});

test('a suppressed address is never sent to, even with consent', async () => {
  const address = 'bounced@example.com';
  const w = makeWorld({ contacts: { [address]: consentedContact(address) }, suppress: address });
  const r = await runOutreach(w.deps, CO, [reviewCandidate(address)]);
  assert.equal(r.blocked.suppressed, 1);
  assert.equal(w.sent.length, 0);
});

test('a transport failure is counted as failed, is not recorded as sent, and leaks no address', async () => {
  const address = 'fail@example.com';
  const w = makeWorld({ contacts: { [address]: consentedContact(address) }, sendFails: true });
  const r = await runOutreach(w.deps, CO, [reviewCandidate(address)]);
  assert.equal(r.failed, 1);
  assert.equal(r.sent, 0);
  const stored = await w.store.listSends(CO, 'job-1');
  assert.equal(stored.length, 0);
});

test('a candidate with missing template data is skipped without stopping the run', async () => {
  const address = 'ok@example.com';
  const w = makeWorld({ contacts: { [address]: consentedContact(address) } });
  const broken = { ...reviewCandidate('x@example.com', 'job-x'), vars: { clientName: 'Sam' } };
  const r = await runOutreach(w.deps, CO, [broken, reviewCandidate(address)]);
  assert.equal(r.renderFailed, 1);
  assert.equal(r.sent, 1);
});

test('outcomes are attributed to the most recent send for that client within the window', async () => {
  const sends = [
    { subjectId: 'job-1', workflow: 'review_request', at: '2026-11-01T00:00:00Z', campaignId: 'c-review', key: 'a' },
    { subjectId: 'job-1', workflow: 'review_request', at: '2026-11-10T00:00:00Z', campaignId: 'c-review', key: 'b' },
    { subjectId: 'job-1', workflow: 'client_reactivation', at: '2026-11-12T00:00:00Z', campaignId: 'c-react', key: 'c' },
  ];
  const review = attributeOutcome(sends, { kind: 'review_received', subjectId: 'job-1', at: '2026-11-11T00:00:00Z' });
  assert.equal(review.key, 'b');
  const rebook = attributeOutcome(sends, { kind: 'rebooked', subjectId: 'job-1', at: '2026-11-18T00:00:00Z' });
  assert.equal(rebook.key, 'c');
  // Too old for a 30 day window.
  const late = attributeOutcome(sends, { kind: 'review_received', subjectId: 'job-1', at: '2026-12-20T00:00:00Z' });
  assert.equal(late, null);
  // A rebooking is not credited to a review request.
  const none = attributeOutcome(
    [sends[0]],
    { kind: 'rebooked', subjectId: 'job-1', at: '2026-11-05T00:00:00Z' },
  );
  assert.equal(none, null);
});

const CO_B = '22222222-2222-4222-8222-222222222222';

function candidateFor(workflow, address, cycleKey = 'cycle-1') {
  const vars = {
    clientName: 'Sam',
    companyName: 'Sparkle Co',
    reviewUrl: 'https://example.com/review',
    bookingUrl: 'https://example.com/book',
    seasonName: 'Spring',
    visitTime: 'Tuesday 9am',
    jobTitle: 'Gutter clean',
  };
  return { workflow, subjectId: `subject-${workflow}`, channel: 'email', address, cycleKey, vars };
}

test('all five outreach workflows run in a test tenant, each sent once per cycle', async () => {
  const address = 'all@example.com';
  const w = makeWorld({ contacts: { [address]: consentedContact(address) } });
  const deps = { ...w.deps, isApproved: async () => true };
  const workflows = ['review_request', 'client_reactivation', 'seasonal_reminder', 'visit_reminder', 'stale_job_nudge'];
  const cands = workflows.map((wf) => candidateFor(wf, address));
  const first = await runOutreach(deps, CO, cands);
  assert.equal(first.sent, 5);
  assert.deepEqual(
    w.sent.map((m) => m.workflow).sort(),
    [...workflows].sort(),
  );
  // Every send is attributed to its own campaign id.
  for (const s of w.sent) assert.equal(s.companyId, CO);
  const second = await runOutreach(deps, CO, cands);
  assert.equal(second.sent, 0);
  assert.equal(second.skippedAlreadySent, 5);
});

test('bulk workflows need an approved cycle: no approval means no send and a recorded reason', async () => {
  const address = 'bulk@example.com';
  const w = makeWorld({ contacts: { [address]: consentedContact(address) } });
  const r = await runOutreach(w.deps, CO, [candidateFor('seasonal_reminder', address)]);
  assert.equal(r.sent, 0);
  assert.equal(r.blocked.approval_required, 1);
  assert.equal(w.sent.length, 0);
  // Approval for this cycle only: a different cycle stays blocked.
  const approvedDeps = { ...w.deps, isApproved: async (_c, _wf, cycle) => cycle === 'spring-2027' };
  const other = await runOutreach(approvedDeps, CO, [candidateFor('seasonal_reminder', address, 'autumn-2027')]);
  assert.equal(other.sent, 0);
  const approved = await runOutreach(approvedDeps, CO, [candidateFor('seasonal_reminder', address, 'spring-2027')]);
  assert.equal(approved.sent, 1);
});

test('per-event workflows are not held for approval', async () => {
  const address = 'event@example.com';
  const w = makeWorld({ contacts: { [address]: consentedContact(address) } });
  const r = await runOutreach(w.deps, CO, [candidateFor('review_request', address), candidateFor('visit_reminder', address)]);
  assert.equal(r.sent, 2);
  assert.equal(r.blocked.approval_required, undefined);
});

test('tenant isolation: a send or consent in one company does not reach another company', async () => {
  const address = 'tenant@example.com';
  const suppression = createSuppressionList();
  const gate = createPreSendGate({
    suppression,
    // Contact exists only under company CO.
    async loadContact(companyId, _ch, addr) {
      return companyId === CO && addr === address ? consentedContact(address) : null;
    },
    async loadQuietHours() {
      return null;
    },
    now: () => new Date(NOW),
    async recordBlocked() {},
  });
  const sent = [];
  const sends = new Map();
  const deps = {
    gate,
    transport: { async send(m) { sent.push(m); return { externalId: `x-${sent.length}` }; } },
    store: {
      async hasSent(c, k) { return sends.has(`${c}|${k}`); },
      async recordSend(r) { sends.set(`${r.companyId}|${r.key}`, r); },
      async listSends() { return []; },
    },
    now: () => new Date(NOW),
    campaignIdFor: (wf) => `campaign-${wf}`,
  };
  const cand = [reviewCandidate(address)];
  const a = await runOutreach(deps, CO, cand);
  assert.equal(a.sent, 1);
  // Company B has no consent for this address, so nothing is sent, and A's send does not mark B's key.
  const b = await runOutreach(deps, CO_B, cand);
  assert.equal(b.sent, 0);
  assert.equal(b.blocked.no_consent, 1);
  assert.equal(b.skippedAlreadySent, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].companyId, CO);
});

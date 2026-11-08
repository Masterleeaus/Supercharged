// Comms audit event vocabulary and builder (node:test). Pure functions only: no database, no network.
// Console is silenced because the module is server code and the test runner's IPC must stay clean.
const noop = () => {};
console.log = noop;
console.info = noop;
console.warn = noop;
console.error = noop;

import test from 'node:test';
import assert from 'node:assert/strict';
import * as events from '../../server/modules/comms/comms-audit-events.ts';
import { buildCommsAuditEvent, COMMS_EVENT_TYPES, CommsAuditEventRefused } from '../../server/modules/comms/comms-audit-events.ts';

const CO = '11111111-1111-4111-8111-111111111111';
const AT = '2026-11-04T09:00:00.000Z';
const TARGET = { type: 'draft', id: 'draft-1' };

function input(overrides = {}) {
  return { companyId: CO, actorId: 'staff-7', at: AT, target: TARGET, ...overrides };
}

function refusedReason(fn) {
  try {
    fn();
  } catch (error) {
    if (error instanceof CommsAuditEventRefused) return error.reason;
    throw error;
  }
  return null;
}

const DETAIL_FOR = {
  'comms.draft_created': { channel: 'email' },
  'comms.draft_edited': { channel: 'sms' },
  'comms.approval_recorded': { decision: 'approved' },
  'comms.message_sent': { channel: 'whatsapp' },
  'comms.assignment_changed': { assigneeId: 'staff-9' },
  'comms.campaign_changed': { change: 'started' },
  'comms.provider_event': { provider: 'mailer', providerEvent: 'delivered' },
  'comms.human_override': { overridden: 'suppression', reason: 'customer asked' },
};

test('vocabulary covers the checklist categories and has no update or delete types', () => {
  assert.equal(COMMS_EVENT_TYPES.length, 8);
  for (const word of ['draft', 'approval', 'sent', 'edited', 'assignment', 'campaign', 'provider', 'override']) {
    assert.ok(COMMS_EVENT_TYPES.some((t) => t.includes(word)), `a type covers ${word}`);
  }
  assert.ok(!COMMS_EVENT_TYPES.some((t) => /update|delete|remove|deleted|updated/.test(t)));
  assert.ok(!Object.keys(events).some((name) => /update|delete|remove|modify|patch/i.test(name)));
});

test('each type builds an event with company, actor, time, target and its own detail', () => {
  for (const type of COMMS_EVENT_TYPES) {
    const event = buildCommsAuditEvent(type, input({ detail: DETAIL_FOR[type] }));
    assert.equal(event.type, type);
    assert.equal(event.companyId, CO);
    assert.equal(event.actorId, 'staff-7');
    assert.equal(event.at, AT);
    assert.deepEqual(event.target, TARGET);
    assert.deepEqual({ ...event.detail }, DETAIL_FOR[type], `${type} keeps its allowed detail`);
    assert.ok(Object.isFrozen(event));
  }
});

test('every type refuses a missing, blank or non-UUID company', () => {
  for (const type of COMMS_EVENT_TYPES) {
    for (const companyId of [undefined, null, '', '   ', 'not-a-uuid', 42]) {
      assert.equal(refusedReason(() => buildCommsAuditEvent(type, input({ companyId }))), 'invalid_company', `${type} with ${String(companyId)}`);
    }
  }
});

test('an unknown type, a blank actor, a bad time and a missing target are refused', () => {
  assert.equal(refusedReason(() => buildCommsAuditEvent('comms.message_updated', input())), 'unknown_type');
  assert.equal(refusedReason(() => buildCommsAuditEvent('comms.message_sent', input({ actorId: ' ' }))), 'invalid_actor');
  assert.equal(refusedReason(() => buildCommsAuditEvent('comms.message_sent', input({ at: '2026-11-04' }))), 'invalid_time');
  assert.equal(refusedReason(() => buildCommsAuditEvent('comms.message_sent', input({ at: 'not a date' }))), 'invalid_time');
  assert.equal(refusedReason(() => buildCommsAuditEvent('comms.message_sent', input({ target: { type: 'draft' } }))), 'invalid_target');
  assert.equal(refusedReason(() => buildCommsAuditEvent('comms.message_sent', input({ target: undefined }))), 'invalid_target');
});

test('detail is limited to the allowlist: message bodies and addresses are dropped', () => {
  const event = buildCommsAuditEvent('comms.message_sent', input({
    detail: { channel: 'email', body: 'hello there', address: 'ann@example.com' },
  }));
  assert.deepEqual({ ...event.detail }, { channel: 'email' });
  assert.ok(!JSON.stringify(event).includes('ann@example.com'));
});

test('an approval decision outside approved or rejected is refused', () => {
  assert.equal(
    refusedReason(() => buildCommsAuditEvent('comms.approval_recorded', input({ detail: { decision: 'maybe' } }))),
    'invalid_detail',
  );
});

test('an assignment may be cleared with a null assignee, other fields may not be null', () => {
  const cleared = buildCommsAuditEvent('comms.assignment_changed', input({ detail: { assigneeId: null } }));
  assert.equal(cleared.detail.assigneeId, null);
  assert.equal(
    refusedReason(() => buildCommsAuditEvent('comms.message_sent', input({ detail: { channel: null } }))),
    'invalid_detail',
  );
});

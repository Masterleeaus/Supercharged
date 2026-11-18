// Telephony call flow decisions (issue #328). Fake numbers, fake secrets, in-memory ports only.
// Run: node --test --experimental-transform-types tests/security/telephony-call-flow.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreSendGate } from '../../server/modules/comms/presend-gate.ts';
import { createSuppressionList } from '../../server/modules/comms/suppression.ts';
import { decideCallFlow } from '../../server/modules/comms/telephony-call-flow.ts';
import { createReplayGuard } from '../../server/middleware/webhook-replay.ts';
import {
  processTelephonyEvent,
  signTelephonyEvent,
  verifyTelephonyEvent,
  TELEPHONY_EVENT_ID_HEADER,
  TELEPHONY_SIGNATURE_HEADER,
  TELEPHONY_TIMESTAMP_HEADER,
} from '../../server/modules/comms/telephony-event-adapter.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CALLER = '+61400111222';
const NOW_SEC = 1_800_000_000;
const SECRET = 'fake-secret-tenant-a-0001';

function makeGate({ contacts = {}, suppressed = [], blocked = [] } = {}) {
  const suppression = createSuppressionList();
  for (const address of suppressed) suppression.suppress(TENANT, { channel: 'sms', address, reason: 'unsubscribed', actorId: 'test' });
  return createPreSendGate({
    suppression,
    async loadContact(companyId, channel, address) {
      return contacts[address] ?? null;
    },
    async loadQuietHours() {
      return null;
    },
    now: () => new Date('2026-11-02T03:00:00Z'),
    async recordBlocked(record) {
      blocked.push(record);
    },
  });
}

const consenting = {
  handles: { phone: CALLER },
  consents: [{ channel: 'sms', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }],
  timezone: 'Australia/Melbourne',
};
const optedOut = {
  handles: { phone: CALLER },
  consents: [
    { channel: 'sms', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' },
    { channel: 'sms', action: 'opt_out', at: '2026-02-01T00:00:00Z', source: 'contact' },
  ],
  timezone: 'Australia/Melbourne',
};

function input(overrides = {}) {
  return {
    routeTenantId: TENANT,
    eventTenantId: TENANT,
    event: 'call_missed',
    callerPhone: CALLER,
    humanAvailable: false,
    actorId: 'system',
    ...overrides,
  };
}

function scheduledSpy(fail = false) {
  const calls = [];
  return {
    calls,
    handoffToScheduled: async (req) => {
      calls.push(req);
      if (fail) throw new Error('scheduled unavailable');
      return { receiptId: `rcpt-${calls.length}` };
    },
  };
}

test('synthetic call flow: missed call with consent records voicemail and queues one callback', async () => {
  const blocked = [];
  const spy = scheduledSpy();
  const out = await decideCallFlow(input(), { gate: makeGate({ contacts: { [CALLER]: consenting }, blocked }), handoffToScheduled: spy.handoffToScheduled });
  assert.equal(out.ok, true);
  assert.deepEqual(out.actions.map((a) => a.type), ['record_voicemail', 'queue_callback']);
  assert.equal(out.blocked, null);
  assert.equal(blocked.length, 0);
  assert.equal(spy.calls.length, 0, 'a missed call never books anything');
});

test('opt-out blocks the callback: voicemail only, and the gate records the block', async () => {
  const blocked = [];
  const out = await decideCallFlow(input(), { gate: makeGate({ contacts: { [CALLER]: optedOut }, blocked }), handoffToScheduled: scheduledSpy().handoffToScheduled });
  assert.equal(out.ok, true);
  assert.deepEqual(out.actions.map((a) => a.type), ['record_voicemail']);
  assert.equal(out.blocked, 'opted_out');
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].reason, 'opted_out');
});

test('no contact record means no automatic callback (no auto-contact without permission)', async () => {
  const blocked = [];
  const out = await decideCallFlow(input(), { gate: makeGate({ blocked }), handoffToScheduled: scheduledSpy().handoffToScheduled });
  assert.deepEqual(out.actions.map((a) => a.type), ['record_voicemail']);
  assert.equal(out.blocked, 'no_consent');
  assert.equal(blocked.length, 1);
});

test('suppressed number is never called back', async () => {
  const out = await decideCallFlow(input(), {
    gate: makeGate({ contacts: { [CALLER]: consenting }, suppressed: [CALLER] }),
    handoffToScheduled: scheduledSpy().handoffToScheduled,
  });
  assert.deepEqual(out.actions.map((a) => a.type), ['record_voicemail']);
  assert.equal(out.blocked, 'suppressed');
});

test('human transfer is offered when a person is free', async () => {
  const out = await decideCallFlow(input({ event: 'human_requested', humanAvailable: true }), {
    gate: makeGate(),
    handoffToScheduled: scheduledSpy().handoffToScheduled,
  });
  assert.deepEqual(out.actions, [{ type: 'offer_transfer', tenantId: TENANT }]);
});

test('human transfer with nobody free falls back to voicemail', async () => {
  const out = await decideCallFlow(input({ event: 'urgent_reported', humanAvailable: false }), {
    gate: makeGate(),
    handoffToScheduled: scheduledSpy().handoffToScheduled,
  });
  assert.deepEqual(out.actions.map((a) => a.type), ['record_voicemail']);
});

test('provider timeout ends the automated call and never queues a contact', async () => {
  const out = await decideCallFlow(input({ event: 'provider_timeout' }), {
    gate: makeGate({ contacts: { [CALLER]: consenting } }),
    handoffToScheduled: scheduledSpy().handoffToScheduled,
  });
  assert.deepEqual(out.actions, [{ type: 'end_automated_call', tenantId: TENANT, reason: 'provider_timeout' }]);
});

test('booking without the customer confirming it is refused and never reaches Scheduled', async () => {
  const spy = scheduledSpy();
  const out = await decideCallFlow(
    input({ event: 'booking_requested', customerConfirmed: false, booking: { serviceId: 'svc-1', slotStartIso: '2026-12-01T09:00:00Z' } }),
    { gate: makeGate(), handoffToScheduled: spy.handoffToScheduled },
  );
  assert.deepEqual(out, { ok: false, reason: 'booking_not_confirmed' });
  assert.equal(spy.calls.length, 0);
});

test('booking confirmed by the customer is handed to Scheduled exactly once with a receipt', async () => {
  const spy = scheduledSpy();
  const out = await decideCallFlow(
    input({ event: 'booking_requested', customerConfirmed: true, booking: { serviceId: 'svc-1', slotStartIso: '2026-12-01T09:00:00Z' } }),
    { gate: makeGate(), handoffToScheduled: spy.handoffToScheduled },
  );
  assert.equal(out.ok, true);
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].tenantId, TENANT);
  assert.equal(out.actions[0].type, 'handoff_booking_request');
  assert.equal(out.actions[0].receiptId, 'rcpt-1');
});

test('booking with missing details is refused', async () => {
  const spy = scheduledSpy();
  const out = await decideCallFlow(input({ event: 'booking_requested', customerConfirmed: true, booking: null }), {
    gate: makeGate(),
    handoffToScheduled: spy.handoffToScheduled,
  });
  assert.deepEqual(out, { ok: false, reason: 'booking_details_missing' });
  assert.equal(spy.calls.length, 0);
});

test('wrong tenant: an event addressed to another tenant is refused before any gate or handoff call', async () => {
  const spy = scheduledSpy();
  let gateCalled = false;
  const gate = { check: async () => { gateCalled = true; return { allowed: true }; }, recordBlock: async () => {} };
  const out = await decideCallFlow(input({ eventTenantId: OTHER, event: 'booking_requested', customerConfirmed: true, booking: { serviceId: 's', slotStartIso: 'x' } }), {
    gate,
    handoffToScheduled: spy.handoffToScheduled,
  });
  assert.deepEqual(out, { ok: false, reason: 'wrong_tenant' });
  assert.equal(gateCalled, false);
  assert.equal(spy.calls.length, 0);
});

test('unknown event names are refused', async () => {
  const out = await decideCallFlow(input({ event: 'call_teleported' }), { gate: makeGate(), handoffToScheduled: scheduledSpy().handoffToScheduled });
  assert.deepEqual(out, { ok: false, reason: 'unknown_event' });
});

test('replayed signed event is accepted once; a replay is refused and not processed again', async () => {
  const guard = createReplayGuard({ now: () => NOW_SEC * 1000, windowMs: 5 * 60 * 1000, maxEntries: 1000 });
  const deps = { guard, secretFor: (t) => (t === TENANT ? SECRET : null) };
  const rawBody = JSON.stringify({ event: 'call_missed', callId: 'c-9' });
  const headers = {
    [TELEPHONY_TIMESTAMP_HEADER]: String(NOW_SEC),
    [TELEPHONY_EVENT_ID_HEADER]: 'evt-replay-1',
    [TELEPHONY_SIGNATURE_HEADER]: signTelephonyEvent(SECRET, NOW_SEC, rawBody),
  };
  let handled = 0;
  const first = await processTelephonyEvent({ provider: 'voice-hosted', tenantId: TENANT, headers, rawBody }, deps, async () => { handled += 1; return 'ok'; });
  const second = await processTelephonyEvent({ provider: 'voice-hosted', tenantId: TENANT, headers, rawBody }, deps, async () => { handled += 1; return 'ok'; });
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, false);
  assert.equal(second.reason, 'replay');
  assert.equal(handled, 1);
});

test('signed event for another tenant is refused by the adapter (wrong-tenant)', () => {
  const guard = createReplayGuard({ now: () => NOW_SEC * 1000, windowMs: 5 * 60 * 1000, maxEntries: 1000 });
  const deps = { guard, secretFor: (t) => (t === TENANT ? SECRET : null) };
  const rawBody = '{}';
  const headers = {
    [TELEPHONY_TIMESTAMP_HEADER]: String(NOW_SEC),
    [TELEPHONY_EVENT_ID_HEADER]: 'evt-x',
    [TELEPHONY_SIGNATURE_HEADER]: signTelephonyEvent(SECRET, NOW_SEC, rawBody),
  };
  const verdict = verifyTelephonyEvent({ provider: 'voice-hosted', tenantId: OTHER, headers, rawBody }, deps);
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, 'unknown_tenant');
});

test('handoff failure releases the event so the provider retry is processed once', async () => {
  const guard = createReplayGuard({ now: () => NOW_SEC * 1000, windowMs: 5 * 60 * 1000, maxEntries: 1000 });
  const deps = { guard, secretFor: (t) => (t === TENANT ? SECRET : null) };
  const rawBody = '{"event":"booking_requested"}';
  const headers = {
    [TELEPHONY_TIMESTAMP_HEADER]: String(NOW_SEC),
    [TELEPHONY_EVENT_ID_HEADER]: 'evt-retry-1',
    [TELEPHONY_SIGNATURE_HEADER]: signTelephonyEvent(SECRET, NOW_SEC, rawBody),
  };
  const spy = scheduledSpy(true);
  const run = () =>
    processTelephonyEvent({ provider: 'voice-hosted', tenantId: TENANT, headers, rawBody }, deps, () =>
      decideCallFlow(
        input({ event: 'booking_requested', customerConfirmed: true, booking: { serviceId: 's', slotStartIso: 'x' } }),
        { gate: makeGate(), handoffToScheduled: spy.handoffToScheduled },
      ),
    );
  await assert.rejects(run(), /scheduled unavailable/);
  const retry = await processTelephonyEvent({ provider: 'voice-hosted', tenantId: TENANT, headers, rawBody }, deps, async () => 'ok');
  assert.equal(retry.accepted, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBookingAgent,
  InMemoryBookingCalendar,
  InMemoryBookingStore,
  BOOKING_TOOLS,
  BOOKING_TOOL_NAMES,
} from '../../server/modules/booking-agent/index.ts';

// Booking agent tests. Ported behaviour from PhoneCallAgent's BookingToolHandler and
// BookingToolDefinitions (the PHP source has no test suite of its own). No database,
// no network, no real calendar provider. The approvals gate is a fake.

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-02T00:00:00Z');

class FakeGate {
  constructor(mode = 'approved') {
    this.mode = mode;
    this.requests = [];
  }
  async gateAction(request) {
    this.requests.push(request);
    if (this.mode === 'throw') throw new Error('gate unavailable');
    return {
      status: this.mode,
      approval: { id: 'appr_1' },
      decision: 'route_to_human',
      policyId: null,
    };
  }
}

class ThrowingCalendar extends InMemoryBookingCalendar {
  async createBooking() {
    throw new Error('boom');
  }
}

function build({ mode = 'approved', calendar, store } = {}) {
  const gate = new FakeGate(mode);
  const cal = calendar ?? new InMemoryBookingCalendar();
  const st = store ?? new InMemoryBookingStore();
  const agent = createBookingAgent({ gate, calendar: cal, store: st, now: () => NOW });
  return { gate, calendar: cal, store: st, agent };
}

const caller = (companyId = CO_A) => ({ companyId, requestedBy: 'user:42', agentId: 'agent-7' });

const validCreate = {
  slot: '2026-06-03T09:00:00Z',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  timezone: 'Australia/Melbourne',
};

async function bookOne(ctx, companyId = CO_A, overrides = {}) {
  const r = await ctx.agent.dispatch(caller(companyId), 'create_booking', { ...validCreate, ...overrides });
  assert.equal(r.outcome, 'executed', r.message);
  return r.bookingUid;
}

// --- definitions ------------------------------------------------------------

test('definitions: the three ported tools with PHP-matching required fields', () => {
  assert.deepEqual([...BOOKING_TOOL_NAMES], ['create_booking', 'cancel_booking', 'reschedule_booking']);
  assert.deepEqual(BOOKING_TOOLS.create_booking.required, ['slot', 'name', 'email', 'timezone']);
  assert.deepEqual(BOOKING_TOOLS.cancel_booking.required, ['booking_uid']);
  assert.deepEqual(BOOKING_TOOLS.reschedule_booking.required, ['booking_uid', 'new_slot']);
  for (const name of BOOKING_TOOL_NAMES) {
    assert.ok(BOOKING_TOOLS[name].description.length > 0);
  }
});

// --- create_booking -----------------------------------------------------------

test('create_booking: approved gate books via calendar, stores the record, returns PHP confirmation text', async () => {
  const ctx = build();
  const r = await ctx.agent.dispatch(caller(), 'create_booking', validCreate);

  assert.equal(r.outcome, 'executed');
  assert.equal(r.bookingUid, 'cal_1');
  assert.equal(r.message, 'Booking confirmed. UID: cal_1. A confirmation has been sent to ada@example.com.');

  const stored = await ctx.store.listBookings(CO_A);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, 'scheduled');
  assert.equal(stored[0].timezone, 'Australia/Melbourne');
  assert.equal(stored[0].phone, null);
});

test('create_booking: gate receives verified caller fields and the parsed params', async () => {
  const ctx = build();
  await ctx.agent.dispatch(caller(), 'create_booking', validCreate);

  assert.equal(ctx.gate.requests.length, 1);
  const req = ctx.gate.requests[0];
  assert.equal(req.companyId, CO_A);
  assert.equal(req.requestedBy, 'user:42');
  assert.equal(req.agentId, 'agent-7');
  assert.equal(req.action, 'create_booking');
  assert.deepEqual(req.params, validCreate);
  assert.equal(req.ttlMs, 15 * 60 * 1000);
});

test('create_booking: a slot already held returns the source failure text and stores nothing', async () => {
  const ctx = build();
  await bookOne(ctx);
  const second = await ctx.agent.dispatch(caller(), 'create_booking', { ...validCreate, name: 'Grace Hopper', email: 'grace@example.com' });

  assert.equal(second.outcome, 'failed');
  assert.equal(second.message, 'Booking failed. Please verify the slot is still available and try again.');
  assert.equal((await ctx.store.listBookings(CO_A)).length, 1);
  assert.deepEqual(ctx.calendar.activeSlots(CO_A), [validCreate.slot]);
});

test('create_booking: optional phone is kept when given and dropped when empty', async () => {
  const ctx = build();
  await bookOne(ctx, CO_A, { phone: '+61412345678' });
  await bookOne(ctx, CO_A, { slot: '2026-06-04T09:00:00Z', phone: '' });

  const [withPhone, withoutPhone] = await ctx.store.listBookings(CO_A);
  assert.equal(withPhone.phone, '+61412345678');
  assert.equal(withoutPhone.phone, null);
});

// --- cancel_booking -----------------------------------------------------------

test('cancel_booking: cancels an existing booking and records the reason', async () => {
  const ctx = build();
  const uid = await bookOne(ctx);
  const r = await ctx.agent.dispatch(caller(), 'cancel_booking', { booking_uid: uid, reason: 'Customer request' });

  assert.equal(r.outcome, 'executed');
  assert.equal(r.message, 'Booking has been cancelled successfully.');
  const [rec] = await ctx.store.listBookings(CO_A);
  assert.equal(rec.status, 'cancelled');
  assert.equal(rec.cancelReason, 'Customer request');
  assert.deepEqual(ctx.calendar.activeSlots(CO_A), []);
});

test('cancel_booking: unknown UID returns the source failure text', async () => {
  const ctx = build();
  const r = await ctx.agent.dispatch(caller(), 'cancel_booking', { booking_uid: 'missing' });

  assert.equal(r.outcome, 'failed');
  assert.equal(r.message, 'Failed to cancel the booking. Please verify the booking UID and try again.');
});

// --- reschedule_booking -------------------------------------------------------

test('reschedule_booking: moves the booking and records the replacement UID', async () => {
  const ctx = build();
  const uid = await bookOne(ctx);
  const r = await ctx.agent.dispatch(caller(), 'reschedule_booking', { booking_uid: uid, new_slot: '2026-06-05T14:00:00Z' });

  assert.equal(r.outcome, 'executed');
  assert.equal(r.bookingUid, 'cal_2');
  assert.equal(r.message, 'Booking rescheduled successfully. New booking UID: cal_2.');

  const stored = await ctx.store.listBookings(CO_A);
  const old = stored.find((s) => s.uid === uid);
  const fresh = stored.find((s) => s.uid === 'cal_2');
  assert.equal(old.status, 'rescheduled');
  assert.equal(fresh.status, 'scheduled');
  assert.equal(fresh.replacesUid, uid);
  assert.equal(fresh.slot, '2026-06-05T14:00:00Z');
  assert.deepEqual(ctx.calendar.activeSlots(CO_A), ['2026-06-05T14:00:00Z']);
});

test('reschedule_booking: a new slot already taken is refused and the original booking is kept', async () => {
  const ctx = build();
  const uid = await bookOne(ctx);
  await bookOne(ctx, CO_A, { slot: '2026-06-05T14:00:00Z', email: 'other@example.com' });

  const r = await ctx.agent.dispatch(caller(), 'reschedule_booking', { booking_uid: uid, new_slot: '2026-06-05T14:00:00Z' });

  assert.equal(r.outcome, 'failed');
  assert.equal(r.message, 'Reschedule failed. Please verify the booking UID and the new slot, then try again.');
  assert.ok(ctx.calendar.activeSlots(CO_A).includes(validCreate.slot));
  assert.equal((await ctx.store.listBookings(CO_A)).find((s) => s.uid === uid).status, 'scheduled');
});

// --- validation ---------------------------------------------------------------

test('validation: missing required fields are rejected before the gate or calendar runs', async () => {
  const ctx = build();
  const { name: _omit, ...noName } = validCreate;
  const r = await ctx.agent.dispatch(caller(), 'create_booking', noName);

  assert.equal(r.outcome, 'invalid_input');
  assert.ok(r.issues.some((i) => i.startsWith('name:')));
  assert.equal(ctx.gate.requests.length, 0);
  assert.equal(ctx.calendar.calls.length, 0);
});

const badCreateCases = [
  ['bad email', { email: 'not-an-email' }, 'email'],
  ['unknown timezone', { timezone: 'Mars/Olympus' }, 'timezone'],
  ['slot without offset', { slot: '2026-06-03 09:00' }, 'slot'],
  ['whitespace-only name', { name: '   ' }, 'name'],
  ['phone not E.164', { phone: '0412 345 678' }, 'phone'],
];

for (const [label, overrides, field] of badCreateCases) {
  test(`validation: create_booking rejects ${label}`, async () => {
    const ctx = build();
    const r = await ctx.agent.dispatch(caller(), 'create_booking', { ...validCreate, ...overrides });
    assert.equal(r.outcome, 'invalid_input');
    assert.ok(r.issues.some((i) => i.startsWith(`${field}:`)), r.issues.join(' | '));
    assert.equal(ctx.gate.requests.length, 0);
    assert.equal(ctx.calendar.calls.length, 0);
  });
}

test('validation: cancel_booking rejects an empty booking_uid', async () => {
  const ctx = build();
  const r = await ctx.agent.dispatch(caller(), 'cancel_booking', { booking_uid: '   ' });
  assert.equal(r.outcome, 'invalid_input');
  assert.equal(ctx.calendar.calls.length, 0);
});

test('validation: reschedule_booking rejects a date-only new_slot', async () => {
  const ctx = build();
  const r = await ctx.agent.dispatch(caller(), 'reschedule_booking', { booking_uid: 'cal_1', new_slot: '2026-06-05' });
  assert.equal(r.outcome, 'invalid_input');
  assert.ok(r.issues.some((i) => i.startsWith('new_slot:')));
});

test('validation: a companyId in the tool input is rejected, not used as the tenant', async () => {
  const ctx = build();
  const cases = [
    ['create_booking', { ...validCreate, companyId: CO_B }],
    ['cancel_booking', { booking_uid: 'cal_1', companyId: CO_B }],
    ['reschedule_booking', { booking_uid: 'cal_1', new_slot: '2026-06-05T14:00:00Z', companyId: CO_B }],
  ];
  for (const [tool, input] of cases) {
    const r = await ctx.agent.dispatch(caller(CO_A), tool, input);
    assert.equal(r.outcome, 'invalid_input', tool);
  }
  assert.equal(ctx.gate.requests.length, 0);
  assert.equal(ctx.calendar.calls.length, 0);
});

test('validation: unported or unknown tool names are refused and nothing runs', async () => {
  const ctx = build();
  const r = await ctx.agent.dispatch(caller(), 'check_availability', { date: '2026-06-03' });
  assert.equal(r.outcome, 'unknown_tool');
  assert.equal(ctx.gate.requests.length, 0);
});

test('validation: non-object input is rejected', async () => {
  const ctx = build();
  const r = await ctx.agent.dispatch(caller(), 'create_booking', 'book me');
  assert.equal(r.outcome, 'invalid_input');
  assert.equal(ctx.calendar.calls.length, 0);
});

// --- approvals gate -----------------------------------------------------------

test('gate: pending approval means nothing executes', async () => {
  const ctx = build({ mode: 'pending' });
  const r = await ctx.agent.dispatch(caller(), 'create_booking', validCreate);

  assert.equal(r.outcome, 'refused');
  assert.equal(r.reason, 'awaiting_approval');
  assert.equal(r.approvalId, 'appr_1');
  assert.equal(ctx.calendar.calls.length, 0);
  assert.equal((await ctx.store.listBookings(CO_A)).length, 0);
});

for (const mode of ['rejected', 'expired']) {
  test(`gate: ${mode} means nothing executes for cancel or reschedule either`, async () => {
    const ctx = build({ mode });
    const c = await ctx.agent.dispatch(caller(), 'cancel_booking', { booking_uid: 'cal_1' });
    const rs = await ctx.agent.dispatch(caller(), 'reschedule_booking', { booking_uid: 'cal_1', new_slot: '2026-06-05T14:00:00Z' });

    assert.equal(c.reason, 'gate_denied');
    assert.equal(rs.reason, 'gate_denied');
    assert.equal(ctx.calendar.calls.length, 0);
  });
}

test('gate: a throwing gate fails closed and nothing executes', async () => {
  const ctx = build({ mode: 'throw' });
  const r = await ctx.agent.dispatch(caller(), 'create_booking', validCreate);

  assert.equal(r.outcome, 'refused');
  assert.equal(r.reason, 'gate_error');
  assert.equal(ctx.calendar.calls.length, 0);
  assert.equal((await ctx.store.listBookings(CO_A)).length, 0);
});

test('gate: an unrecognised status fails closed', async () => {
  const ctx = build({ mode: 'maybe' });
  const r = await ctx.agent.dispatch(caller(), 'create_booking', validCreate);
  assert.equal(r.outcome, 'refused');
  assert.equal(r.reason, 'gate_error');
  assert.equal(ctx.calendar.calls.length, 0);
});

test('gate: only status approved lets a provider call run', async () => {
  const ctx = build({ mode: 'approved' });
  const r = await ctx.agent.dispatch(caller(), 'create_booking', validCreate);
  assert.equal(r.outcome, 'executed');
  assert.equal(ctx.calendar.calls.length, 1);
});

test('failure: a provider exception surfaces the source failure prefix', async () => {
  const ctx = build({ calendar: new ThrowingCalendar() });
  const r = await ctx.agent.dispatch(caller(), 'create_booking', validCreate);
  assert.equal(r.outcome, 'failed');
  assert.equal(r.message, 'Booking action failed: boom');
});

// --- company scope ------------------------------------------------------------

test('company scope: companyId is required on every dispatch', async () => {
  const ctx = build();
  await assert.rejects(ctx.agent.dispatch({ companyId: '', requestedBy: null, agentId: null }, 'create_booking', validCreate), TypeError);
  await assert.rejects(ctx.agent.dispatch({ requestedBy: null, agentId: null }, 'create_booking', validCreate), TypeError);
  assert.equal(ctx.gate.requests.length, 0);
});

test('company scope: in-memory adapters refuse calls without a companyId', async () => {
  const cal = new InMemoryBookingCalendar();
  const st = new InMemoryBookingStore();
  await assert.rejects(cal.createBooking('', validCreate), TypeError);
  await assert.rejects(st.listBookings(undefined), TypeError);
});

test('company isolation: company B cannot cancel or reschedule a company A booking', async () => {
  const ctx = build();
  const uid = await bookOne(ctx, CO_A);

  const cancelByB = await ctx.agent.dispatch(caller(CO_B), 'cancel_booking', { booking_uid: uid });
  const moveByB = await ctx.agent.dispatch(caller(CO_B), 'reschedule_booking', { booking_uid: uid, new_slot: '2026-06-05T14:00:00Z' });

  assert.equal(cancelByB.outcome, 'failed');
  assert.equal(moveByB.outcome, 'failed');
  assert.deepEqual(ctx.calendar.activeSlots(CO_A), [validCreate.slot]);
  assert.equal((await ctx.store.listBookings(CO_A))[0].status, 'scheduled');
  assert.equal((await ctx.store.listBookings(CO_B)).length, 0);
});

test('company isolation: the same slot can be booked by two companies independently', async () => {
  const ctx = build();
  const a = await bookOne(ctx, CO_A);
  const b = await bookOne(ctx, CO_B);

  assert.notEqual(a, b);
  assert.equal((await ctx.store.listBookings(CO_A)).length, 1);
  assert.equal((await ctx.store.listBookings(CO_B)).length, 1);
  assert.deepEqual(ctx.calendar.activeSlots(CO_A), [validCreate.slot]);
  assert.deepEqual(ctx.calendar.activeSlots(CO_B), [validCreate.slot]);
});

test('company isolation: the gate request carries the caller company, not another', async () => {
  const ctx = build();
  await ctx.agent.dispatch(caller(CO_B), 'create_booking', validCreate);
  assert.equal(ctx.gate.requests[0].companyId, CO_B);
});

// --- double booking -----------------------------------------------------------

test('double booking: a second booking for the same company and slot is refused and leaves one record', async () => {
  const ctx = build();
  await bookOne(ctx, CO_A);
  const dup = await ctx.agent.dispatch(caller(CO_A), 'create_booking', { ...validCreate, email: 'second@example.com' });

  assert.equal(dup.outcome, 'failed');
  assert.equal((await ctx.store.listBookings(CO_A)).length, 1);
  assert.equal(ctx.calendar.activeSlots(CO_A).length, 1);
});

// Bookings slice tests for the chatbot module. Ported from the Commerce Crew chatbot-booking extension.
// Run: node --test --experimental-transform-types tests/modules/chatbot-bookings.test.mjs
// No database, no network. Storage is the in-memory implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBookingService,
  createMemoryBookingStorage,
  isBookingsEnabled,
  BOOKINGS_FLAG_ENV,
  BookingValidationError,
  applyBookingAssistantTag,
  bookingAssistantInstructionFor,
  resolveBookingAssistantConditions,
  DEFAULT_BOOKING_ASSISTANT_CONDITIONS,
  signBookingBody,
  verifyBookingSignature,
  buildSignedBookingRequest,
  createBookingEvent,
  bookingHealth,
  intervalsConflict,
  zonedWallTimeToInstant,
  assertTransition,
  canTransition,
} from '../../server/modules/chatbot/bookings/index.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-01T00:00:00Z'); // Sunday, before the New York DST change
const SECRET = 'fake-webhook-secret-for-tests';

const WORKING_WEEK = {
  monday: { enabled: true, start: '09:00', end: '17:00' },
  tuesday: { enabled: true, start: '09:00', end: '17:00' },
  wednesday: { enabled: true, start: '09:00', end: '17:00' },
  thursday: { enabled: true, start: '09:00', end: '17:00' },
  friday: { enabled: true, start: '09:00', end: '17:00' },
  saturday: { enabled: false, start: '09:00', end: '17:00' },
  sunday: { enabled: false, start: '09:00', end: '17:00' },
};

function makeHarness({ now = NOW, enabled = true, buffer = 0, availability = WORKING_WEEK } = {}) {
  const storage = createMemoryBookingStorage();
  const emitted = [];
  const events = { emit: async (companyId, event) => void emitted.push({ companyId, event }) };
  const service = createBookingService({ storage, now: () => now, enabled, events });
  return { storage, service, emitted, now, buffer, availability };
}

async function makeCalendar(service, companyId, overrides = {}) {
  return service.createCalendar(companyId, {
    name: 'Front desk',
    timezone: 'America/New_York',
    availability: WORKING_WEEK,
    buffer_minutes: 0,
    ...overrides,
  });
}

function bookingBody(calendarId, startsAt, overrides = {}) {
  const starts = new Date(startsAt);
  return {
    calendar_id: calendarId,
    customer_name: 'Alex Customer',
    customer_email: 'alex@example.com',
    starts_at: starts.toISOString(),
    ends_at: new Date(starts.getTime() + 60 * 60_000).toISOString(),
    ...overrides,
  };
}

// Monday 2026-11-02 in New York (EST, UTC-5). 10:00 local is 15:00Z.
const MON_10AM_NY = '2026-11-02T15:00:00.000Z';
const MON_11AM_NY = '2026-11-02T16:00:00.000Z';
const MON_NEXT_DAY_RANGE = { from: '2026-11-02T00:00:00Z', to: '2026-11-03T00:00:00Z', duration_minutes: 60 };

// ---------- slot availability ----------

test('availability: slots follow working hours in the calendar timezone across the DST change', async () => {
  const h = makeHarness();
  const cal = await makeCalendar(h.service, CO_A);
  const result = await h.service.getAvailability(CO_A, cal.id, MON_NEXT_DAY_RANGE);
  // 09:00 EST is 14:00Z. The last one-hour slot starts at 16:00 EST, which is 21:00Z.
  assert.equal(result.slots[0].start, '2026-11-02T14:00:00.000Z');
  assert.equal(result.slots.at(-1).start, '2026-11-02T21:00:00.000Z');
  assert.equal(result.slots.length, 8);
});

test('availability: before the DST change the same 09:00 local start is 13:00Z', async () => {
  const h = makeHarness({ now: new Date('2026-10-01T00:00:00Z') });
  const cal = await makeCalendar(h.service, CO_A);
  const result = await h.service.getAvailability(CO_A, cal.id, {
    from: '2026-10-26T00:00:00Z',
    to: '2026-10-27T00:00:00Z',
    duration_minutes: 60,
  });
  assert.equal(result.slots[0].start, '2026-10-26T13:00:00.000Z');
});

test('availability: a booked slot is removed and returned as busy without customer details', async () => {
  const h = makeHarness();
  const cal = await makeCalendar(h.service, CO_A);
  await h.service.book(CO_A, bookingBody(cal.id, MON_10AM_NY));
  const result = await h.service.getAvailability(CO_A, cal.id, MON_NEXT_DAY_RANGE);
  assert.equal(result.slots.some((s) => s.start === MON_10AM_NY), false);
  assert.deepEqual(result.busy, [{ start: MON_10AM_NY, end: '2026-11-02T16:00:00.000Z' }]);
  assert.equal(JSON.stringify(result).includes('alex@example.com'), false);
});

test('availability: waitlisted and cancelled appointments do not block slots', async () => {
  const h = makeHarness();
  const cal = await makeCalendar(h.service, CO_A);
  await h.service.waitlist(CO_A, bookingBody(cal.id, MON_10AM_NY));
  const booked = await h.service.book(CO_A, bookingBody(cal.id, MON_11AM_NY));
  await h.service.cancel(CO_A, booked.id, 'customer request');
  const result = await h.service.getAvailability(CO_A, cal.id, MON_NEXT_DAY_RANGE);
  assert.equal(result.slots.some((s) => s.start === MON_10AM_NY), true);
  assert.equal(result.slots.some((s) => s.start === MON_11AM_NY), true);
  assert.deepEqual(result.busy, []);
});

test('availability: a calendar with no working hours offers no slots (fail closed)', async () => {
  const h = makeHarness();
  const cal = await makeCalendar(h.service, CO_A, { availability: null });
  const result = await h.service.getAvailability(CO_A, cal.id, MON_NEXT_DAY_RANGE);
  assert.deepEqual(result.slots, []);
});

test('availability: past times are never offered', async () => {
  const h = makeHarness({ now: new Date('2026-11-02T15:30:00Z') });
  const cal = await makeCalendar(h.service, CO_A);
  const result = await h.service.getAvailability(CO_A, cal.id, MON_NEXT_DAY_RANGE);
  assert.equal(result.slots[0].start, '2026-11-02T16:00:00.000Z');
});

test('zonedWallTimeToInstant resolves New York wall times on both sides of DST', () => {
  assert.equal(zonedWallTimeToInstant(2026, 11, 2, 9, 0, 'America/New_York').toISOString(), '2026-11-02T14:00:00.000Z');
  assert.equal(zonedWallTimeToInstant(2026, 10, 26, 9, 0, 'America/New_York').toISOString(), '2026-10-26T13:00:00.000Z');
});

// ---------- double booking ----------

test('double booking: the second booking for the same slot is refused with 409', async () => {
  const h = makeHarness();
  const cal = await makeCalendar(h.service, CO_A);
  await h.service.book(CO_A, bookingBody(cal.id, MON_10AM_NY));
  await assert.rejects(h.service.book(CO_A, bookingBody(cal.id, MON_10AM_NY)), { status: 409 });
  const list = await h.service.listAppointments(CO_A, cal.id, MON_NEXT_DAY_RANGE);
  assert.equal(list.filter((a) => a.status === 'confirmed').length, 1);
});

test('double booking: ten concurrent bookings for one slot leave exactly one confirmed row', async () => {
  const h = makeHarness();
  const cal = await makeCalendar(h.service, CO_A);
  const attempts = Array.from({ length: 10 }, () => h.service.book(CO_A, bookingBody(cal.id, MON_10AM_NY)));
  const settled = await Promise.allSettled(attempts);
  assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 1);
  assert.equal(settled.filter((s) => s.status === 'rejected' && s.reason.status === 409).length, 9);
});

test('double booking: the buffer requires a gap of at least buffer_minutes between appointments', async () => {
  const h = makeHarness();
  const cal = await makeCalendar(h.service, CO_A, { buffer_minutes: 15 });
  await h.service.book(CO_A, bookingBody(cal.id, MON_10AM_NY)); // 15:00Z to 16:00Z
  // Starts 10 minutes after the first ends: too close.
  await assert.rejects(
    h.service.book(CO_A, bookingBody(cal.id, '2026-11-02T16:10:00Z')),
    { status: 409 },
  );
  // Starts exactly 15 minutes after the first ends: allowed.
  await h.service.book(CO_A, bookingBody(cal.id, '2026-11-02T16:15:00Z'));
});

test('double booking: a cancelled slot can be booked again', async () => {
  const h = makeHarness();
  const cal = await makeCalendar(h.service, CO_A);
  const first = await h.service.book(CO_A, bookingBody(cal.id, MON_10AM_NY));
  await h.service.cancel(CO_A, first.id);
  const second = await h.service.book(CO_A, bookingBody(cal.id, MON_10AM_NY));
  assert.equal(second.status, 'confirmed');
});

test('intervalsConflict: half-open overlap with and without buffer', () => {
  const d = (s) => new Date(s);
  assert.equal(intervalsConflict(d('2026-01-01T10:00Z'), d('2026-01-01T11:00Z'), d('2026-01-01T11:00Z'), d('2026-01-01T12:00Z')), false);
  assert.equal(intervalsConflict(d('2026-01-01T10:00Z'), d('2026-01-01T11:00Z'), d('2026-01-01T10:30Z'), d('2026-01-01T12:00Z')), true);
  assert.equal(
    intervalsConflict(d('2026-01-01T10:00Z'), d('2026-01-01T11:00Z'), d('2026-01-01T11:10Z'), d('2026-01-01T12:00Z'), 15 * 60_000),
    true,
  );
});

// ---------- state transitions ----------

test('state transitions: cancel records the reason, and a cancelled appointment cannot be confirmed again', async () => {
  const h = makeHarness();
  const cal = await makeCalendar(h.service, CO_A);
  const appt = await h.service.book(CO_A, bookingBody(cal.id, MON_10AM_NY));
  const cancelled = await h.service.cancel(CO_A, appt.id, 'Customer moved away');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.statusReason, 'Customer moved away');
  await assert.rejects(h.service.promote(CO_A, appt.id), { status: 409 });
});

test('state transitions: a waitlisted entry is promoted once its slot is free', async () => {
  const h = makeHarness();
  const cal = await makeCalendar(h.service, CO_A);
  const waiting = await h.service.waitlist(CO_A, bookingBody(cal.id, MON_10AM_NY));
  assert.equal(waiting.status, 'waitlisted');
  const promoted = await h.service.promote(CO_A, waiting.id);
  assert.equal(promoted.status, 'confirmed');
});

test('state transitions: promotion is refused while another booking holds the slot', async () => {
  const h = makeHarness();
  const cal = await makeCalendar(h.service, CO_A);
  const waiting = await h.service.waitlist(CO_A, bookingBody(cal.id, MON_10AM_NY));
  await h.service.book(CO_A, bookingBody(cal.id, MON_10AM_NY));
  await assert.rejects(h.service.promote(CO_A, waiting.id), { status: 409, message: /no longer available/ });
  const still = await h.service.listAppointments(CO_A, cal.id, MON_NEXT_DAY_RANGE);
  assert.equal(still.find((a) => a.id === waiting.id).status, 'waitlisted');
});

test('state transitions: the storage compare-and-set refuses a stale status', async () => {
  const h = makeHarness();
  const cal = await makeCalendar(h.service, CO_A);
  const appt = await h.service.book(CO_A, bookingBody(cal.id, MON_10AM_NY));
  const result = await h.storage.transitionAppointment(
    CO_A,
    appt.id,
    { from: 'waitlisted', to: 'cancelled', reason: null, guard: null },
    NOW,
  );
  assert.deepEqual(result, { ok: false, reason: 'stale_status' });
});

test('state machine: cancelled is terminal and confirmed cannot go back to waitlisted', () => {
  assert.equal(canTransition('cancelled', 'confirmed'), false);
  assert.equal(canTransition('confirmed', 'waitlisted'), false);
  assert.equal(canTransition('waitlisted', 'confirmed'), true);
  assert.throws(() => assertTransition('cancelled', 'waitlisted'), { status: 409 });
});

test('state transitions: a cancellation reason longer than 500 characters is refused', async () => {
  const h = makeHarness();
  const cal = await makeCalendar(h.service, CO_A);
  const appt = await h.service.book(CO_A, bookingBody(cal.id, MON_10AM_NY));
  await assert.rejects(h.service.cancel(CO_A, appt.id, 'x'.repeat(501)), { status: 422 });
});

// ---------- company isolation ----------

test('company isolation: a calendar and its bookings in company A are invisible to company B', async () => {
  const h = makeHarness();
  const calA = await makeCalendar(h.service, CO_A);
  const apptA = await h.service.book(CO_A, bookingBody(calA.id, MON_10AM_NY));
  await h.service.scheduleReminder(CO_A, apptA.id, {
    channel: 'email',
    send_at: '2026-11-02T14:00:00Z',
  });

  assert.deepEqual(await h.service.listCalendars(CO_B), []);
  assert.equal(await h.storage.findCalendar(CO_B, calA.id), null);
  await assert.rejects(h.service.getAvailability(CO_B, calA.id, MON_NEXT_DAY_RANGE), { status: 404 });
  await assert.rejects(h.service.listAppointments(CO_B, calA.id, MON_NEXT_DAY_RANGE), { status: 404 });
  await assert.rejects(h.service.book(CO_B, bookingBody(calA.id, MON_11AM_NY)), { status: 404 });
  await assert.rejects(h.service.cancel(CO_B, apptA.id), { status: 404 });
  await assert.rejects(h.service.listReminders(CO_B, apptA.id), { status: 404 });
  await assert.rejects(
    h.service.scheduleReminder(CO_B, apptA.id, { channel: 'sms', send_at: '2026-11-02T14:00:00Z' }),
    { status: 404 },
  );
  assert.equal(await h.storage.findAppointment(CO_B, apptA.id), null);
  assert.deepEqual(await h.storage.listAppointments(CO_B, calA.id, { from: NOW, to: new Date('2026-12-01') }), []);
});

test('company isolation: company A still sees its own rows after B has written', async () => {
  const h = makeHarness();
  const calA = await makeCalendar(h.service, CO_A);
  await makeCalendar(h.service, CO_B, { name: 'Other company' });
  await h.service.book(CO_A, bookingBody(calA.id, MON_10AM_NY));
  assert.equal((await h.service.listCalendars(CO_A)).length, 1);
  assert.equal((await h.service.listAppointments(CO_A, calA.id, MON_NEXT_DAY_RANGE)).length, 1);
});

test('company isolation: the storage refuses to attach an appointment to another company\'s calendar', async () => {
  const h = makeHarness();
  const calA = await makeCalendar(h.service, CO_A);
  const result = await h.storage.insertAppointment(
    CO_B,
    {
      calendarId: calA.id,
      conversationId: null,
      customerName: 'Mallory',
      customerEmail: 'm@example.com',
      customerPhone: null,
      startsAt: new Date(MON_10AM_NY),
      endsAt: new Date('2026-11-02T16:00:00Z'),
      status: 'confirmed',
      metadata: null,
    },
    null,
    NOW,
  );
  assert.deepEqual(result, { ok: false, reason: 'calendar_not_found' });
});

test('company isolation: a missing or malformed company id fails closed with 403', async () => {
  const h = makeHarness();
  await assert.rejects(h.service.listCalendars(''), { status: 403 });
  await assert.rejects(h.service.listCalendars('not-a-uuid'), { status: 403 });
  await assert.rejects(h.storage.listCalendars(undefined), { status: 403 });
});

// ---------- validation failures ----------

test('validation: a companyId or status smuggled into a booking payload is rejected', async () => {
  const h = makeHarness();
  const cal = await makeCalendar(h.service, CO_A);
  await assert.rejects(
    h.service.book(CO_A, bookingBody(cal.id, MON_10AM_NY, { companyId: CO_B, status: 'cancelled' })),
    (err) => err instanceof BookingValidationError && err.status === 422 && err.issues.includes('unknown field "companyId"'),
  );
});

test('validation: bad email, bad phone and missing contact details are refused', async () => {
  const h = makeHarness();
  const cal = await makeCalendar(h.service, CO_A);
  await assert.rejects(h.service.book(CO_A, bookingBody(cal.id, MON_10AM_NY, { customer_email: 'not-an-email' })), {
    status: 422,
  });
  await assert.rejects(
    h.service.book(CO_A, bookingBody(cal.id, MON_10AM_NY, { customer_email: undefined, customer_phone: '0400 000 000' })),
    (err) => err.issues.some((i) => i.includes('E.164')),
  );
  await assert.rejects(
    h.service.book(CO_A, bookingBody(cal.id, MON_10AM_NY, { customer_email: undefined })),
    (err) => err.issues.some((i) => i.includes('customer_email or customer_phone is required')),
  );
});

test('validation: times must be ISO with an offset, ordered, in the future, and of a sensible length', async () => {
  const h = makeHarness();
  const cal = await makeCalendar(h.service, CO_A);
  await assert.rejects(h.service.book(CO_A, bookingBody(cal.id, MON_10AM_NY, { starts_at: '2026-11-02 10:00' })), {
    status: 422,
  });
  await assert.rejects(
    h.service.book(CO_A, bookingBody(cal.id, MON_10AM_NY, { ends_at: '2026-11-02T14:00:00Z' })),
    (err) => err.issues.includes('ends_at must be after starts_at'),
  );
  await assert.rejects(
    h.service.book(CO_A, bookingBody(cal.id, MON_10AM_NY, { ends_at: '2026-11-02T15:03:00Z' })),
    (err) => err.issues.some((i) => i.includes('appointment length')),
  );
  await assert.rejects(
    h.service.book(CO_A, bookingBody(cal.id, '2026-10-30T15:00:00Z', { ends_at: '2026-10-30T16:00:00Z' })),
    (err) => err.issues.includes('starts_at must not be in the past'),
  );
});

test('validation: booking outside working hours is refused with 422', async () => {
  const h = makeHarness();
  const cal = await makeCalendar(h.service, CO_A);
  // Monday 08:00 EST is 13:00Z, an hour before opening.
  await assert.rejects(h.service.book(CO_A, bookingBody(cal.id, '2026-11-02T13:00:00Z')), {
    status: 422,
    message: /outside working hours/,
  });
});

test('validation: calendar input rejects a bad timezone, an inverted day, an oversized buffer and unknown keys', async () => {
  const h = makeHarness();
  await assert.rejects(makeCalendar(h.service, CO_A, { timezone: 'Mars/Olympus' }), (err) =>
    err.issues.includes('timezone must be an IANA timezone'),
  );
  await assert.rejects(
    makeCalendar(h.service, CO_A, {
      availability: { ...WORKING_WEEK, monday: { enabled: true, start: '17:00', end: '09:00' } },
    }),
    (err) => err.issues.includes('availability.monday end must be after start'),
  );
  await assert.rejects(makeCalendar(h.service, CO_A, { buffer_minutes: 999 }), (err) =>
    err.issues.some((i) => i.startsWith('buffer_minutes')),
  );
  await assert.rejects(makeCalendar(h.service, CO_A, { owner_id: 'x' }), (err) =>
    err.issues.includes('unknown field "owner_id"'),
  );
});

test('validation: an oversized metadata object and an over-long availability query are refused', async () => {
  const h = makeHarness();
  const cal = await makeCalendar(h.service, CO_A);
  await assert.rejects(
    h.service.book(CO_A, bookingBody(cal.id, MON_10AM_NY, { metadata: { blob: 'x'.repeat(5000) } })),
    (err) => err.issues.some((i) => i.startsWith('metadata must be at most')),
  );
  await assert.rejects(
    h.service.getAvailability(CO_A, cal.id, { from: '2026-11-02T00:00:00Z', to: '2026-12-15T00:00:00Z' }),
    (err) => err.issues.includes('range must be at most 31 days'),
  );
  await assert.rejects(
    h.service.getAvailability(CO_A, cal.id, { from: '2026-11-03T00:00:00Z', to: '2026-11-02T00:00:00Z' }),
    (err) => err.issues.includes('to must be after from'),
  );
});

test('validation: reminders need a known channel and a send time between now and the start', async () => {
  const h = makeHarness();
  const cal = await makeCalendar(h.service, CO_A);
  const appt = await h.service.book(CO_A, bookingBody(cal.id, MON_10AM_NY));
  await assert.rejects(h.service.scheduleReminder(CO_A, appt.id, { channel: 'pigeon', send_at: '2026-11-02T14:00:00Z' }), {
    status: 422,
  });
  await assert.rejects(
    h.service.scheduleReminder(CO_A, appt.id, { channel: 'email', send_at: '2026-11-02T16:00:00Z' }),
    { status: 422, message: /before the appointment starts/ },
  );
  const ok = await h.service.scheduleReminder(CO_A, appt.id, { channel: 'email', send_at: '2026-11-02T14:00:00Z' });
  assert.equal(ok.status, 'queued');
  await h.service.cancel(CO_A, appt.id);
  await assert.rejects(
    h.service.scheduleReminder(CO_A, appt.id, { channel: 'email', send_at: '2026-11-02T14:00:00Z' }),
    { status: 409 },
  );
});

// ---------- events, feature flag, webhooks, health ----------

test('events: booking events carry ids and times only, never customer details', async () => {
  const h = makeHarness();
  const cal = await makeCalendar(h.service, CO_A);
  await h.service.book(CO_A, bookingBody(cal.id, MON_10AM_NY));
  const names = h.emitted.map((e) => e.event.event);
  assert.deepEqual(names, ['appointment.booked']);
  const serialised = JSON.stringify(h.emitted);
  assert.equal(serialised.includes('alex@example.com'), false);
  assert.equal(serialised.includes('Alex Customer'), false);
  assert.equal(h.emitted[0].companyId, CO_A);
});

test('feature flag: off by default and only the exact value true enables it (rule L3)', () => {
  assert.equal(BOOKINGS_FLAG_ENV, 'CHATBOT_BOOKINGS_ENABLED');
  assert.equal(isBookingsEnabled({}), false);
  assert.equal(isBookingsEnabled({ CHATBOT_BOOKINGS_ENABLED: '1' }), false);
  assert.equal(isBookingsEnabled({ CHATBOT_BOOKINGS_ENABLED: '0' }), false);
  assert.equal(isBookingsEnabled({ CHATBOT_BOOKINGS_ENABLED: 'TRUE' }), false);
  assert.equal(isBookingsEnabled({ CHATBOT_BOOKINGS_ENABLED: 'true' }), true);
});

test('feature flag: with the flag off every service call throws 503', async () => {
  const h = makeHarness({ enabled: false });
  await assert.rejects(h.service.createCalendar(CO_A, {}), { status: 503 });
  await assert.rejects(h.service.listCalendars(CO_A), { status: 503 });
  await assert.rejects(h.service.book(CO_A, {}), { status: 503 });
});

test('booking assistant: stored conditions win, otherwise the five defaults apply', () => {
  assert.equal(DEFAULT_BOOKING_ASSISTANT_CONDITIONS.length, 5);
  assert.deepEqual(resolveBookingAssistantConditions(undefined), [...DEFAULT_BOOKING_ASSISTANT_CONDITIONS]);
  assert.deepEqual(resolveBookingAssistantConditions([]), [...DEFAULT_BOOKING_ASSISTANT_CONDITIONS]);
  assert.deepEqual(resolveBookingAssistantConditions(['  Ask for a demo ', 'Ask for a demo', 7, '', 'Line\nbreak']), [
    'Ask for a demo',
    'Line break',
  ]);
});

test('booking assistant: no instruction when the flag is off or the chatbot is not an assistant', () => {
  assert.equal(bookingAssistantInstructionFor({ isBookingAssistant: true, storedConditions: null }, {}), null);
  assert.equal(
    bookingAssistantInstructionFor({ isBookingAssistant: false, storedConditions: null }, { CHATBOT_BOOKINGS_ENABLED: 'true' }),
    null,
  );
  const text = bookingAssistantInstructionFor(
    { isBookingAssistant: true, storedConditions: ['User wants a demo'] },
    { CHATBOT_BOOKINGS_ENABLED: 'true' },
  );
  assert.match(text, /\[booking-assistant\]/);
  assert.match(text, /- User wants a demo/);
});

test('booking assistant: only a trailing tag is removed and reported, and only when the assistant is active', () => {
  assert.deepEqual(applyBookingAssistantTag('Happy to help. [booking-assistant]', true), {
    showBookingButton: true,
    message: 'Happy to help.',
  });
  assert.deepEqual(applyBookingAssistantTag('Happy to help.', true), { showBookingButton: false, message: 'Happy to help.' });
  assert.deepEqual(applyBookingAssistantTag('See [booking-assistant] in the middle.', true), {
    showBookingButton: false,
    message: 'See [booking-assistant] in the middle.',
  });
  assert.deepEqual(applyBookingAssistantTag('Happy. [booking-assistant]', false), {
    showBookingButton: false,
    message: 'Happy. [booking-assistant]',
  });
});

test('webhooks: the signature covers the exact body, and an empty secret is refused', () => {
  const body = JSON.stringify({ event: 'appointment.booked' });
  const sig = signBookingBody(SECRET, body);
  assert.equal(sig.length, 64);
  assert.equal(verifyBookingSignature(SECRET, body, sig), true);
  assert.equal(verifyBookingSignature(SECRET, body + ' ', sig), false);
  assert.equal(verifyBookingSignature('other-secret', body, sig), false);
  assert.throws(() => signBookingBody('', body), { status: 500 });
});

test('webhooks: a signed request carries the body that was signed', () => {
  const event = createBookingEvent('appointment.booked', { appointment_id: 'a1' }, NOW);
  const { body, headers } = buildSignedBookingRequest(SECRET, event);
  assert.equal(headers['X-Chatbot-Signature'], signBookingBody(SECRET, body));
  assert.equal(JSON.parse(body).extension, 'chatbot-booking');
});

test('health: reports ok only when the probe passes and configuration is present, without leaking errors', async () => {
  const good = await bookingHealth(async () => {}, true, NOW);
  assert.equal(good.ok, true);
  assert.equal(good.timestamp, NOW.toISOString());
  const bad = await bookingHealth(async () => {
    throw new Error('password authentication failed for user "titan"');
  }, true, NOW);
  assert.equal(bad.ok, false);
  assert.equal(bad.checks.database, false);
  assert.equal(JSON.stringify(bad).includes('password'), false);
});

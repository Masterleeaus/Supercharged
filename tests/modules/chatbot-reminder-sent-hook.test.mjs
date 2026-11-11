// Reminder onSent hook: appends one appointment.reminder_sent outbox row for the company after a successful send.
// It never fires for a failed send, and a throwing outbox write never undoes the send.
// Run: node --test --experimental-transform-types tests/modules/chatbot-reminder-sent-hook.test.mjs
// No network. The bookings service and the ledger are in memory. The outbox is a recording stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReminderDispatcher, createMemoryProviderStore } from '../../server/modules/chatbot/booking-providers/index.ts';
import { createReminderSentHook, REMINDER_SENT_EVENT } from '../../server/modules/chatbot/booking-providers/reminder-sent-hook.ts';
import { createBookingService, createMemoryBookingStorage } from '../../server/modules/chatbot/bookings/index.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const MON_10 = '2026-11-09T10:00:00.000Z';
const NOW = '2026-11-08T11:00:00Z';

const ALL_DAYS = {
  monday: { enabled: true, start: '09:00', end: '17:00' },
  tuesday: { enabled: true, start: '09:00', end: '17:00' },
  wednesday: { enabled: true, start: '09:00', end: '17:00' },
  thursday: { enabled: true, start: '09:00', end: '17:00' },
  friday: { enabled: true, start: '09:00', end: '17:00' },
  saturday: { enabled: true, start: '09:00', end: '17:00' },
  sunday: { enabled: true, start: '09:00', end: '17:00' },
};

function harness() {
  const clock = { now: new Date(NOW) };
  const service = createBookingService({ storage: createMemoryBookingStorage(), now: () => clock.now, enabled: true });
  const store = createMemoryProviderStore();
  return { clock, service, store };
}

function emailSender(script) {
  const sent = [];
  return {
    channel: 'email',
    sent,
    async send(request) {
      sent.push(request);
      return script ? script(request) : { status: 'sent', externalMessageId: `msg-${sent.length}` };
    },
  };
}

/** Recording outbox. Dedupes on (companyId, dedupeKey) the way the real store does. */
function recordingOutbox(behaviour) {
  const appends = [];
  const seen = new Map();
  return {
    appends,
    async append(companyId, event) {
      if (behaviour) await behaviour();
      appends.push({ companyId, event });
      const key = `${companyId}:${event.dedupeKey}`;
      if (!seen.has(key)) seen.set(key, { id: `ob-${seen.size + 1}`, companyId, ...event });
      return seen.get(key);
    },
  };
}

async function bookDueBooking(h) {
  const calendar = await h.service.createCalendar(CO_A, { name: 'Desk', timezone: 'UTC', availability: ALL_DAYS, buffer_minutes: 0 });
  const starts = new Date(MON_10);
  await h.service.book(CO_A, {
    calendar_id: calendar.id,
    customer_name: 'Alex Customer',
    customer_email: 'alex@example.com',
    starts_at: starts.toISOString(),
    ends_at: new Date(starts.getTime() + 30 * 60_000).toISOString(),
  });
  return calendar;
}

// Builds the dispatcher with onSent set from the hook, the way the production composition does.
function buildDispatcher(h, { sender, outbox }) {
  return createReminderDispatcher({
    bookings: h.service,
    ledger: h.store.ledger,
    senders: { email: sender },
    http: { request: async () => ({ status: 200, body: {} }) },
    config: { channels: ['email'], leadMinutes: 24 * 60 },
    now: () => h.clock.now,
    onSent: createReminderSentHook({ outbox, error: () => {} }),
  });
}

test('onSent: a successful send appends one company outbox row with the reminder payload', async () => {
  const h = harness();
  await bookDueBooking(h);
  const outbox = recordingOutbox();
  const sender = emailSender();
  const dispatcher = buildDispatcher(h, { sender, outbox });

  const summary = await dispatcher.runDue(CO_A);

  assert.equal(summary.sent, 1);
  assert.equal(outbox.appends.length, 1, 'one outbox row');
  const { companyId, event } = outbox.appends[0];
  assert.equal(companyId, CO_A);
  assert.equal(event.companyId, CO_A);
  assert.equal(event.topic, REMINDER_SENT_EVENT);
  assert.equal(event.topic, 'appointment.reminder_sent');
  assert.deepEqual(Object.keys(event.payload).sort(), ['appointmentId', 'channel', 'companyId', 'sentAt']);
  assert.equal(event.payload.companyId, CO_A);
  assert.equal(event.payload.channel, 'email');
  assert.equal(typeof event.payload.appointmentId, 'string');
  assert.ok(!Number.isNaN(Date.parse(event.payload.sentAt)));
  assert.equal(event.aggregateId, event.payload.appointmentId);
  assert.ok(!('userId' in event.payload), 'no user id is part of the event');

  const ledger = await h.store.ledger.find(CO_A, event.payload.appointmentId, 'email');
  assert.equal(ledger.status, 'sent', 'the ledger row is marked sent');
});

test('onSent: a second run does not send again, so no second outbox row is written', async () => {
  const h = harness();
  await bookDueBooking(h);
  const outbox = recordingOutbox();
  const sender = emailSender();
  const dispatcher = buildDispatcher(h, { sender, outbox });

  await dispatcher.runDue(CO_A);
  await dispatcher.runDue(CO_A);

  assert.equal(sender.sent.length, 1);
  assert.equal(outbox.appends.length, 1);
});

test('onSent: a failed send does not append an outbox row', async () => {
  const h = harness();
  await bookDueBooking(h);
  const outbox = recordingOutbox();
  const sender = emailSender(() => ({ status: 'failed', retryable: false, reason: 'rejected' }));
  const dispatcher = buildDispatcher(h, { sender, outbox });

  const summary = await dispatcher.runDue(CO_A);

  assert.equal(summary.sent, 0);
  assert.equal(summary.failed, 1);
  assert.equal(outbox.appends.length, 0);
});

test('onSent: a throwing outbox write is logged, and the send is not undone', async () => {
  const h = harness();
  await bookDueBooking(h);
  const outbox = recordingOutbox(() => {
    throw new Error('outbox down');
  });
  const errors = [];
  const hook = createReminderSentHook({ outbox, error: (m) => errors.push(m) });
  const sender = emailSender();
  const dispatcher = createReminderDispatcher({
    bookings: h.service,
    ledger: h.store.ledger,
    senders: { email: sender },
    http: { request: async () => ({ status: 200, body: {} }) },
    config: { channels: ['email'], leadMinutes: 24 * 60 },
    now: () => h.clock.now,
    onSent: hook,
  });

  const summary = await dispatcher.runDue(CO_A);

  assert.equal(summary.sent, 1, 'the send still counts as sent');
  assert.equal(sender.sent.length, 1, 'the message was sent once');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /outbox down/);
  const again = await dispatcher.runDue(CO_A);
  assert.equal(again.sent, 0, 'the ledger row stays sent, so a later run does not resend');
  assert.equal(sender.sent.length, 1);
});

// Reminder onSent hook: fires appointment.reminder_sent once after a successful send, and never undoes a send.
// Run: node --test --experimental-transform-types tests/modules/chatbot-reminder-sent-hook.test.mjs
// No network. The bookings service is in memory. The flow trigger is a recording stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReminderDispatcher, createMemoryProviderStore } from '../../server/modules/chatbot/booking-providers/index.ts';
import { createReminderSentHook, REMINDER_SENT_EVENT } from '../../server/modules/chatbot/booking-providers/reminder-sent-hook.ts';
import { createBookingService, createMemoryBookingStorage } from '../../server/modules/chatbot/bookings/index.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const USER_A = 'user-a-1';
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

function recordingTrigger(behaviour) {
  const calls = [];
  const fn = async (...args) => {
    calls.push(args);
    if (behaviour) await behaviour();
  };
  return { calls, fn };
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

// Builds the dispatcher with onSent set from the hook, the way a production composition would.
function buildDispatcher(h, { sender, hook }) {
  return createReminderDispatcher({
    bookings: h.service,
    ledger: h.store.ledger,
    senders: { email: sender },
    http: { request: async () => ({ status: 200, body: {} }) },
    config: { channels: ['email'], leadMinutes: 24 * 60 },
    now: () => h.clock.now,
    onSent: hook,
  });
}

test('onSent: a successful send calls the trigger once, with the company, user and event name', async () => {
  const h = harness();
  await bookDueBooking(h);
  const sender = emailSender();
  const trigger = recordingTrigger();
  const hook = createReminderSentHook({ triggerEvent: trigger.fn, resolveUserId: () => USER_A, warn: () => {}, error: () => {} });
  const dispatcher = buildDispatcher(h, { sender, hook });

  const summary = await dispatcher.runDue(CO_A);

  assert.equal(summary.sent, 1);
  assert.equal(trigger.calls.length, 1, 'the trigger runs exactly once');
  const [companyId, userId, event, data] = trigger.calls[0];
  assert.equal(companyId, CO_A);
  assert.equal(userId, USER_A);
  assert.equal(event, REMINDER_SENT_EVENT);
  assert.equal(event, 'appointment.reminder_sent');
  assert.equal(data.channel, 'email');
  assert.equal(typeof data.appointmentId, 'string');
  assert.ok(!Number.isNaN(Date.parse(data.sentAt)));
});

test('onSent: a second run does not send again, so the trigger does not fire again', async () => {
  const h = harness();
  await bookDueBooking(h);
  const trigger = recordingTrigger();
  const hook = createReminderSentHook({ triggerEvent: trigger.fn, resolveUserId: () => USER_A, warn: () => {}, error: () => {} });
  const dispatcher = buildDispatcher(h, { sender: emailSender(), hook });

  await dispatcher.runDue(CO_A);
  await dispatcher.runDue(CO_A);

  assert.equal(trigger.calls.length, 1);
});

test('onSent: a failed send does not call the trigger', async () => {
  const h = harness();
  await bookDueBooking(h);
  const trigger = recordingTrigger();
  const hook = createReminderSentHook({ triggerEvent: trigger.fn, resolveUserId: () => USER_A, warn: () => {}, error: () => {} });
  const sender = emailSender(() => ({ status: 'failed', retryable: false, reason: 'rejected' }));
  const dispatcher = buildDispatcher(h, { sender, hook });

  const summary = await dispatcher.runDue(CO_A);

  assert.equal(summary.sent, 0);
  assert.equal(summary.failed, 1);
  assert.equal(trigger.calls.length, 0);
});

test('onSent: a throwing trigger is logged, and the send is not undone', async () => {
  const h = harness();
  await bookDueBooking(h);
  const trigger = recordingTrigger(() => {
    throw new Error('webhook down');
  });
  const errors = [];
  const hook = createReminderSentHook({
    triggerEvent: trigger.fn,
    resolveUserId: () => USER_A,
    warn: () => {},
    error: (m) => errors.push(m),
  });
  const sender = emailSender();
  const dispatcher = buildDispatcher(h, { sender, hook });

  const summary = await dispatcher.runDue(CO_A);

  assert.equal(summary.sent, 1, 'the send still counts as sent');
  assert.equal(sender.sent.length, 1, 'the message was sent once');
  assert.equal(trigger.calls.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /webhook down/);
  // The ledger row stays sent, so a later run does not resend.
  const again = await dispatcher.runDue(CO_A);
  assert.equal(again.sent, 0);
  assert.equal(sender.sent.length, 1);
});

test('onSent: no user id means the trigger is skipped and a warning is logged', async () => {
  const h = harness();
  await bookDueBooking(h);
  const trigger = recordingTrigger();
  const warnings = [];
  const hook = createReminderSentHook({
    triggerEvent: trigger.fn,
    resolveUserId: () => null,
    warn: (m) => warnings.push(m),
    error: () => {},
  });
  const sender = emailSender();
  const dispatcher = buildDispatcher(h, { sender, hook });

  const summary = await dispatcher.runDue(CO_A);

  assert.equal(summary.sent, 1);
  assert.equal(sender.sent.length, 1);
  assert.equal(trigger.calls.length, 0, 'no event fires without a user id');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /appointment\.reminder_sent skipped/);
});

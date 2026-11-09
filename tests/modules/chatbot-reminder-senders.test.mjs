// Reminder sender adapters, the attempt log wrapper and the production pipeline composition.
// Run: node --test --experimental-transform-types tests/modules/chatbot-reminder-senders.test.mjs
// No network. Email is a recording stub. The bookings service, ledger and attempt log are in memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryProviderStore } from '../../server/modules/chatbot/booking-providers/index.ts';
import { createMemoryAttemptLog } from '../../server/modules/chatbot/booking-providers/reminder-attempt-log.ts';
import {
  createEmailReminderSender,
  createNotWiredReminderSender,
  createWhatsappReminderSender,
  withAttemptLog,
} from '../../server/modules/chatbot/booking-providers/reminder-senders.ts';
import { createReminderPipeline } from '../../server/modules/chatbot/booking-providers/reminder-pipeline.ts';
import { createBookingService, createMemoryBookingStorage } from '../../server/modules/chatbot/bookings/index.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-11-08T11:00:00Z';
const MON_10 = '2026-11-09T10:00:00.000Z';
const ALL_DAYS = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => [d, { enabled: true, start: '09:00', end: '17:00' }]),
);
const noHttp = async () => {
  throw new Error('no network in tests');
};

function request(overrides = {}) {
  return {
    companyId: CO_A,
    appointmentId: 'appt-1',
    channel: 'email',
    recipient: 'alex@example.com',
    body: 'Hi <b>Alex</b>, reminder.',
    idempotencyKey: 'appt-1:email:key',
    ...overrides,
  };
}

test('email adapter: sends through the email transport with the idempotency header and escaped html', async () => {
  const calls = [];
  const sender = createEmailReminderSender(async (message) => {
    calls.push(message);
    return { success: true, messageId: 'mail-9' };
  });

  const result = await sender.send(request(), noHttp);

  assert.deepEqual(result, { status: 'sent', externalMessageId: 'mail-9' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, 'alex@example.com');
  assert.equal(calls[0].headers['Idempotency-Key'], 'appt-1:email:key');
  assert.match(calls[0].html, /&lt;b&gt;Alex&lt;\/b&gt;/, 'customer text is escaped in html');
  assert.ok(!calls[0].html.includes('<b>'));
});

test('email adapter: a rejected send is a retryable failure with a fixed reason', async () => {
  const sender = createEmailReminderSender(async () => ({ success: false, error: 'smtp 550 user alex@example.com unknown' }));

  const result = await sender.send(request(), noHttp);

  assert.deepEqual(result, { status: 'failed', retryable: true, reason: 'email_rejected' });
  assert.ok(!JSON.stringify(result).includes('alex@example.com'), 'no address in the failure');
});

test('sms has no existing transport: every send is an explicit not_wired failure', async () => {
  const sender = createNotWiredReminderSender('sms');
  assert.equal(sender.channel, 'sms');
  assert.deepEqual(await sender.send(request({ channel: 'sms' }), noHttp), {
    status: 'failed',
    retryable: false,
    reason: 'not_wired',
  });
});

test('whatsapp adapter: no account for the company is a terminal account_not_wired failure, with no network call', async () => {
  let httpCalls = 0;
  const sender = createWhatsappReminderSender({
    resolveAccountId: () => null,
    credentials: { load: async () => ({}) },
  });
  const http = async () => {
    httpCalls += 1;
    throw new Error('must not be called');
  };

  assert.deepEqual(await sender.send(request({ channel: 'whatsapp' }), http), {
    status: 'failed',
    retryable: false,
    reason: 'account_not_wired',
  });
  assert.equal(httpCalls, 0);
});

test('attempt log wrapper: records one row per attempt, including failures', async () => {
  const log = createMemoryAttemptLog();
  const outcomes = [
    { status: 'failed', retryable: true, reason: 'email_rejected' },
    { status: 'sent', externalMessageId: 'mail-2' },
  ];
  const inner = { channel: 'email', send: async () => outcomes.shift() };
  const sender = withAttemptLog(inner, log, () => {});

  await sender.send(request(), noHttp);
  await sender.send(request(), noHttp);

  assert.equal(log.entries.length, 2);
  assert.deepEqual(
    log.entries.map((e) => [e.attemptNo, e.status, e.reason, e.externalMessageId]),
    [
      [1, 'failed', 'email_rejected', null],
      [2, 'sent', null, 'mail-2'],
    ],
  );
});

test('attempt log wrapper: a sender throw is recorded as error and rethrown; a log failure does not change the result', async () => {
  const errors = [];
  const throwing = withAttemptLog(
    { channel: 'email', send: async () => { throw new Error('socket hang up'); } },
    createMemoryAttemptLog(),
    () => {},
  );
  await assert.rejects(throwing.send(request(), noHttp), /socket hang up/);

  const brokenLog = {
    countAttempts: async () => 0,
    record: async () => {
      throw new Error('db down');
    },
  };
  const sender = withAttemptLog({ channel: 'email', send: async () => ({ status: 'sent', externalMessageId: 'm-1' }) }, brokenLog, (m) => errors.push(m));

  const result = await sender.send(request(), noHttp);

  assert.deepEqual(result, { status: 'sent', externalMessageId: 'm-1' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /attempt log write failed/);
});

test('pipeline: one successful send writes one attempt row, marks the ledger sent and appends one outbox row', async () => {
  const clock = { now: new Date(NOW) };
  const service = createBookingService({ storage: createMemoryBookingStorage(), now: () => clock.now, enabled: true });
  const store = createMemoryProviderStore();
  const calendar = await service.createCalendar(CO_A, { name: 'Desk', timezone: 'UTC', availability: ALL_DAYS, buffer_minutes: 0 });
  const starts = new Date(MON_10);
  await service.book(CO_A, {
    calendar_id: calendar.id,
    customer_name: 'Alex Customer',
    customer_email: 'alex@example.com',
    starts_at: starts.toISOString(),
    ends_at: new Date(starts.getTime() + 30 * 60_000).toISOString(),
  });

  const attemptLog = createMemoryAttemptLog();
  const outbox = { appends: [], async append(companyId, event) { this.appends.push({ companyId, event }); return event; } };
  const emailSent = [];
  const pipeline = createReminderPipeline({
    bookings: service,
    ledger: store.ledger,
    attemptLog,
    senders: { email: createEmailReminderSender(async (m) => { emailSent.push(m); return { success: true, messageId: 'mail-1' }; }) },
    outbox,
    http: noHttp,
    config: { channels: ['email'], leadMinutes: 24 * 60 },
    now: () => clock.now,
  });

  const summary = await pipeline.runDue(CO_A);

  assert.equal(summary.sent, 1);
  assert.equal(emailSent.length, 1);
  assert.equal(attemptLog.entries.length, 1);
  assert.equal(attemptLog.entries[0].status, 'sent');
  assert.equal(outbox.appends.length, 1);
  assert.equal(outbox.appends[0].event.topic, 'appointment.reminder_sent');
  const ledger = await store.ledger.find(CO_A, attemptLog.entries[0].appointmentId, 'email');
  assert.equal(ledger.status, 'sent');
});

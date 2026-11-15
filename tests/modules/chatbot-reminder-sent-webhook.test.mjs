// appointment.reminder_sent end to end: a successful reminder send appends one company outbox row, the outbox row is
// dispatched to a subscriber that listens for the topic, and the body is signed with the subscriber's secret.
// Run: node --test --experimental-transform-types tests/modules/chatbot-reminder-sent-webhook.test.mjs
// No network. The outbox is the real outbox over the in-memory events store. The HTTP transport is a recording stub.
// The signing secret is generated per run and never written to the repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createMemoryEventsStore } from '../../server/modules/chatbot/events/memory-store.ts';
import { createOutboxStorage } from '../../server/modules/chatbot/events/outbox.ts';
import {
  WEBHOOK_HEADERS,
  createWebhookDispatcher,
  createWebhookSubscriptionService,
  signWebhookBody,
  verifyWebhookSignature,
} from '../../server/modules/chatbot/events/webhooks.ts';
import { SECRET_KEY_ENV, createSecretBox } from '../../server/modules/chatbot/secrets/secret-box.ts';
import {
  REMINDER_SENT_EVENT,
  createReminderSentHook,
  reminderSentDedupeKey,
} from '../../server/modules/chatbot/booking-providers/reminder-sent-hook.ts';

const COMPANY_A = '11111111-1111-4111-8111-111111111111';
const COMPANY_B = '22222222-2222-4222-8222-222222222222';
const URL_IN = 'https://hooks.example.com/reminders';
const SECRET = `whsec_${randomBytes(24).toString('hex')}`;
const resolve = async () => ['93.184.216.34'];
const ENABLED = { CHATBOT_OUTBOUND_WEBHOOKS_ENABLED: 'true' };
const SENT_AT = new Date('2026-11-15T09:00:00.000Z');

function harness() {
  const env = { [SECRET_KEY_ENV]: randomBytes(32).toString('base64') };
  const box = createSecretBox({ env });
  let ids = 0;
  const deps = { now: () => new Date('2026-11-15T08:59:00.000Z'), newId: () => `id-${++ids}` };
  const store = createMemoryEventsStore();
  const outbox = createOutboxStorage(store, deps);
  const hook = createReminderSentHook({ outbox, error: () => {} });
  const sent = [];
  const http = async (request) => {
    sent.push(request);
    return { status: 200, headers: {}, body: '' };
  };
  const dispatcher = createWebhookDispatcher({ http, secretBox: box, store, env: ENABLED, events: deps, resolve });
  const subscriptions = createWebhookSubscriptionService(store, box, deps, resolve);
  return { store, hook, sent, dispatcher, subscriptions };
}

function reminderEvent(overrides = {}) {
  return {
    companyId: COMPANY_A,
    appointmentId: 'appt-1',
    channel: 'email',
    sentAt: SENT_AT,
    ...overrides,
  };
}

async function drain(store, companyId) {
  return store.claimBatch(companyId, 50, new Date('2026-11-15T10:00:00.000Z'), { workerId: 'test', leaseSeconds: 60 });
}

test('a successful reminder send is delivered to a subscriber of appointment.reminder_sent, signed with its secret', async () => {
  const h = harness();
  await h.subscriptions.subscribe(COMPANY_A, { url: URL_IN, topics: [REMINDER_SENT_EVENT], signingSecret: SECRET });

  await h.hook(reminderEvent());
  const [row] = await drain(h.store, COMPANY_A);
  assert.ok(row, 'one outbox row was written');
  assert.equal(row.topic, REMINDER_SENT_EVENT);

  const results = await h.dispatcher.dispatch(COMPANY_A, row);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);

  const request = h.sent[0];
  assert.equal(request.url, URL_IN);
  assert.equal(request.headers[WEBHOOK_HEADERS.event], REMINDER_SENT_EVENT);
  assert.equal(request.headers[WEBHOOK_HEADERS.signature], signWebhookBody(SECRET, request.body));
  assert.equal(verifyWebhookSignature(SECRET, request.body, request.headers[WEBHOOK_HEADERS.signature]), true);
  assert.equal(verifyWebhookSignature(`${SECRET}x`, request.body, request.headers[WEBHOOK_HEADERS.signature]), false);
});

test('the delivered body carries the reminder payload and no contact details', async () => {
  const h = harness();
  await h.subscriptions.subscribe(COMPANY_A, { url: URL_IN, topics: [REMINDER_SENT_EVENT], signingSecret: SECRET });
  await h.hook(reminderEvent({ channel: 'sms' }));
  const [row] = await drain(h.store, COMPANY_A);
  await h.dispatcher.dispatch(COMPANY_A, row);

  const body = JSON.parse(h.sent[0].body);
  assert.equal(body.event, REMINDER_SENT_EVENT);
  assert.equal(body.extension, 'chatbot');
  assert.equal(body.payload.companyId, COMPANY_A);
  assert.equal(body.payload.appointmentId, 'appt-1');
  assert.equal(body.payload.channel, 'sms');
  assert.equal(body.payload.sentAt, SENT_AT.toISOString());
  assert.equal(typeof body.payload.event_uuid, 'string');
  assert.equal(typeof body.occurred_at, 'string');
  const serialised = h.sent[0].body;
  assert.doesNotMatch(serialised, /@|\+\d{6,}/, 'no email address or phone number in the body');
});

test('a subscriber that does not list the topic gets no reminder delivery', async () => {
  const h = harness();
  await h.subscriptions.subscribe(COMPANY_A, { url: URL_IN, topics: ['appointment.booked'], signingSecret: SECRET });
  await h.hook(reminderEvent());
  const [row] = await drain(h.store, COMPANY_A);
  const results = await h.dispatcher.dispatch(COMPANY_A, row);
  assert.equal(results.length, 0);
  assert.equal(h.sent.length, 0);
});

test('a reminder for one company is not delivered to another company subscriber', async () => {
  const h = harness();
  await h.subscriptions.subscribe(COMPANY_B, { url: URL_IN, topics: [REMINDER_SENT_EVENT], signingSecret: SECRET });
  await h.hook(reminderEvent());
  const rows = await drain(h.store, COMPANY_A);
  assert.equal(rows.length, 1);
  const results = await h.dispatcher.dispatch(COMPANY_A, rows[0]);
  assert.equal(results.length, 0);
  assert.equal(h.sent.length, 0);
});

test('the same appointment and channel write one outbox row, so a retried hook does not double-send', async () => {
  const h = harness();
  await h.hook(reminderEvent());
  await h.hook(reminderEvent({ sentAt: new Date('2026-11-15T09:05:00.000Z') }));
  const rows = await drain(h.store, COMPANY_A);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dedupeKey, reminderSentDedupeKey('appt-1', 'email'));
});

test('a different channel for the same appointment writes its own row', async () => {
  const h = harness();
  await h.hook(reminderEvent({ channel: 'email' }));
  await h.hook(reminderEvent({ channel: 'sms' }));
  const rows = await drain(h.store, COMPANY_A);
  assert.equal(rows.length, 2);
});

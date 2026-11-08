// Calendar providers (Calendly, Cal.com), reminder dispatch, and reconciliation.
// Run: NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types tests/modules/chatbot-booking-providers.test.mjs
// No network. Every provider call goes to a fake HttpClient. The Drizzle queries are rendered to SQL, never executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHmac, createCipheriv, createDecipheriv } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import {
  CalendarProviderError,
  CALENDLY_SIGNING_KEY,
  CALENDLY_TOKEN_KEY,
  CALCOM_API_KEY,
  CALCOM_WEBHOOK_SECRET,
  createCalendlyProvider,
  createCalcomProvider,
  createReminderDispatcher,
  createMemoryProviderStore,
  createDrizzleProviderStore,
  providerQueries,
  reconcileBookings,
  reconcileCalendar,
  loadCalendlyCredentials,
  BookingAttemptError,
  bookingRequestHash,
  createBookingCaller,
  createCalendarSecretStore,
  createDrizzleRetryStore,
  createMemoryRetryStore,
  loadCalcomCredentials,
  retryQueries,
  runReconciliationJob,
} from '../../server/modules/chatbot/booking-providers/index.ts';
import { chatbotBookingReminderSends, chatbotExternalBookings, chatbotBookingAttempts, chatbotCalendarSecrets } from '../../server/modules/chatbot/booking-providers/db.ts';
import { createBookingService, createMemoryBookingStorage } from '../../server/modules/chatbot/bookings/index.ts';
import { CONTRACT_FLAGS } from '../../server/modules/chatbot/contracts/index.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const CALENDLY_BASE = 'https://api.calendly.test';
const CALCOM_BASE = 'https://api.cal.test/v2';
const TOKEN = 'cly_live_TOKEN_SHOULD_NEVER_LEAK_' + randomBytes(8).toString('hex');
const CALCOM_KEY = 'cal_live_KEY_SHOULD_NEVER_LEAK_' + randomBytes(8).toString('hex');
const SIGNING = 'signing-secret-for-tests';
const WEBHOOK_SECRET = 'webhook-secret-for-tests';
const EVENT_TYPE_URI = `${CALENDLY_BASE}/event_types/11111111-aaaa-4bbb-8ccc-000000000001`;
const SCHEDULED_EVENT_URI = `${CALENDLY_BASE}/scheduled_events/22222222-aaaa-4bbb-8ccc-000000000002`;
const CALENDLY_CREDS = { [CALENDLY_TOKEN_KEY]: TOKEN, [CALENDLY_SIGNING_KEY]: SIGNING };
const CALCOM_CREDS = { [CALCOM_API_KEY]: CALCOM_KEY, [CALCOM_WEBHOOK_SECRET]: WEBHOOK_SECRET };
const REF_CALENDLY = { companyId: CO_A, chatbotId: 'bot-1', provider: 'calendly', externalEventTypeId: EVENT_TYPE_URI };
const REF_CALCOM = { companyId: CO_A, chatbotId: 'bot-1', provider: 'calcom', externalEventTypeId: '4242' };
const ENABLED = { enabled: true };

/** Fake HttpClient. The handler gets each request and returns { status, body } or throws a transport error. */
function fakeHttp(handler) {
  const calls = [];
  const http = async (req) => {
    calls.push(req);
    const out = await handler(req);
    return {
      status: out.status ?? 200,
      headers: {},
      body: typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? {}),
    };
  };
  return { http, calls };
}

async function captureConsole(fn) {
  const seen = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const originals = {};
  for (const m of methods) {
    originals[m] = console[m];
    console[m] = (...args) => seen.push(args.map(String).join(' '));
  }
  try {
    return { result: await fn(), seen };
  } finally {
    for (const m of methods) console[m] = originals[m];
  }
}

const dialect = new PgDialect();
const pool = new Pool({ connectionString: 'postgres://user:pass@127.0.0.1:1/none' });
const db = drizzle(pool);
function untouchableDb() {
  return new Proxy({}, {
    get(_t, prop) {
      throw new Error(`database touched: ${String(prop)}`);
    },
  });
}
function render(query) {
  if (typeof query.toSQL === 'function') return query.toSQL();
  return dialect.sqlToQuery(query.getSQL());
}

// ---------------------------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------------------------

test('flag: external calendars default off, and only the exact value "true" turns them on', async () => {
  assert.equal(CONTRACT_FLAGS.EXTERNAL_CALENDARS_ENABLED, 'CHATBOT_EXTERNAL_CALENDARS_ENABLED');
  const { http, calls } = fakeHttp(() => ({ body: {} }));
  for (const value of [undefined, '1', 'yes', 'on', 'TRUE']) {
    const env = value === undefined ? {} : { CHATBOT_EXTERNAL_CALENDARS_ENABLED: value };
    const provider = createCalendlyProvider({ env, baseUrl: CALENDLY_BASE });
    await assert.rejects(provider.listSlots(REF_CALENDLY, { from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z', timezone: 'UTC' }, CALENDLY_CREDS, http), { status: 503 });
  }
  assert.equal(calls.length, 0, 'a disabled provider makes no request');
  const on = createCalcomProvider({ env: { CHATBOT_EXTERNAL_CALENDARS_ENABLED: 'true' }, baseUrl: CALCOM_BASE });
  assert.equal(on.key, 'calcom');
});

// ---------------------------------------------------------------------------------------------
// Calendly
// ---------------------------------------------------------------------------------------------

test('calendly: listSlots keeps only available times and sends the token only in the Authorization header', async () => {
  const { http, calls } = fakeHttp((req) => {
    if (req.url.startsWith(`${CALENDLY_BASE}/event_types/`)) return { body: { resource: { duration: 30 } } };
    return {
      body: {
        collection: [
          { status: 'available', start_time: '2026-11-10T09:00:00Z' },
          { status: 'unavailable', start_time: '2026-11-10T10:00:00Z' },
          { status: 'available', start_time: '2026-11-10T10:30:00Z' },
        ],
      },
    };
  });
  const provider = createCalendlyProvider({ ...ENABLED, baseUrl: CALENDLY_BASE });
  const slots = await provider.listSlots(REF_CALENDLY, { from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z', timezone: 'UTC' }, CALENDLY_CREDS, http);
  assert.deepEqual(slots, [
    { startsAt: '2026-11-10T09:00:00.000Z', endsAt: '2026-11-10T09:30:00.000Z' },
    { startsAt: '2026-11-10T10:30:00.000Z', endsAt: '2026-11-10T11:00:00.000Z' },
  ]);
  for (const req of calls) {
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    assert.ok(!req.url.includes(TOKEN), 'token must not appear in a URL');
    assert.ok(req.timeoutMs > 0, 'every request has a timeout');
  }
  const availability = calls.find((c) => c.url.includes('/event_type_available_times'));
  assert.ok(availability.url.includes('start_time=2026-11-10T00%3A00%3A00.000Z'));
});

test('calendly: createBooking posts to /invitees and returns the scheduled event as the external id', async () => {
  const { http, calls } = fakeHttp((req) => {
    if (req.method === 'POST' && req.url === `${CALENDLY_BASE}/invitees`) {
      return {
        status: 201,
        body: { resource: { event: SCHEDULED_EVENT_URI, reschedule_url: 'https://calendly.test/resched/abc' } },
      };
    }
    return { status: 404, body: {} };
  });
  const provider = createCalendlyProvider({ ...ENABLED, baseUrl: CALENDLY_BASE });
  const booked = await provider.createBooking(
    REF_CALENDLY,
    {
      startsAt: '2026-11-10T09:00:00Z',
      endsAt: '2026-11-10T09:30:00Z',
      timezone: 'UTC',
      customerName: 'Alex Customer',
      customerEmail: 'alex@example.com',
      idempotencyKey: 'idem-1',
      metadata: { note: 'x' },
    },
    CALENDLY_CREDS,
    http,
  );
  assert.equal(booked.externalBookingId, SCHEDULED_EVENT_URI);
  assert.equal(booked.manageUrl, 'https://calendly.test/resched/abc');
  const body = JSON.parse(calls[0].body);
  assert.equal(body.event_type, EVENT_TYPE_URI);
  assert.equal(body.start_time, '2026-11-10T09:00:00.000Z');
  assert.deepEqual(body.invitee, { name: 'Alex Customer', email: 'alex@example.com', timezone: 'UTC' });
});

test('calendly: a booking response that points outside the provider is rejected', async () => {
  const { http } = fakeHttp(() => ({
    status: 201,
    body: { resource: { event: 'https://attacker.example/scheduled_events/x' } },
  }));
  const provider = createCalendlyProvider({ ...ENABLED, baseUrl: CALENDLY_BASE });
  await assert.rejects(
    provider.createBooking(REF_CALENDLY, { startsAt: '2026-11-10T09:00:00Z', endsAt: '2026-11-10T09:30:00Z', timezone: 'UTC', customerName: 'A', customerEmail: 'a@example.com', idempotencyKey: 'k', metadata: {} }, CALENDLY_CREDS, http),
    { code: 'bad_response' },
  );
});

test('calendly: cancelBooking refuses a reference outside the provider without any request, and 404 returns false', async () => {
  const { http, calls } = fakeHttp(() => ({ status: 404, body: {} }));
  const provider = createCalendlyProvider({ ...ENABLED, baseUrl: CALENDLY_BASE });
  await assert.rejects(provider.cancelBooking(REF_CALENDLY, 'https://attacker.example/scheduled_events/x', null, CALENDLY_CREDS, http), { code: 'invalid_request' });
  assert.equal(calls.length, 0);
  assert.equal(await provider.cancelBooking(REF_CALENDLY, SCHEDULED_EVENT_URI, 'changed plans', CALENDLY_CREDS, http), false);
  assert.ok(calls[0].url.endsWith('/cancellation'));
});

test('calendly: pagination never follows a next-page URL to another host, so the token stays with the provider', async () => {
  const { http, calls } = fakeHttp(() => ({
    body: {
      resource: { uri: `${CALENDLY_BASE}/users/u1` },
      collection: [],
      pagination: { next_page: 'https://attacker.example/steal?x=1' },
    },
  }));
  const provider = createCalendlyProvider({ ...ENABLED, baseUrl: CALENDLY_BASE });
  await assert.rejects(provider.listEventTypes(CO_A, 'bot-1', CALENDLY_CREDS, http), { code: 'bad_response' });
  for (const req of calls) assert.ok(req.url.startsWith(CALENDLY_BASE), `request went to ${req.url}`);
});

test('calendly: the token never appears in an error, a stack, or a log, even when the provider echoes it', async () => {
  const { http } = fakeHttp(() => ({ status: 500, body: { error: `bad token ${TOKEN}` } }));
  const provider = createCalendlyProvider({ ...ENABLED, baseUrl: CALENDLY_BASE });
  const { result, seen } = await captureConsole(() =>
    provider.listSlots(REF_CALENDLY, { from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z', timezone: 'UTC' }, CALENDLY_CREDS, http).then(
      () => null,
      (error) => error,
    ),
  );
  assert.ok(result instanceof CalendarProviderError);
  assert.equal(result.status, 500);
  assert.equal(result.retryable, true);
  assert.ok(!result.message.includes(TOKEN));
  assert.ok(!String(result.stack).includes(TOKEN));
  assert.ok(!JSON.stringify(result).includes(TOKEN));
  assert.equal(seen.length, 0, 'the provider writes no logs');

  // A transport error that carries the token in its message is replaced by a fixed message.
  const transport = fakeHttp(() => {
    throw Object.assign(new Error(`socket for ${TOKEN}`), { kind: 'network' });
  });
  const failure = await provider.listEventTypes(CO_A, 'bot-1', CALENDLY_CREDS, transport.http).catch((e) => e);
  assert.equal(failure.code, 'network');
  assert.ok(!failure.message.includes(TOKEN));
});

test('calendly: a timeout is retryable and reported as a timeout', async () => {
  const { http } = fakeHttp(() => {
    throw { kind: 'timeout', message: 'slow' };
  });
  const provider = createCalendlyProvider({ ...ENABLED, baseUrl: CALENDLY_BASE });
  const error = await provider.listSlots(REF_CALENDLY, { from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z', timezone: 'UTC' }, CALENDLY_CREDS, http).catch((e) => e);
  assert.equal(error.code, 'timeout');
  assert.equal(error.retryable, true);
});

test('calendly: a missing token is a config error that names the key, never a value', async () => {
  const { http, calls } = fakeHttp(() => ({ body: {} }));
  const provider = createCalendlyProvider({ ...ENABLED, baseUrl: CALENDLY_BASE });
  const error = await provider.listSlots(REF_CALENDLY, { from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z', timezone: 'UTC' }, { [CALENDLY_TOKEN_KEY]: '  ' }, http).catch((e) => e);
  assert.equal(error.code, 'config');
  assert.match(error.message, /accessToken/);
  assert.equal(calls.length, 0);
});

test('calendly: loadCalendlyCredentials reads the encrypted settings through readCalendlyToken and returns null without a token', async () => {
  const company = CO_A;
  const found = await loadCalendlyCredentials(company, { readCalendlyToken: async (id) => (id === CO_A ? TOKEN : null) }, { webhookSigningKey: SIGNING });
  assert.deepEqual(found, { [CALENDLY_TOKEN_KEY]: TOKEN, [CALENDLY_SIGNING_KEY]: SIGNING });
  assert.equal(await loadCalendlyCredentials(CO_B, { readCalendlyToken: async () => null }), null);
  await assert.rejects(loadCalendlyCredentials('not-a-company', { readCalendlyToken: async () => TOKEN }), { status: 403 });
});

test('calendly: webhook signature passes only for the exact timestamp and body, within three minutes', async () => {
  const now = new Date('2026-11-10T09:00:00Z');
  const provider = createCalendlyProvider({ ...ENABLED, baseUrl: CALENDLY_BASE, now: () => now });
  const t = String(Math.floor(now.getTime() / 1000));
  const body = JSON.stringify({ event: 'invitee.created', payload: { event: SCHEDULED_EVENT_URI, uri: 'inv-1' } });
  const v1 = createHmac('sha256', SIGNING).update(`${t}.${body}`).digest('hex');
  const header = `t=${t},v1=${v1}`;
  const verify = (input, creds = CALENDLY_CREDS) => provider.verifyWebhook(CO_A, input, creds);

  assert.equal(await verify({ rawBody: body, signature: header, timestamp: t }), true);
  assert.equal(await verify({ rawBody: body + ' ', signature: header, timestamp: t }), false, 'changed body');
  assert.equal(await verify({ rawBody: body, signature: `t=${t},v1=${'0'.repeat(64)}`, timestamp: t }), false, 'wrong signature');
  assert.equal(await verify({ rawBody: body, signature: header, timestamp: String(Number(t) + 1) }), false, 'timestamp mismatch');
  const old = String(Math.floor(now.getTime() / 1000) - 3600);
  const oldSig = createHmac('sha256', SIGNING).update(`${old}.${body}`).digest('hex');
  assert.equal(await verify({ rawBody: body, signature: `t=${old},v1=${oldSig}`, timestamp: old }), false, 'stale');
  assert.equal(await verify({ rawBody: body, signature: header, timestamp: t }, { [CALENDLY_TOKEN_KEY]: TOKEN }), false, 'missing secret fails closed');
  assert.equal(await verify({ rawBody: body, signature: null, timestamp: null }), false);
});

test('calendly: parseWebhook maps invitee events and never parses a bad body into events', () => {
  const provider = createCalendlyProvider({ ...ENABLED, baseUrl: CALENDLY_BASE });
  const created = provider.parseWebhook(CO_A, JSON.stringify({ event: 'invitee.created', created_at: '2026-11-10T08:00:00Z', payload: { uri: 'inv-1', event: SCHEDULED_EVENT_URI } }));
  assert.deepEqual(created, [
    { providerEventId: 'inv-1', type: 'booking.created', externalBookingId: SCHEDULED_EVENT_URI, occurredAt: new Date('2026-11-10T08:00:00Z') },
  ]);
  const cancelled = provider.parseWebhook(CO_A, JSON.stringify({ event: 'invitee.canceled', payload: { uri: 'inv-2', event: SCHEDULED_EVENT_URI } }));
  assert.equal(cancelled[0].type, 'booking.cancelled');
  assert.deepEqual(provider.parseWebhook(CO_A, 'not json'), []);
});

// ---------------------------------------------------------------------------------------------
// Cal.com
// ---------------------------------------------------------------------------------------------

test('calcom: listSlots reads event length, sends the versioned headers, and sets each end from the length', async () => {
  const { http, calls } = fakeHttp((req) => {
    if (req.url.startsWith(`${CALCOM_BASE}/event-types`)) {
      return { body: { status: 'success', data: [{ id: 4242, title: 'Quote visit', lengthInMinutes: 45, hidden: false }] } };
    }
    return {
      body: {
        status: 'success',
        data: { '2026-11-10': [{ start: '2026-11-10T09:00:00.000Z' }, { start: '2026-11-10T13:00:00.000Z' }] },
      },
    };
  });
  const provider = createCalcomProvider({ ...ENABLED, baseUrl: CALCOM_BASE });
  const slots = await provider.listSlots(REF_CALCOM, { from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z', timezone: 'Australia/Melbourne' }, CALCOM_CREDS, http);
  assert.equal(slots.length, 2);
  assert.equal(slots[0].endsAt, '2026-11-10T09:45:00.000Z');
  const slotCall = calls.find((c) => c.url.includes('/slots?'));
  assert.equal(slotCall.headers['cal-api-version'], '2024-09-04');
  assert.equal(calls[0].headers['cal-api-version'], '2024-06-14');
  for (const req of calls) {
    assert.equal(req.headers.authorization, `Bearer ${CALCOM_KEY}`);
    assert.ok(!req.url.includes(CALCOM_KEY));
  }
});

test('calcom: createBooking posts the attendee, the numeric event type and the pinned version, and returns the uid', async () => {
  const { http, calls } = fakeHttp((req) => {
    if (req.url === `${CALCOM_BASE}/bookings`) {
      return { status: 201, body: { status: 'success', data: { id: 9, uid: 'abc_DEF-123', start: '2026-11-10T09:00:00.000Z', end: '2026-11-10T10:00:00.000Z' } } };
    }
    return { status: 404, body: {} };
  });
  const provider = createCalcomProvider({ ...ENABLED, baseUrl: CALCOM_BASE });
  const booked = await provider.createBooking(
    REF_CALCOM,
    { startsAt: '2026-11-10T09:00:00Z', endsAt: '2026-11-10T10:00:00Z', timezone: 'Australia/Melbourne', customerName: 'Alex', customerEmail: 'alex@example.com', idempotencyKey: 'k1', metadata: { source: 'chatbot', bad: 5 } },
    CALCOM_CREDS,
    http,
  );
  assert.equal(booked.externalBookingId, 'abc_DEF-123');
  assert.equal(calls[0].headers['cal-api-version'], '2026-02-25');
  const body = JSON.parse(calls[0].body);
  assert.equal(body.eventTypeId, 4242);
  assert.deepEqual(body.attendee, { name: 'Alex', email: 'alex@example.com', timeZone: 'Australia/Melbourne', language: 'en' });
  assert.deepEqual(body.metadata, { source: 'chatbot' }, 'non-string metadata is dropped');
});

test('calcom: cancelBooking posts to the booking path and returns false on 404', async () => {
  const { http, calls } = fakeHttp((req) => (req.url.endsWith('/bookings/abc_DEF-123/cancel') ? { body: { status: 'success' } } : { status: 404, body: {} }));
  const provider = createCalcomProvider({ ...ENABLED, baseUrl: CALCOM_BASE });
  assert.equal(await provider.cancelBooking(REF_CALCOM, 'abc_DEF-123', 'no longer needed', CALCOM_CREDS, http), true);
  assert.equal(calls[0].method, 'POST');
  assert.equal(await provider.cancelBooking(REF_CALCOM, 'missing', null, CALCOM_CREDS, http), false);
  await assert.rejects(provider.cancelBooking(REF_CALCOM, '../etc', null, CALCOM_CREDS, http), { code: 'invalid_request' });
});

test('calcom: webhook HMAC passes only with the right secret and body, and fails closed without a secret', async () => {
  const provider = createCalcomProvider({ ...ENABLED, baseUrl: CALCOM_BASE });
  const body = JSON.stringify({ triggerEvent: 'BOOKING_CANCELLED', createdAt: '2026-11-10T08:00:00Z', payload: { uid: 'abc' } });
  const sig = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  assert.equal(await provider.verifyWebhook(CO_A, { rawBody: body, signature: sig, timestamp: null }, CALCOM_CREDS), true);
  assert.equal(await provider.verifyWebhook(CO_A, { rawBody: body, signature: '0'.repeat(64), timestamp: null }, CALCOM_CREDS), false);
  assert.equal(await provider.verifyWebhook(CO_A, { rawBody: body, signature: sig, timestamp: null }, { [CALCOM_API_KEY]: CALCOM_KEY }), false);
  const [event] = provider.parseWebhook(CO_A, body);
  assert.equal(event.type, 'booking.cancelled');
  assert.equal(event.externalBookingId, 'abc');
});

test('calcom: the API key never appears in an error when the provider rejects the key', async () => {
  const { http } = fakeHttp(() => ({ status: 401, body: { message: `invalid ${CALCOM_KEY}` } }));
  const provider = createCalcomProvider({ ...ENABLED, baseUrl: CALCOM_BASE });
  const error = await provider.listEventTypes(CO_A, 'bot-1', CALCOM_CREDS, http).catch((e) => e);
  assert.equal(error.status, 401);
  assert.equal(error.retryable, false);
  assert.ok(!JSON.stringify(error).includes(CALCOM_KEY));
  assert.ok(!error.message.includes(CALCOM_KEY));
});

test('calcom: listBookings keeps only this event type and maps cancelled and rejected to cancelled', async () => {
  const { http } = fakeHttp((req) => {
    const status = new URL(req.url).searchParams.get('status');
    if (status !== 'upcoming') return { body: { status: 'success', data: [] } };
    return {
      body: {
        status: 'success',
        data: [
          { uid: 'u1', eventTypeId: 4242, status: 'accepted', start: '2026-11-10T09:00:00.000Z', end: '2026-11-10T10:00:00.000Z' },
          { uid: 'u2', eventTypeId: 4242, status: 'rejected', start: '2026-11-10T11:00:00.000Z', end: '2026-11-10T12:00:00.000Z' },
          { uid: 'u3', eventTypeId: 999, status: 'accepted', start: '2026-11-10T13:00:00.000Z', end: '2026-11-10T14:00:00.000Z' },
        ],
      },
    };
  });
  const provider = createCalcomProvider({ ...ENABLED, baseUrl: CALCOM_BASE });
  const remote = await provider.listBookings(REF_CALCOM, { from: new Date('2026-11-10T00:00:00Z'), to: new Date('2026-11-11T00:00:00Z') }, CALCOM_CREDS, http);
  assert.deepEqual(remote.map((r) => [r.externalBookingId, r.status]), [['u1', 'active'], ['u2', 'cancelled']]);
});

// ---------------------------------------------------------------------------------------------
// Reminders (real bookings service, in memory)
// ---------------------------------------------------------------------------------------------

const ALL_DAYS = {
  monday: { enabled: true, start: '09:00', end: '17:00' },
  tuesday: { enabled: true, start: '09:00', end: '17:00' },
  wednesday: { enabled: true, start: '09:00', end: '17:00' },
  thursday: { enabled: true, start: '09:00', end: '17:00' },
  friday: { enabled: true, start: '09:00', end: '17:00' },
  saturday: { enabled: true, start: '09:00', end: '17:00' },
  sunday: { enabled: true, start: '09:00', end: '17:00' },
};
const MON_10 = '2026-11-09T10:00:00.000Z';

function reminderHarness(startNow = '2026-11-08T11:00:00Z') {
  const clock = { now: new Date(startNow) };
  const service = createBookingService({ storage: createMemoryBookingStorage(), now: () => clock.now, enabled: true });
  const store = createMemoryProviderStore();
  return { clock, service, store };
}

async function bookFor(service, companyId, calendarId, startsAt, overrides = {}) {
  const starts = new Date(startsAt);
  return service.book(companyId, {
    calendar_id: calendarId,
    customer_name: 'Alex Customer',
    customer_email: 'alex@example.com',
    starts_at: starts.toISOString(),
    ends_at: new Date(starts.getTime() + 30 * 60_000).toISOString(),
    ...overrides,
  });
}

function makeSender(channel, script) {
  const sent = [];
  return {
    channel,
    sent,
    async send(request) {
      sent.push(request);
      return script ? script(request, sent.length) : { status: 'sent', externalMessageId: `msg-${sent.length}` };
    },
  };
}

test('reminder: a due reminder is sent once, and a second run does not send it again', async () => {
  const h = reminderHarness('2026-11-08T11:00:00Z');
  const calendar = await h.service.createCalendar(CO_A, { name: 'Desk', timezone: 'UTC', availability: ALL_DAYS, buffer_minutes: 0 });
  await bookFor(h.service, CO_A, calendar.id, MON_10);
  const email = makeSender('email');
  const dispatcher = createReminderDispatcher({
    bookings: h.service,
    ledger: h.store.ledger,
    senders: { email },
    http: fakeHttp(() => ({})).http,
    config: { channels: ['email'], leadMinutes: 24 * 60 },
    now: () => h.clock.now,
  });
  const first = await dispatcher.runDue(CO_A);
  assert.equal(first.sent, 1);
  const second = await dispatcher.runDue(CO_A);
  assert.equal(second.sent, 0);
  assert.equal(email.sent.length, 1, 'the reminder is sent exactly once');
  assert.equal(email.sent[0].recipient, 'alex@example.com');
  assert.match(email.sent[0].body, /Alex Customer/);
  assert.match(email.sent[0].idempotencyKey, /:email:/);
});

test('reminder: nothing is sent before the lead time, and the same booking is sent once it is due', async () => {
  const h = reminderHarness('2026-11-08T08:00:00Z');
  const calendar = await h.service.createCalendar(CO_A, { name: 'Desk', timezone: 'UTC', availability: ALL_DAYS, buffer_minutes: 0 });
  await bookFor(h.service, CO_A, calendar.id, MON_10);
  const email = makeSender('email');
  const dispatcher = createReminderDispatcher({
    bookings: h.service,
    ledger: h.store.ledger,
    senders: { email },
    http: fakeHttp(() => ({})).http,
    config: { channels: ['email'], leadMinutes: 24 * 60 },
    now: () => h.clock.now,
  });
  assert.equal((await dispatcher.runDue(CO_A)).sent, 0, 'not due yet');
  h.clock.now = new Date('2026-11-08T10:30:00Z');
  assert.equal((await dispatcher.runDue(CO_A)).sent, 1);
  assert.equal(email.sent.length, 1);
});

test('reminder: a cancelled booking gets no reminder', async () => {
  const h = reminderHarness('2026-11-08T11:00:00Z');
  const calendar = await h.service.createCalendar(CO_A, { name: 'Desk', timezone: 'UTC', availability: ALL_DAYS, buffer_minutes: 0 });
  const booking = await bookFor(h.service, CO_A, calendar.id, MON_10);
  await h.service.cancel(CO_A, booking.id, 'customer asked');
  const email = makeSender('email');
  const dispatcher = createReminderDispatcher({
    bookings: h.service,
    ledger: h.store.ledger,
    senders: { email },
    http: fakeHttp(() => ({})).http,
    config: { channels: ['email'], leadMinutes: 24 * 60 },
    now: () => h.clock.now,
  });
  const summary = await dispatcher.runDue(CO_A);
  assert.equal(summary.sent, 0);
  assert.equal(email.sent.length, 0);
});

test('reminder: a booking cancelled between the list and the send is not sent (re-checked after the claim)', async () => {
  const h = reminderHarness('2026-11-08T11:00:00Z');
  const calendar = await h.service.createCalendar(CO_A, { name: 'Desk', timezone: 'UTC', availability: ALL_DAYS, buffer_minutes: 0 });
  const booking = await bookFor(h.service, CO_A, calendar.id, MON_10);
  const email = makeSender('email');
  const racingLedger = {
    ...h.store.ledger,
    async claim(...args) {
      // Simulates a cancel that lands right after the dispatcher has claimed the row.
      await h.service.cancel(CO_A, booking.id, 'race');
      return h.store.ledger.claim(...args);
    },
  };
  const dispatcher = createReminderDispatcher({
    bookings: h.service,
    ledger: racingLedger,
    senders: { email },
    http: fakeHttp(() => ({})).http,
    config: { channels: ['email'], leadMinutes: 24 * 60 },
    now: () => h.clock.now,
  });
  const summary = await dispatcher.runDue(CO_A);
  assert.equal(summary.sent, 0);
  assert.equal(email.sent.length, 0);
  const row = await h.store.ledger.find(CO_A, booking.id, 'email');
  assert.equal(row.status, 'cancelled');
});

test('reminder: cancelReminders blocks a later send for that booking', async () => {
  const h = reminderHarness('2026-11-08T11:00:00Z');
  const calendar = await h.service.createCalendar(CO_A, { name: 'Desk', timezone: 'UTC', availability: ALL_DAYS, buffer_minutes: 0 });
  const booking = await bookFor(h.service, CO_A, calendar.id, MON_10);
  const email = makeSender('email');
  const dispatcher = createReminderDispatcher({
    bookings: h.service,
    ledger: h.store.ledger,
    senders: { email },
    http: fakeHttp(() => ({})).http,
    config: { channels: ['email'], leadMinutes: 24 * 60 },
    now: () => h.clock.now,
  });
  await dispatcher.cancelReminders(CO_A, booking.id);
  assert.equal((await dispatcher.runDue(CO_A)).sent, 0);
  assert.equal(email.sent.length, 0);
});

test('reminder: a retryable failure is retried with the same idempotency key, and a sent reminder is never repeated', async () => {
  const h = reminderHarness('2026-11-08T11:00:00Z');
  const calendar = await h.service.createCalendar(CO_A, { name: 'Desk', timezone: 'UTC', availability: ALL_DAYS, buffer_minutes: 0 });
  await bookFor(h.service, CO_A, calendar.id, MON_10);
  const email = makeSender('email', (_req, attempt) =>
    attempt === 1 ? { status: 'failed', retryable: true, reason: 'provider_busy' } : { status: 'sent', externalMessageId: 'm' },
  );
  const dispatcher = createReminderDispatcher({
    bookings: h.service,
    ledger: h.store.ledger,
    senders: { email },
    http: fakeHttp(() => ({})).http,
    config: { channels: ['email'], leadMinutes: 24 * 60 },
    now: () => h.clock.now,
  });
  const first = await dispatcher.runDue(CO_A);
  assert.equal(first.failed, 1);
  const second = await dispatcher.runDue(CO_A);
  assert.equal(second.sent, 1);
  assert.equal(email.sent.length, 2);
  assert.equal(email.sent[0].idempotencyKey, email.sent[1].idempotencyKey);
  await dispatcher.runDue(CO_A);
  assert.equal(email.sent.length, 2, 'after a sent reminder there is no further send');
});

test('reminder: a sender that throws is treated as retryable, and a non-retryable failure is not retried', async () => {
  const h = reminderHarness('2026-11-08T11:00:00Z');
  const calendar = await h.service.createCalendar(CO_A, { name: 'Desk', timezone: 'UTC', availability: ALL_DAYS, buffer_minutes: 0 });
  await bookFor(h.service, CO_A, calendar.id, MON_10);
  let throwOnce = true;
  const email = makeSender('email', () => {
    if (throwOnce) {
      throwOnce = false;
      throw new Error('boom');
    }
    return { status: 'failed', retryable: false, reason: 'address_rejected' };
  });
  const dispatcher = createReminderDispatcher({
    bookings: h.service,
    ledger: h.store.ledger,
    senders: { email },
    http: fakeHttp(() => ({})).http,
    config: { channels: ['email'], leadMinutes: 24 * 60 },
    now: () => h.clock.now,
  });
  assert.equal((await dispatcher.runDue(CO_A)).failed, 1);
  assert.equal((await dispatcher.runDue(CO_A)).failed, 1);
  assert.equal(email.sent.length, 2);
  assert.equal((await dispatcher.runDue(CO_A)).sent, 0, 'a non-retryable failure is terminal');
  assert.equal(email.sent.length, 2);
});

test('reminder: no recipient on the channel means no send; SMS goes to the phone number', async () => {
  const h = reminderHarness('2026-11-08T11:00:00Z');
  const calendar = await h.service.createCalendar(CO_A, { name: 'Desk', timezone: 'UTC', availability: ALL_DAYS, buffer_minutes: 0 });
  await bookFor(h.service, CO_A, calendar.id, MON_10, { customer_email: null, customer_phone: '+61400000000' });
  const email = makeSender('email');
  const sms = makeSender('sms');
  const dispatcher = createReminderDispatcher({
    bookings: h.service,
    ledger: h.store.ledger,
    senders: { email, sms },
    http: fakeHttp(() => ({})).http,
    config: { channels: ['email', 'sms'], leadMinutes: 24 * 60 },
    now: () => h.clock.now,
  });
  const summary = await dispatcher.runDue(CO_A);
  assert.equal(email.sent.length, 0);
  assert.equal(sms.sent.length, 1);
  assert.equal(sms.sent[0].recipient, '+61400000000');
  assert.equal(summary.skipped, 1);
});

test('reminder: a company never sends reminders for another company’s bookings', async () => {
  const h = reminderHarness('2026-11-08T11:00:00Z');
  const calendarB = await h.service.createCalendar(CO_B, { name: 'Other', timezone: 'UTC', availability: ALL_DAYS, buffer_minutes: 0 });
  await bookFor(h.service, CO_B, calendarB.id, MON_10);
  const email = makeSender('email');
  const dispatcher = createReminderDispatcher({
    bookings: h.service,
    ledger: h.store.ledger,
    senders: { email },
    http: fakeHttp(() => ({})).http,
    config: { channels: ['email'], leadMinutes: 24 * 60 },
    now: () => h.clock.now,
  });
  assert.equal((await dispatcher.runDue(CO_A)).sent, 0);
  assert.equal(email.sent.length, 0);
  assert.equal((await dispatcher.runDue(CO_B)).sent, 1);
});

test('reminder: onSent fires once after a successful send, with company and appointment ids', async () => {
  const h = reminderHarness('2026-11-08T11:00:00Z');
  const calendar = await h.service.createCalendar(CO_A, { name: 'Desk', timezone: 'UTC', availability: ALL_DAYS, buffer_minutes: 0 });
  const booked = await bookFor(h.service, CO_A, calendar.id, MON_10);
  const events = [];
  const dispatcher = createReminderDispatcher({
    bookings: h.service,
    ledger: h.store.ledger,
    senders: { email: makeSender('email') },
    http: fakeHttp(() => ({})).http,
    config: { channels: ['email'], leadMinutes: 24 * 60 },
    now: () => h.clock.now,
    onSent: (event) => { events.push(event); },
  });
  await dispatcher.runDue(CO_A);
  await dispatcher.runDue(CO_A);
  assert.equal(events.length, 1, 'the hook fires once, and a second run does not fire it again');
  assert.equal(events[0].companyId, CO_A);
  assert.equal(events[0].appointmentId, booked.id);
  assert.equal(events[0].channel, 'email');
  assert.ok(events[0].sentAt instanceof Date);
});

test('reminder: onSent does not fire for a failed send, and a throwing hook does not undo the send', async () => {
  const h = reminderHarness('2026-11-08T11:00:00Z');
  const calendar = await h.service.createCalendar(CO_A, { name: 'Desk', timezone: 'UTC', availability: ALL_DAYS, buffer_minutes: 0 });
  await bookFor(h.service, CO_A, calendar.id, MON_10);
  const events = [];
  const failing = createReminderDispatcher({
    bookings: h.service,
    ledger: h.store.ledger,
    senders: { email: makeSender('email', () => ({ status: 'failed', retryable: false, reason: 'bounced' })) },
    http: fakeHttp(() => ({})).http,
    config: { channels: ['email'], leadMinutes: 24 * 60 },
    now: () => h.clock.now,
    onSent: (event) => { events.push(event); },
  });
  const failed = await failing.runDue(CO_A);
  assert.equal(failed.failed, 1);
  assert.equal(events.length, 0, 'no event for a failed send');

  const h2 = reminderHarness('2026-11-08T11:00:00Z');
  const calendar2 = await h2.service.createCalendar(CO_A, { name: 'Desk', timezone: 'UTC', availability: ALL_DAYS, buffer_minutes: 0 });
  await bookFor(h2.service, CO_A, calendar2.id, MON_10);
  const email = makeSender('email');
  const throwing = createReminderDispatcher({
    bookings: h2.service,
    ledger: h2.store.ledger,
    senders: { email },
    http: fakeHttp(() => ({})).http,
    config: { channels: ['email'], leadMinutes: 24 * 60 },
    now: () => h2.clock.now,
    onSent: () => { throw new Error('webhook down'); },
  });
  const sentRun = await captureConsole(() => throwing.runDue(CO_A));
  assert.equal(sentRun.result.sent, 1, 'the send still counts as sent');
  assert.equal(sentRun.result.failed, 0);
  assert.equal(email.sent.length, 1);
});

test('reminder: appointment.reminder_sent is registered in the user webhook event list', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../server/routes/user-webhook-routes.ts', import.meta.url), 'utf8');
  assert.match(source, /'appointment\.reminder_sent'/);
});

test('reminder: invalid config is refused at construction', () => {
  const h = reminderHarness();
  const base = { bookings: h.service, ledger: h.store.ledger, senders: {}, http: fakeHttp(() => ({})).http };
  assert.throws(() => createReminderDispatcher({ ...base, config: { channels: ['email'], leadMinutes: 4 } }), RangeError);
  assert.throws(() => createReminderDispatcher({ ...base, config: { channels: ['email'], leadMinutes: 10081 } }), RangeError);
  assert.throws(() => createReminderDispatcher({ ...base, config: { channels: ['email', 'email'], leadMinutes: 60 } }), RangeError);
  assert.throws(() => createReminderDispatcher({ ...base, config: { channels: ['pigeon'], leadMinutes: 60 } }), RangeError);
  assert.throws(() => createReminderDispatcher({ ...base, senders: { email: makeSender('sms') }, config: { channels: ['email'], leadMinutes: 60 } }), RangeError);
});

// ---------------------------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------------------------

const T0 = new Date('2026-11-10T09:00:00Z');
const T1 = new Date('2026-11-10T09:30:00Z');

function local(id, companyId, status = 'confirmed', startsAt = T0, endsAt = T1) {
  return { id, companyId, calendarId: 'cal-1', conversationId: null, customerName: 'A', customerEmail: 'a@example.com', customerPhone: null, startsAt, endsAt, status, statusReason: null, metadata: null, createdAt: T0, updatedAt: T0 };
}
function link(appointmentId, externalBookingId, companyId = CO_A, provider = 'calendly') {
  return { id: `link-${externalBookingId}`, companyId, chatbotId: 'bot-1', provider, externalEventTypeId: EVENT_TYPE_URI, externalBookingId, appointmentId, startsAt: T0, endsAt: T1, status: 'active', manageUrl: null, createdAt: T0, updatedAt: T0 };
}
const remote = (externalBookingId, status = 'active', startsAt = T0, endsAt = T1) => ({ externalBookingId, startsAt, endsAt, status });

test('reconcile: a matching booking is counted as matched with no discrepancy', () => {
  const result = reconcileBookings({ companyId: CO_A, provider: 'calendly', localAppointments: [local('a1', CO_A)], links: [link('a1', 'evt-1')], remote: [remote('evt-1')] });
  assert.equal(result.checked, 1);
  assert.equal(result.matched, 1);
  assert.deepEqual(result.discrepancies, []);
});

test('reconcile: a confirmed local booking missing on the provider is reported', () => {
  const result = reconcileBookings({ companyId: CO_A, provider: 'calendly', localAppointments: [local('a1', CO_A)], links: [link('a1', 'evt-1')], remote: [] });
  assert.deepEqual(result.discrepancies.map((d) => d.kind), ['missing_remote']);
});

test('reconcile: a provider cancellation of a confirmed booking is a status mismatch, and a moved time is a time mismatch', () => {
  const cancelled = reconcileBookings({ companyId: CO_A, provider: 'calendly', localAppointments: [local('a1', CO_A)], links: [link('a1', 'evt-1')], remote: [remote('evt-1', 'cancelled')] });
  assert.deepEqual(cancelled.discrepancies.map((d) => d.kind), ['status_mismatch']);
  const moved = reconcileBookings({
    companyId: CO_A,
    provider: 'calendly',
    localAppointments: [local('a1', CO_A)],
    links: [link('a1', 'evt-1')],
    remote: [remote('evt-1', 'active', new Date('2026-11-10T10:00:00Z'), new Date('2026-11-10T10:30:00Z'))],
  });
  assert.deepEqual(moved.discrepancies.map((d) => d.kind), ['time_mismatch']);
});

test('reconcile: a provider booking with no link is counted as untracked and never compared', () => {
  const result = reconcileBookings({ companyId: CO_A, provider: 'calendly', localAppointments: [], links: [], remote: [remote('manual-1')] });
  assert.equal(result.untrackedRemote, 1);
  assert.equal(result.checked, 0);
  assert.deepEqual(result.discrepancies, []);
});

test('reconcile: an event that belongs to another company is never reconciled, even when it is in the same provider account', () => {
  // Company B's link and appointment, and a provider event for B that shows up in A's listing.
  const bLocal = local('b1', CO_B, 'confirmed');
  const bLink = link('b1', 'evt-B', CO_B);
  const result = reconcileBookings({
    companyId: CO_A,
    provider: 'calendly',
    localAppointments: [bLocal],
    links: [bLink],
    remote: [remote('evt-B', 'cancelled')],
  });
  assert.equal(result.checked, 0);
  assert.equal(result.untrackedRemote, 1);
  assert.deepEqual(result.discrepancies, [], 'B’s cancelled event must not produce a discrepancy for A');
});

test('reconcile: a link or appointment whose company differs is ignored even if it is handed in', () => {
  // A link row says company A, but its appointment belongs to company B. Only the company check decides.
  const mixedLink = link('a1', 'evt-1', CO_A);
  const result = reconcileBookings({
    companyId: CO_A,
    provider: 'calendly',
    localAppointments: [local('a1', CO_B)], // wrong company on the local row
    links: [mixedLink, link('a1', 'evt-2', CO_B)],
    remote: [remote('evt-1'), remote('evt-2', 'cancelled')],
  });
  assert.equal(result.checked, 1);
  assert.deepEqual(result.discrepancies.map((d) => d.kind), ['missing_local']);
});

test('reconcile: reconcileCalendar loads links and bookings for the company only', async () => {
  const store = createMemoryProviderStore();
  const bookingsB = createBookingService({ storage: createMemoryBookingStorage(), now: () => new Date('2026-11-08T00:00:00Z'), enabled: true });
  const calendar = await bookingsB.createCalendar(CO_A, { name: 'Desk', timezone: 'UTC', availability: ALL_DAYS, buffer_minutes: 0 });
  const booked = await bookFor(bookingsB, CO_A, calendar.id, MON_10);
  await store.links.insertLink(CO_A, { chatbotId: 'bot-1', provider: 'calendly', externalEventTypeId: EVENT_TYPE_URI, externalBookingId: 'evt-A', appointmentId: booked.id, startsAt: new Date(MON_10), endsAt: new Date('2026-11-09T10:30:00Z'), manageUrl: null }, T0);
  await store.links.insertLink(CO_B, { chatbotId: 'bot-2', provider: 'calendly', externalEventTypeId: EVENT_TYPE_URI, externalBookingId: 'evt-B', appointmentId: null, startsAt: new Date(MON_10), endsAt: new Date('2026-11-09T10:30:00Z'), manageUrl: null }, T0);
  const lister = { async listBookings() { return [remote('evt-A', 'active', new Date(MON_10), new Date('2026-11-09T10:30:00Z')), remote('evt-B', 'cancelled', new Date(MON_10), new Date('2026-11-09T10:30:00Z'))]; } };
  const result = await reconcileCalendar({
    companyId: CO_A,
    provider: 'calendly',
    lister,
    links: store.links,
    bookings: bookingsB,
    ref: REF_CALENDLY,
    credentials: CALENDLY_CREDS,
    http: fakeHttp(() => ({})).http,
    window: { from: new Date('2026-11-09T00:00:00Z'), to: new Date('2026-11-10T00:00:00Z') },
  });
  assert.equal(result.checked, 1);
  assert.equal(result.matched, 1);
  assert.equal(result.untrackedRemote, 1);
  assert.deepEqual(result.discrepancies, []);
});

// ---------------------------------------------------------------------------------------------
// Stores: company isolation and the Drizzle query shape
// ---------------------------------------------------------------------------------------------

test('memory store: links and reminder rows are invisible across companies', async () => {
  const store = createMemoryProviderStore();
  const input = { chatbotId: 'bot-1', provider: 'calcom', externalEventTypeId: '4242', externalBookingId: 'uid-1', appointmentId: null, startsAt: T0, endsAt: T1, manageUrl: null };
  const first = await store.links.insertLink(CO_A, input, T0);
  const again = await store.links.insertLink(CO_A, input, T0);
  assert.equal(first.id, again.id, 'a repeated insert returns the same link');
  assert.equal((await store.links.listLinks(CO_B, 'calcom', { from: T0, to: T1 })).length, 0);
  assert.equal((await store.links.listLinks(CO_A, 'calcom', { from: T0, to: T1 })).length, 1);
  assert.equal(await store.links.setLinkStatus(CO_B, 'calcom', 'uid-1', 'cancelled', T1), false);

  assert.equal(await store.ledger.claim(CO_A, 'a1', 'email', 'k', T0), true);
  assert.equal(await store.ledger.claim(CO_A, 'a1', 'email', 'k', T0), false);
  assert.equal(await store.ledger.claim(CO_B, 'a1', 'email', 'k', T0), true, 'the same appointment id in another company is a different row');
});

test('drizzle store: every query carries company_id, and the once-per-booking key is the conflict target', () => {
  const company = CO_A;
  const at = T0;
  const cases = {
    insertLink: providerQueries.insertLink(db, company, { chatbotId: 'b', provider: 'calendly', externalEventTypeId: 'e', externalBookingId: 'x', appointmentId: null, startsAt: at, endsAt: T1, manageUrl: null }, at),
    selectLink: providerQueries.selectLink(db, company, 'calendly', 'x'),
    listLinks: providerQueries.listLinks(db, company, 'calendly', { from: at, to: T1 }),
    setLinkStatus: providerQueries.setLinkStatus(db, company, 'calendly', 'x', 'cancelled', at),
    claimReminder: providerQueries.claimReminder(db, company, 'a1', 'email', 'k', at),
    completeReminder: providerQueries.completeReminder(db, company, 'a1', 'email', { status: 'sent', externalMessageId: 'm' }, at),
    releaseReminder: providerQueries.releaseReminder(db, company, 'a1', 'email'),
    cancelReminder: providerQueries.cancelReminder(db, company, 'a1', 'email', at),
    selectReminder: providerQueries.selectReminder(db, company, 'a1', 'email'),
  };
  for (const [name, query] of Object.entries(cases)) {
    const { sql, params } = render(query);
    assert.match(sql, /"company_id"/, `${name} must filter or set company_id`);
    assert.ok(params.includes(company), `${name} must bind the company id`);
  }
  const claim = render(cases.claimReminder).sql;
  assert.match(claim, /on conflict \("company_id",\s*"appointment_id",\s*"channel"\) do nothing/i);
  const link = render(cases.insertLink).sql;
  assert.match(link, /on conflict \("company_id",\s*"provider",\s*"external_booking_id"\) do nothing/i);
  assert.match(render(cases.releaseReminder).sql, /"status" = /, 'release only deletes a sending row');
});

test('drizzle schema: both tables carry company_id and the unique keys include it', () => {
  for (const table of [chatbotExternalBookings, chatbotBookingReminderSends]) {
    const config = getTableConfig(table);
    assert.ok(config.columns.some((c) => c.name === 'company_id' && c.notNull), `${config.name} has company_id`);
  }
  const reminder = getTableConfig(chatbotBookingReminderSends);
  const once = reminder.indexes.find((i) => i.config.name === 'chatbot_booking_reminder_sends_once_uidx');
  assert.ok(once, 'once-per-booking index exists');
  assert.equal(once.config.unique, true);
  assert.deepEqual(once.config.columns.map((c) => c.name), ['company_id', 'appointment_id', 'channel']);
});

test('drizzle store: a company id that is not a UUID is refused before any query is built', async () => {
  const store = createDrizzleProviderStore(untouchableDb());
  await assert.rejects(store.links.listLinks('not-a-company', 'calendly', { from: T0, to: T1 }), { status: 403 });
  await assert.rejects(store.ledger.claim('not-a-company', 'a1', 'email', 'k', T0), { status: 403 });
});

// ---------------------------------------------------------------------------------------------
// Provider API facts fixed in this pass (see DECISIONS.md, "Provider API facts")
// ---------------------------------------------------------------------------------------------

test('calendly: the invitee event and manage link are read from the top level, and a wrapped reply still works', async () => {
  const top = fakeHttp(() => ({ status: 201, body: { event: SCHEDULED_EVENT_URI, reschedule_url: 'https://calendly.test/resched/top' } }));
  const provider = createCalendlyProvider({ ...ENABLED, baseUrl: CALENDLY_BASE });
  const a = await provider.createBooking(REF_CALENDLY, bookRequest(), CALENDLY_CREDS, top.http);
  assert.equal(a.externalBookingId, SCHEDULED_EVENT_URI);
  assert.equal(a.manageUrl, 'https://calendly.test/resched/top');

  const wrapped = fakeHttp(() => ({ status: 201, body: { resource: { event: SCHEDULED_EVENT_URI, cancel_url: 'https://calendly.test/cancel/w' } } }));
  const b = await provider.createBooking(REF_CALENDLY, bookRequest(), CALENDLY_CREDS, wrapped.http);
  assert.equal(b.externalBookingId, SCHEDULED_EVENT_URI);
  assert.equal(b.manageUrl, 'https://calendly.test/cancel/w');
});

test('calendly: a webhook timestamp older than three minutes is refused, and two minutes old passes', async () => {
  const t = Math.floor(Date.parse('2026-11-10T08:00:00Z') / 1000);
  const body = JSON.stringify({ event: 'invitee.canceled', payload: { uri: 'x' } });
  const header = `t=${t},v1=${createHmac('sha256', SIGNING).update(`${t}.${body}`).digest('hex')}`;
  const at = (minutes) => createCalendlyProvider({ ...ENABLED, baseUrl: CALENDLY_BASE, now: () => new Date((t + minutes * 60) * 1000) });
  const input = { rawBody: body, signature: header, timestamp: null };
  assert.equal(await at(2).verifyWebhook(CO_A, input, CALENDLY_CREDS), true);
  assert.equal(await at(4).verifyWebhook(CO_A, input, CALENDLY_CREDS), false);
});

test('calcom: cancel uses the 2026-02-25 version, and listBookings pages by cursor with the 2026-05-01 version', async () => {
  const provider = createCalcomProvider({ ...ENABLED, baseUrl: CALCOM_BASE });
  const cancel = fakeHttp(() => ({ body: { status: 'success' } }));
  await provider.cancelBooking(REF_CALCOM, 'uid-1', null, CALCOM_CREDS, cancel.http);
  assert.equal(cancel.calls[0].headers['cal-api-version'], '2026-02-25');

  const listing = fakeHttp((req) => {
    const url = new URL(req.url);
    if (url.searchParams.get('status') !== 'upcoming') return { body: { status: 'success', data: [], pagination: { hasMore: false } } };
    if (url.searchParams.get('cursor') === 'c2') {
      return { body: { status: 'success', data: [{ uid: 'u2', eventType: { id: 4242 }, status: 'pending', start: '2026-11-10T11:00:00.000Z', end: '2026-11-10T11:30:00.000Z' }], pagination: { hasMore: false, nextCursor: null } } };
    }
    return { body: { status: 'success', data: [{ uid: 'u1', eventType: { id: 4242 }, status: 'accepted', start: '2026-11-10T09:00:00.000Z', end: '2026-11-10T09:30:00.000Z' }], pagination: { hasMore: true, nextCursor: 'c2' } } };
  });
  const remote = await provider.listBookings(REF_CALCOM, { from: new Date('2026-11-10T00:00:00Z'), to: new Date('2026-11-11T00:00:00Z') }, CALCOM_CREDS, listing.http);
  assert.deepEqual(remote.map((r) => [r.externalBookingId, r.status]), [['u1', 'active'], ['u2', 'active']]);
  const upcoming = listing.calls.filter((c) => new URL(c.url).searchParams.get('status') === 'upcoming');
  assert.equal(upcoming.length, 2);
  for (const call of upcoming) {
    assert.equal(call.headers['cal-api-version'], '2026-05-01');
    assert.equal(new URL(call.url).searchParams.get('eventTypeIds'), '4242');
    assert.equal(new URL(call.url).searchParams.has('skip'), false);
    assert.equal(new URL(call.url).searchParams.has('take'), false);
  }
  assert.equal(new URL(upcoming[1].url).searchParams.get('cursor'), 'c2');
});

test('calcom and calendly: a listing that never runs out of pages fails instead of returning a partial list', async () => {
  let n = 0;
  const calcom = fakeHttp(() => ({ body: { status: 'success', data: [], pagination: { hasMore: true, nextCursor: `c${n++}` } } }));
  const calcomProvider = createCalcomProvider({ ...ENABLED, baseUrl: CALCOM_BASE });
  const cError = await calcomProvider.listBookings(REF_CALCOM, { from: new Date('2026-11-10T00:00:00Z'), to: new Date('2026-11-11T00:00:00Z') }, CALCOM_CREDS, calcom.http).catch((e) => e);
  assert.equal(cError.code, 'bad_response');
  assert.equal(calcom.calls.filter((c) => new URL(c.url).searchParams.get('status') === 'upcoming').length, 20);

  let m = 0;
  const calendly = fakeHttp((req) => {
    if (req.url.endsWith('/users/me')) return { body: { resource: { uri: `${CALENDLY_BASE}/users/u1` } } };
    return { body: { collection: [], pagination: { next_page: `${CALENDLY_BASE}/scheduled_events?page_token=p${m++}` } } };
  });
  const calendlyProvider = createCalendlyProvider({ ...ENABLED, baseUrl: CALENDLY_BASE });
  const dError = await calendlyProvider.listBookings(REF_CALENDLY, { from: new Date('2026-11-10T00:00:00Z'), to: new Date('2026-11-11T00:00:00Z') }, CALENDLY_CREDS, calendly.http).catch((e) => e);
  assert.equal(dError.code, 'bad_response');
});

// ---------------------------------------------------------------------------------------------
// Retry-safe booking
// ---------------------------------------------------------------------------------------------

const OK_CALCOM = { status: 'success', data: { uid: 'bk_0001', start: '2026-11-10T09:00:00.000Z', end: '2026-11-10T09:30:00.000Z' } };

function bookRequest(key = 'retry-key-0001', overrides = {}) {
  return {
    startsAt: '2026-11-10T09:00:00Z',
    endsAt: '2026-11-10T09:30:00Z',
    timezone: 'Australia/Melbourne',
    customerName: 'Alex Customer',
    customerEmail: 'alex@example.com',
    idempotencyKey: key,
    metadata: { source: 'chatbot' },
    ...overrides,
  };
}

function callInput(request, extra = {}) {
  return { companyId: CO_A, chatbotId: 'bot-1', appointmentId: 'appt-1', ref: REF_CALCOM, request, credentials: CALCOM_CREDS, ...extra };
}

function callerHarness(handler, { links } = {}) {
  const { http, calls } = fakeHttp(handler ?? (() => ({ status: 201, body: OK_CALCOM })));
  const retry = createMemoryRetryStore();
  const provider = createCalcomProvider({ ...ENABLED, baseUrl: CALCOM_BASE });
  const caller = createBookingCaller({ provider, links: links ?? createMemoryProviderStore().links, attempts: retry.attempts, http });
  return { caller, calls, retry };
}

const posts = (calls) => calls.filter((c) => c.method === 'POST').length;

test('booking retry: a retried booking creates one event, and the second call sends no request', async () => {
  const h = callerHarness();
  const first = await h.caller.book(callInput(bookRequest()));
  const second = await h.caller.book(callInput(bookRequest()));
  assert.equal(posts(h.calls), 1);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.booking.externalBookingId, first.booking.externalBookingId);
  assert.equal(second.link.id, first.link.id, 'the link is stored once');
});

test('booking retry: a timed-out booking is never posted again, because the first request may have created it', async () => {
  const h = callerHarness(() => {
    throw { kind: 'timeout', message: 'slow' };
  });
  const first = await h.caller.book(callInput(bookRequest())).catch((e) => e);
  assert.equal(first.code, 'timeout');
  const second = await h.caller.book(callInput(bookRequest())).catch((e) => e);
  assert.ok(second instanceof BookingAttemptError);
  assert.equal(second.code, 'outcome_unknown');
  assert.equal(second.status, 409);
  assert.equal(posts(h.calls), 1);
});

test('booking retry: a 5xx is an unknown outcome, and a 4xx is a refusal that the same key may retry on purpose', async () => {
  let status = 503;
  const h = callerHarness(() => (status === 201 ? { status: 201, body: OK_CALCOM } : { status, body: { status: 'error' } }));
  await h.caller.book(callInput(bookRequest('retry-key-0001'))).catch((e) => e);
  const blocked = await h.caller.book(callInput(bookRequest('retry-key-0001'))).catch((e) => e);
  assert.equal(blocked.code, 'outcome_unknown');
  assert.equal(posts(h.calls), 1);

  status = 400;
  await h.caller.book(callInput(bookRequest('retry-key-0002'))).catch((e) => e);
  status = 201;
  const retried = await h.caller.book(callInput(bookRequest('retry-key-0002')));
  assert.equal(retried.replayed, false);
  assert.equal(posts(h.calls), 3);
});

test('booking retry: the same key with different booking fields is refused before any request', async () => {
  const h = callerHarness();
  await h.caller.book(callInput(bookRequest()));
  const changed = await h.caller
    .book(callInput(bookRequest('retry-key-0001', { startsAt: '2026-11-10T10:00:00Z', endsAt: '2026-11-10T10:30:00Z' })))
    .catch((e) => e);
  assert.equal(changed.code, 'key_reused');
  assert.equal(posts(h.calls), 1);
  assert.equal(
    bookingRequestHash(REF_CALCOM, bookRequest()),
    bookingRequestHash(REF_CALCOM, bookRequest('other-key-0001')),
    'the key itself is not part of the hash',
  );
  assert.notEqual(
    bookingRequestHash(REF_CALCOM, bookRequest()),
    bookingRequestHash(REF_CALCOM, bookRequest('retry-key-0001', { customerName: 'Sam Other' })),
    'a booking field change changes the hash',
  );
  assert.equal(
    bookingRequestHash(REF_CALCOM, bookRequest()),
    bookingRequestHash(REF_CALCOM, bookRequest('retry-key-0001', { customerEmail: 'ALEX@example.com' })),
    'the email is compared without case',
  );
});

test('booking retry: two calls at the same moment make one request, and the second is refused while the first runs', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = callerHarness(async () => {
    await gate;
    return { status: 201, body: OK_CALCOM };
  });
  const first = h.caller.book(callInput(bookRequest()));
  const second = await h.caller.book(callInput(bookRequest())).catch((e) => e);
  assert.equal(second.code, 'in_progress');
  release();
  const done = await first;
  assert.equal(done.replayed, false);
  assert.equal(posts(h.calls), 1);
});

test('booking retry: a booking whose link failed to save is linked on the retry, with no second request', async () => {
  const memory = createMemoryProviderStore().links;
  let failNext = true;
  const links = {
    ...memory,
    insertLink: async (...args) => {
      if (failNext) {
        failNext = false;
        throw new Error('database unavailable');
      }
      return memory.insertLink(...args);
    },
  };
  const h = callerHarness(undefined, { links });
  await h.caller.book(callInput(bookRequest())).catch((e) => e);
  const retried = await h.caller.book(callInput(bookRequest()));
  assert.equal(retried.replayed, true);
  assert.equal(retried.link.externalBookingId, 'bk_0001');
  assert.equal(posts(h.calls), 1);
});

test('booking retry: a short or malformed key is refused before any request', async () => {
  const h = callerHarness();
  for (const key of ['short', 'has spaces in it', 'x'.repeat(129), '']) {
    const error = await h.caller.book(callInput(bookRequest(key))).catch((e) => e);
    assert.equal(error.status, 422, `key ${JSON.stringify(key.slice(0, 12))} is refused`);
  }
  assert.equal(posts(h.calls), 0);
});

test('booking retry: a Calendly invitee is not posted twice on a retry either', async () => {
  const { http, calls } = fakeHttp(() => ({ status: 201, body: { event: SCHEDULED_EVENT_URI } }));
  const retry = createMemoryRetryStore();
  const caller = createBookingCaller({
    provider: createCalendlyProvider({ ...ENABLED, baseUrl: CALENDLY_BASE }),
    links: createMemoryProviderStore().links,
    attempts: retry.attempts,
    http,
  });
  const input = { ...callInput(bookRequest('calendly-key-0001')), ref: REF_CALENDLY, credentials: CALENDLY_CREDS };
  const first = await caller.book(input);
  const second = await caller.book(input);
  assert.equal(first.booking.externalBookingId, SCHEDULED_EVENT_URI);
  assert.equal(second.replayed, true);
  assert.equal(posts(calls), 1);
});

// ---------------------------------------------------------------------------------------------
// Cal.com secrets through SecretBox
// ---------------------------------------------------------------------------------------------

/** Test-only SecretBox with the contract's shape. AES-256-GCM, company id as associated data. */
function testSecretBox() {
  const key = randomBytes(32);
  const decryptFailed = () => Object.assign(new Error('SECRET_DECRYPT_FAILED'), { code: 'SECRET_DECRYPT_FAILED' });
  return {
    async encrypt(companyId, plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(companyId, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return { v: 1, alg: 'aes-256-gcm', keyId: 'v1', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
    },
    async decrypt(companyId, sealed) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
        decipher.setAAD(Buffer.from(companyId, 'utf8'));
        decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]).toString('utf8');
      } catch {
        throw decryptFailed();
      }
    },
  };
}

test('calcom secrets: the stored row holds no plaintext, and a sealed row does not open under another company', async () => {
  const retry = createMemoryRetryStore();
  const secrets = createCalendarSecretStore({ box: testSecretBox(), storage: retry.secrets });
  await secrets.save(CO_A, 'calcom', 'api_key', CALCOM_KEY);
  const row = await retry.secrets.get(CO_A, 'calcom', 'api_key');
  assert.ok(!JSON.stringify(row).includes(CALCOM_KEY), 'the sealed row carries no plaintext');
  assert.equal(await secrets.read(CO_A, 'calcom', 'api_key'), CALCOM_KEY);
  assert.equal(await secrets.read(CO_B, 'calcom', 'api_key'), null, 'another company sees no row');

  await retry.secrets.put(CO_B, 'calcom', 'api_key', row, new Date());
  await assert.rejects(secrets.read(CO_B, 'calcom', 'api_key'), { code: 'SECRET_DECRYPT_FAILED' });
  await assert.rejects(secrets.save(CO_A, 'calcom', 'not_a_purpose', 'x'), { status: 422 });
  await assert.rejects(secrets.save(CO_A, 'calcom', 'api_key', '   '), { status: 422 });
});

test('calcom secrets: loadCalcomCredentials returns null without an API key and never another company’s key', async () => {
  const retry = createMemoryRetryStore();
  const secrets = createCalendarSecretStore({ box: testSecretBox(), storage: retry.secrets });
  assert.equal(await loadCalcomCredentials(CO_A, secrets), null);
  await secrets.save(CO_A, 'calcom', 'api_key', CALCOM_KEY);
  assert.deepEqual(await loadCalcomCredentials(CO_A, secrets), { [CALCOM_API_KEY]: CALCOM_KEY });
  assert.equal(await loadCalcomCredentials(CO_B, secrets), null);
  await secrets.save(CO_A, 'calcom', 'webhook_secret', WEBHOOK_SECRET);
  assert.deepEqual(await loadCalcomCredentials(CO_A, secrets), { [CALCOM_API_KEY]: CALCOM_KEY, [CALCOM_WEBHOOK_SECRET]: WEBHOOK_SECRET });
});

test('calcom secrets: the API key and webhook secret never appear in output, errors, or logs during a booking', async () => {
  const retry = createMemoryRetryStore();
  const secrets = createCalendarSecretStore({ box: testSecretBox(), storage: retry.secrets });
  await secrets.save(CO_A, 'calcom', 'api_key', CALCOM_KEY);
  await secrets.save(CO_A, 'calcom', 'webhook_secret', WEBHOOK_SECRET);
  const credentials = await loadCalcomCredentials(CO_A, secrets);
  const { http } = fakeHttp(() => ({ status: 401, body: { message: `invalid ${CALCOM_KEY} ${WEBHOOK_SECRET}` } }));
  const caller = createBookingCaller({
    provider: createCalcomProvider({ ...ENABLED, baseUrl: CALCOM_BASE }),
    links: createMemoryProviderStore().links,
    attempts: retry.attempts,
    http,
  });
  const { result: error, seen } = await captureConsole(() => caller.book(callInput(bookRequest(), { credentials })).then(() => null, (e) => e));
  assert.ok(error, 'the booking was refused');
  const stored = JSON.stringify(await retry.secrets.get(CO_A, 'calcom', 'api_key'));
  const text = [JSON.stringify(error), String(error.stack), error.message, ...seen, stored].join('\n');
  assert.ok(!text.includes(CALCOM_KEY), 'the API key is absent');
  assert.ok(!text.includes(WEBHOOK_SECRET), 'the webhook secret is absent');
});

// ---------------------------------------------------------------------------------------------
// Provider URLs from user input cannot leave the provider's host
// ---------------------------------------------------------------------------------------------

test('provider urls: every request built from hostile user input stays on the provider host', async () => {
  const seen = [];
  const http = async (req) => {
    seen.push(req.url);
    return { status: 200, headers: {}, body: JSON.stringify({ status: 'success', data: [], collection: [], resource: { uri: `${CALENDLY_BASE}/users/u1`, duration: 30 } }) };
  };
  const calendly = createCalendlyProvider({ ...ENABLED, baseUrl: CALENDLY_BASE });
  const calcom = createCalcomProvider({ ...ENABLED, baseUrl: CALCOM_BASE });
  const window = { from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z', timezone: 'UTC' };
  const hostileCalendlyRefs = [
    'https://attacker.example/event_types/abc',
    `${CALENDLY_BASE}/event_types/abc/../../../x`,
    `${CALENDLY_BASE}/event_types/abc?next=https://attacker.example`,
    `${CALENDLY_BASE}/event_types/abc#https://attacker.example`,
    `${CALENDLY_BASE}.attacker.example/event_types/abc`,
    'https://api.calendly.test@attacker.example/event_types/abc',
  ];
  for (const externalEventTypeId of hostileCalendlyRefs) {
    const ref = { ...REF_CALENDLY, externalEventTypeId };
    await calendly.listSlots(ref, window, CALENDLY_CREDS, http).catch(() => {});
    await calendly.createBooking(ref, bookRequest(), CALENDLY_CREDS, http).catch(() => {});
  }
  for (const uid of ['https://attacker.example/x', '../x', 'a?b=https://attacker.example', 'a%2F..%2Fx', 'a/b']) {
    await calendly.cancelBooking(REF_CALENDLY, uid, null, CALENDLY_CREDS, http).catch(() => {});
  }
  for (const externalEventTypeId of ['4242/../x', '4242?x=https://attacker.example', 'https://attacker.example', '4242#x', '-1']) {
    const ref = { ...REF_CALCOM, externalEventTypeId };
    await calcom.listSlots(ref, window, CALCOM_CREDS, http).catch(() => {});
    await calcom.createBooking(ref, bookRequest(), CALCOM_CREDS, http).catch(() => {});
  }
  for (const uid of ['https://attacker.example/x', '../x', 'a?b=https://attacker.example', 'a%2F..%2Fx']) {
    await calcom.cancelBooking(REF_CALCOM, uid, null, CALCOM_CREDS, http).catch(() => {});
  }
  await calcom.listSlots(REF_CALCOM, { ...window, timezone: 'UTC&next=https://attacker.example' }, CALCOM_CREDS, http).catch(() => {});

  for (const url of seen) {
    const origin = new URL(url).origin;
    assert.ok(origin === 'https://api.calendly.test' || origin === 'https://api.cal.test', `unexpected host for ${url}`);
  }
  assert.equal(seen.filter((u) => u.includes('attacker')).length, 0, 'no hostile value reached a URL');
  assert.throws(() => createCalendlyProvider({ baseUrl: 'http://api.calendly.test' }), RangeError);
  assert.throws(() => createCalcomProvider({ baseUrl: 'http://api.cal.test/v2' }), RangeError);
});

// ---------------------------------------------------------------------------------------------
// Drizzle SQL for the new tables, and their schema
// ---------------------------------------------------------------------------------------------

test('drizzle retry: every attempt and secret query carries company_id, and the key or purpose', () => {
  const sealed = { v: 1, alg: 'aes-256-gcm', keyId: 'k', iv: 'aXY=', tag: 'dGFn', ciphertext: 'Y3Q=' };
  const renders = [
    render(retryQueries.insertAttempt(db, CO_A, 'calcom', 'retry-key-0001', 'hash', T0)),
    render(retryQueries.selectAttempt(db, CO_A, 'calcom', 'retry-key-0001')),
    render(retryQueries.reclaimAttempt(db, CO_A, 'calcom', 'retry-key-0001', T0)),
    render(retryQueries.settleAttempt(db, CO_A, 'calcom', 'retry-key-0001', { status: 'rejected' }, T0)),
    render(retryQueries.upsertSecret(db, CO_A, 'calcom', 'api_key', sealed, T0)),
    render(retryQueries.selectSecret(db, CO_A, 'calcom', 'api_key')),
  ];
  for (const r of renders) {
    assert.ok(r.sql.includes('"company_id"'), 'company_id is in the statement');
    assert.ok(r.params.includes(CO_A), 'the company id is a bound parameter');
  }
  assert.ok(renders[1].params.includes('retry-key-0001'));
  assert.ok(renders[5].params.includes('api_key'));
});

test('drizzle retry: both new tables carry company_id, and their unique keys include it', () => {
  const attemptsConfig = getTableConfig(chatbotBookingAttempts);
  assert.ok(attemptsConfig.columns.some((c) => c.name === 'company_id'));
  const attemptUnique = attemptsConfig.indexes.find((i) => i.config.name === 'chatbot_booking_attempts_key_uidx');
  assert.deepEqual(attemptUnique.config.columns.map((c) => c.name), ['company_id', 'provider', 'idempotency_key']);

  const secretsConfig = getTableConfig(chatbotCalendarSecrets);
  assert.ok(secretsConfig.columns.some((c) => c.name === 'company_id'));
  const secretUnique = secretsConfig.indexes.find((i) => i.config.name === 'chatbot_calendar_secrets_uidx');
  assert.deepEqual(secretUnique.config.columns.map((c) => c.name), ['company_id', 'provider', 'purpose']);
  assert.ok(createDrizzleRetryStore(untouchableDb()).attempts);
});

// ---------------------------------------------------------------------------------------------
// Reconciliation as a worker call
// ---------------------------------------------------------------------------------------------

test('reconciliation job: a company sees only its own links, and a connection for another company is refused', async () => {
  const now = new Date('2026-11-10T08:00:00Z');
  const links = createMemoryProviderStore().links;
  const base = { chatbotId: 'bot-1', provider: 'calcom', externalEventTypeId: '4242', startsAt: new Date('2026-11-10T09:00:00Z'), endsAt: new Date('2026-11-10T09:30:00Z'), manageUrl: null };
  await links.insertLink(CO_A, { ...base, externalBookingId: 'uid-a', appointmentId: 'appt-a' }, now);
  await links.insertLink(CO_B, { ...base, externalBookingId: 'uid-b', appointmentId: 'appt-b' }, now);
  const appointment = (id) => ({ id, companyId: CO_A, status: 'confirmed', startsAt: new Date('2026-11-10T09:00:00Z'), endsAt: new Date('2026-11-10T09:30:00Z') });
  const bookings = {
    listCalendars: async (companyId) => (companyId === CO_A ? [{ id: 'cal-a', timezone: 'UTC' }] : []),
    listAppointments: async (companyId) => (companyId === CO_A ? [appointment('appt-a')] : []),
  };
  const remote = [
    { externalBookingId: 'uid-a', startsAt: new Date('2026-11-10T09:00:00Z'), endsAt: new Date('2026-11-10T09:30:00Z'), status: 'active' },
    { externalBookingId: 'uid-b', startsAt: new Date('2026-11-10T09:00:00Z'), endsAt: new Date('2026-11-10T09:30:00Z'), status: 'cancelled' },
  ];
  const deps = {
    provider: 'calcom',
    lister: { listBookings: async () => remote },
    links,
    bookings,
    http: fakeHttp(() => ({})).http,
    loadConnection: async (companyId) => (companyId === CO_A ? { ref: { ...REF_CALCOM, companyId: CO_A }, credentials: CALCOM_CREDS } : null),
    now: () => now,
  };

  const outcome = await runReconciliationJob(CO_A, deps);
  assert.equal(outcome.status, 'reconciled');
  assert.equal(outcome.result.checked, 1, 'only the company’s own link is compared');
  assert.equal(outcome.result.matched, 1);
  assert.equal(outcome.result.discrepancies.length, 0);
  assert.equal(outcome.result.untrackedRemote, 1, 'the other company’s provider booking is counted, never compared');

  assert.deepEqual(await runReconciliationJob(CO_B, deps), { status: 'not_connected' });
  const leaky = { ...deps, loadConnection: async () => ({ ref: { ...REF_CALCOM, companyId: CO_A }, credentials: CALCOM_CREDS }) };
  assert.deepEqual(await runReconciliationJob(CO_B, leaky), { status: 'failed', code: 'config' });
});

test('reconciliation job: a provider failure comes back as a code, and the key never appears in the outcome', async () => {
  const { http } = fakeHttp(() => ({ status: 500, body: { error: `boom ${CALCOM_KEY}` } }));
  const deps = {
    provider: 'calcom',
    lister: createCalcomProvider({ ...ENABLED, baseUrl: CALCOM_BASE }),
    links: createMemoryProviderStore().links,
    bookings: { listCalendars: async () => [], listAppointments: async () => [] },
    http,
    loadConnection: async () => ({ ref: { ...REF_CALCOM, companyId: CO_A }, credentials: CALCOM_CREDS }),
  };
  const outcome = await runReconciliationJob(CO_A, deps);
  assert.deepEqual(outcome, { status: 'failed', code: 'http' });
  assert.ok(!JSON.stringify(outcome).includes(CALCOM_KEY));

  const off = await runReconciliationJob(CO_A, { ...deps, lister: createCalcomProvider({ enabled: false, baseUrl: CALCOM_BASE }) });
  assert.deepEqual(off, { status: 'failed', code: 'disabled' });
  await assert.rejects(runReconciliationJob('not-a-company', deps), { status: 403 });
});

test.after(async () => {
  await pool.end();
});

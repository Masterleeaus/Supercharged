// Drizzle bookings storage, Calendly token encryption, and the booking-routes adapter.
// Run: node --test --experimental-transform-types tests/modules/chatbot-bookings-drizzle.test.mjs
// No database connection. The Drizzle queries are rendered to SQL and checked; nothing is executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import express from 'express';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import {
  chatbotAppointments,
  chatbotBookingCalendars,
  chatbotBookingReminders,
  chatbotBookingSettings,
} from '../../server/modules/chatbot/db/bookings.ts';
import {
  bookingQueries,
  createDrizzleBookingStorage,
} from '../../server/modules/chatbot/bookings/drizzle-booking-storage.ts';
import { createSecretBox, SECRET_KEY_ENV, SecretKeyError } from '../../server/modules/chatbot/bookings/secret-box.ts';
import {
  createBookingService,
  createMemoryBookingStorage,
} from '../../server/modules/chatbot/bookings/index.ts';
import { createBookingRoutesService } from '../../server/modules/chatbot/booking-routes/bookings-adapter.ts';
import { createBookingRouter } from '../../server/modules/chatbot/booking-routes/router.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const KEY_B64 = randomBytes(32).toString('base64');
const NOW = new Date('2026-11-01T00:00:00Z');
const WORKING_WEEK = {
  monday: { enabled: true, start: '09:00', end: '17:00' },
  tuesday: { enabled: true, start: '09:00', end: '17:00' },
  wednesday: { enabled: true, start: '09:00', end: '17:00' },
  thursday: { enabled: true, start: '09:00', end: '17:00' },
  friday: { enabled: true, start: '09:00', end: '17:00' },
  saturday: { enabled: false, start: '09:00', end: '17:00' },
  sunday: { enabled: false, start: '09:00', end: '17:00' },
};

const dialect = new PgDialect();
// Never connects: the pool only exists so drizzle can build queries.
const pool = new Pool({ connectionString: 'postgres://user:pass@127.0.0.1:1/none' });
const db = drizzle(pool);

/** A db stand-in that fails the test if the storage touches it. */
function untouchableDb() {
  const touched = [];
  const db = new Proxy({}, {
    get(_target, prop) {
      touched.push(String(prop));
      throw new Error(`database touched: ${String(prop)}`);
    },
  });
  return { db, touched };
}

function render(query) {
  if (typeof query.getSQL === 'function') return dialect.sqlToQuery(query.getSQL());
  return query.toSQL();
}

function isoOf(date) {
  return date.toISOString();
}

test.after(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// 1. Company filtering in the generated SQL
// ---------------------------------------------------------------------------

const START = new Date('2026-11-02T15:00:00Z');
const END = new Date('2026-11-02T15:30:00Z');
const BUFFER_MS = 15 * 60_000;
const SEALED = { iv: 'aXY=', tag: 'dGFn', ciphertext: 'Y2lwaGVy' };
// The settings builder takes the three token columns, not the SealedSecret shape.
const SEALED_COLUMNS = { calendlyTokenIv: 'aXY=', calendlyTokenTag: 'dGFn', calendlyTokenCiphertext: 'Y2lwaGVy' };

const scopedCases = {
  calendarById: () => bookingQueries.calendarById(db, CO_A, 'cal-1'),
  calendars: () => bookingQueries.calendars(db, CO_A),
  calendarNumberById: () => bookingQueries.calendarNumberById(db, CO_A, 'cal-1'),
  calendarIdByNumber: () => bookingQueries.calendarIdByNumber(db, CO_A, 7),
  lockCalendar: () => bookingQueries.lockCalendar(db, CO_A, 'cal-1'),
  insertCalendar: () =>
    bookingQueries.insertCalendar(
      db,
      CO_A,
      { name: 'Front desk', timezone: 'America/New_York', availability: WORKING_WEEK, bufferMinutes: 0 },
      NOW,
    ),
  conflicts: () => bookingQueries.conflicts(db, CO_A, 'cal-1', START, END, 0, null),
  conflictsExcludingSelf: () => bookingQueries.conflicts(db, CO_A, 'cal-1', START, END, BUFFER_MS, 'appt-1'),
  listAppointmentsInRange: () =>
    bookingQueries.listAppointmentsInRange(db, CO_A, 'cal-1', { from: START, to: END }),
  appointmentById: () => bookingQueries.appointmentById(db, CO_A, 'appt-1'),
  insertAppointment: () =>
    bookingQueries.insertAppointment(
      db,
      CO_A,
      {
        calendarId: 'cal-1',
        conversationId: null,
        customerName: 'Ana',
        customerEmail: 'ana@example.com',
        customerPhone: null,
        startsAt: START,
        endsAt: END,
        status: 'confirmed',
        metadata: null,
      },
      BUFFER_MS,
      NOW,
    ),
  updateAppointmentStatus: () =>
    bookingQueries.updateAppointmentStatus(
      db,
      CO_A,
      'appt-1',
      { from: 'waitlisted', to: 'confirmed', reason: null },
      NOW,
    ),
  insertReminder: () =>
    bookingQueries.insertReminder(
      db,
      CO_A,
      { appointmentId: 'appt-1', channel: 'email', sendAt: NOW },
      NOW,
    ),
  remindersFor: () => bookingQueries.remindersFor(db, CO_A, 'appt-1'),
  settingsRow: () => bookingQueries.settingsRow(db, CO_A),
  upsertSettingsConditions: () =>
    bookingQueries.upsertSettings(db, CO_A, { conditions: ['Only weekdays'] }, NOW),
  upsertSettingsToken: () => bookingQueries.upsertSettings(db, CO_A, { token: SEALED_COLUMNS }, NOW),
};

for (const [name, build] of Object.entries(scopedCases)) {
  test(`SQL is company-scoped: ${name}`, () => {
    const rendered = render(build());
    assert.match(rendered.sql, /"company_id"/, `${name}: no company_id in the statement`);
    assert.ok(rendered.params.includes(CO_A), `${name}: company id is not among the params`);
    if (/^\s*(select|update|delete)\b/i.test(rendered.sql)) {
      assert.match(rendered.sql, /"company_id"\s*=\s*\$\d+/, `${name}: no company_id = $n predicate`);
    }
    if (/^\s*insert\b/i.test(rendered.sql)) {
      assert.match(rendered.sql, /insert into "[^"]+" \([^)]*"company_id"/, `${name}: company_id is not a written column`);
    }
  });
}

test('SQL: every write path takes the company id from its first argument, not from row data', () => {
  const rendered = render(scopedCases.insertAppointment());
  // The company param is the first value written, before any appointment field.
  assert.equal(rendered.params[0], CO_A);
});

test('SQL: the overlap check applies the buffer on both sides, matching intervalsConflict()', () => {
  const rendered = render(scopedCases.conflicts());
  const withBuffer = render(scopedCases.conflictsExcludingSelf());
  assert.match(rendered.sql, /"status" = \$\d+/);
  // Buffer 0: existing starts before new ends, and existing ends after new starts.
  assert.ok(rendered.params.includes(isoOf(END)), 'new end is a param (buffer 0)');
  assert.ok(rendered.params.includes(isoOf(START)), 'new start is a param (buffer 0)');
  // Buffer 15 minutes: the bounds move out by 15 minutes each way.
  assert.ok(withBuffer.params.includes('2026-11-02T15:45:00.000Z'), 'end + buffer is a param');
  assert.ok(withBuffer.params.includes('2026-11-02T14:45:00.000Z'), 'start - buffer is a param');
  assert.ok(withBuffer.params.includes('appt-1'), 'the excluded id is a param');
});

test('SQL: the calendar lock is a row lock taken inside the transaction', () => {
  const rendered = render(scopedCases.lockCalendar());
  assert.match(rendered.sql, /for update$/i);
});

test('SQL: the blocked range is written as tstzrange(start, end + buffer, [))', () => {
  const rendered = render(scopedCases.insertAppointment());
  assert.match(rendered.sql, /tstzrange\(\$\d+, \$\d+, '\[\)'\)/);
  assert.ok(rendered.params.includes('2026-11-02T15:45:00.000Z'), 'blocked end is end + buffer');
});

test('SQL: a stale status write matches no row (compare-and-set on the current status)', () => {
  const rendered = render(scopedCases.updateAppointmentStatus());
  assert.match(rendered.sql, /"status" = \$\d+/);
  assert.ok(rendered.params.includes('waitlisted'));
});

test('SQL: the settings upsert never writes a plaintext token', () => {
  const rendered = render(scopedCases.upsertSettingsToken());
  assert.ok(rendered.params.includes(SEALED.ciphertext));
  assert.ok(rendered.params.includes(SEALED.iv));
  assert.ok(rendered.params.includes(SEALED.tag));
  assert.match(rendered.sql, /on conflict \("company_id"\) do update/i);
});

test('SQL: a plaintext token string is not present in any settings statement', () => {
  const plain = 'plain-calendly-token-do-not-store';
  const sealed = createSecretBox({ env: { [SECRET_KEY_ENV]: KEY_B64 } }).seal(plain);
  const rendered = render(
    bookingQueries.upsertSettings(
      db,
      CO_A,
      {
        token: {
          calendlyTokenIv: sealed.iv,
          calendlyTokenTag: sealed.tag,
          calendlyTokenCiphertext: sealed.ciphertext,
        },
      },
      NOW,
    ),
  );
  assert.ok(rendered.params.includes(sealed.ciphertext), 'the ciphertext is what is written');
  assert.equal(rendered.params.some((p) => String(p).includes(plain)), false);
});

test('storage: a bad company id is refused before any database call', async () => {
  const { db: trap, touched } = untouchableDb();
  const storage = createDrizzleBookingStorage({ db: trap, secretBox: createSecretBox({ env: {} }) });
  await assert.rejects(storage.listCalendars('not-a-uuid'), { status: 403 });
  await assert.rejects(storage.findAppointment(undefined, 'x'), { status: 403 });
  await assert.rejects(storage.getSettings(''), { status: 403 });
  assert.deepEqual(touched, []);
});

// ---------------------------------------------------------------------------
// 2. Schema: every table carries company_id, the double-booking index exists
// ---------------------------------------------------------------------------

test('schema: every chatbot booking table has a company_id column', () => {
  for (const table of [chatbotBookingCalendars, chatbotAppointments, chatbotBookingReminders, chatbotBookingSettings]) {
    const config = getTableConfig(table);
    const column = config.columns.find((c) => c.name === 'company_id');
    assert.ok(column, `${config.name} has no company_id`);
    assert.equal(column.notNull, true, `${config.name}.company_id must be NOT NULL`);
  }
});

test('schema: the confirmed-start unique index is partial on status = confirmed', () => {
  const config = getTableConfig(chatbotAppointments);
  const index = config.indexes.find((i) => i.config.name === 'chatbot_appointments_confirmed_start_uidx');
  assert.ok(index, 'partial unique index is missing');
  assert.equal(index.config.unique, true);
  assert.ok(index.config.where, 'the index must carry a WHERE clause');
  assert.match(dialect.sqlToQuery(index.config.where).sql, /"status" = 'confirmed'/);
});

test('schema: the settings table allows at most one row per company', () => {
  const config = getTableConfig(chatbotBookingSettings);
  const index = config.indexes.find((i) => i.config.name === 'chatbot_booking_settings_company_uidx');
  assert.ok(index && index.config.unique);
});

// ---------------------------------------------------------------------------
// 3. Calendly token encryption
// ---------------------------------------------------------------------------

test('encryption: seal then open returns the original token', () => {
  const box = createSecretBox({ env: { [SECRET_KEY_ENV]: KEY_B64 } });
  const token = 'cal_live_0123456789abcdef';
  const sealed = box.seal(token);
  assert.equal(box.open(sealed), token);
});

test('encryption: ciphertext does not contain the plaintext and differs on every seal', () => {
  const box = createSecretBox({ env: { [SECRET_KEY_ENV]: KEY_B64 } });
  const token = 'cal_live_0123456789abcdef';
  const a = box.seal(token);
  const b = box.seal(token);
  assert.equal(a.ciphertext.includes(token), false);
  assert.notEqual(a.iv, b.iv, 'a new iv is used for each seal');
  assert.notEqual(a.ciphertext, b.ciphertext);
});

test('encryption: the iv is 12 bytes and the auth tag is 16 bytes', () => {
  const box = createSecretBox({ env: { [SECRET_KEY_ENV]: KEY_B64 } });
  const sealed = box.seal('token');
  assert.equal(Buffer.from(sealed.iv, 'base64').length, 12);
  assert.equal(Buffer.from(sealed.tag, 'base64').length, 16);
});

test('encryption: a tampered ciphertext fails to open', () => {
  const box = createSecretBox({ env: { [SECRET_KEY_ENV]: KEY_B64 } });
  const sealed = box.seal('token');
  const bytes = Buffer.from(sealed.ciphertext, 'base64');
  bytes[0] ^= 0x01;
  assert.throws(() => box.open({ ...sealed, ciphertext: bytes.toString('base64') }));
});

test('encryption: a wrong auth tag fails to open', () => {
  const box = createSecretBox({ env: { [SECRET_KEY_ENV]: KEY_B64 } });
  const sealed = box.seal('token');
  const other = box.seal('another');
  assert.throws(() => box.open({ ...sealed, tag: other.tag }));
});

test('encryption: a different key cannot open the value', () => {
  const sealed = createSecretBox({ env: { [SECRET_KEY_ENV]: KEY_B64 } }).seal('token');
  const otherBox = createSecretBox({ env: { [SECRET_KEY_ENV]: randomBytes(32).toString('base64') } });
  assert.throws(() => otherBox.open(sealed));
});

test('encryption: a missing key throws at first use, not at creation', () => {
  const env = {};
  const box = createSecretBox({ env });
  assert.throws(() => box.seal('token'), (err) => {
    assert.ok(err instanceof SecretKeyError);
    assert.match(err.message, /CHATBOT_SECRET_KEY is not set/);
    return true;
  });
});

test('encryption: an empty key throws, same as a missing one', () => {
  assert.throws(() => createSecretBox({ env: { [SECRET_KEY_ENV]: '' } }).seal('token'), SecretKeyError);
});

test('encryption: a key that is not 32 bytes throws (16 bytes given)', () => {
  const short = randomBytes(16).toString('base64');
  assert.throws(() => createSecretBox({ env: { [SECRET_KEY_ENV]: short } }).seal('token'), /exactly 32 bytes/);
});

test('encryption: a key that is not canonical base64 throws', () => {
  const bad = KEY_B64.slice(0, -2) + '!!';
  assert.throws(() => createSecretBox({ env: { [SECRET_KEY_ENV]: bad } }).seal('token'), SecretKeyError);
});

test('encryption: the key is read on first use, so a value set after creation works', () => {
  const env = {};
  const box = createSecretBox({ env });
  env[SECRET_KEY_ENV] = KEY_B64;
  assert.equal(box.open(box.seal('late key')), 'late key');
});

test('storage: saving a token with no key throws before any query is built, and nothing is written', async () => {
  const { db: trap, touched } = untouchableDb();
  const storage = createDrizzleBookingStorage({ db: trap, secretBox: createSecretBox({ env: {} }) });
  await assert.rejects(
    storage.saveSettings(CO_A, { calendlyAccessToken: 'cal_live_secret' }),
    (err) => {
      assert.ok(err instanceof SecretKeyError);
      return true;
    },
  );
  assert.deepEqual(touched, [], 'the database must not be touched when the key is missing');
});

test('storage: constructing the storage never reads the key', () => {
  const { db: trap, touched } = untouchableDb();
  assert.doesNotThrow(() => createDrizzleBookingStorage({ db: trap }));
  assert.deepEqual(touched, []);
});

// ---------------------------------------------------------------------------
// 4. Booking-routes adapter, through the real router over HTTP
// ---------------------------------------------------------------------------

const TOKEN = 'cal_live_TOP_SECRET_TOKEN_9f8e7d';

/**
 * Builds the slice service on in-memory storage, plus the settings and numbering methods the adapter needs.
 * The settings store over-returns on purpose: it hands back the raw token too, so the test proves the adapter and
 * the router both keep it out of responses.
 */
function makeHarness() {
  const base = createMemoryBookingStorage();
  const numbers = new Map();
  let nextNumber = 1;
  const settings = new Map();

  const insertCalendar = base.insertCalendar;
  base.insertCalendar = async (companyId, input, now) => {
    const record = await insertCalendar(companyId, input, now);
    numbers.set(`${companyId}:${record.id}`, nextNumber);
    nextNumber += 1;
    return record;
  };
  base.calendarNumberOf = async (companyId, id) => numbers.get(`${companyId}:${id}`) ?? null;
  base.calendarIdForNumber = async (companyId, n) => {
    for (const [key, value] of numbers) {
      if (value === n && key.startsWith(`${companyId}:`)) return key.slice(companyId.length + 1);
    }
    return null;
  };
  base.getSettings = async (companyId) => {
    const row = settings.get(companyId);
    return {
      hasCalendlyToken: Boolean(row?.token),
      bookingAssistantConditions: row?.conditions ?? [],
      calendlyAccessToken: row?.token ?? null, // over-returned on purpose
    };
  };
  base.saveSettings = async (companyId, patch) => {
    const row = settings.get(companyId) ?? { token: null, conditions: [] };
    const next = {
      token: patch.calendlyAccessToken === undefined ? row.token : patch.calendlyAccessToken,
      conditions: patch.bookingAssistantConditions ?? row.conditions,
    };
    settings.set(companyId, next);
    return { hasCalendlyToken: Boolean(next.token), bookingAssistantConditions: next.conditions };
  };
  base.readCalendlyToken = async (companyId) => settings.get(companyId)?.token ?? null;

  const service = createBookingService({ storage: base, now: () => NOW, enabled: true });
  const adapter = createBookingRoutesService({ service, storage: base });
  return { base, service, adapter, settings };
}

async function createCalendar(service, companyId) {
  return service.createCalendar(companyId, {
    name: 'Front desk',
    timezone: 'America/New_York',
    availability: WORKING_WEEK,
    buffer_minutes: 0,
  });
}

async function startRouter(adapter) {
  const app = express();
  const authenticate = (req, res, next) => {
    const company = req.headers['x-test-company'];
    if (typeof company !== 'string') {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    res.locals.companyId = company;
    next();
  };
  const router = createBookingRouter({
    service: adapter,
    authenticate,
    requireRole: () => (_req, _res, next) => next(),
    env: { ENABLE_CHATBOT_BOOKING_ROUTES: 'true' },
  });
  app.use('/api/chatbot', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}/api/chatbot`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function call(server, method, path, { company = CO_A, body } = {}) {
  const res = await fetch(`${server.base}${path}`, {
    method,
    headers: { 'x-test-company': company, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
}

test('adapter: getAssistantSettings reports presence only and never the token', async () => {
  const { adapter, settings } = makeHarness();
  settings.set(CO_A, { token: TOKEN, conditions: ['Only weekdays'] });
  const view = await adapter.getAssistantSettings(CO_A);
  assert.equal(view.calendlyAccessTokenSet, true);
  assert.deepEqual(view.bookingAssistantConditions, ['Only weekdays']);
  assert.equal(JSON.stringify(view).includes(TOKEN), false);
  assert.equal('calendlyAccessToken' in view, false);
});

test('adapter: updateAssistantSettings returns the view, not the token it was given', async () => {
  const { adapter } = makeHarness();
  const view = await adapter.updateAssistantSettings(CO_A, { calendlyAccessToken: TOKEN });
  assert.equal(view.calendlyAccessTokenSet, true);
  assert.equal(JSON.stringify(view).includes(TOKEN), false);
});

test('router: GET booking-settings returns hasCalendlyToken and no token, even from a leaky store', async () => {
  const { adapter, settings } = makeHarness();
  settings.set(CO_A, { token: TOKEN, conditions: [] });
  const server = await startRouter(adapter);
  try {
    const res = await call(server, 'GET', '/booking-settings');
    assert.equal(res.status, 200);
    assert.equal(res.json.hasCalendlyToken, true);
    assert.equal(res.text.includes(TOKEN), false, 'the token must not appear anywhere in the response');
    assert.equal('calendlyAccessToken' in res.json, false);
    assert.equal('calendlyAccessTokenSet' in res.json, false);
  } finally {
    await server.close();
  }
});

test('router: PATCH booking-settings stores the token and does not echo it', async () => {
  const { adapter, settings } = makeHarness();
  const server = await startRouter(adapter);
  try {
    const res = await call(server, 'PATCH', '/booking-settings', { body: { calendlyAccessToken: TOKEN } });
    assert.equal(res.status, 200);
    assert.equal(res.json.hasCalendlyToken, true);
    assert.equal(res.text.includes(TOKEN), false);
    assert.equal(settings.get(CO_A).token, TOKEN, 'the token reaches the store');
  } finally {
    await server.close();
  }
});

test('router: a booking created over HTTP keeps the numeric calendar id and hides customer contact details', async () => {
  const { adapter, service } = makeHarness();
  await createCalendar(service, CO_A);
  const server = await startRouter(adapter);
  try {
    const res = await call(server, 'POST', '/bookings', {
      body: {
        calendarId: 1,
        startsAt: '2026-11-02T15:00:00Z',
        endsAt: '2026-11-02T15:30:00Z',
        metadata: { customer_name: 'Ana Ruiz', customer_email: 'ana@example.com', service: 'trim' },
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.json.calendarId, 1);
    assert.equal(res.json.status, 'confirmed');
    assert.deepEqual(res.json.metadata, { service: 'trim' });
    assert.equal(res.text.includes('ana@example.com'), false);
    assert.equal(res.text.includes('Ana Ruiz'), false);
  } finally {
    await server.close();
  }
});

test('router: a second confirmed booking on the same slot is refused with 409', async () => {
  const { adapter, service } = makeHarness();
  await createCalendar(service, CO_A);
  const server = await startRouter(adapter);
  try {
    const body = {
      calendarId: 1,
      startsAt: '2026-11-02T15:00:00Z',
      endsAt: '2026-11-02T15:30:00Z',
      metadata: { customer_name: 'Ana', customer_phone: '+61400000000' },
    };
    assert.equal((await call(server, 'POST', '/bookings', { body })).status, 201);
    const second = await call(server, 'POST', '/bookings', { body });
    assert.equal(second.status, 409);
  } finally {
    await server.close();
  }
});

test('router: a booking without a customer name or contact is refused with 422', async () => {
  const { adapter, service } = makeHarness();
  await createCalendar(service, CO_A);
  const server = await startRouter(adapter);
  try {
    const res = await call(server, 'POST', '/bookings', {
      body: { calendarId: 1, startsAt: '2026-11-02T15:00:00Z', endsAt: '2026-11-02T15:30:00Z', metadata: {} },
    });
    assert.equal(res.status, 422);
  } finally {
    await server.close();
  }
});

test('router: a calendar number that belongs to another company is not found', async () => {
  const { adapter, service } = makeHarness();
  await createCalendar(service, CO_A);
  const server = await startRouter(adapter);
  try {
    const res = await call(server, 'POST', '/bookings', {
      company: CO_B,
      body: {
        calendarId: 1,
        startsAt: '2026-11-02T15:00:00Z',
        endsAt: '2026-11-02T15:30:00Z',
        metadata: { customer_name: 'Ana', customer_email: 'ana@example.com' },
      },
    });
    assert.equal(res.status, 404);
  } finally {
    await server.close();
  }
});

test('router: a booking is readable by its own company only (other company gets 404)', async () => {
  const { adapter, service } = makeHarness();
  await createCalendar(service, CO_A);
  const server = await startRouter(adapter);
  try {
    const created = await call(server, 'POST', '/bookings', {
      body: {
        calendarId: 1,
        startsAt: '2026-11-02T15:00:00Z',
        endsAt: '2026-11-02T15:30:00Z',
        metadata: { customer_name: 'Ana', customer_email: 'ana@example.com' },
      },
    });
    const id = created.json.id;
    assert.equal((await call(server, 'GET', `/bookings/${id}`)).status, 200);
    assert.equal((await call(server, 'GET', `/bookings/${id}`, { company: CO_B })).status, 404);
  } finally {
    await server.close();
  }
});

test('router: cancelling frees the slot and records the reason', async () => {
  const { adapter, service } = makeHarness();
  await createCalendar(service, CO_A);
  const server = await startRouter(adapter);
  try {
    const body = {
      calendarId: 1,
      startsAt: '2026-11-02T15:00:00Z',
      endsAt: '2026-11-02T15:30:00Z',
      metadata: { customer_name: 'Ana', customer_email: 'ana@example.com' },
    };
    const first = await call(server, 'POST', '/bookings', { body });
    const cancelled = await call(server, 'POST', `/bookings/${first.json.id}/cancel`, {
      body: { reason: 'Client asked' },
    });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.json.status, 'cancelled');
    assert.equal(cancelled.json.cancelReason, 'Client asked');
    assert.equal((await call(server, 'POST', '/bookings', { body })).status, 201, 'the slot is free again');
  } finally {
    await server.close();
  }
});

test('router: promoting a waitlisted booking is refused while its slot is taken', async () => {
  const { adapter, service } = makeHarness();
  await createCalendar(service, CO_A);
  const server = await startRouter(adapter);
  try {
    const metadata = { customer_name: 'Ana', customer_email: 'ana@example.com' };
    await call(server, 'POST', '/bookings', {
      body: { calendarId: 1, startsAt: '2026-11-02T15:00:00Z', endsAt: '2026-11-02T15:30:00Z', metadata },
    });
    const waitlisted = await call(server, 'POST', '/bookings', {
      body: {
        calendarId: 1,
        startsAt: '2026-11-02T15:00:00Z',
        endsAt: '2026-11-02T15:30:00Z',
        status: 'waitlisted',
        metadata,
      },
    });
    assert.equal(waitlisted.status, 201);
    assert.equal(waitlisted.json.status, 'waitlisted');
    const promoted = await call(server, 'PATCH', `/bookings/${waitlisted.json.id}`, {
      body: { status: 'confirmed' },
    });
    assert.equal(promoted.status, 409);
  } finally {
    await server.close();
  }
});

test('router: a waitlisted booking is promoted when its slot is free', async () => {
  const { adapter, service } = makeHarness();
  await createCalendar(service, CO_A);
  const server = await startRouter(adapter);
  try {
    const waitlisted = await call(server, 'POST', '/bookings', {
      body: {
        calendarId: 1,
        startsAt: '2026-11-02T16:00:00Z',
        endsAt: '2026-11-02T16:30:00Z',
        status: 'waitlisted',
        metadata: { customer_name: 'Ana', customer_email: 'ana@example.com' },
      },
    });
    const promoted = await call(server, 'PATCH', `/bookings/${waitlisted.json.id}`, {
      body: { status: 'confirmed' },
    });
    assert.equal(promoted.status, 200);
    assert.equal(promoted.json.status, 'confirmed');
  } finally {
    await server.close();
  }
});

test('router: changing the time of a booking is refused (not supported yet)', async () => {
  const { adapter, service } = makeHarness();
  await createCalendar(service, CO_A);
  const server = await startRouter(adapter);
  try {
    const created = await call(server, 'POST', '/bookings', {
      body: {
        calendarId: 1,
        startsAt: '2026-11-02T15:00:00Z',
        endsAt: '2026-11-02T15:30:00Z',
        metadata: { customer_name: 'Ana', customer_email: 'ana@example.com' },
      },
    });
    const res = await call(server, 'PATCH', `/bookings/${created.json.id}`, {
      body: { startsAt: '2026-11-02T16:00:00Z' },
    });
    assert.equal(res.status, 422);
  } finally {
    await server.close();
  }
});

test('router: listing needs a range and returns only the company bookings in that range', async () => {
  const { adapter, service } = makeHarness();
  await createCalendar(service, CO_A);
  await createCalendar(service, CO_B);
  const server = await startRouter(adapter);
  try {
    const metadata = { customer_name: 'Ana', customer_email: 'ana@example.com' };
    await call(server, 'POST', '/bookings', {
      body: { calendarId: 1, startsAt: '2026-11-02T16:00:00Z', endsAt: '2026-11-02T16:30:00Z', metadata },
    });
    await call(server, 'POST', '/bookings', {
      body: { calendarId: 1, startsAt: '2026-11-02T15:00:00Z', endsAt: '2026-11-02T15:30:00Z', metadata },
    });
    const missing = await call(server, 'GET', '/bookings');
    assert.equal(missing.status, 422);

    const listed = await call(
      server,
      'GET',
      '/bookings?calendar_id=1&from=2026-11-02T00:00:00Z&to=2026-11-03T00:00:00Z',
    );
    assert.equal(listed.status, 200);
    assert.deepEqual(
      listed.json.data.map((b) => b.startsAt),
      ['2026-11-02T15:00:00.000Z', '2026-11-02T16:00:00.000Z'],
    );

    const other = await call(
      server,
      'GET',
      '/bookings?from=2026-11-02T00:00:00Z&to=2026-11-03T00:00:00Z',
      { company: CO_B },
    );
    assert.equal(other.json.data.length, 0);
  } finally {
    await server.close();
  }
});

test('adapter: the router is refused without a role check (deny by default)', async () => {
  const { adapter } = makeHarness();
  const app = express();
  const router = createBookingRouter({
    service: adapter,
    authenticate: (req, res, next) => {
      res.locals.companyId = CO_A;
      next();
    },
    env: { ENABLE_CHATBOT_BOOKING_ROUTES: 'true' },
  });
  app.use('/api/chatbot', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/chatbot/booking-settings`);
    assert.equal(res.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------- H-2: the double-booking exclusion is a draft migration, not applied ----------

const EXCLUSION_DRAFT = new URL('../../server/modules/chatbot/db/migrations-draft/0001_bookings_exclusion.sql', import.meta.url);

test('H-2: the exclusion draft exists, is marked as a draft and unverified, and creates btree_gist', () => {
  const sql = readFileSync(EXCLUSION_DRAFT, 'utf8');
  assert.match(sql, /DRAFT\. NOT APPLIED/);
  assert.match(sql, /UNVERIFIED against Postgres/);
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS btree_gist/);
});

test('H-2: the exclusion constraint is on the company, the calendar and the blocked range, and only for confirmed rows', () => {
  const sql = readFileSync(EXCLUSION_DRAFT, 'utf8');
  assert.match(sql, /ALTER TABLE chatbot_appointments/);
  assert.match(sql, /EXCLUDE USING gist/);
  assert.match(sql, /company_id WITH =/, 'the constraint must be scoped by company_id');
  assert.match(sql, /calendar_id WITH =/);
  assert.match(sql, /blocked_range WITH &&/);
  assert.match(sql, /WHERE \(status = 'confirmed'\)/, 'only active (confirmed) rows may block a slot');
});

test('H-2: every column the draft names exists on chatbot_appointments', () => {
  const sql = readFileSync(EXCLUSION_DRAFT, 'utf8');
  const columns = new Set(getTableConfig(chatbotAppointments).columns.map((column) => column.name));
  for (const name of ['company_id', 'calendar_id', 'blocked_range', 'status']) {
    assert.ok(columns.has(name), `${name} is not a column of chatbot_appointments`);
    assert.match(sql, new RegExp(name));
  }
});

// ---------- Fix pass 2, item 4: database claims in the docs are marked UNVERIFIED ----------

const CHATBOT_DOCS_ROOT = fileURLToPath(new URL('../../server/modules/chatbot/', import.meta.url));

function chatbotDocFiles(dir = CHATBOT_DOCS_ROOT, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) chatbotDocFiles(path, out);
    else if (entry.name === 'DECISIONS.md' || entry.name === 'INTEGRATION.md') out.push(path);
  }
  return out;
}

test('item 4: every DECISIONS.md and INTEGRATION.md sentence that claims a database behaviour is marked UNVERIFIED', () => {
  const claim = /FOR UPDATE|ON CONFLICT|database transaction|one transaction|row lock|unique index|CHECK constraint|partial unique|EXCLUDE constraint|database trigger/i;
  const marked = /UNVERIFIED|Not verified|not proven|not run|No run|not been run|not applied|not checked|not built|Confirm|needs|must|should|requires|Writing/i;
  const bullet = /^\s*([-*]|\d+\.|#)\s/;
  const problems = [];
  for (const file of chatbotDocFiles()) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!claim.test(line)) return;
      let start = i;
      while (start > 0 && lines[start].trim() !== '' && !bullet.test(lines[start])) start -= 1;
      let end = i;
      while (end + 1 < lines.length && lines[end + 1].trim() !== '' && !bullet.test(lines[end + 1])) end += 1;
      const paragraph = lines.slice(start, end + 1).join(' ');
      if (!marked.test(paragraph)) problems.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(problems, []);
});

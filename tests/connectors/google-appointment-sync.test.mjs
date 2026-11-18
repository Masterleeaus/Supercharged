import test from 'node:test';
import assert from 'node:assert/strict';

const { createGoogleAppointmentSync, appointmentEventInput, appointmentEventTimes } = await import(
  '../../server/connectors/calendar/google-appointment-sync.ts'
);
const { ConnectorError } = await import('../../server/connectors/sdk/contract.ts');

const apt = {
  id: 'apt-1',
  contactName: 'Ana Lopez',
  contactPhone: '+15550100',
  contactEmail: 'ana@example.com',
  appointmentDate: '2026-12-01',
  appointmentTime: '09:30:00',
  duration: 90,
  serviceName: 'Drain clearing',
  notes: 'Back door',
  status: 'scheduled',
};

const reply = (status, json, headers = {}) => ({
  status,
  headers,
  body: json === undefined ? '' : JSON.stringify(json),
});

// Fake HttpClient: records every request and answers from a queue of replies.
function fakeHttp(replies) {
  const calls = [];
  const http = async (req) => {
    calls.push(req);
    const next = replies.shift();
    if (!next) throw new Error('unexpected extra request');
    return next;
  };
  return { http, calls };
}

const auditRecords = () => {
  const records = [];
  return { records, audit: async (r) => void records.push(r) };
};

test('appointment times: local start and end, same rules as the old service', () => {
  assert.deepEqual(appointmentEventTimes(apt), {
    startsAt: '2026-12-01T09:30:00',
    endsAt: '2026-12-01T11:00:00',
  });
});

test('appointment input: summary, description and confirmed status match the old event body', () => {
  const input = appointmentEventInput(apt, 'America/New_York', new Date('2026-11-18T12:00:00Z'));
  assert.equal(input.summary, 'Scheduled: Ana Lopez — Drain clearing');
  assert.equal(
    input.description,
    [
      'Phone: +15550100',
      'Email: ana@example.com',
      'Service: Drain clearing',
      'Duration: 90 minutes',
      'Notes: Back door',
      '\nBooked by AI agent via Diploy',
    ].join('\n'),
  );
  assert.equal(input.status, 'confirmed');
  assert.equal(input.timezone, 'America/New_York');
});

test('appointment input: a completed appointment records when it was completed', () => {
  const input = appointmentEventInput({ ...apt, status: 'completed' }, 'UTC', new Date('2026-12-01T12:00:00Z'));
  assert.match(input.description, /\nCompleted at: .+/);
  assert.match(input.summary, /^Completed: Ana Lopez/);
});

test('create: posts a confirmed event in the user timezone and returns the Google event id', async () => {
  const { http, calls } = fakeHttp([reply(200, { id: 'evt_created' })]);
  const { records, audit } = auditRecords();
  const sync = createGoogleAppointmentSync({
    http,
    audit,
    companyId: 'co-1',
    timezone: 'America/New_York',
    getAccessToken: async () => 'tok-A',
  });

  const eventId = await sync.create(apt);

  assert.equal(eventId, 'evt_created');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /\/calendars\/primary\/events\?sendUpdates=none$/);
  const body = JSON.parse(calls[0].body);
  assert.equal(body.status, 'confirmed');
  assert.deepEqual(body.start, { dateTime: '2026-12-01T09:30:00', timeZone: 'America/New_York' });
  assert.deepEqual(body.end, { dateTime: '2026-12-01T11:00:00', timeZone: 'America/New_York' });
  assert.match(body.id, /^[0-9a-f]{64}$/);
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, 'success');
});

test('create: a replay for the same appointment and start asks for the same event id', async () => {
  const { http, calls } = fakeHttp([reply(200, { id: 'e1' }), reply(200, { id: 'e1' })]);
  const { audit } = auditRecords();
  const sync = createGoogleAppointmentSync({ http, audit, companyId: 'co-1', timezone: 'UTC', getAccessToken: async () => 'tok' });
  await sync.create(apt);
  await sync.create(apt);
  assert.equal(JSON.parse(calls[0].body).id, JSON.parse(calls[1].body).id);
});

test('update: patches summary, description and times, and leaves the event status alone', async () => {
  const { http, calls } = fakeHttp([reply(200, { id: 'evt_1' })]);
  const { audit } = auditRecords();
  const sync = createGoogleAppointmentSync({ http, audit, companyId: 'co-1', timezone: 'Europe/London', getAccessToken: async () => 'tok' });

  const ok = await sync.update('evt_1', { ...apt, status: 'completed' });

  assert.equal(ok, true);
  assert.equal(calls[0].method, 'PATCH');
  assert.match(calls[0].url, /\/events\/evt_1\?sendUpdates=none$/);
  const body = JSON.parse(calls[0].body);
  assert.match(body.summary, /^Completed: Ana Lopez/);
  assert.match(body.description, /Completed at:/);
  assert.deepEqual(body.start, { dateTime: '2026-12-01T09:30:00', timeZone: 'Europe/London' });
  assert.equal('status' in body, false);
});

test('remove: deletes the event; an event already gone (410) counts as deleted', async () => {
  const { http, calls } = fakeHttp([reply(204, undefined), reply(410, undefined)]);
  const { audit } = auditRecords();
  const sync = createGoogleAppointmentSync({ http, audit, companyId: 'co-1', timezone: 'UTC', getAccessToken: async () => 'tok' });
  assert.equal(await sync.remove('evt_2'), true);
  assert.equal(await sync.remove('evt_2'), true);
  assert.equal(calls[0].method, 'DELETE');
});

test('auth: a 401 refreshes the token once and retries with the new one', async () => {
  const { http, calls } = fakeHttp([reply(401, { error: 'expired' }), reply(200, { id: 'evt_after_refresh' })]);
  const { audit } = auditRecords();
  const forced = [];
  const sync = createGoogleAppointmentSync({
    http,
    audit,
    companyId: 'co-1',
    timezone: 'UTC',
    getAccessToken: async (force) => {
      forced.push(force);
      return force ? 'tok-new' : 'tok-old';
    },
  });

  assert.equal(await sync.create(apt), 'evt_after_refresh');
  assert.deepEqual(forced, [false, true]);
  assert.equal(calls[0].headers.authorization, 'Bearer tok-old');
  assert.equal(calls[1].headers.authorization, 'Bearer tok-new');
});

test('auth: no connected token means no vendor call and an auth error', async () => {
  const { http, calls } = fakeHttp([]);
  const { audit } = auditRecords();
  const sync = createGoogleAppointmentSync({ http, audit, companyId: 'co-1', timezone: 'UTC', getAccessToken: async () => null });
  await assert.rejects(sync.create(apt), (err) => err instanceof ConnectorError && err.code === 'auth');
  assert.equal(calls.length, 0);
});

test('negative: a vendor rejection surfaces as a validation error without a retry', async () => {
  const { http, calls } = fakeHttp([reply(400, { error: { message: 'bad time, token tok-A echoed' } })]);
  const { records, audit } = auditRecords();
  const sync = createGoogleAppointmentSync({ http, audit, companyId: 'co-1', timezone: 'UTC', getAccessToken: async () => 'tok-A' });
  await assert.rejects(sync.create(apt), (err) => err instanceof ConnectorError && err.code === 'validation');
  assert.equal(calls.length, 1);
  assert.equal(records[0].outcome, 'failure');
});

test('negative: audit records never carry the access token', async () => {
  const { http } = fakeHttp([reply(200, { id: 'evt_x' })]);
  const { records, audit } = auditRecords();
  const sync = createGoogleAppointmentSync({ http, audit, companyId: 'co-1', timezone: 'UTC', getAccessToken: async () => 'secret-token-zz' });
  await sync.create(apt);
  assert.equal(JSON.stringify(records).includes('secret-token-zz'), false);
});

// Calendly exposes createBooking and cancelBooking only, so the calendar-event operations (hold, confirm,
// reschedule) are refused for it instead of being faked. Default decision recorded in the PR for #354.
test('calendly: hold, confirm and reschedule are refused with a validation error and never reach the vendor', async () => {
  const { createCalendlyConnector } = await import('../../server/connectors/calendar/calendly.ts');
  const { createBookingOps } = await import('../../server/connectors/calendar/booking-ops.ts');
  const { http, calls } = fakeHttp([]);
  const { audit } = auditRecords();
  const ops = createBookingOps({
    definition: createCalendlyConnector({ http }),
    companyId: 'co-1',
    credentials: { type: 'oauth2', accessToken: 'tok' },
    audit,
  });
  const slot = { startsAt: '2026-12-01T09:30:00Z', endsAt: '2026-12-01T11:00:00Z', timezone: 'UTC' };
  await assert.rejects(ops.hold('b1', slot, 'x'), (err) => err instanceof ConnectorError && err.code === 'validation');
  await assert.rejects(ops.confirm('b1', 'e1'), (err) => err instanceof ConnectorError && err.code === 'validation');
  await assert.rejects(ops.reschedule('b1', 'e1', slot), (err) => err instanceof ConnectorError && err.code === 'validation');
  assert.equal(calls.length, 0);
});

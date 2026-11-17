import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const { createGoogleCalendarConnector, googleEventIdFor } = await import('../../server/connectors/calendar/google-calendar.ts');
const { createOutlookCalendarConnector } = await import('../../server/connectors/calendar/outlook.ts');
const { createCalendlyConnector } = await import('../../server/connectors/calendar/calendly.ts');
const { createBookingOps } = await import('../../server/connectors/calendar/booking-ops.ts');
const { freeSlots, footprint } = await import('../../server/connectors/calendar/slots.ts');
const { ConnectorError } = await import('../../server/connectors/sdk/contract.ts');
const { runAction } = await import('../../server/connectors/sdk/runner.ts');
const manifestMod = await import('../../server/plugins/manifest.ts');
const discovery = await import('../../server/plugins/connector-discovery.ts');

const CATALOG = fileURLToPath(new URL('../../server/connectors/catalog', import.meta.url));
const FIX = (name) => JSON.parse(fs.readFileSync(fileURLToPath(new URL(`./fixtures/calendar/${name}`, import.meta.url)), 'utf8'));
const TOKEN = 'CAL-TEST-TOKEN-VALUE';
const oauth = { type: 'oauth2', accessToken: TOKEN };

/** Replays recorded interactions in order, matched by method and path. Records every request it sees. */
function replay(interactions) {
  const queue = interactions.map((i) => ({ ...i, used: false }));
  const calls = [];
  const http = async (req) => {
    const u = new URL(req.url);
    calls.push({ method: req.method, path: u.pathname, search: u.search, headers: req.headers, body: req.body });
    const hit = queue.find((i) => !i.used && i.method === req.method && i.path === u.pathname);
    if (!hit) throw new Error(`no recorded interaction for ${req.method} ${u.pathname}`);
    hit.used = true;
    return { status: hit.status, headers: {}, body: hit.body === '' ? '' : JSON.stringify(hit.body) };
  };
  return { http, calls, queue };
}

const audit = () => {
  const rows = [];
  return { rows, sink: async (r) => { rows.push(r); } };
};

/** A stateful Google stand-in: POST with an existing id returns 409, DELETE of a missing id returns 410. */
function fakeGoogle() {
  const events = new Map();
  const calls = [];
  const http = async (req) => {
    const u = new URL(req.url);
    calls.push({ method: req.method, path: u.pathname });
    const base = '/calendar/v3/calendars/primary/events';
    if (req.method === 'POST' && u.pathname === base) {
      const body = JSON.parse(req.body);
      if (events.has(body.id)) return { status: 409, headers: {}, body: '{}' };
      events.set(body.id, body);
      return { status: 200, headers: {}, body: JSON.stringify(body) };
    }
    if (req.method === 'GET' && u.pathname.startsWith(`${base}/`)) {
      const id = decodeURIComponent(u.pathname.slice(base.length + 1));
      const ev = events.get(id);
      return ev ? { status: 200, headers: {}, body: JSON.stringify(ev) } : { status: 404, headers: {}, body: '' };
    }
    if (req.method === 'PATCH' && u.pathname.startsWith(`${base}/`)) {
      const id = decodeURIComponent(u.pathname.slice(base.length + 1));
      const ev = events.get(id);
      if (!ev) return { status: 404, headers: {}, body: '' };
      Object.assign(ev, JSON.parse(req.body));
      return { status: 200, headers: {}, body: JSON.stringify(ev) };
    }
    if (req.method === 'DELETE' && u.pathname.startsWith(`${base}/`)) {
      const id = decodeURIComponent(u.pathname.slice(base.length + 1));
      if (!events.has(id)) return { status: 410, headers: {}, body: '' };
      events.delete(id);
      return { status: 204, headers: {}, body: '' };
    }
    return { status: 500, headers: {}, body: '' };
  };
  return { http, events, calls };
}

const SLOT = { startsAt: '2026-11-20T09:00:00+10:00', endsAt: '2026-11-20T10:00:00+10:00', timezone: 'Australia/Melbourne' };
const BOOKING = 'booking-1';

// ---- Google Calendar -------------------------------------------------------

test('google: listBusy follows pages and keeps only confirmed, timed, non-transparent events', async () => {
  const fixture = FIX('google-events.json');
  const rec = replay(fixture.interactions);
  const def = createGoogleCalendarConnector({ http: rec.http });
  const busy = await def.execute({ action: 'listBusy', input: { from: '2026-11-20T00:00:00Z', to: '2026-11-21T00:00:00Z' }, timeoutMs: 1000 }, oauth);
  assert.deepEqual(busy.map((b) => b.id), ['busy-1', 'busy-2']);
  assert.equal(rec.calls.length, 2);
  assert.match(rec.calls[1].search, /pageToken=page-2/);
  for (const c of rec.calls) {
    assert.equal(c.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(c.search.includes(TOKEN), false, 'token never goes in a URL');
  }
});

test('google: createEvent uses an id derived from the idempotency key and posts tentative by default', async () => {
  const g = fakeGoogle();
  const def = createGoogleCalendarConnector({ http: g.http });
  const ev = await def.execute({ action: 'createEvent', input: { ...SLOT, summary: 'Clean' }, idempotencyKey: 'key-abc', timeoutMs: 1000 }, oauth);
  assert.equal(ev.id, googleEventIdFor('key-abc'));
  assert.equal(ev.status, 'tentative');
  assert.match(ev.id, /^[a-f0-9]{64}$/);
});

test('google: a retried create with the same key returns the existing event and posts nothing twice', async () => {
  const g = fakeGoogle();
  const def = createGoogleCalendarConnector({ http: g.http });
  const input = { ...SLOT, summary: 'Clean' };
  const first = await def.execute({ action: 'createEvent', input, idempotencyKey: 'same', timeoutMs: 1000 }, oauth);
  const second = await def.execute({ action: 'createEvent', input, idempotencyKey: 'same', timeoutMs: 1000 }, oauth);
  assert.equal(first.id, second.id);
  assert.equal(g.events.size, 1);
  assert.equal(g.calls.filter((c) => c.method === 'POST').length, 2);
});

test('google: vendor status maps to the SDK taxonomy, and Retry-After is honoured', async () => {
  const mk = (status, headers = {}) => createGoogleCalendarConnector({
    http: async () => ({ status, headers, body: '{"error":"secret detail"}' }),
  });
  await assert.rejects(mk(401).execute({ action: 'listBusy', input: { from: '2026-11-20T00:00:00Z', to: '2026-11-21T00:00:00Z' }, timeoutMs: 1000 }, oauth), (e) => e instanceof ConnectorError && e.code === 'auth');
  await assert.rejects(mk(429, { 'retry-after': '7' }).execute({ action: 'listBusy', input: { from: '2026-11-20T00:00:00Z', to: '2026-11-21T00:00:00Z' }, timeoutMs: 1000 }, oauth), (e) => e.code === 'rate_limited' && e.retryAfterMs === 7000);
  await assert.rejects(mk(503).execute({ action: 'listBusy', input: { from: '2026-11-20T00:00:00Z', to: '2026-11-21T00:00:00Z' }, timeoutMs: 1000 }, oauth), (e) => e.code === 'upstream' && !String(e.message).includes('secret'));
});

// ---- Outlook ---------------------------------------------------------------

test('outlook: listBusy follows the next link and skips free events, with UTC instants', async () => {
  const rec = replay(FIX('outlook-events.json').interactions);
  const def = createOutlookCalendarConnector({ http: rec.http });
  const busy = await def.execute({ action: 'listBusy', input: { from: '2026-11-20T00:00:00Z', to: '2026-11-21T00:00:00Z' }, timeoutMs: 1000 }, oauth);
  assert.deepEqual(busy.map((b) => b.id), ['AAMk-busy-1', 'AAMk-busy-2']);
  assert.equal(busy[0].start, '2026-11-20T00:00:00.0000000Z');
  assert.equal(rec.calls[0].headers.prefer, 'outlook.timezone="UTC"');
});

test('outlook: createEvent sends the idempotency key as transactionId; confirm and cancel are applied', async () => {
  const rec = replay(FIX('outlook-events.json').interactions);
  const def = createOutlookCalendarConnector({ http: rec.http });
  const created = await def.execute({ action: 'createEvent', input: { ...SLOT, summary: 'Clean' }, idempotencyKey: 'out-key', timeoutMs: 1000 }, oauth);
  assert.equal(created.id, 'AAMk-created-1');
  const posted = JSON.parse(rec.calls[0].body);
  assert.equal(posted.transactionId, 'out-key');
  assert.equal(posted.showAs, 'tentative');
  assert.equal(posted.start.timeZone, 'UTC');

  const confirmed = await def.execute({ action: 'updateEvent', input: { eventId: 'AAMk-created-1', status: 'confirmed' }, timeoutMs: 1000 }, oauth);
  assert.equal(confirmed.showAs, 'busy');
  const cancelled = await def.execute({ action: 'deleteEvent', input: { eventId: 'AAMk-created-1' }, timeoutMs: 1000 }, oauth);
  assert.deepEqual(cancelled, { deleted: true, alreadyGone: false });
});

test('outlook: deleting an event Graph already reports as gone is treated as cancelled', async () => {
  const def = createOutlookCalendarConnector({ http: async () => ({ status: 404, headers: {}, body: '' }) });
  const r = await def.execute({ action: 'deleteEvent', input: { eventId: 'gone' }, timeoutMs: 1000 }, oauth);
  assert.deepEqual(r, { deleted: true, alreadyGone: true });
});

// ---- Calendly (adapter over the existing provider) --------------------------

const CAL_BASE = 'https://api.calendly.com';
function calendlyHttp(routes) {
  return async (req) => {
    const u = new URL(req.url);
    const hit = routes[`${req.method} ${u.pathname}`];
    if (!hit) return { status: 500, headers: {}, body: '' };
    return { status: hit.status ?? 200, headers: hit.headers ?? {}, body: JSON.stringify(hit.body ?? {}) };
  };
}

test('calendly: listEventTypes maps the existing provider result through the connector contract', async () => {
  const http = calendlyHttp({
    'GET /users/me': { body: { resource: { uri: `${CAL_BASE}/users/U1` } } },
    'GET /event_types': { body: { collection: [{ uri: `${CAL_BASE}/event_types/ET1`, name: 'Clean', duration: 60, active: true }], pagination: { next_page: null } } },
  });
  const def = createCalendlyConnector({ http });
  const ref = { companyId: '11111111-1111-4111-8111-111111111111', chatbotId: 'bot-1', externalEventTypeId: `${CAL_BASE}/event_types/ET1` };
  const types = await def.execute({ action: 'listEventTypes', input: { ref }, timeoutMs: 1000 }, { type: 'api_key', apiKey: 'CAL-KEY' });
  assert.deepEqual(types, [{ externalId: `${CAL_BASE}/event_types/ET1`, name: 'Clean', durationMinutes: 60, active: true }]);
});

test('calendly: a 429 from the provider becomes rate_limited, and a missing ref is a validation error', async () => {
  const def = createCalendlyConnector({ http: calendlyHttp({ 'GET /users/me': { status: 429 } }) });
  const ref = { companyId: '11111111-1111-4111-8111-111111111111', chatbotId: 'bot-1', externalEventTypeId: `${CAL_BASE}/event_types/ET1` };
  await assert.rejects(def.execute({ action: 'listEventTypes', input: { ref }, timeoutMs: 1000 }, { type: 'api_key', apiKey: 'K' }), (e) => e.code === 'rate_limited');
  await assert.rejects(def.execute({ action: 'listEventTypes', input: {}, timeoutMs: 1000 }, { type: 'api_key', apiKey: 'K' }), (e) => e.code === 'validation');
});

// ---- Booking operations (hold, confirm, reschedule, cancel) -----------------

test('booking ops: a replayed hold for the same booking and slot creates one event', async () => {
  const g = fakeGoogle();
  const def = createGoogleCalendarConnector({ http: g.http });
  const a = audit();
  const ops = createBookingOps({ definition: def, companyId: 'co-1', credentials: oauth, audit: a.sink, now: () => new Date('2026-11-18T00:00:00Z') });
  const first = await ops.hold(BOOKING, SLOT, 'Clean');
  const replay2 = await ops.hold(BOOKING, SLOT, 'Clean');
  assert.equal(first.eventId, replay2.eventId);
  assert.equal(g.events.size, 1);
  assert.equal(a.rows.length, 2, 'each call still writes one audit record');
});

test('booking ops: confirm, reschedule and cancel act on the held event; cancelling twice is safe', async () => {
  const g = fakeGoogle();
  const def = createGoogleCalendarConnector({ http: g.http });
  const a = audit();
  const ops = createBookingOps({ definition: def, companyId: 'co-1', credentials: oauth, audit: a.sink });
  const { eventId } = await ops.hold(BOOKING, SLOT, 'Clean');
  await ops.confirm(BOOKING, eventId);
  assert.equal(g.events.get(eventId).status, 'confirmed');
  const moved = { startsAt: '2026-11-21T09:00:00+10:00', endsAt: '2026-11-21T10:00:00+10:00', timezone: 'Australia/Melbourne' };
  await ops.reschedule(BOOKING, eventId, moved);
  assert.equal(g.events.get(eventId).start.dateTime, moved.startsAt);
  const c1 = await ops.cancel(BOOKING, eventId);
  const c2 = await ops.cancel(BOOKING, eventId);
  assert.equal(c1.alreadyGone, false);
  assert.equal(c2.alreadyGone, true);
  assert.equal(g.events.size, 0);
});

test('runner: a write without a stable id still gets an idempotency key', async () => {
  const g = fakeGoogle();
  const def = createGoogleCalendarConnector({ http: g.http });
  const a = audit();
  const r = await runAction({ definition: def, companyId: 'co-1', action: 'createEvent', input: { ...SLOT, summary: 'x' }, credentials: oauth, audit: a.sink });
  assert.equal(typeof r.idempotencyKey, 'string');
});

// ---- Availability -------------------------------------------------------------

const T = (h, m = 0) => Date.UTC(2026, 10, 20, h, m);

test('availability: travel and buffers block the time either side of a job', () => {
  const job = { durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 15, travelBeforeMin: 30, travelAfterMin: 0 };
  const slots = freeSlots({ windowStart: T(8), windowEnd: T(14), busy: [{ start: T(10), end: T(11) }], job, stepMin: 15 });
  const starts = slots.map((s) => s.start);
  assert.equal(starts.includes(T(9, 0)), false, 'a 9:00 job would need travel into 10:00 and is refused');
  assert.equal(starts.includes(T(9, 15)), false);
  assert.equal(starts.includes(T(9, 30)), false, 'a 9:30 job runs into the 10:00 booking');
  assert.equal(starts.includes(T(8, 30)), true, '8:30 job ends 9:30, its 15 minute buffer ends 9:45, clear of 10:00');
  assert.equal(starts.includes(T(11, 0)), false, 'an 11:00 job would need travel into 10:30');
  assert.equal(starts.includes(T(11, 30)), true);
});

test('availability: the footprint covers travel and buffers on both sides, and bad profiles are refused', () => {
  const fp = footprint(T(10), { durationMin: 60, bufferBeforeMin: 5, bufferAfterMin: 10, travelBeforeMin: 20, travelAfterMin: 15 });
  assert.equal(fp.start, T(9, 35));
  assert.equal(fp.end, T(11, 25));
  assert.throws(() => freeSlots({ windowStart: T(8), windowEnd: T(9), busy: [], job: { durationMin: 0, bufferBeforeMin: 0, bufferAfterMin: 0, travelBeforeMin: 0, travelAfterMin: 0 } }), RangeError);
});

// ---- Manifests ----------------------------------------------------------------

test('every catalog manifest validates and discovery reports no rejects', () => {
  const out = discovery.discoverConnectorManifests(CATALOG);
  assert.deepEqual(out.rejected, []);
  assert.deepEqual(out.manifests.map((m) => m.id).sort(), ['calendly', 'google-calendar', 'outlook-calendar']);
  for (const dir of ['google-calendar', 'outlook-calendar', 'calendly']) {
    const r = manifestMod.validateConnectorManifest(JSON.parse(fs.readFileSync(`${CATALOG}/${dir}/connector.json`, 'utf8')));
    assert.equal(r.ok, true, `${dir} manifest is valid`);
  }
});

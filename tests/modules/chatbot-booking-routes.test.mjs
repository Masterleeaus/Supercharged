/**
 * Tests for the booking HTTP layer (server/modules/chatbot/booking-routes). Builds a real express app, mounts the
 * router on an ephemeral port and makes real HTTP requests. Storage and service are in-memory fakes, so no
 * database is touched. The fakes scope every read and write by companyId, so cross-company checks exercise real
 * scoping rather than a stub that always answers null.
 * Run: node --test --experimental-transform-types tests/modules/chatbot-booking-routes.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";

const { createBookingRouter, BOOKING_ROUTES_FLAG } = await import(
  "../../server/modules/chatbot/booking-routes/router.ts"
);
const { BOOKING_ROUTES } = await import("../../server/modules/chatbot/booking-routes/contract.ts");

const CO_A = "11111111-1111-4111-8111-111111111111";
const CO_B = "22222222-2222-4222-8222-222222222222";
const ENABLED = { [BOOKING_ROUTES_FLAG]: "true" };
const BASE = "/api/chatbot";

/* ---------- in-memory fakes that implement the BookingStorage contract ---------- */

function createFakeStorage() {
  const rows = new Map();
  const settings = new Map();
  const view = (r) => ({
    id: r.id,
    calendarId: r.calendarId,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    status: r.status,
    metadata: r.metadata,
    cancelReason: r.cancelReason,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
  const own = (companyId, id) => {
    const r = rows.get(id);
    return r && r.companyId === companyId ? r : null;
  };
  return {
    rows,
    settings,
    async listBookings(companyId, q) {
      return [...rows.values()]
        .filter((r) => r.companyId === companyId)
        .filter((r) => q.calendarId === undefined || r.calendarId === q.calendarId)
        .filter((r) => !q.status || q.status === "all" || r.status === q.status)
        .slice(q.offset, q.offset + q.limit);
    },
    async getBooking(companyId, id) {
      return own(companyId, id);
    },
    async insertBooking(companyId, row) {
      const record = { ...row, companyId, cancelReason: null };
      rows.set(row.id, record);
      return record;
    },
    async updateBooking(companyId, id, patch) {
      const r = own(companyId, id);
      if (!r) return null;
      Object.assign(r, patch);
      return r;
    },
    async findOverlapping(companyId, calendarId, startsAt, endsAt, excludeId) {
      return [...rows.values()].filter(
        (r) =>
          r.companyId === companyId &&
          r.id !== excludeId &&
          r.calendarId === calendarId &&
          r.status !== "cancelled" &&
          Date.parse(r.startsAt) < Date.parse(endsAt) &&
          Date.parse(r.endsAt) > Date.parse(startsAt),
      );
    },
    async getAssistantSettings(companyId) {
      return settings.get(companyId) ?? null;
    },
    async saveAssistantSettings(companyId, patch) {
      const current = settings.get(companyId) ?? { calendlyAccessToken: null, bookingAssistantConditions: [] };
      const next = { ...current };
      if (patch.calendlyAccessToken !== undefined) next.calendlyAccessToken = patch.calendlyAccessToken;
      if (patch.bookingAssistantConditions !== undefined) next.bookingAssistantConditions = patch.bookingAssistantConditions;
      settings.set(companyId, next);
    },
    view,
  };
}

/** Fake BookingService built on the fake storage. Records each call so tests can assert none happened. */
function createFakeService(storage) {
  const calls = [];
  const note = (name) => calls.push(name);
  const service = {
    calls,
    async listBookings(companyId, query) {
      note("listBookings");
      return (await storage.listBookings(companyId, query)).map(storage.view);
    },
    async getBooking(companyId, id) {
      note("getBooking");
      const r = await storage.getBooking(companyId, id);
      return r ? storage.view(r) : null;
    },
    async createBooking(companyId, input) {
      note("createBooking");
      if (input.status === "confirmed") {
        const clash = await storage.findOverlapping(companyId, input.calendarId, input.startsAt, input.endsAt);
        if (clash.length > 0) throw Object.assign(new Error("Slot already booked"), { status: 409 });
      }
      const now = new Date().toISOString();
      const row = await storage.insertBooking(companyId, { id: randomUUID(), ...input, createdAt: now, updatedAt: now });
      return storage.view(row);
    },
    async updateBooking(companyId, id, patch) {
      note("updateBooking");
      const current = await storage.getBooking(companyId, id);
      if (!current) return null;
      const next = { ...current, ...patch };
      const clash = await storage.findOverlapping(companyId, next.calendarId, next.startsAt, next.endsAt, id);
      if (next.status === "confirmed" && clash.length > 0) throw Object.assign(new Error("Slot already booked"), { status: 409 });
      const updated = await storage.updateBooking(companyId, id, { ...patch, updatedAt: new Date().toISOString() });
      return storage.view(updated);
    },
    async cancelBooking(companyId, id, reason) {
      note("cancelBooking");
      const updated = await storage.updateBooking(companyId, id, {
        status: "cancelled",
        cancelReason: reason,
        updatedAt: new Date().toISOString(),
      });
      return updated ? storage.view(updated) : null;
    },
    async getAssistantSettings(companyId) {
      note("getAssistantSettings");
      const s = await storage.getAssistantSettings(companyId);
      return {
        calendlyAccessTokenSet: Boolean(s?.calendlyAccessToken),
        bookingAssistantConditions: s?.bookingAssistantConditions ?? [],
      };
    },
    async updateAssistantSettings(companyId, patch) {
      note("updateAssistantSettings");
      await storage.saveAssistantSettings(companyId, patch);
      return service.getAssistantSettings(companyId);
    },
  };
  return service;
}

/* ---------- stubs for the injected auth and role functions ---------- */

// Identity arrives in x-test-user. No header means 401, as authenticateToken answers.
const authenticate = (req, res, next) => {
  const raw = req.headers["x-test-user"];
  if (!raw) return res.status(401).json({ error: "Authentication required" });
  const user = JSON.parse(raw);
  req.authRole = user.role;
  req.authCompanyId = user.companyId;
  return next();
};

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.authRole) ? next() : res.status(403).json({ error: "Insufficient permissions" });

const getCompanyId = (req) => req.authCompanyId;

function buildApp({ env = ENABLED, storage = createFakeStorage(), service: serviceOverride, withRoles = true } = {}) {
  const service = serviceOverride ?? createFakeService(storage);
  const app = express();
  const deps = { service, authenticate, getCompanyId, env };
  if (withRoles) deps.requireRole = requireRole;
  app.use(BASE, createBookingRouter(deps));
  return { app, storage, service };
}

async function withServer(opts, fn) {
  const built = buildApp(opts);
  const server = built.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  const request = async (method, path, { user, body, raw } = {}) => {
    const headers = {};
    if (user) headers["x-test-user"] = JSON.stringify(user);
    let payload;
    if (raw !== undefined) {
      headers["content-type"] = "application/json";
      payload = raw;
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(`http://127.0.0.1:${port}${BASE}${path}`, { method, headers, body: payload });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  };
  try {
    return await fn({ ...built, request });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const ADMIN_A = { role: "admin", companyId: CO_A };
const ADMIN_B = { role: "admin", companyId: CO_B };
const SLOT = { calendarId: 7, startsAt: "2026-11-10T09:00:00+11:00", endsAt: "2026-11-10T10:00:00+11:00" };

/** Seeds one booking directly into storage for a company. */
function seed(storage, companyId, overrides = {}) {
  const id = overrides.id ?? randomUUID();
  storage.rows.set(id, {
    id,
    companyId,
    calendarId: 7,
    startsAt: "2026-11-12T09:00:00+11:00",
    endsAt: "2026-11-12T10:00:00+11:00",
    status: "confirmed",
    metadata: {},
    cancelReason: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  });
  return id;
}

/* ---------- tests ---------- */

test("flag off by default: every booking route answers 404 without running auth", async () => {
  await withServer({ env: {} }, async ({ request, service }) => {
    const list = await request("GET", "/bookings");
    const create = await request("POST", "/bookings", { user: ADMIN_A, body: SLOT });
    assert.equal(list.status, 404);
    assert.equal(create.status, 404);
    assert.equal(service.calls.length, 0);
  });
  assert.equal(BOOKING_ROUTES.length, 7);
});

test("unauthenticated GET is rejected with 401 and the service is never called", async () => {
  await withServer({}, async ({ request, service }) => {
    const res = await request("GET", "/bookings");
    assert.equal(res.status, 401);
    assert.equal(service.calls.length, 0);
  });
});

test("unauthenticated POST is rejected with 401 and nothing is stored", async () => {
  await withServer({}, async ({ request, storage }) => {
    const res = await request("POST", "/bookings", { body: SLOT });
    assert.equal(res.status, 401);
    assert.equal(storage.rows.size, 0);
  });
});

test("authenticated caller with no company scope is refused with 403", async () => {
  await withServer({}, async ({ request, storage }) => {
    const res = await request("POST", "/bookings", { user: { role: "admin" }, body: SLOT });
    assert.equal(res.status, 403);
    assert.equal(storage.rows.size, 0);
  });
});

test("create: body cannot override companyId; the request is rejected and nothing is stored under either company", async () => {
  await withServer({}, async ({ request, storage }) => {
    const res = await request("POST", "/bookings", { user: ADMIN_A, body: { ...SLOT, companyId: CO_B } });
    assert.equal(res.status, 400);
    assert.equal(storage.rows.size, 0);
  });
});

test("list: a companyId in the query string is rejected with 400", async () => {
  await withServer({}, async ({ request, storage }) => {
    const res = await request("GET", `/bookings?companyId=${CO_B}`, { user: ADMIN_A });
    assert.equal(res.status, 400);
    assert.equal(storage.rows.size, 0);
  });
});

test("create: endsAt before startsAt fails validation with 400", async () => {
  await withServer({}, async ({ request, storage }) => {
    const res = await request("POST", "/bookings", {
      user: ADMIN_A,
      body: { ...SLOT, startsAt: "2026-11-10T10:00:00+11:00", endsAt: "2026-11-10T09:00:00+11:00" },
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "Invalid input");
    assert.equal(storage.rows.size, 0);
  });
});

test("create: a local time without an offset and a missing calendarId fail validation with 400", async () => {
  await withServer({}, async ({ request }) => {
    const local = await request("POST", "/bookings", {
      user: ADMIN_A,
      body: { calendarId: 7, startsAt: "2026-11-10T09:00:00", endsAt: "2026-11-10T10:00:00" },
    });
    const noCalendar = await request("POST", "/bookings", {
      user: ADMIN_A,
      body: { startsAt: SLOT.startsAt, endsAt: SLOT.endsAt },
    });
    assert.equal(local.status, 400);
    assert.equal(noCalendar.status, 400);
    assert.ok(Array.isArray(noCalendar.json.issues));
  });
});

test("create: malformed JSON is rejected with 400", async () => {
  await withServer({}, async ({ request, storage }) => {
    const res = await request("POST", "/bookings", { user: ADMIN_A, raw: "{not json" });
    assert.equal(res.status, 400);
    assert.equal(storage.rows.size, 0);
  });
});

test("create: successful booking returns 201, is stored under the caller's company, and omits companyId", async () => {
  await withServer({}, async ({ request, storage }) => {
    const res = await request("POST", "/bookings", { user: ADMIN_A, body: SLOT });
    assert.equal(res.status, 201);
    assert.equal(res.json.status, "confirmed");
    assert.equal(res.json.calendarId, 7);
    assert.equal("companyId" in res.json, false);
    const stored = storage.rows.get(res.json.id);
    assert.equal(stored.companyId, CO_A);
  });
});

test("create: overlapping slot on the same calendar returns 409 from the service error", async () => {
  await withServer({}, async ({ request }) => {
    const first = await request("POST", "/bookings", { user: ADMIN_A, body: SLOT });
    const second = await request("POST", "/bookings", { user: ADMIN_A, body: SLOT });
    assert.equal(first.status, 201);
    assert.equal(second.status, 409);
    assert.equal(second.json.error, "Slot already booked");
  });
});

test("list: returns only the caller's company bookings", async () => {
  await withServer({}, async ({ request, storage }) => {
    seed(storage, CO_A);
    seed(storage, CO_B);
    const res = await request("GET", "/bookings", { user: ADMIN_A });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.length, 1);
    assert.equal(res.json.data.every((b) => !("companyId" in b)), true);
  });
});

test("get: a booking id belonging to another company returns 404 and is not revealed", async () => {
  await withServer({}, async ({ request, storage }) => {
    const bId = seed(storage, CO_B);
    const res = await request("GET", `/bookings/${bId}`, { user: ADMIN_A });
    assert.equal(res.status, 404);
    assert.equal(storage.rows.get(bId).companyId, CO_B);
  });
});

test("update: a booking id belonging to another company returns 404 and leaves that row unchanged", async () => {
  await withServer({}, async ({ request, storage }) => {
    const bId = seed(storage, CO_B, { metadata: { note: "original" } });
    const res = await request("PATCH", `/bookings/${bId}`, { user: ADMIN_A, body: { metadata: { note: "hijacked" } } });
    assert.equal(res.status, 404);
    assert.deepEqual(storage.rows.get(bId).metadata, { note: "original" });
  });
});

test("update: empty body fails validation with 400; a valid patch on own booking returns 200", async () => {
  await withServer({}, async ({ request, storage }) => {
    const own = seed(storage, CO_A);
    const empty = await request("PATCH", `/bookings/${own}`, { user: ADMIN_A, body: {} });
    const ok = await request("PATCH", `/bookings/${own}`, { user: ADMIN_A, body: { metadata: { room: "2" } } });
    assert.equal(empty.status, 400);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.metadata, { room: "2" });
  });
});

test("cancel: successful cancel returns 200 with status cancelled and stores the reason", async () => {
  await withServer({}, async ({ request, storage }) => {
    const own = seed(storage, CO_A);
    const res = await request("POST", `/bookings/${own}/cancel`, { user: ADMIN_A, body: { reason: "customer request" } });
    assert.equal(res.status, 200);
    assert.equal(res.json.status, "cancelled");
    assert.equal(storage.rows.get(own).status, "cancelled");
    assert.equal(storage.rows.get(own).cancelReason, "customer request");
  });
});

test("cancel: a booking id belonging to another company returns 404 and stays confirmed", async () => {
  await withServer({}, async ({ request, storage }) => {
    const bId = seed(storage, CO_B);
    const res = await request("POST", `/bookings/${bId}/cancel`, { user: ADMIN_A, body: {} });
    assert.equal(res.status, 404);
    assert.equal(storage.rows.get(bId).status, "confirmed");
  });
});

test("cancel: companyId in the body is rejected with 400 and nothing changes", async () => {
  await withServer({}, async ({ request, storage }) => {
    const own = seed(storage, CO_A);
    const res = await request("POST", `/bookings/${own}/cancel`, { user: ADMIN_A, body: { companyId: CO_B } });
    assert.equal(res.status, 400);
    assert.equal(storage.rows.get(own).status, "confirmed");
  });
});

test("invalid booking id in the path returns 400 before the service is called", async () => {
  await withServer({}, async ({ request, service }) => {
    const res = await request("GET", "/bookings/bad%21id", { user: ADMIN_A });
    assert.equal(res.status, 400);
    assert.equal(service.calls.length, 0);
  });
});

test("settings: the Calendly token is written but never returned; GET reports only whether one is set", async () => {
  const secret = "fake-calendly-token-for-tests";
  await withServer({}, async ({ request }) => {
    const before = await request("GET", "/booking-settings", { user: ADMIN_A });
    const patched = await request("PATCH", "/booking-settings", {
      user: ADMIN_A,
      body: { calendlyAccessToken: secret, bookingAssistantConditions: ["ask for a time"] },
    });
    const after = await request("GET", "/booking-settings", { user: ADMIN_A });
    assert.equal(before.json.hasCalendlyToken, false);
    assert.equal(patched.status, 200);
    assert.equal(after.json.hasCalendlyToken, true);
    assert.equal("calendlyAccessToken" in after.json, false);
    assert.deepEqual(after.json.bookingAssistantConditions, ["ask for a time"]);
    assert.equal(after.text.includes(secret), false);
    assert.equal(patched.text.includes(secret), false);
  });
});

test("settings: a service that returns the token in its object still does not leak it over HTTP", async () => {
  const LEAKED_TOKEN = "leaky-service-token-for-tests";
  const storage = createFakeStorage();
  const honest = createFakeService(storage);
  // Simulates a real BookingService that returns the stored token, as the storage contract allows.
  const leakyService = {
    ...honest,
    async getAssistantSettings() {
      return { calendlyAccessToken: LEAKED_TOKEN, calendlyAccessTokenSet: true, bookingAssistantConditions: ["x"] };
    },
    async updateAssistantSettings(_companyId, patch) {
      return { calendlyAccessToken: LEAKED_TOKEN, bookingAssistantConditions: patch.bookingAssistantConditions ?? [] };
    },
  };
  await withServer({ service: leakyService, storage }, async ({ request }) => {
    const get = await request("GET", "/booking-settings", { user: ADMIN_A });
    const patched = await request("PATCH", "/booking-settings", {
      user: ADMIN_A,
      body: { bookingAssistantConditions: ["y"] },
    });
    assert.equal(get.status, 200);
    assert.equal(get.text.includes(LEAKED_TOKEN), false);
    assert.equal(get.json.hasCalendlyToken, true);
    assert.equal("calendlyAccessToken" in get.json, false);
    assert.equal(patched.status, 200);
    assert.equal(patched.text.includes(LEAKED_TOKEN), false);
    assert.equal(patched.json.hasCalendlyToken, true);
  });
});

test("roles: a router built without requireRole refuses every authenticated request with 403", async () => {
  await withServer({ withRoles: false }, async ({ request, service }) => {
    const list = await request("GET", "/bookings", { user: ADMIN_A });
    const create = await request("POST", "/bookings", { user: ADMIN_A, body: SLOT });
    const settings = await request("GET", "/booking-settings", { user: ADMIN_A });
    assert.equal(list.status, 403);
    assert.equal(create.status, 403);
    assert.equal(settings.status, 403);
    assert.equal(service.calls.length, 0);
  });
});

test("settings: an empty PATCH is rejected with 400, and an agent role cannot write settings", async () => {
  await withServer({}, async ({ request }) => {
    const empty = await request("PATCH", "/booking-settings", { user: ADMIN_A, body: {} });
    const agent = await request("PATCH", "/booking-settings", {
      user: { role: "agent", companyId: CO_A },
      body: { bookingAssistantConditions: ["x"] },
    });
    assert.equal(empty.status, 400);
    assert.equal(agent.status, 403);
  });
});

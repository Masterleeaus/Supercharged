// Integration mount tests (node:test): server/modules/chatbot/integration/mount.ts.
// Flags default off, a flag on without its dependency refuses to mount, the agent plan gate is passed through,
// and a refused reply never reaches the store. Run with the single integration hook (see INTEGRATION.md).
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mountChatbotSlices } from "../../server/modules/chatbot/integration/mount.ts";

const CO_A = "11111111-1111-4111-8111-111111111111";
const stubRoles = () => (req, res, next) => next();
const stubScope = (req, res, next) => { res.locals.companyId = CO_A; next(); };
const stubAuth = (req, res, next) => { req.userRole = "admin"; next(); };
const fakeApp = () => { const calls = []; return { calls, use: (...args) => calls.push(args) }; };
const base = { authenticate: stubAuth, requireRole: stubRoles, requireCompanyScope: stubScope };

// A store that fails the test if any method is called. Used where the gate must refuse before storage is touched.
const untouchableStore = new Proxy({}, {
  get(_target, prop) {
    return () => { throw new Error(`store.${String(prop)} must not be called on a refused reply`); };
  },
});
const agentIdentity = { staffId: "11111111-1111-4111-8111-222222222222", companyId: CO_A, role: "agent" };
const authenticateAgent = () => agentIdentity;
const inboxFake = {
  async query() { return { data: [], page: 1, perPage: 30, total: 0 }; },
  async handoffToHuman() { throw new Error("not used"); },
  async handBackToAi() { throw new Error("not used"); },
  async setTicketStatus() { throw new Error("not used"); },
};

test("all flags off by default: nothing mounted and no agent plan gate reported", () => {
  const app = fakeApp();
  const r = mountChatbotSlices({ ...base, app, env: {} });
  assert.equal(app.calls.length, 0);
  assert.equal(r.mounted.length, 0);
  assert.equal(r.skipped.length, 3);
  assert.equal(r.agentPlanGate, null);
});

test("flags set to values other than exactly \"true\" stay off", () => {
  const app = fakeApp();
  const r = mountChatbotSlices({ ...base, app, env: { ENABLE_CHATBOT_BOOKING_ROUTES: "1", ENABLE_CHATBOT_BUILDER_ROUTES: "yes", DESK_CHATBOT_AGENT_ROUTES: "TRUE" } });
  assert.equal(app.calls.length, 0);
  assert.equal(r.skipped.length, 3);
});

test("a flag on without its dependency throws at mount time (fail closed, no in-memory fallback)", () => {
  assert.throws(() => mountChatbotSlices({ ...base, app: fakeApp(), env: { ENABLE_CHATBOT_BOOKING_ROUTES: "true" } }), /no BookingService/);
  assert.throws(() => mountChatbotSlices({ ...base, app: fakeApp(), env: { ENABLE_CHATBOT_BUILDER_ROUTES: "true" } }), /no BuilderStorage/);
  assert.throws(() => mountChatbotSlices({ ...base, app: fakeApp(), env: { DESK_CHATBOT_AGENT_ROUTES: "true" } }), /no agent inbox or store/);
});

test("bookings: flag on with the adapter inputs mounts the router and serves the list route", async () => {
  const bookingService = { listAppointments: async () => [] };
  const bookingStorage = {
    async listCalendars() { return []; },
    async listAppointments() { return []; },
    async calendarNumberOf() { return null; },
    async getSettings() { return null; },
    async saveSettings() { throw new Error("not used"); },
  };
  const app = express();
  app.use(express.json());
  const r = mountChatbotSlices({
    ...base,
    app,
    env: { ENABLE_CHATBOT_BOOKING_ROUTES: "true" },
    bookings: { service: bookingService, storage: bookingStorage },
  });
  assert.deepEqual(r.mounted.map((m) => m.slice), ["booking-routes"]);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/chatbot/bookings`);
    assert.notEqual(res.status, 404, "the bookings route must be mounted");
  } finally { server.close(); }
});

test("builder: flag on with storage mounts the router and passes demoMode through", () => {
  const app = fakeApp();
  const r = mountChatbotSlices({
    ...base,
    app,
    env: { ENABLE_CHATBOT_BUILDER_ROUTES: "true" },
    builder: { storage: {}, demoMode: true },
  });
  assert.deepEqual(r.mounted.map((m) => m.slice), ["builder-routes"]);
  assert.equal(app.calls[0][0], "/api/chatbot");
});

test("agent: without a plan gate the report says so, and every reply is refused with 403 before storage", async () => {
  const app = express();
  app.use(express.json());
  const r = mountChatbotSlices({
    ...base,
    app,
    env: { DESK_CHATBOT_AGENT_ROUTES: "true" },
    agent: { inbox: inboxFake, store: untouchableStore, authenticate: authenticateAgent },
  });
  assert.equal(r.agentPlanGate, false);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/chatbot/agent/conversations/11111111-1111-4111-8111-333333333333/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "Plan does not include human agents", "the refusal must come from the plan gate");
  } finally { server.close(); }
});

test("agent: a plan gate that returns false refuses the reply with 403 before storage", async () => {
  const app = express();
  app.use(express.json());
  const r = mountChatbotSlices({
    ...base,
    app,
    env: { DESK_CHATBOT_AGENT_ROUTES: "true" },
    agent: { inbox: inboxFake, store: untouchableStore, authenticate: authenticateAgent, hasHumanAgents: async () => false },
  });
  assert.equal(r.agentPlanGate, true, "a gate function is supplied");
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/chatbot/agent/conversations/11111111-1111-4111-8111-333333333333/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "Plan does not include human agents", "the refusal must come from the plan gate");
  } finally { server.close(); }
});

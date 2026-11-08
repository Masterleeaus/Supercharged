// Staff identity resolver for the agent surface (node:test). Same helpers as chatbot-agent-routes.test.mjs:
// the route logic runs through createAgentHandlers against the in-memory store, with no Express and no database.
import test from "node:test";
import assert from "node:assert/strict";
import { createAgentHandlers } from "../../server/modules/chatbot/agent-routes/agent-handlers.ts";
import { createMemoryAgentStore } from "../../server/modules/chatbot/agent-routes/memory-services.ts";
import { resolveAgentStaffIdentity } from "../../server/modules/chatbot/agent-routes/staff-identity.ts";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const STAFF_AGENT = "33333333-3333-4333-8333-333333333333";
const STAFF_OTHER = "44444444-4444-4444-8444-444444444444";

function clock() {
  let tick = 0;
  const base = Date.UTC(2026, 10, 8, 10, 0, 0);
  return () => new Date(base + tick++ * 1000);
}

/** Builds the handlers the way the router does: the resolver reads req.user, passed in by the router adapter. */
function setup() {
  const store = createMemoryAgentStore(clock());
  store.seedConversation({ id: "conv-a1", companyId: COMPANY_A, handler: "ai" });
  store.seedConversation({ id: "conv-b1", companyId: COMPANY_B, handler: "ai" });
  const handlers = createAgentHandlers({
    inbox: store,
    conversations: store,
    authenticate: resolveAgentStaffIdentity,
    delivery: { deliver: async () => {} },
    hasHumanAgents: () => true,
  });
  return { store, handlers };
}

/** An HTTP request as the router adapter builds it. `user` is set only by the upstream auth middleware. */
function httpReq({ id, query, body, user, headers } = {}) {
  return {
    params: id === undefined ? {} : { id },
    query: query ?? {},
    body,
    headers: headers ?? {},
    user,
  };
}

const userOf = (companyId, role = "agent", id = STAFF_AGENT) => ({ id, role, companyId });

// ---------- (a) an authenticated staff user with a company gets past the resolver ----------

test("an authenticated staff user with a company resolves to that company and staff id", () => {
  const identity = resolveAgentStaffIdentity(httpReq({ user: userOf(COMPANY_A, "agent") }));
  assert.deepEqual(identity, { companyId: COMPANY_A, staffId: STAFF_AGENT, role: "agent" });
});

test("an authenticated agent passes the resolver and can read and write in their own company", async () => {
  const { store, handlers } = setup();
  const user = userOf(COMPANY_A, "agent");

  const inbox = await handlers.listInbox(httpReq({ user }));
  assert.equal(inbox.status, 200);
  assert.ok(inbox.body.items.every((item) => item.companyId === undefined || item.companyId === COMPANY_A));

  const takeover = await handlers.takeOver(httpReq({ id: "conv-a1", user }));
  assert.equal(takeover.status, 200);
  assert.equal((await store.getConversation(COMPANY_A, "conv-a1")).conversation.handler, "human");
});

test("an authenticated manager passes the resolver and can read but not write", async () => {
  const { handlers } = setup();
  const user = userOf(COMPANY_A, "manager");
  assert.equal((await handlers.listInbox(httpReq({ user }))).status, 200);
  assert.equal((await handlers.takeOver(httpReq({ id: "conv-a1", user }))).status, 403);
});

// ---------- (b) no identity gets 401 ----------

test("a request with no verified user gets 401 from every agent handler and changes nothing", async () => {
  const { store, handlers } = setup();
  assert.equal(resolveAgentStaffIdentity(httpReq({})), null);

  const results = await Promise.all([
    handlers.listInbox(httpReq()),
    handlers.getConversation(httpReq({ id: "conv-a1" })),
    handlers.postStaffReply(httpReq({ id: "conv-a1", body: { message: "hi" } })),
    handlers.takeOver(httpReq({ id: "conv-a1" })),
    handlers.handBack(httpReq({ id: "conv-a1" })),
    handlers.closeTicket(httpReq({ id: "conv-a1" })),
  ]);
  for (const r of results) assert.equal(r.status, 401);
  assert.equal((await store.getConversation(COMPANY_A, "conv-a1")).conversation.handler, "ai");
});

test("company and role sent in headers, query or body never create an identity", async () => {
  const { store, handlers } = setup();
  const spoofed = httpReq({
    id: "conv-a1",
    headers: { "x-company-id": COMPANY_A, "x-staff-id": STAFF_AGENT, "x-role": "admin" },
    query: { companyId: COMPANY_A, role: "admin" },
    body: { companyId: COMPANY_A, staffId: STAFF_AGENT, role: "admin" },
  });
  assert.equal(resolveAgentStaffIdentity(spoofed), null);
  assert.equal((await handlers.takeOver(spoofed)).status, 401);
  assert.equal((await store.getConversation(COMPANY_A, "conv-a1")).conversation.handler, "ai");
});

test("a verified user without a usable id gets 401", () => {
  assert.equal(resolveAgentStaffIdentity(httpReq({ user: { role: "agent", companyId: COMPANY_A } })), null);
  assert.equal(resolveAgentStaffIdentity(httpReq({ user: { id: "", role: "agent", companyId: COMPANY_A } })), null);
  assert.equal(resolveAgentStaffIdentity(httpReq({ user: "not-an-object" })), null);
});

// ---------- fail closed: no company or a disallowed role gets 403 ----------

test("a user with no company, or a malformed company, gets 403 and changes nothing", async () => {
  for (const companyId of [undefined, null, "", "not-a-uuid", 42]) {
    const { store, handlers } = setup();
    const res = await handlers.takeOver(httpReq({ id: "conv-a1", user: userOf(companyId, "agent") }));
    assert.equal(res.status, 403, `companyId ${String(companyId)}`);
    assert.equal((await store.getConversation(COMPANY_A, "conv-a1")).conversation.handler, "ai");
  }
});

test("a role the agent surface does not allow gets 403", async () => {
  const { handlers } = setup();
  const roles = ["user", "customer", "", undefined];
  for (const role of roles) {
    const user = { id: STAFF_AGENT, companyId: COMPANY_A, ...(role === undefined ? {} : { role }) };
    const res = await handlers.listInbox(httpReq({ user }));
    assert.equal(res.status, 403, `role ${String(role)}`);
  }
});

// ---------- (c) a user from another company cannot act on company A's resource ----------

test("a staff user from company B cannot read, reply to, or change company A's conversation", async () => {
  const { store, handlers } = setup();
  const intruder = httpReq({ id: "conv-a1", user: userOf(COMPANY_B, "admin", STAFF_OTHER) });
  const before = store.allMessages(COMPANY_A, "conv-a1").length;

  assert.equal((await handlers.getConversation(intruder)).status, 404);
  assert.equal((await handlers.postStaffReply({ ...intruder, body: { message: "hi" } })).status, 404);
  assert.equal((await handlers.takeOver(intruder)).status, 404);
  assert.equal((await handlers.handBack(intruder)).status, 404);
  assert.equal((await handlers.closeTicket(intruder)).status, 404);

  assert.equal(store.allMessages(COMPANY_A, "conv-a1").length, before);
  const row = (await store.getConversation(COMPANY_A, "conv-a1")).conversation;
  assert.equal(row.handler, "ai");
  assert.notEqual(row.ticketStatus, "closed");
});

test("a company B user's inbox never lists company A's conversations", async () => {
  const { handlers } = setup();
  const res = await handlers.listInbox(httpReq({ user: userOf(COMPANY_B, "agent", STAFF_OTHER) }));
  assert.equal(res.status, 200);
  assert.ok(!JSON.stringify(res.body).includes("conv-a1"));
});

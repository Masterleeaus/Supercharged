// Staff reply and handoff HTTP layer tests (node:test). No Express, no database, no node_modules.
// The route logic runs through createAgentHandlers against the in-memory store. agent-router.ts is not
// imported here because express is not installed in this checkout.
import test from "node:test";
import assert from "node:assert/strict";
import { createAgentHandlers, READ_ROLES, WRITE_ROLES } from "../../server/modules/chatbot/agent-routes/agent-handlers.ts";
import { createMemoryAgentStore } from "../../server/modules/chatbot/agent-routes/memory-services.ts";
import { customerVisibleMessages } from "../../server/modules/chatbot/agent-routes/customer-view.ts";
import { AGENT_ROUTES_FLAG, isAgentRoutesEnabled } from "../../server/modules/chatbot/agent-routes/flags.ts";
import { NOOP_CUSTOMER_DELIVERY } from "../../server/modules/chatbot/agent-routes/contracts.ts";
import { AGENT_ROUTE_PATHS } from "../../server/modules/chatbot/agent-routes/route-table.ts";

// ---------- fixtures ----------

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const STAFF_AGENT = "staff-agent-1";

function clock() {
  let tick = 0;
  const base = Date.UTC(2026, 10, 8, 10, 0, 0);
  return () => new Date(base + tick++ * 1000);
}

function authAs(identity) {
  return async () => identity;
}

const agentA = { companyId: COMPANY_A, staffId: STAFF_AGENT, role: "agent" };

function recordingDelivery({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async deliver(input) {
      calls.push(input);
      if (fail) throw new Error("transport down");
    },
  };
}

function httpReq({ id, query, body } = {}) {
  return {
    params: id === undefined ? {} : { id },
    query: query ?? {},
    body,
    headers: {},
  };
}

function setup({ auth = authAs(agentA), delivery = recordingDelivery(), onError, hasHumanAgents = () => true } = {}) {
  const store = createMemoryAgentStore(clock());
  store.seedConversation({ id: "conv-a1", companyId: COMPANY_A, handler: "ai" });
  store.seedConversation({ id: "conv-b1", companyId: COMPANY_B, handler: "ai" });
  const handlers = createAgentHandlers({
    inbox: store,
    conversations: store,
    authenticate: auth,
    delivery,
    onError,
    // Plan gate (Drizzle pass). Replies are refused unless this returns exactly true. Tests opt in here.
    hasHumanAgents,
  });
  return { store, handlers, delivery };
}

// ---------- flag ----------

test("the agent routes flag is off unless the env value is exactly true", () => {
  assert.equal(AGENT_ROUTES_FLAG, "DESK_CHATBOT_AGENT_ROUTES");
  assert.equal(isAgentRoutesEnabled({}), false);
  assert.equal(isAgentRoutesEnabled({ DESK_CHATBOT_AGENT_ROUTES: "1" }), false);
  assert.equal(isAgentRoutesEnabled({ DESK_CHATBOT_AGENT_ROUTES: "TRUE" }), false);
  assert.equal(isAgentRoutesEnabled({ DESK_CHATBOT_AGENT_ROUTES: "true" }), true);
});

test("the route table covers the six staff routes", () => {
  assert.deepEqual(
    AGENT_ROUTE_PATHS.map((r) => `${r.method} ${r.path}`),
    [
      "GET /inbox",
      "GET /conversations/:id",
      "POST /conversations/:id/messages",
      "POST /conversations/:id/takeover",
      "POST /conversations/:id/handback",
      "POST /conversations/:id/close",
    ],
  );
});

// ---------- authentication and roles ----------

test("unauthenticated requests are rejected with 401 and never reach the service", async () => {
  const { store, handlers, delivery } = setup({ auth: async () => null });
  const before = store.allMessages(COMPANY_A, "conv-a1").length;

  const results = await Promise.all([
    handlers.listInbox(httpReq()),
    handlers.getConversation(httpReq({ id: "conv-a1" })),
    handlers.postStaffReply(httpReq({ id: "conv-a1", body: { message: "hi" } })),
    handlers.takeOver(httpReq({ id: "conv-a1" })),
    handlers.handBack(httpReq({ id: "conv-a1" })),
    handlers.closeTicket(httpReq({ id: "conv-a1" })),
  ]);

  for (const r of results) assert.equal(r.status, 401);
  assert.equal(store.allMessages(COMPANY_A, "conv-a1").length, before);
  assert.equal(delivery.calls.length, 0);
  assert.equal((await store.getConversation(COMPANY_A, "conv-a1")).conversation.handler, "ai");
});

test("an authenticate function that throws is treated as unauthenticated", async () => {
  const { handlers } = setup({
    auth: async () => {
      throw new Error("session store unavailable");
    },
  });
  const res = await handlers.listInbox(httpReq());
  assert.equal(res.status, 401);
});

test("an identity without a valid staff id is rejected with 401", async () => {
  const { handlers } = setup({ auth: authAs({ companyId: COMPANY_A, staffId: "", role: "agent" }) });
  const res = await handlers.listInbox(httpReq());
  assert.equal(res.status, 401);
});

test("an identity with a missing or malformed company id is rejected with 403", async () => {
  for (const companyId of [undefined, "", "not-a-uuid", "1; DROP TABLE"]) {
    const { store, handlers } = setup({ auth: authAs({ companyId, staffId: STAFF_AGENT, role: "agent" }) });
    const res = await handlers.takeOver(httpReq({ id: "conv-a1" }));
    assert.equal(res.status, 403, `companyId ${String(companyId)}`);
    assert.equal((await store.getConversation(COMPANY_A, "conv-a1")).conversation.handler, "ai");
  }
});

test("managers can read but not write, agents can read and write", async () => {
  assert.deepEqual([...READ_ROLES].sort(), ["admin", "agent", "manager"]);
  assert.deepEqual([...WRITE_ROLES].sort(), ["admin", "agent"]);

  const manager = setup({ auth: authAs({ companyId: COMPANY_A, staffId: "mgr-1", role: "manager" }) });
  assert.equal((await manager.handlers.listInbox(httpReq())).status, 200);
  assert.equal((await manager.handlers.getConversation(httpReq({ id: "conv-a1" }))).status, 200);
  assert.equal((await manager.handlers.takeOver(httpReq({ id: "conv-a1" }))).status, 403);
  assert.equal((await manager.handlers.postStaffReply(httpReq({ id: "conv-a1", body: { message: "x" } }))).status, 403);

  const agent = setup();
  assert.equal((await agent.handlers.takeOver(httpReq({ id: "conv-a1" }))).status, 200);
});

// ---------- company isolation ----------

test("the inbox lists only the authenticated company's conversations", async () => {
  const { handlers } = setup();
  const res = await handlers.listInbox(httpReq());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items.map((c) => c.id), ["conv-a1"]);
  assert.equal(res.body.total, 1);
});

test("a conversation in another company reads as not found and leaks nothing", async () => {
  const { handlers } = setup();
  const res = await handlers.getConversation(httpReq({ id: "conv-b1" }));
  assert.equal(res.status, 404);
  assert.equal(JSON.stringify(res.body).includes("conv-b1"), false);
});

test("writes to another company's conversation fail and leave its state unchanged", async () => {
  const { store, handlers, delivery } = setup();

  assert.equal((await handlers.takeOver(httpReq({ id: "conv-b1" }))).status, 404);
  assert.equal((await handlers.closeTicket(httpReq({ id: "conv-b1" }))).status, 404);
  const reply = await handlers.postStaffReply(httpReq({ id: "conv-b1", body: { message: "hello" } }));
  assert.equal(reply.status, 404);

  const b = await store.getConversation(COMPANY_B, "conv-b1");
  assert.equal(b.conversation.handler, "ai");
  assert.equal(b.conversation.ticketStatus, "new");
  assert.equal(b.messages.length, 0);
  assert.equal(delivery.calls.length, 0);
});

// ---------- internal notes ----------

test("an internal note is stored, is never delivered, and is excluded from customer output", async () => {
  const { store, handlers, delivery } = setup();
  store.seedMessage(COMPANY_A, { conversationId: "conv-a1", role: "user", message: "Is Saturday open?" });

  const res = await handlers.postStaffReply(
    httpReq({ id: "conv-a1", body: { message: "Customer is a VIP, offer the discount", isInternalNote: true } }),
  );
  assert.equal(res.status, 201);
  assert.equal(res.body.deliveredToCustomer, false);
  assert.equal(res.body.message.isInternalNote, true);
  assert.equal(delivery.calls.length, 0, "internal note must not reach the customer channel");

  const staffView = await handlers.getConversation(httpReq({ id: "conv-a1" }));
  const note = staffView.body.messages.find((m) => m.isInternalNote);
  assert.ok(note, "staff view keeps the note, flagged");
  assert.equal(note.message, "Customer is a VIP, offer the discount");

  const customer = customerVisibleMessages(staffView.body.messages);
  assert.deepEqual(customer.map((m) => m.message), ["Is Saturday open?"]);
  assert.equal(JSON.stringify(customer).includes("VIP"), false);
});

test("a customer-visible staff reply is delivered once and persisted as a normal message", async () => {
  const { store, handlers, delivery } = setup();

  const res = await handlers.postStaffReply(
    httpReq({ id: "conv-a1", body: { message: "  We are open until 5pm.  " } }),
  );
  assert.equal(res.status, 201);
  assert.equal(res.body.deliveredToCustomer, true);
  assert.equal(res.body.deliveryFailed, false);
  assert.equal(res.body.message.message, "We are open until 5pm.");
  assert.equal(res.body.message.isInternalNote, false);
  assert.equal(res.body.message.staffId, STAFF_AGENT, "sender comes from the authenticated identity");

  assert.equal(delivery.calls.length, 1);
  assert.equal(delivery.calls[0].companyId, COMPANY_A);
  assert.equal(delivery.calls[0].conversationId, "conv-a1");
  assert.equal(store.allMessages(COMPANY_A, "conv-a1").length, 1);
});

test("a failed delivery keeps the saved message and reports deliveryFailed", async () => {
  const errors = [];
  const { store, handlers } = setup({
    delivery: recordingDelivery({ fail: true }),
    onError: (err) => errors.push(err),
  });

  const res = await handlers.postStaffReply(httpReq({ id: "conv-a1", body: { message: "Hello" } }));
  assert.equal(res.status, 201);
  assert.equal(res.body.deliveredToCustomer, false);
  assert.equal(res.body.deliveryFailed, true);
  assert.equal(store.allMessages(COMPANY_A, "conv-a1").length, 1);
  assert.equal(errors.length, 1);
});

// ---------- reply validation ----------

test("reply bodies with tenancy fields, bad types or bad lengths are rejected with 400", async () => {
  const { store, handlers, delivery } = setup();
  const bad = [
    { message: "hi", companyId: COMPANY_B },
    { message: "hi", staffId: "someone-else" },
    { message: "hi", isInternalNote: "yes" },
    { message: "   " },
    { message: 42 },
    { isInternalNote: true },
    { message: "x".repeat(10001) },
    "not an object",
    [],
  ];
  for (const body of bad) {
    const res = await handlers.postStaffReply(httpReq({ id: "conv-a1", body }));
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal(store.allMessages(COMPANY_A, "conv-a1").length, 0);
  assert.equal(delivery.calls.length, 0);
});

test("a malformed route id is rejected with 400 before any service call", async () => {
  const { handlers } = setup();
  assert.equal((await handlers.getConversation(httpReq({ id: "bad id!" }))).status, 400);
  assert.equal((await handlers.takeOver(httpReq({ id: "x".repeat(65) }))).status, 400);
  assert.equal((await handlers.postStaffReply(httpReq({ id: undefined, body: { message: "x" } }))).status, 400);
});

// ---------- inbox validation ----------

test("inbox queries reject unknown keys, including companyId, and out-of-range values", async () => {
  const { handlers } = setup();
  const bad = [
    { companyId: COMPANY_B },
    { status: "archived" },
    { handler: "bot" },
    { per_page: "500" },
    { page: "0" },
    { page: "1.5" },
  ];
  for (const query of bad) {
    const res = await handlers.listInbox(httpReq({ query }));
    assert.equal(res.status, 400, JSON.stringify(query));
  }
});

test("inbox filters by handler and status within the company", async () => {
  const { store, handlers } = setup();
  store.seedConversation({ id: "conv-a2", companyId: COMPANY_A, handler: "human", ticketStatus: "closed" });
  store.seedConversation({ id: "conv-a3", companyId: COMPANY_A, handler: "human", ticketStatus: "new" });

  const human = await handlers.listInbox(httpReq({ query: { handler: "human" } }));
  assert.deepEqual(human.body.items.map((c) => c.id).sort(), ["conv-a2", "conv-a3"]);

  const closed = await handlers.listInbox(httpReq({ query: { status: "closed" } }));
  assert.deepEqual(closed.body.items.map((c) => c.id), ["conv-a2"]);
});

// ---------- takeover, handback, close ----------

test("takeover then handback change handler state and record the handling staff member", async () => {
  const { store, handlers } = setup();

  const taken = await handlers.takeOver(httpReq({ id: "conv-a1" }));
  assert.equal(taken.status, 200);
  assert.equal(taken.body.conversation.handler, "human");
  assert.equal(taken.body.conversation.handlerStaffId, STAFF_AGENT);

  const returned = await handlers.handBack(httpReq({ id: "conv-a1" }));
  assert.equal(returned.status, 200);
  assert.equal(returned.body.conversation.handler, "ai");
  assert.equal(returned.body.conversation.handlerStaffId, null);

  const stored = await store.getConversation(COMPANY_A, "conv-a1");
  assert.equal(stored.conversation.handler, "ai");
});

test("takeover and handback reject a request body", async () => {
  const { handlers } = setup();
  assert.equal((await handlers.takeOver(httpReq({ id: "conv-a1", body: { handler: "ai" } }))).status, 400);
  assert.equal((await handlers.handBack(httpReq({ id: "conv-a1", body: { companyId: COMPANY_B } }))).status, 400);
});

test("closing a ticket sets it to closed and stays inside the company", async () => {
  const { store, handlers } = setup();

  const closed = await handlers.closeTicket(httpReq({ id: "conv-a1" }));
  assert.equal(closed.status, 200);
  assert.equal(closed.body.conversation.ticketStatus, "closed");
  assert.equal((await store.getConversation(COMPANY_A, "conv-a1")).conversation.ticketStatus, "closed");

  assert.equal((await handlers.closeTicket(httpReq({ id: "conv-b1" }))).status, 404);
  assert.equal((await store.getConversation(COMPANY_B, "conv-b1")).conversation.ticketStatus, "new");
});

// ---------- error handling and customer projection ----------

test("an unexpected service failure returns a generic 500 and does not leak the detail", async () => {
  const errors = [];
  const store = createMemoryAgentStore(clock());
  store.seedConversation({ id: "conv-a1", companyId: COMPANY_A });
  const broken = {
    ...store,
    async setHandler() {
      throw new Error("connection string postgres://secret");
    },
  };
  const handlers = createAgentHandlers({
    inbox: store,
    conversations: broken,
    authenticate: authAs(agentA),
    delivery: NOOP_CUSTOMER_DELIVERY,
    onError: (err) => errors.push(err),
  });

  const res = await handlers.takeOver(httpReq({ id: "conv-a1" }));
  assert.equal(res.status, 500);
  assert.equal(JSON.stringify(res.body).includes("secret"), false);
  assert.equal(errors.length, 1);
});

test("customerVisibleMessages drops internal notes and keeps customer and AI messages in order", async () => {
  const store = createMemoryAgentStore(clock());
  store.seedConversation({ id: "conv-a1", companyId: COMPANY_A });
  store.seedMessage(COMPANY_A, { conversationId: "conv-a1", role: "user", message: "Hi" });
  store.seedMessage(COMPANY_A, { conversationId: "conv-a1", role: "assistant", message: "Hello, how can I help?" });
  store.seedMessage(COMPANY_A, {
    conversationId: "conv-a1",
    role: "assistant",
    message: "internal: refund approved in principle",
    isInternalNote: true,
    staffId: STAFF_AGENT,
  });
  store.seedMessage(COMPANY_A, { conversationId: "conv-a1", role: "assistant", message: "Refund is on its way", staffId: STAFF_AGENT });

  const { messages } = await store.getConversation(COMPANY_A, "conv-a1");
  assert.equal(messages.length, 4);
  assert.deepEqual(
    customerVisibleMessages(messages).map((m) => m.message),
    ["Hi", "Hello, how can I help?", "Refund is on its way"],
  );
});

// ---------- plan gate (integration fix 4) ----------

test("plan gate: a reply is refused with 403 when the plan has no human agents, and nothing is stored or delivered", async () => {
  // null, not undefined: undefined would take setup()'s default (allow). null reaches the handler as a non-function.
  for (const hasHumanAgents of [null, () => false, () => "true", () => { throw new Error("db down"); }]) {
    const errors = [];
    const { store, handlers, delivery } = setup({ hasHumanAgents, onError: (err) => errors.push(err) });
    const res = await handlers.postStaffReply(httpReq({ id: "conv-a1", body: { message: "hello" } }));
    assert.equal(res.status, 403);
    assert.equal(store.allMessages(COMPANY_A, "conv-a1").length, 0, "a refused reply must not be saved");
    assert.equal(delivery.calls.length, 0, "a refused reply must not be delivered");
  }
});

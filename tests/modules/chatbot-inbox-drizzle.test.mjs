// Drizzle inbox and staff reply tests (node:test). No database is reached: every Drizzle query is built by an
// exported builder and rendered to SQL with PgDialect, and the pool is never connected.
// Covers: company filtering in the generated SQL, the plan gate for staff replies, internal notes staying out of
// customer reads, and the inbox-to-agent adapter.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import pg from "pg";
import * as inboxDrizzle from "../../server/modules/chatbot/inbox/drizzle-storage.ts";
import * as agentDrizzle from "../../server/modules/chatbot/agent-routes/drizzle-services.ts";
import { createAgentHandlers } from "../../server/modules/chatbot/agent-routes/agent-handlers.ts";
import { createMemoryAgentStore } from "../../server/modules/chatbot/agent-routes/memory-services.ts";
import { NOOP_CUSTOMER_DELIVERY } from "../../server/modules/chatbot/agent-routes/contracts.ts";
import { createInboxService, InMemoryInboxStorage } from "../../server/modules/chatbot/inbox/index.ts";
import { ChatbotError } from "../../server/modules/chatbot/chatbot-scope.ts";

// ---------- fixtures ----------

const COMPANY_A = "6f1c2a3e-9b7d-4c5a-8e21-0a1b2c3d4e51";
const COMPANY_B = "b2d4f6a8-1c3e-4f50-9a7b-6c5d4e3f2a12";
const START = Date.UTC(2026, 10, 8, 10, 0, 0);

// Never connected: the pool only exists so drizzle can build queries against a real dialect.
const pool = new pg.Pool({ connectionString: "postgres://unused:unused@127.0.0.1:1/unused" });
const db = drizzle(pool);
after(() => pool.end());

const dialect = new PgDialect();
const render = (query) => dialect.sqlToQuery(query.getSQL());

const FILTER = { q: null, handler: "all", assignedTo: null, priority: null, status: null, unread: false, offset: 0, limit: 30 };

/** Every statement must carry a company_id predicate (or insert it) and bind the company id it was given. */
function assertScoped(query, companyId, label) {
  const { sql, params } = render(query);
  assert.ok(sql.includes('"company_id"'), `${label}: references company_id`);
  assert.ok(params.includes(companyId), `${label}: binds the company id`);
  if (!/^\s*insert/i.test(sql)) {
    assert.match(sql, /"company_id" = \$\d+/, `${label}: has a company_id equality predicate`);
  }
  return { sql, params };
}

// ---------- read builders ----------

test("every read builder filters on company_id and binds the company it was given", () => {
  const cases = [
    ["list conversations", inboxDrizzle.buildListConversationRows(db, COMPANY_A, FILTER)],
    ["count conversations", inboxDrizzle.buildCountConversations(db, COMPANY_A, FILTER)],
    ["count unread conversations", inboxDrizzle.buildCountUnreadConversations(db, COMPANY_A, "all")],
    ["get conversation", inboxDrizzle.buildSelectConversation(db, COMPANY_A, "conv-1")],
    ["latest message cursor", inboxDrizzle.buildLatestMessageCursor(db, COMPANY_A, "conv-1")],
    ["find message cursor", inboxDrizzle.buildFindMessageCursor(db, COMPANY_A, "conv-1", "msg-1")],
    ["count messages after cursor", inboxDrizzle.buildCountMessagesAfter(db, COMPANY_A, "conv-1", { createdAt: new Date(START), id: "msg-1" })],
    ["count all messages", inboxDrizzle.buildCountMessagesAfter(db, COMPANY_A, "conv-1", null)],
    ["find participant by key", inboxDrizzle.buildFindParticipantByKey(db, COMPANY_A, "conv-1", "agent", "staff-1")],
    ["get participant", inboxDrizzle.buildGetParticipant(db, COMPANY_A, "conv-1", "part-1")],
    ["list participants", inboxDrizzle.buildListParticipants(db, COMPANY_A, "conv-1")],
    ["get presence", inboxDrizzle.buildGetPresence(db, COMPANY_A, "conv-1", "key-1")],
    ["list presence since", inboxDrizzle.buildListPresenceSince(db, COMPANY_A, "conv-1", new Date(START))],
    ["staff messages", agentDrizzle.buildSelectMessages(db, COMPANY_A, "conv-1", false)],
    ["customer messages", agentDrizzle.buildSelectMessages(db, COMPANY_A, "conv-1", true)],
    ["handler staff ids", agentDrizzle.buildHandlerStaffIds(db, COMPANY_A, ["conv-1", "conv-2"])],
  ];
  for (const [label, query] of cases) {
    const { sql } = assertScoped(query, COMPANY_A, label);
    assert.ok(!/^\s*insert/i.test(sql), `${label}: is a read`);
  }
});

test("list and count reuse the same company predicate, and the unread subquery is correlated to it", () => {
  const list = render(inboxDrizzle.buildListConversationRows(db, COMPANY_A, { ...FILTER, unread: true }));
  const count = render(inboxDrizzle.buildCountConversations(db, COMPANY_A, { ...FILTER, unread: true }));
  for (const { sql } of [list, count]) {
    assert.match(sql, /exists \(select 1 from "chatbot_messages" where \("chatbot_messages"\."company_id" = "chatbot_conversations"\."company_id"/);
  }
  assert.equal(list.params[0], COMPANY_A);
  assert.equal(count.params[0], COMPANY_A);
});

test("the company id of one request never appears in a statement built for another company", () => {
  const { params: paramsB } = assertScoped(inboxDrizzle.buildListConversationRows(db, COMPANY_B, FILTER), COMPANY_B, "list for B");
  assert.ok(!paramsB.includes(COMPANY_A), "company A id is not bound in a statement for company B");
  const { params: paramsA } = assertScoped(agentDrizzle.buildSelectMessages(db, COMPANY_A, "conv-1", true), COMPANY_A, "messages for A");
  assert.ok(!paramsA.includes(COMPANY_B), "company B id is not bound in a statement for company A");
});

test("the handler filter maps to the connect_agent_at null check, in the same statement as company_id", () => {
  const ai = render(inboxDrizzle.buildListConversationRows(db, COMPANY_A, { ...FILTER, handler: "ai" }));
  const human = render(inboxDrizzle.buildListConversationRows(db, COMPANY_A, { ...FILTER, handler: "human" }));
  assert.match(ai.sql, /"connect_agent_at" is null/);
  assert.match(human.sql, /"connect_agent_at" is not null/);
});

test("the q filter matches message text with strpos, so LIKE wildcards are literal", () => {
  const { sql, params } = render(inboxDrizzle.buildListConversationRows(db, COMPANY_A, { ...FILTER, q: "50%_off" }));
  assert.match(sql, /strpos\(lower\("chatbot_messages"\."message"\), \$\d+\) > 0/);
  assert.ok(params.includes("50%_off"), "the search text is bound as a parameter, not spliced into the SQL");
});

// ---------- write builders ----------

test("every write builder writes or matches on company_id", () => {
  const participant = {
    companyId: COMPANY_A,
    id: "part-1",
    conversationId: "conv-1",
    type: "agent",
    reference: null,
    displayName: "Ana",
    metadata: {},
    lastSeenAt: new Date(START),
    lastReadMessageId: null,
    lastReadMessageCreatedAt: null,
    lastReadAt: null,
  };
  const presence = {
    companyId: COMPANY_A,
    conversationId: "conv-1",
    participantKey: "key-1",
    state: "online",
    lastSeenAt: new Date(START),
    metadata: {},
  };
  const cases = [
    ["handoff to human", inboxDrizzle.buildSetHandler(db, COMPANY_A, "conv-1", "human", new Date(START))],
    ["handback to ai", inboxDrizzle.buildSetHandler(db, COMPANY_A, "conv-1", "ai", new Date(START))],
    ["set ticket status", inboxDrizzle.buildSetTicketStatus(db, COMPANY_A, "conv-1", "closed")],
    ["upsert conversation state", inboxDrizzle.buildUpsertConversationState(db, COMPANY_A, "conv-1", { priority: "urgent" })],
    ["upsert participant", inboxDrizzle.buildUpsertParticipant(db, COMPANY_A, participant)],
    ["delete participant", inboxDrizzle.buildDeleteParticipant(db, COMPANY_A, "conv-1", "part-1")],
    ["upsert presence", inboxDrizzle.buildUpsertPresence(db, COMPANY_A, presence)],
  ];
  for (const [label, query] of cases) assertScoped(query, COMPANY_A, label);
});

test("the handoff update is a conditional write, so only the matching state changes", () => {
  const takeover = render(inboxDrizzle.buildSetHandler(db, COMPANY_A, "conv-1", "human", new Date(START)));
  const handback = render(inboxDrizzle.buildSetHandler(db, COMPANY_A, "conv-1", "ai", new Date(START)));
  assert.match(takeover.sql, /"connect_agent_at" is null/);
  assert.match(handback.sql, /"connect_agent_at" is not null/);
});

test("participant upserts cannot overwrite a row that belongs to another company", () => {
  const { sql } = render(
    inboxDrizzle.buildUpsertParticipant(db, COMPANY_A, {
      companyId: COMPANY_A,
      id: "part-1",
      conversationId: "conv-1",
      type: "agent",
      reference: null,
      displayName: null,
      metadata: {},
      lastSeenAt: new Date(START),
      lastReadMessageId: null,
      lastReadMessageCreatedAt: null,
      lastReadAt: null,
    }),
  );
  assert.match(sql, /on conflict \("id"\) do update .* where "chatbot_inbox_participants"\."company_id" = \$\d+/);
});

test("a reference-less participant is matched with coalesce, as the unique index is", () => {
  const { sql, params } = render(inboxDrizzle.buildFindParticipantByKey(db, COMPANY_A, "conv-1", "agent", null));
  assert.match(sql, /coalesce\("chatbot_inbox_participants"\."reference", ''\) = \$\d+/);
  assert.ok(params.includes(""), "a null reference is compared as the empty string");
});

// ---------- company guard on the storage methods ----------

test("storage methods refuse a missing company before any query is built", async () => {
  const storage = inboxDrizzle.createDrizzleInboxStorage(db);
  await assert.rejects(storage.listConversations(undefined, FILTER), (err) => err instanceof ChatbotError && err.status === 403);
  await assert.rejects(storage.getConversation("", "conv-1"), (err) => err instanceof ChatbotError && err.status === 403);
  const agent = agentDrizzle.createDrizzleAgentStore(db);
  await assert.rejects(agent.getConversation("not-a-uuid", "conv-1"), (err) => err instanceof ChatbotError && err.status === 403);
  await assert.rejects(agent.readCustomerView(undefined, "conv-1"), (err) => err instanceof ChatbotError && err.status === 403);
});

test("the Drizzle inbox storage implements every method of the storage port", () => {
  const storage = inboxDrizzle.createDrizzleInboxStorage(db);
  const methods = [
    "getConversation", "transitionHandler", "listConversations", "saveConversationState",
    "countConversationsWithUnreadInbound", "latestMessageCursor", "findMessageCursor", "countMessagesAfter",
    "findParticipantByKey", "getParticipant", "saveParticipant", "listParticipants", "deleteParticipant",
    "getPresence", "savePresence", "listPresenceSince",
  ];
  for (const name of methods) assert.equal(typeof storage[name], "function", `${name} is a function`);
});

// ---------- plan gate ----------

const AGENT = { companyId: COMPANY_A, staffId: "staff-agent-1", role: "agent" };

function staffHandlers(hasHumanAgents) {
  const store = createMemoryAgentStore(() => new Date(START));
  store.seedConversation({ id: "conv-1", companyId: COMPANY_A });
  const delivered = [];
  const errors = [];
  const handlers = createAgentHandlers({
    inbox: store,
    conversations: store,
    authenticate: async () => AGENT,
    delivery: { async deliver(input) { delivered.push(input); } },
    hasHumanAgents,
    onError: (err) => errors.push(err),
  });
  const reply = (body) => handlers.postStaffReply({ params: { id: "conv-1" }, query: {}, body, headers: {} });
  return { store, reply, delivered, errors };
}

test("plan gate: a staff reply is refused with 403 when hasHumanAgents is not supplied, and nothing is stored", async () => {
  const { store, reply, delivered } = staffHandlers(undefined);
  const res = await reply({ message: "Hello" });
  assert.equal(res.status, 403);
  assert.equal(store.allMessages(COMPANY_A, "conv-1").length, 0);
  assert.equal(delivered.length, 0);
});

test("plan gate: internal notes are refused too when hasHumanAgents is not supplied", async () => {
  const { store, reply } = staffHandlers(undefined);
  const res = await reply({ message: "Check the refund", isInternalNote: true });
  assert.equal(res.status, 403);
  assert.equal(store.allMessages(COMPANY_A, "conv-1").length, 0);
});

test("plan gate: a plan with no human agents refuses the reply", async () => {
  const { store, reply, delivered } = staffHandlers(() => false);
  const res = await reply({ message: "Hello" });
  assert.equal(res.status, 403);
  assert.equal(store.allMessages(COMPANY_A, "conv-1").length, 0);
  assert.equal(delivered.length, 0);
});

test("plan gate: only the boolean true allows the reply, so a truthy value does not", async () => {
  for (const truthy of ["yes", 1, {}, "true"]) {
    const { store, reply } = staffHandlers(() => truthy);
    const res = await reply({ message: "Hello" });
    assert.equal(res.status, 403, `value ${JSON.stringify(truthy)} is refused`);
    assert.equal(store.allMessages(COMPANY_A, "conv-1").length, 0);
  }
});

test("plan gate: a check that throws refuses the reply and reports the error", async () => {
  const { store, reply, errors } = staffHandlers(() => {
    throw new Error("plan service down");
  });
  const res = await reply({ message: "Hello" });
  assert.equal(res.status, 403);
  assert.equal(store.allMessages(COMPANY_A, "conv-1").length, 0);
  assert.equal(errors.length, 1);
});

test("plan gate: the check receives the authenticated company, not a value from the request", async () => {
  const seen = [];
  const { reply } = staffHandlers((companyId) => {
    seen.push(companyId);
    return true;
  });
  const injected = await reply({ message: "Hello", companyId: COMPANY_B });
  assert.equal(injected.status, 400, "a companyId in the body is rejected by the strict body schema");
  assert.deepEqual(seen, [COMPANY_A], "the gate is asked about the caller's company only");
  const ok = await reply({ message: "Hello" });
  assert.equal(ok.status, 201);
  assert.deepEqual(seen, [COMPANY_A, COMPANY_A]);
});

test("plan gate: a plan with human agents lets the reply through", async () => {
  const { store, reply, delivered } = staffHandlers(async () => true);
  const res = await reply({ message: "Hello" });
  assert.equal(res.status, 201);
  assert.equal(store.allMessages(COMPANY_A, "conv-1").length, 1);
  assert.equal(delivered.length, 1);
});

// ---------- internal notes and customer reads ----------

function messageRow(overrides) {
  return {
    msg: {
      id: "msg-1",
      companyId: COMPANY_A,
      conversationId: "conv-1",
      role: "assistant",
      message: "Hello",
      contentType: "text",
      uiSpec: null,
      mediaUrl: null,
      mediaName: null,
      isInternalNote: false,
      readAt: null,
      createdAt: new Date(START),
      ...overrides.msg,
    },
    staffId: overrides.staffId ?? null,
  };
}

test("internal notes stay out of the Drizzle customer read: the SQL excludes them", () => {
  const { sql, params } = render(agentDrizzle.buildSelectMessages(db, COMPANY_A, "conv-1", true));
  assert.match(sql, /"chatbot_messages"\."is_internal_note" = \$\d+/);
  assert.ok(params.includes(false), "the internal-note predicate binds false");
});

test("the staff read does not filter notes out, so staff still see them", () => {
  const { sql } = render(agentDrizzle.buildSelectMessages(db, COMPANY_A, "conv-1", false));
  assert.ok(!/"is_internal_note" = \$/.test(sql), "no internal-note predicate on the staff read");
});

test("the Drizzle customer read path drops a note even when the query returns one", () => {
  const rows = [
    messageRow({ msg: { id: "msg-1", message: "Your order ships Monday" } }),
    messageRow({ msg: { id: "msg-2", message: "Refund approved, check with finance", isInternalNote: true }, staffId: "staff-agent-1" }),
    messageRow({ msg: { id: "msg-3", role: "user", message: "Thanks" } }),
  ];
  const view = agentDrizzle.mapCustomerRows(rows);
  assert.deepEqual(view.map((m) => m.id), ["msg-1", "msg-3"]);
  assert.ok(view.every((m) => !("isInternalNote" in m) && !("staffId" in m)), "the customer view carries no staff fields");
  assert.ok(!JSON.stringify(view).includes("finance"), "the note text does not appear anywhere in the customer view");
});

test("the staff view keeps internal notes and flags them", () => {
  const note = agentDrizzle.toAgentMessage(messageRow({ msg: { id: "msg-2", isInternalNote: true }, staffId: "staff-agent-1" }));
  assert.equal(note.isInternalNote, true);
  assert.equal(note.staffId, "staff-agent-1");
});

// ---------- adapter: inbox service -> agent router ----------

/**
 * Minimal store for the adapter tests. Message storage is not needed here, so it only tracks handler staff.
 * knownIds are the conversations the header read finds.
 */
function fakeStore(knownIds = []) {
  const handlerStaff = new Map();
  const known = new Set(knownIds);
  return {
    handlerStaff,
    async getConversation() {
      return null;
    },
    async getConversationHeader(companyId, id) {
      if (!known.has(id)) return null;
      return {
        id,
        companyId,
        chatbotId: "bot-1",
        channel: "web",
        handler: "ai",
        ticketStatus: "new",
        handlerStaffId: handlerStaff.get(`${companyId}:${id}`) ?? null,
        updatedAt: new Date(START),
      };
    },
    async readCustomerView() {
      return [];
    },
    async appendStaffMessage() {
      return null;
    },
    async setHandlerStaff(companyId, id, staffId) {
      handlerStaff.set(`${companyId}:${id}`, staffId);
    },
    async handlerStaffIds(companyId, ids) {
      return new Map(ids.map((id) => [id, handlerStaff.get(`${companyId}:${id}`) ?? null]));
    },
  };
}

function inboxWith(conversations) {
  const storage = new InMemoryInboxStorage();
  for (const c of conversations) storage.seedConversation(COMPANY_A, c);
  const inbox = createInboxService({ storage, enabled: true, now: () => new Date(START) });
  return { storage, inbox };
}

test("adapter: a takeover goes through the inbox service and records the staff member", async () => {
  const { inbox } = inboxWith([{ id: "conv-1", lastActivityAt: new Date(START) }]);
  const store = fakeStore(["conv-1"]);
  const services = agentDrizzle.createInboxAgentServices({ inbox, store });

  const result = await services.conversations.setHandler(COMPANY_A, "conv-1", "human", "staff-1");
  assert.equal(result?.id, "conv-1");
  assert.equal(result.handlerStaffId, "staff-1");
  assert.equal((await inbox.handlingState(COMPANY_A, "conv-1")).handler, "human");
});

test("adapter: a conversation outside the company resolves to null and nothing changes", async () => {
  const { inbox } = inboxWith([{ id: "conv-1", lastActivityAt: new Date(START) }]);
  const store = fakeStore();
  const services = agentDrizzle.createInboxAgentServices({ inbox, store });

  assert.equal(await services.conversations.setHandler(COMPANY_B, "conv-1", "human", "staff-1"), null);
  assert.equal(await services.conversations.setTicketStatus(COMPANY_B, "conv-1", "closed", "staff-1"), null);
  assert.equal((await inbox.handlingState(COMPANY_A, "conv-1")).handler, "ai");
  assert.equal(store.handlerStaff.size, 0);
});

test("adapter: closing a ticket goes through the inbox service", async () => {
  const { storage, inbox } = inboxWith([{ id: "conv-1", lastActivityAt: new Date(START) }]);
  const services = agentDrizzle.createInboxAgentServices({ inbox, store: fakeStore() });
  await services.conversations.setTicketStatus(COMPANY_A, "conv-1", "closed", "staff-1");
  assert.equal((await storage.getConversation(COMPANY_A, "conv-1")).ticketStatus, "closed");
});

test("adapter: the inbox list maps handler, the handler staff member and the page", async () => {
  const { inbox } = inboxWith([
    { id: "conv-1", lastActivityAt: new Date(START + 2000) },
    { id: "conv-2", lastActivityAt: new Date(START + 1000), connectAgentAt: new Date(START) },
  ]);
  const store = fakeStore();
  store.handlerStaff.set(`${COMPANY_A}:conv-2`, "staff-9");
  const services = agentDrizzle.createInboxAgentServices({ inbox, store });

  const page = await services.inbox.listInbox(COMPANY_A, { handler: "human", page: 1, perPage: 10 });
  assert.equal(page.total, 1);
  assert.deepEqual(page.items.map((c) => [c.id, c.handler, c.handlerStaffId]), [["conv-2", "human", "staff-9"]]);
});

test("adapter: a missing company is refused before the inbox is read", async () => {
  const { inbox } = inboxWith([{ id: "conv-1", lastActivityAt: new Date(START) }]);
  const services = agentDrizzle.createInboxAgentServices({ inbox, store: fakeStore() });
  await assert.rejects(services.inbox.listInbox("", { page: 1, perPage: 10 }), (err) => err instanceof ChatbotError);
});

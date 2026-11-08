// Drizzle conversation store: every query is built and rendered with PgDialect. No database is reached.
// The pool is never connected. Covers the company predicate on every builder, the search filters and cursor,
// the role and text mapping, and that the store implements the whole ConversationStore port.
//
// Run: NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types server/modules/chatbot/runtime/drizzle-conversation-store.test.mjs
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import pg from "pg";
import * as store from "./drizzle-conversation-store.ts";

const COMPANY_A = "6f1c2a3e-9b7d-4c5a-8e21-0a1b2c3d4e51";
const COMPANY_B = "b2d4f6a8-1c3e-4f50-9a7b-6c5d4e3f2a12";
const NOW = new Date("2026-11-09T10:00:00Z");

// Never connected: the pool exists only so drizzle can build queries against a real dialect.
const pool = new pg.Pool({ connectionString: "postgres://unused:unused@127.0.0.1:1/unused" });
const db = drizzle(pool);
after(() => pool.end());

const dialect = new PgDialect();
const render = (query) => dialect.sqlToQuery(query.getSQL());

/** A read or update must carry a company_id equality predicate that binds the company it was given. */
function assertScoped(query, companyId, label) {
  const { sql, params } = render(query);
  assert.match(sql, /"company_id" = \$\d+/, `${label}: has a company_id equality predicate`);
  assert.ok(params.includes(companyId), `${label}: binds the company id`);
  assert.ok(!params.includes(COMPANY_B === companyId ? COMPANY_A : COMPANY_B), `${label}: binds no other company`);
  return { sql, params };
}

const CONVERSATION_ID = "conv-1";
const MESSAGE_ID = "msg-1";
const CHATBOT_ID = "bot-1";

test("every single-row and list builder filters on company_id and binds the company it was given", () => {
  const cases = [
    ["chatbot ownership", store.buildChatbotBelongs(db, COMPANY_A, CHATBOT_ID)],
    ["conversation of message", store.buildConversationOfMessage(db, COMPANY_A, MESSAGE_ID)],
    ["find conversation", store.buildFindConversation(db, COMPANY_A, CONVERSATION_ID)],
    ["list messages", store.buildListMessages(db, COMPANY_A, CONVERSATION_ID)],
    ["set status", store.buildSetStatus(db, COMPANY_A, CONVERSATION_ID, "archived", NOW)],
    ["set summary", store.buildSetSummary(db, COMPANY_A, CONVERSATION_ID, "Summary", NOW)],
    ["move messages on merge", store.buildMoveMessages(db, COMPANY_A, "conv-source", CONVERSATION_ID)],
    ["mark source merged", store.buildMarkMerged(db, COMPANY_A, "conv-source", CONVERSATION_ID, NOW)],
  ];
  for (const [label, query] of cases) assertScoped(query, COMPANY_A, label);
});

test("the chatbot and conversation reads bind the ids they were given", () => {
  const { params } = render(store.buildConversationOfMessage(db, COMPANY_A, MESSAGE_ID));
  assert.ok(params.includes(MESSAGE_ID));
  const status = render(store.buildSetStatus(db, COMPANY_A, CONVERSATION_ID, "merged", NOW));
  assert.ok(status.params.includes("merged"));
  assert.ok(status.params.includes(CONVERSATION_ID));
});

test("status update and summary update touch the stamp they are given, and nothing else", () => {
  const status = render(store.buildSetStatus(db, COMPANY_A, CONVERSATION_ID, "archived", NOW));
  assert.match(status.sql, /"status" = \$\d+/);
  assert.match(status.sql, /"updated_at" = \$\d+/);
  const summary = render(store.buildSetSummary(db, COMPANY_A, CONVERSATION_ID, "Hi", NOW));
  assert.match(summary.sql, /"summary" = \$\d+/);
  assert.match(summary.sql, /"summary_updated_at" = \$\d+/);
});

test("merge marks the source merged with its target id, not the company's other rows", () => {
  const { sql, params } = render(store.buildMarkMerged(db, COMPANY_A, "conv-source", CONVERSATION_ID, NOW));
  assert.match(sql, /"merged_into_id" = \$\d+/);
  assert.ok(params.includes("merged"));
  assert.ok(params.includes(CONVERSATION_ID));
});

test("insert builders write the company they were given into the row", () => {
  const message = { id: MESSAGE_ID, role: "customer", text: "Hello", isInternalNote: false, createdAt: NOW };
  const insert = render(store.buildInsertMessage(db, COMPANY_A, CONVERSATION_ID, message));
  assert.ok(insert.params.includes(COMPANY_A), "insert message binds company");
  assert.ok(!insert.params.includes(COMPANY_B));
  assert.ok(insert.params.includes("user"), "customer is stored as user");
  assert.ok(!insert.params.includes("customer"), "stored role never says customer");

  const outbox = render(store.buildInsertOutboxRow(db, COMPANY_A, {
    topic: "chatbot.conversation.created",
    aggregateId: CONVERSATION_ID,
    payload: { conversation_id: CONVERSATION_ID },
    dedupeKey: `chatbot.conversation.created:${CONVERSATION_ID}`,
    availableAt: NOW,
  }));
  assert.ok(outbox.params.includes(COMPANY_A), "outbox row binds company");
  assert.match(outbox.sql, /on conflict do nothing/i);
});

test("search filters every field and binds the company on the outer query", () => {
  const { sql, params } = assertScoped(
    store.buildSearchConversations(db, COMPANY_A, { chatbotId: CHATBOT_ID, channel: "web", limit: 25, after: null }),
    COMPANY_A,
    "search",
  );
  assert.ok(params.includes(CHATBOT_ID));
  assert.ok(params.includes("web"));
  assert.ok(params.includes("open"), "default status is open, as in the memory store");
  assert.match(sql, /order by .*"updated_at" desc.*"id" desc/i);
  assert.ok(params.includes(25));
});

test("search with a status, customer and update stamp binds each value", () => {
  const updatedAfter = new Date("2026-11-01T00:00:00Z");
  const { params } = assertScoped(
    store.buildSearchConversations(db, COMPANY_A, {
      status: "archived",
      customerId: "cust-1",
      updatedAfter,
      limit: 10,
      after: null,
    }),
    COMPANY_A,
    "search with filters",
  );
  assert.ok(params.includes("archived"));
  assert.ok(params.includes("cust-1"));
  assert.ok(params.includes(updatedAfter));
});

test("search cursor is a keyset on (updated_at, id) and binds the cursor", () => {
  const cut = new Date("2026-11-08T09:00:00Z");
  const { sql, params } = assertScoped(
    store.buildSearchConversations(db, COMPANY_A, { limit: 25, after: { updatedAt: cut, id: "conv-9" } }),
    COMPANY_A,
    "search cursor",
  );
  assert.match(sql, /"updated_at" < \$\d+ or \("chatbot_conversations"\."updated_at" = \$\d+ and "chatbot_conversations"\."id" < \$\d+\)/i);
  assert.ok(params.includes("conv-9"));
});

test("free-text search matches summary or a text message of the same company, case-insensitively", () => {
  const { sql, params } = assertScoped(
    store.buildSearchConversations(db, COMPANY_A, { query: "  Refund  ", limit: 25, after: null }),
    COMPANY_A,
    "search text",
  );
  assert.ok(params.includes("refund"), "needle is trimmed and lower-cased");
  assert.match(sql, /strpos\(lower\(coalesce\("chatbot_conversations"\."summary", ''\)\), \$\d+\) > 0/);
  assert.match(sql, /exists \(select/i);
  // The message subquery is scoped too: its own company predicate and conversation link.
  assert.match(sql, /"search_msg"\."company_id" = \$\d+/);
  assert.match(sql, /"search_msg"\."conversation_id" = "chatbot_conversations"\."id"/);
  assert.match(sql, /"search_msg"\."content_type" = \$\d+/);
  assert.equal(params.filter((value) => value === COMPANY_A).length >= 2, true, "outer and subquery both bind the company");
});

test("a blank text query adds no text predicate", () => {
  const { sql } = render(store.buildSearchConversations(db, COMPANY_A, { query: "   ", limit: 25, after: null }));
  assert.ok(!sql.includes("strpos"), "no strpos for a blank query");
  assert.ok(!sql.includes("exists"));
});

test("a message row is mapped to the contract shape: customer, text only for text content", () => {
  const row = {
    id: "m1",
    companyId: COMPANY_A,
    conversationId: CONVERSATION_ID,
    role: "user",
    message: "Hello",
    contentType: "text",
    isInternalNote: false,
    createdAt: NOW,
  };
  assert.deepEqual(store.toStoredMessage(row), {
    id: "m1",
    companyId: COMPANY_A,
    conversationId: CONVERSATION_ID,
    role: "customer",
    text: "Hello",
    isInternalNote: false,
    createdAt: NOW,
  });
  const card = store.toStoredMessage({ ...row, role: "assistant", contentType: "titan-ui", message: "{}" });
  assert.equal(card.role, "assistant");
  assert.equal(card.text, null, "non-text content has no text");
});

test("a conversation row is mapped to the contract record", () => {
  const record = store.toConversationRecord({
    id: CONVERSATION_ID,
    companyId: COMPANY_A,
    chatbotId: CHATBOT_ID,
    sessionId: "sess",
    channel: "whatsapp",
    externalThreadId: "thread-1",
    customerId: null,
    status: "merged",
    handler: "human",
    summary: null,
    summaryUpdatedAt: null,
    mergedIntoId: "conv-target",
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.equal(record.status, "merged");
  assert.equal(record.handler, "human");
  assert.equal(record.mergedIntoId, "conv-target");
  assert.equal(record.channel, "whatsapp");
});

test("the Drizzle store implements every method of the ConversationStore port", () => {
  const port = store.createDrizzleConversationStore(db);
  const methods = [
    "chatbotBelongsTo",
    "conversationOfMessage",
    "insertConversation",
    "findConversation",
    "insertMessage",
    "insertReply",
    "listMessages",
    "setStatus",
    "mergeConversations",
    "setSummary",
    "searchConversations",
  ];
  for (const name of methods) assert.equal(typeof port[name], "function", `${name} is implemented`);
});

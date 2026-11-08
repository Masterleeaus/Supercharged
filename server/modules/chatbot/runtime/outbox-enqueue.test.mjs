// Reply transaction and channel send enqueue. The stored reply and its send row are written as one unit:
// a failed send row leaves no reply, and a send row is never written for a conversation without a channel send.
// Memory store and memory channel outbox only. The Drizzle transaction is covered by the builder tests.
//
// Run: NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types server/modules/chatbot/runtime/outbox-enqueue.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryConversationStore } from "./conversation-store.ts";
import { createConversationReplyWriter, ReplyWriteError } from "./reply-writer.ts";
import { withStoreEvents } from "./store-events.ts";
import { createChannelOutbox, createMemoryChannelOutboxStore } from "../channels/outbox.ts";
import { passThroughLock } from "../cart/keyed-lock.ts";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const CHATBOT_A = "aaaaaaaa-0000-4000-8000-000000000001";
const BASE = new Date("2026-11-09T10:00:00Z");

let counter = 0;
const nextId = (prefix) => {
  counter += 1;
  return `${prefix}-${counter}`;
};

function conversationRecord(companyId, id, channel = "whatsapp") {
  return {
    id,
    companyId,
    chatbotId: CHATBOT_A,
    channel,
    externalThreadId: "thread-1",
    customerId: null,
    status: "open",
    handler: "ai",
    summary: null,
    summaryUpdatedAt: null,
    mergedIntoId: null,
    createdAt: BASE,
    updatedAt: BASE,
  };
}

function whatsappSend(text) {
  return {
    channel: "whatsapp",
    accountId: "acc-1",
    recipient: "+61400000000",
    contentKind: "text",
    text,
    attachmentUrl: null,
    templateName: null,
    templateParams: null,
    replyToExternalMessageId: null,
    idempotencyKey: "set-by-writer",
  };
}

/** A store with one channel conversation and one web conversation, both in company A. */
async function seeded() {
  const conversations = createMemoryConversationStore();
  await conversations.insertConversation(COMPANY_A, conversationRecord(COMPANY_A, "conv-wa"), {
    topic: "chatbot.conversation.created",
    aggregateId: "conv-wa",
    payload: { conversation_id: "conv-wa" },
    dedupeKey: "chatbot.conversation.created:conv-wa",
    availableAt: BASE,
  });
  await conversations.insertConversation(COMPANY_A, conversationRecord(COMPANY_A, "conv-web", "web"), {
    topic: "chatbot.conversation.created",
    aggregateId: "conv-web",
    payload: { conversation_id: "conv-web" },
    dedupeKey: "chatbot.conversation.created:conv-web",
    availableAt: BASE,
  });
  const channelStore = createMemoryChannelOutboxStore();
  const channelOutbox = createChannelOutbox({ store: channelStore, clock: () => BASE });
  return { conversations, channelStore, channelOutbox };
}

const buildSend = (conversation, text) => (conversation.channel === "web" ? null : whatsappSend(text));

test("a channel reply stores the message and its send row together", async () => {
  const { conversations, channelStore, channelOutbox } = await seeded();
  const writer = createConversationReplyWriter({
    store: conversations,
    channelOutbox,
    buildSend,
    newId: () => nextId("msg"),
    now: () => BASE,
  });

  const result = await writer.recordAssistantReply(COMPANY_A, "conv-wa", "Hello there");

  assert.equal(result.accepted, true);
  const messages = await conversations.listMessages(COMPANY_A, "conv-wa");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, result.message.id);
  assert.equal(messages[0].text, "Hello there");

  const sends = channelStore.rowsFor(COMPANY_A);
  assert.equal(sends.length, 1, "one send row for the one reply");
  assert.equal(sends[0].idempotencyKey, `reply:${result.message.id}`, "send key is derived from the message id");
  assert.equal(sends[0].text, "Hello there", "the send carries the reply text it was built from");
});

test("a failed send row takes the stored reply with it", async () => {
  const { conversations, channelOutbox } = await seeded();
  const failing = {
    ...channelOutbox,
    async enqueue() {
      throw new Error("send row write failed");
    },
  };
  const writer = createConversationReplyWriter({
    store: conversations,
    channelOutbox: failing,
    buildSend,
    newId: () => nextId("msg"),
    now: () => BASE,
  });

  await assert.rejects(() => writer.recordAssistantReply(COMPANY_A, "conv-wa", "Lost reply"), /send row write failed/);
  assert.deepEqual(await conversations.listMessages(COMPANY_A, "conv-wa"), [], "no stored reply without its send");
});

test("a web conversation stores the reply with no send row", async () => {
  const { conversations, channelStore, channelOutbox } = await seeded();
  const writer = createConversationReplyWriter({
    store: conversations,
    channelOutbox,
    buildSend,
    newId: () => nextId("msg"),
    now: () => BASE,
  });

  await writer.recordAssistantReply(COMPANY_A, "conv-web", "Web reply");

  assert.equal((await conversations.listMessages(COMPANY_A, "conv-web")).length, 1);
  assert.equal(channelStore.rowsFor(COMPANY_A).length, 0, "no channel send for web chat");
});

test("a channel reply without a channel outbox is refused and nothing is stored", async () => {
  const { conversations } = await seeded();
  const writer = createConversationReplyWriter({ store: conversations, buildSend, newId: () => nextId("msg"), now: () => BASE });

  await assert.rejects(
    () => writer.recordAssistantReply(COMPANY_A, "conv-wa", "No outbox"),
    (error) => error instanceof ReplyWriteError && error.code === "outbox_missing",
  );
  assert.deepEqual(await conversations.listMessages(COMPANY_A, "conv-wa"), []);
});

test("another company's conversation is treated as absent: nothing stored, nothing sent", async () => {
  const { conversations, channelStore, channelOutbox } = await seeded();
  const writer = createConversationReplyWriter({
    store: conversations,
    channelOutbox,
    buildSend,
    newId: () => nextId("msg"),
    now: () => BASE,
  });

  await assert.rejects(
    () => writer.recordAssistantReply(COMPANY_B, "conv-wa", "Cross tenant"),
    (error) => error instanceof ReplyWriteError && error.code === "conversation_not_found",
  );
  assert.deepEqual(await conversations.listMessages(COMPANY_A, "conv-wa"), []);
  assert.equal(channelStore.rowsFor(COMPANY_B).length, 0);
  assert.equal(channelStore.rowsFor(COMPANY_A).length, 0);
});

test("the memory insertReply returns null for another company and writes nothing", async () => {
  const { conversations } = await seeded();
  let called = false;
  const result = await conversations.insertReply(
    COMPANY_B,
    "conv-wa",
    { id: "m-x", role: "assistant", text: "x", isInternalNote: false, createdAt: BASE },
    async () => {
      called = true;
    },
  );
  assert.equal(result, null);
  assert.equal(called, false, "the send is not enqueued for a foreign conversation");
});

test("passThroughLock is accepted and two replies to one conversation both store", async () => {
  const { conversations, channelStore, channelOutbox } = await seeded();
  const writer = createConversationReplyWriter({
    store: conversations,
    channelOutbox,
    buildSend,
    lock: passThroughLock,
    newId: () => nextId("msg"),
    now: () => BASE,
  });

  const [first, second] = await Promise.all([
    writer.recordAssistantReply(COMPANY_A, "conv-wa", "One"),
    writer.recordAssistantReply(COMPANY_A, "conv-wa", "Two"),
  ]);

  assert.notEqual(first.message.id, second.message.id);
  assert.equal((await conversations.listMessages(COMPANY_A, "conv-wa")).length, 2);
  assert.equal(channelStore.rowsFor(COMPANY_A).length, 2);
});

test("the default keyed lock serialises replies to the same conversation", async () => {
  const { conversations, channelOutbox } = await seeded();
  let inside = 0;
  let maxInside = 0;
  const slowStore = {
    ...conversations,
    findConversation: async (...args) => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inside -= 1;
      return conversations.findConversation(...args);
    },
  };
  const writer = createConversationReplyWriter({
    store: slowStore,
    channelOutbox,
    buildSend,
    newId: () => nextId("msg"),
    now: () => BASE,
  });

  await Promise.all([
    writer.recordAssistantReply(COMPANY_A, "conv-wa", "A"),
    writer.recordAssistantReply(COMPANY_A, "conv-wa", "B"),
  ]);
  assert.equal(maxInside, 1, "only one reply runs inside the lock for one conversation");
});

test("a store event is published only after the change commits, and never for a conflict", async () => {
  const conversations = createMemoryConversationStore();
  const published = [];
  const events = withStoreEvents(conversations, (companyId, event) => {
    published.push({ companyId, topic: event.topic, aggregateId: event.aggregateId });
  });
  const created = {
    topic: "chatbot.conversation.created",
    aggregateId: "conv-1",
    payload: { conversation_id: "conv-1" },
    dedupeKey: "chatbot.conversation.created:conv-1",
    availableAt: BASE,
  };

  await events.insertConversation(COMPANY_A, conversationRecord(COMPANY_A, "conv-1"), created);
  assert.deepEqual(published, [{ companyId: COMPANY_A, topic: "chatbot.conversation.created", aggregateId: "conv-1" }]);

  // A setStatus on a conversation of another company changes nothing, so nothing is published.
  const absent = await events.setStatus(COMPANY_B, "conv-1", "archived", BASE, {
    ...created,
    topic: "chatbot.conversation.archived",
    dedupeKey: "archived:conv-1",
  });
  assert.equal(absent, null);
  assert.equal(published.length, 1);

  // A merge with a missing source is a conflict: nothing changes and nothing is published.
  const conflict = await events.mergeConversations(COMPANY_A, "conv-1", "conv-missing", BASE, {
    ...created,
    topic: "chatbot.conversation.merged",
    dedupeKey: "merged:conv-1",
  });
  assert.equal(conflict.kind, "conflict");
  assert.equal(published.length, 1);
});

test("a sink failure never undoes the committed change", async () => {
  const conversations = createMemoryConversationStore();
  const events = withStoreEvents(conversations, () => {
    throw new Error("sink down");
  });
  const created = await events.insertConversation(COMPANY_A, conversationRecord(COMPANY_A, "conv-2"), {
    topic: "chatbot.conversation.created",
    aggregateId: "conv-2",
    payload: {},
    dedupeKey: "chatbot.conversation.created:conv-2",
    availableAt: BASE,
  });
  assert.equal(created.id, "conv-2");
  assert.equal((await conversations.findConversation(COMPANY_A, "conv-2")).id, "conv-2");
  assert.equal(conversations.outbox.length, 1, "the outbox row is kept");
});

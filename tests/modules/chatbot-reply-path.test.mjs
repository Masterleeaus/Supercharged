// Reply path for the widget and the channel webhooks: customer turn, reply runtime, channel outbox row, receipts.
// node:test, no network, no provider keys, no database. Conversation and turn stores are in memory; the model is a fake.
//
// Run: node --test --experimental-transform-types tests/modules/chatbot-reply-path.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryConversationStore } from "../../server/modules/chatbot/runtime/conversation-store.ts";
import { createConversationRuntime } from "../../server/modules/chatbot/runtime/conversation-runtime.ts";
import { createConversationReplyWriter } from "../../server/modules/chatbot/runtime/reply-writer.ts";
import { createReplyRuntime } from "../../server/modules/chatbot/runtime/reply-runtime.ts";
import { createMemoryReplyTurnStore } from "../../server/modules/chatbot/runtime/turn-store.ts";
import { createConversationReplyStorage, toMessageRecord } from "../../server/modules/chatbot/runtime/reply-storage.ts";
import { createCustomerTurns, messageIdForKey } from "../../server/modules/chatbot/runtime/customer-turn.ts";
import { createChannelReceiptHandler, buildChannelSend, channelThreadOf } from "../../server/modules/chatbot/runtime/channel-receipts.ts";
import { createWidgetMessagePort } from "../../server/modules/chatbot/runtime/widget-message-port.ts";
import { passThroughLock } from "../../server/modules/chatbot/cart/keyed-lock.ts";
import { replyModelsFrom } from "../../server/modules/chatbot/wiring/reply-stack.ts";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const CHATBOT = "aaaaaaaa-0000-4000-8000-000000000001";
const BASE = new Date("2026-11-15T10:00:00Z");

function fakeRoute({ reply = "We can help.", fail = false } = {}) {
  const calls = [];
  const provider = {
    key: "openai",
    async complete(companyId, request) {
      calls.push({ companyId, request });
      if (fail) throw Object.assign(new Error("upstream said secret-ish text"), { code: "bad_request", retryable: false, provider: "openai" });
      return { provider: "openai", model: request.model, text: reply, toolCalls: [], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, providerRequestId: null };
    },
    stream() {
      throw new Error("not used");
    },
    embed() {
      throw new Error("not used");
    },
  };
  return {
    calls,
    route: {
      providers: [provider],
      models: { openai: "gpt-test" },
      policy: { order: [], retryOnStatus: [], maxAttemptsPerProvider: 1, backoffBaseMs: 0, backoffMaxMs: 0, failoverAfterFirstDelta: false },
    },
  };
}

function world(options) {
  const store = createMemoryConversationStore();
  store.addChatbot(COMPANY_A, CHATBOT);
  const model = fakeRoute(options);
  const sent = [];
  const outbox = {
    async enqueue(_tx, companyId, message) {
      sent.push({ companyId, message });
      return { id: `row-${sent.length}` };
    },
  };
  const chatbotRecord = { id: CHATBOT, companyId: COMPANY_A, title: "Shop", language: "en", welcomeMessage: null, instructions: null, generativeUiEnabled: false, active: true, createdAt: BASE, updatedAt: BASE };
  const chatbots = { async findChatbot(companyId, id) { return id === CHATBOT && companyId === COMPANY_A ? chatbotRecord : null; } };
  // Each read of the clock moves forward a second, so messages written in one test never tie on createdAt.
  let tick = 0;
  const now = () => new Date(BASE.getTime() + ++tick * 1000);
  let ids = 0;
  const newId = () => `c-${++ids}`;
  const conversations = createConversationRuntime({ store, route: model.route, now, newId });
  const writer = createConversationReplyWriter({ store, channelOutbox: outbox, buildSend: buildChannelSend, lock: passThroughLock, now, newId });
  const replies = createReplyRuntime({
    storage: createConversationReplyStorage({ store, chatbots }),
    writer,
    turns: createMemoryReplyTurnStore(),
    route: model.route,
    now,
  });
  const turns = createCustomerTurns({ store, conversations, replies, now, newId: () => `m-${++ids}` });
  const widgetChatbots = {
    async findByPublicId(publicId) {
      return publicId === "pub-1" ? { companyId: COMPANY_A, chatbotId: CHATBOT, publicId, title: "Shop" } : null;
    },
  };
  const widget = createWidgetMessagePort({ chatbots: widgetChatbots, turns, store });
  const receipts = createChannelReceiptHandler({ turns, chatbotIdFor: async () => CHATBOT });
  return { store, model, sent, conversations, turns, widget, receipts };
}

function receipt({ text = "Do you fix taps?", contentKind = "text", externalMessageId = "m-100", externalThreadId = "chat-9", accountId = "bot-1" } = {}) {
  return {
    ok: true,
    channel: "telegram",
    accountId,
    events: [
      {
        kind: "message",
        message: {
          channel: "telegram",
          accountId,
          externalThreadId,
          externalMessageId,
          sender: { externalId: externalThreadId, displayName: null },
          contentKind,
          text: contentKind === "text" ? text : null,
          attachments: [],
          sentAt: BASE,
        },
      },
    ],
  };
}

async function messagesOf(store, companyId, conversationId) {
  return (await store.listMessages(companyId, conversationId)).map((row) => `${row.role}:${row.text}`);
}

test("widget: a visitor message gets a stored reply, and the same visitor keeps one conversation", async () => {
  const w = world({ reply: "Yes, we fix taps." });
  const first = await w.widget.send({ companyId: COMPANY_A, chatbotPublicId: "pub-1", visitorId: "visitor-aaaaaaaaaaaaaaaa", text: "Fix taps?" });
  assert.equal(first.text, "Yes, we fix taps.");
  const conv = await w.store.findConversationByThread(COMPANY_A, CHATBOT, "web", "visitor-aaaaaaaaaaaaaaaa");
  assert.ok(conv, "conversation created for the visitor");
  assert.deepEqual(await messagesOf(w.store, COMPANY_A, conv.id), ["customer:Fix taps?", "assistant:Yes, we fix taps."]);
  assert.equal(w.sent.length, 0, "web replies have no channel send");

  await w.widget.send({ companyId: COMPANY_A, chatbotPublicId: "pub-1", visitorId: "visitor-aaaaaaaaaaaaaaaa", text: "Thanks" });
  const again = await w.store.findConversationByThread(COMPANY_A, CHATBOT, "web", "visitor-aaaaaaaaaaaaaaaa");
  assert.equal(again.id, conv.id);
  assert.equal((await w.store.listMessages(COMPANY_A, conv.id)).length, 4);
});

test("widget: a chatbot of another company is refused before any write", async () => {
  const w = world();
  await assert.rejects(
    w.widget.send({ companyId: COMPANY_B, chatbotPublicId: "pub-1", visitorId: "visitor-bbbbbbbbbbbbbbbb", text: "hi" }),
    /widget chatbot not found/,
  );
  assert.equal(await w.store.findConversationByThread(COMPANY_B, CHATBOT, "web", "visitor-bbbbbbbbbbbbbbbb"), null);
  assert.equal(w.model.calls.length, 0);
});

test("widget: a failed model call throws, stores no assistant text, and leaves the customer message", async () => {
  const w = world({ fail: true });
  await assert.rejects(w.widget.send({ companyId: COMPANY_A, chatbotPublicId: "pub-1", visitorId: "visitor-cccccccccccccccc", text: "hi" }));
  const conv = await w.store.findConversationByThread(COMPANY_A, CHATBOT, "web", "visitor-cccccccccccccccc");
  assert.deepEqual(await messagesOf(w.store, COMPANY_A, conv.id), ["customer:hi"]);
});

test("channel: a telegram text message is answered and the reply is queued to the same chat", async () => {
  const w = world({ reply: "We can help with that." });
  await w.receipts(COMPANY_A, receipt());
  assert.equal(w.model.calls.length, 1);
  assert.equal(w.sent.length, 1);
  const { message } = w.sent[0];
  assert.equal(message.channel, "telegram");
  assert.equal(message.accountId, "bot-1");
  assert.equal(message.recipient, "chat-9");
  assert.equal(message.contentKind, "text");
  assert.equal(message.text, "We can help with that.");
  assert.match(message.idempotencyKey, /^reply:/);
});

test("channel: a redelivered webhook does not store a second customer message or a second reply", async () => {
  const w = world();
  await w.receipts(COMPANY_A, receipt());
  await w.receipts(COMPANY_A, receipt());
  assert.equal(w.model.calls.length, 1);
  assert.equal(w.sent.length, 1);
  const conv = await w.store.findConversationByThread(COMPANY_A, CHATBOT, "telegram", channelThreadOf("bot-1", "chat-9"));
  const roles = (await w.store.listMessages(COMPANY_A, conv.id)).map((row) => row.role);
  assert.deepEqual(roles, ["customer", "assistant"]);
});

test("channel: a non-text message is skipped, with no conversation and no model call", async () => {
  const w = world();
  await w.receipts(COMPANY_A, receipt({ contentKind: "image" }));
  assert.equal(w.model.calls.length, 0);
  assert.equal(w.sent.length, 0);
  assert.equal(await w.store.findConversationByThread(COMPANY_A, CHATBOT, "telegram", channelThreadOf("bot-1", "chat-9")), null);
});

test("channel: no chatbot for the account means no conversation and no reply", async () => {
  const w = world();
  const handler = createChannelReceiptHandler({ turns: w.turns, chatbotIdFor: async () => null });
  await handler(COMPANY_A, receipt());
  assert.equal(w.model.calls.length, 0);
  assert.equal(await w.store.findConversationByThread(COMPANY_A, CHATBOT, "telegram", channelThreadOf("bot-1", "chat-9")), null);
});

test("channel: an account id containing the thread separator is refused", async () => {
  const w = world();
  await w.receipts(COMPANY_A, receipt({ accountId: "bot|1" }));
  assert.equal(w.model.calls.length, 0);
});

test("channel: an archived conversation keeps the customer message and gets no reply", async () => {
  const w = world();
  const thread = channelThreadOf("bot-1", "chat-9");
  const conv = await w.conversations.create(COMPANY_A, { chatbotId: CHATBOT, channel: "telegram", externalThreadId: thread, customerId: null });
  await w.conversations.archive(COMPANY_A, conv.id);
  await w.receipts(COMPANY_A, receipt());
  assert.equal(w.model.calls.length, 0);
  assert.deepEqual((await w.store.listMessages(COMPANY_A, conv.id)).map((row) => row.role), ["customer"]);
});

test("channel: a failed model call stores no reply and queues no send", async () => {
  const w = world({ fail: true });
  await w.receipts(COMPANY_A, receipt());
  assert.equal(w.sent.length, 0);
  const conv = await w.store.findConversationByThread(COMPANY_A, CHATBOT, "telegram", channelThreadOf("bot-1", "chat-9"));
  assert.deepEqual((await w.store.listMessages(COMPANY_A, conv.id)).map((row) => row.role), ["customer"]);
});

test("buildChannelSend: web gets no send, a malformed channel thread is refused", () => {
  const base = { id: "c", companyId: COMPANY_A, chatbotId: CHATBOT, status: "open", handler: "ai", summary: null, summaryUpdatedAt: null, mergedIntoId: null, customerId: null, createdAt: BASE, updatedAt: BASE };
  assert.equal(buildChannelSend({ ...base, channel: "web", externalThreadId: "visitor-1" }, "hi"), null);
  assert.throws(() => buildChannelSend({ ...base, channel: "telegram", externalThreadId: "no-separator" }, "hi"), /malformed/);
  assert.throws(() => buildChannelSend({ ...base, channel: "telegram", externalThreadId: "bot|" }, "hi"), /malformed/);
});

test("reply storage adapter: customer rows read as user, staff and system rows are left out", () => {
  const row = (role) => ({ id: role, companyId: COMPANY_A, conversationId: "c", role, text: "t", isInternalNote: false, createdAt: BASE });
  assert.equal(toMessageRecord(row("customer")).role, "user");
  assert.equal(toMessageRecord(row("assistant")).role, "assistant");
  assert.equal(toMessageRecord(row("staff")), null);
  assert.equal(toMessageRecord(row("system")), null);
});

test("message ids from a key are stable and scoped to the company", () => {
  assert.equal(messageIdForKey(COMPANY_A, "k"), messageIdForKey(COMPANY_A, "k"));
  assert.notEqual(messageIdForKey(COMPANY_A, "k"), messageIdForKey(COMPANY_B, "k"));
  assert.match(messageIdForKey(COMPANY_A, "k"), /^in_[0-9a-f]{32}$/);
});

test("reply models come only from the CHATBOT_REPLY_MODEL_* variables, and bad ids are dropped", () => {
  assert.deepEqual(
    replyModelsFrom({ CHATBOT_REPLY_MODEL_OPENAI: " gpt-x ", CHATBOT_REPLY_MODEL_ANTHROPIC: "bad model!", CHATBOT_REPLY_MODEL_GEMINI: "" }),
    { openai: "gpt-x" },
  );
  assert.deepEqual(replyModelsFrom({}), {});
});

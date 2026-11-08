// Conversation runtime gaps: create, archive, merge, search, summary cache, delivery status. node:test, no network,
// no provider keys, no database. Storage and model provider are in-memory fakes.
//
// Run: NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types tests/modules/chatbot-runtime-conversations.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryConversationStore } from "../../server/modules/chatbot/runtime/conversation-store.ts";
import {
  createConversationRuntime,
  decodeSearchCursor,
  encodeSearchCursor,
  SUMMARY_REFRESH_AFTER_MESSAGES,
} from "../../server/modules/chatbot/runtime/conversation-runtime.ts";
import {
  createDeliveryStatusRuntime,
  createMemoryDeliveryStatusStore,
  toFailureCode,
  UNKNOWN_FAILURE_CODE,
} from "../../server/modules/chatbot/runtime/delivery-status.ts";
import { DeliveryError } from "../../server/modules/chatbot/runtime/delivery-rules.ts";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const CHATBOT_A = "aaaaaaaa-0000-4000-8000-000000000001";
const CHATBOT_A2 = "aaaaaaaa-0000-4000-8000-000000000002";
const CHATBOT_B = "bbbbbbbb-0000-4000-8000-000000000001";
const BASE = new Date("2026-11-08T10:00:00Z");
const OPTIONS = { timeoutMs: 5000 };

let idCounter = 0;
const nextId = (prefix) => {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
};

function fakeModel(reply, { failNonRetryable = false } = {}) {
  const calls = [];
  const provider = {
    key: "openai",
    async complete(companyId, request) {
      calls.push({ companyId, request });
      if (failNonRetryable) throw Object.assign(new Error("boom"), { code: "bad_request", retryable: false, provider: "openai" });
      return {
        provider: "openai",
        model: request.model,
        text: reply,
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
        providerRequestId: null,
      };
    },
    stream() {
      throw new Error("not used");
    },
    embed() {
      throw new Error("not used");
    },
  };
  const route = {
    providers: [provider],
    models: { openai: "gpt-test" },
    policy: { order: [], retryOnStatus: [], maxAttemptsPerProvider: 1, backoffBaseMs: 0, backoffMaxMs: 0, failoverAfterFirstDelta: false },
  };
  return { calls, route };
}

function world({ model = fakeModel("Summary text.") } = {}) {
  const store = createMemoryConversationStore();
  store.addChatbot(COMPANY_A, CHATBOT_A);
  store.addChatbot(COMPANY_A, CHATBOT_A2);
  store.addChatbot(COMPANY_B, CHATBOT_B);
  let clock = BASE.getTime();
  const now = () => new Date(clock);
  const runtime = createConversationRuntime({ store, route: model.route, now, newId: () => nextId("conv") });
  const deliveryStore = createMemoryDeliveryStatusStore();
  const delivery = createDeliveryStatusRuntime({ store: deliveryStore, messages: store, now });
  return {
    store,
    runtime,
    delivery,
    model,
    tick(ms = 1000) {
      clock += ms;
      return new Date(clock);
    },
  };
}

async function seedMessages(store, companyId, conversationId, texts, { role = "customer", startMs = BASE.getTime() } = {}) {
  const rows = [];
  for (let i = 0; i < texts.length; i += 1) {
    rows.push(
      await store.insertMessage(companyId, conversationId, {
        id: nextId("msg"),
        role,
        text: texts[i],
        isInternalNote: false,
        createdAt: new Date(startMs + (i + 1) * 1000),
      }),
    );
  }
  return rows;
}

const newConv = (chatbotId) => ({ chatbotId, channel: "web", externalThreadId: null, customerId: null });

// ---------------------------------------------------------------------------
// Create and archive
// ---------------------------------------------------------------------------

test("create stores an open conversation and writes its outbox row with it", async () => {
  const w = world();
  const conv = await w.runtime.create(COMPANY_A, newConv(CHATBOT_A));
  assert.equal(conv.status, "open");
  assert.equal(conv.companyId, COMPANY_A);
  assert.equal(conv.mergedIntoId, null);
  assert.equal(w.store.outbox.length, 1);
  assert.equal(w.store.outbox[0].topic, "chatbot.conversation.created");
  assert.equal(w.store.outbox[0].companyId, COMPANY_A);
});

test("create refuses a chatbot of another company and stores nothing", async () => {
  const w = world();
  await assert.rejects(w.runtime.create(COMPANY_A, newConv(CHATBOT_B)), { code: "chatbot_not_found" });
  assert.equal(w.store.outbox.length, 0);
});

test("archive hides a conversation from default search without deleting it", async () => {
  const w = world();
  const conv = await w.runtime.create(COMPANY_A, newConv(CHATBOT_A));
  await seedMessages(w.store, COMPANY_A, conv.id, ["keep this message"]);

  const archived = await w.runtime.archive(COMPANY_A, conv.id);
  assert.equal(archived.status, "archived");

  const defaultPage = await w.runtime.search(COMPANY_A, { limit: 25, cursor: null });
  assert.equal(defaultPage.rows.some((row) => row.id === conv.id), false);

  const archivedPage = await w.runtime.search(COMPANY_A, { status: "archived", limit: 25, cursor: null });
  assert.deepEqual(archivedPage.rows.map((row) => row.id), [conv.id]);

  const kept = await w.store.listMessages(COMPANY_A, conv.id);
  assert.equal(kept.length, 1, "messages stay in place");
  assert.equal((await w.store.findConversation(COMPANY_A, conv.id)).status, "archived");
});

test("archiving twice writes one outbox event and keeps the first state", async () => {
  const w = world();
  const conv = await w.runtime.create(COMPANY_A, newConv(CHATBOT_A));
  await w.runtime.archive(COMPANY_A, conv.id);
  w.tick();
  const again = await w.runtime.archive(COMPANY_A, conv.id);
  assert.equal(again.status, "archived");
  assert.equal(w.store.outbox.filter((row) => row.topic === "chatbot.conversation.archived").length, 1);
});

test("archive of another company's conversation returns null and changes nothing", async () => {
  const w = world();
  const conv = await w.runtime.create(COMPANY_A, newConv(CHATBOT_A));
  assert.equal(await w.runtime.archive(COMPANY_B, conv.id), null);
  assert.equal((await w.store.findConversation(COMPANY_A, conv.id)).status, "open");
});

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

test("merge moves messages from source to target once", async () => {
  const w = world();
  const target = await w.runtime.create(COMPANY_A, newConv(CHATBOT_A));
  const source = await w.runtime.create(COMPANY_A, newConv(CHATBOT_A));
  await seedMessages(w.store, COMPANY_A, target.id, ["t1", "t2"]);
  await seedMessages(w.store, COMPANY_A, source.id, ["s1", "s2", "s3"], { startMs: BASE.getTime() + 60000 });

  const merged = await w.runtime.merge(COMPANY_A, target.id, source.id);
  assert.equal(merged.id, target.id);
  assert.equal((await w.store.listMessages(COMPANY_A, target.id)).length, 5);
  assert.equal((await w.store.listMessages(COMPANY_A, source.id)).length, 0);
  assert.equal((await w.store.findConversation(COMPANY_A, source.id)).status, "merged");
  assert.equal((await w.store.findConversation(COMPANY_A, source.id)).mergedIntoId, target.id);

  // A repeat of the same merge moves nothing and adds no event.
  const repeat = await w.runtime.merge(COMPANY_A, target.id, source.id);
  assert.equal(repeat.id, target.id);
  assert.equal((await w.store.listMessages(COMPANY_A, target.id)).length, 5);
  assert.equal(w.store.outbox.filter((row) => row.topic === "chatbot.conversation.merged").length, 1);
});

test("merge refuses self merge, a different chatbot, and an archived target, moving nothing", async () => {
  const w = world();
  const a = await w.runtime.create(COMPANY_A, newConv(CHATBOT_A));
  const other = await w.runtime.create(COMPANY_A, newConv(CHATBOT_A2));
  const archivedTarget = await w.runtime.create(COMPANY_A, newConv(CHATBOT_A));
  await seedMessages(w.store, COMPANY_A, a.id, ["x"]);
  await w.runtime.archive(COMPANY_A, archivedTarget.id);

  await assert.rejects(w.runtime.merge(COMPANY_A, a.id, a.id), { code: "self_merge" });
  await assert.rejects(w.runtime.merge(COMPANY_A, a.id, other.id), { code: "chatbot_mismatch" });
  await assert.rejects(w.runtime.merge(COMPANY_A, archivedTarget.id, a.id), { code: "target_not_open" });
  assert.equal((await w.store.listMessages(COMPANY_A, a.id)).length, 1);
  assert.equal(w.store.outbox.filter((row) => row.topic === "chatbot.conversation.merged").length, 0);
});

test("two conversations from different companies can never merge", async () => {
  const w = world();
  const inA = await w.runtime.create(COMPANY_A, newConv(CHATBOT_A));
  const inB = await w.runtime.create(COMPANY_B, newConv(CHATBOT_B));
  await seedMessages(w.store, COMPANY_A, inA.id, ["a1"]);
  await seedMessages(w.store, COMPANY_B, inB.id, ["b1", "b2"]);

  assert.equal(await w.runtime.merge(COMPANY_A, inA.id, inB.id), null, "source from another company is absent");
  assert.equal(await w.runtime.merge(COMPANY_B, inB.id, inA.id), null, "target from another company is absent");

  assert.equal((await w.store.listMessages(COMPANY_A, inA.id)).length, 1);
  assert.equal((await w.store.listMessages(COMPANY_B, inB.id)).length, 2);
  assert.equal((await w.store.findConversation(COMPANY_A, inA.id)).status, "open");
  assert.equal((await w.store.findConversation(COMPANY_B, inB.id)).status, "open");
  assert.equal(w.store.outbox.filter((row) => row.topic === "chatbot.conversation.merged").length, 0);
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

test("search never returns another company's conversations", async () => {
  const w = world();
  const a1 = await w.runtime.create(COMPANY_A, newConv(CHATBOT_A));
  const b1 = await w.runtime.create(COMPANY_B, newConv(CHATBOT_B));
  await seedMessages(w.store, COMPANY_A, a1.id, ["refund please"]);
  await seedMessages(w.store, COMPANY_B, b1.id, ["refund please"]);

  const pageA = await w.runtime.search(COMPANY_A, { query: "refund", limit: 25, cursor: null });
  assert.deepEqual(pageA.rows.map((row) => row.id), [a1.id]);

  const pageB = await w.runtime.search(COMPANY_B, { query: "refund", limit: 25, cursor: null });
  assert.deepEqual(pageB.rows.map((row) => row.id), [b1.id]);

  const crossChatbot = await w.runtime.search(COMPANY_A, { chatbotId: CHATBOT_B, limit: 25, cursor: null });
  assert.deepEqual(crossChatbot.rows, [], "a chatbot of another company filters to nothing");

});

test("search matches message text without case and pages with a cursor", async () => {
  const w = world();
  const ids = [];
  for (let i = 0; i < 5; i += 1) {
    const conv = await w.runtime.create(COMPANY_A, newConv(CHATBOT_A));
    await seedMessages(w.store, COMPANY_A, conv.id, [`Booking ${i}`]);
    ids.push(conv.id);
    w.tick();
  }
  const seen = [];
  let cursor = null;
  do {
    const page = await w.runtime.search(COMPANY_A, { query: "BOOKING", limit: 2, cursor });
    seen.push(...page.rows.map((row) => row.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen.length, 5);
  assert.equal(new Set(seen).size, 5, "no row appears on two pages");
  assert.deepEqual(new Set(seen), new Set(ids));
});

test("search rejects a malformed cursor with a code, not a crash", async () => {
  const w = world();
  await assert.rejects(w.runtime.search(COMPANY_A, { limit: 5, cursor: "%%%not-a-cursor" }), { code: "invalid_cursor" });
  assert.equal(decodeSearchCursor(null), null);
  const row = { id: "conv-x", updatedAt: BASE };
  assert.deepEqual(decodeSearchCursor(encodeSearchCursor(row)), { id: "conv-x", updatedAt: BASE });
});

// ---------------------------------------------------------------------------
// Summary cache
// ---------------------------------------------------------------------------

test("summary is cached: a repeat call with no new messages makes no model call", async () => {
  const model = fakeModel("First summary.");
  const w = world({ model });
  const conv = await w.runtime.create(COMPANY_A, newConv(CHATBOT_A));
  await seedMessages(w.store, COMPANY_A, conv.id, ["hello", "I need a quote"]);

  assert.equal(await w.runtime.summarize(COMPANY_A, conv.id, { force: false, ...OPTIONS }), "First summary.");
  assert.equal(await w.runtime.summarize(COMPANY_A, conv.id, { force: false, ...OPTIONS }), "First summary.");
  assert.equal(model.calls.length, 1);
  assert.equal((await w.store.findConversation(COMPANY_A, conv.id)).summary, "First summary.");
});

test("summary refreshes after enough new messages, and force always re-summarises", async () => {
  const model = fakeModel("Summary.");
  const w = world({ model });
  const conv = await w.runtime.create(COMPANY_A, newConv(CHATBOT_A));
  await seedMessages(w.store, COMPANY_A, conv.id, ["one"]);
  await w.runtime.summarize(COMPANY_A, conv.id, { force: false, ...OPTIONS });

  const later = BASE.getTime() + 10 * 60000;
  await seedMessages(w.store, COMPANY_A, conv.id, Array.from({ length: SUMMARY_REFRESH_AFTER_MESSAGES }, (_, i) => `more ${i}`), { startMs: later });
  await w.runtime.summarize(COMPANY_A, conv.id, { force: false, ...OPTIONS });
  assert.equal(model.calls.length, 2, "ten new messages trigger a refresh");

  await w.runtime.summarize(COMPANY_A, conv.id, { force: true, ...OPTIONS });
  assert.equal(model.calls.length, 3, "force always calls the model");
});

test("a failed model call returns a fallback excerpt and caches nothing", async () => {
  const model = fakeModel("unused", { failNonRetryable: true });
  const w = world({ model });
  const conv = await w.runtime.create(COMPANY_A, newConv(CHATBOT_A));
  await seedMessages(w.store, COMPANY_A, conv.id, ["the customer wants a plumber on Friday"]);

  const text = await w.runtime.summarize(COMPANY_A, conv.id, { force: false, ...OPTIONS });
  assert.match(text, /plumber/);
  assert.equal((await w.store.findConversation(COMPANY_A, conv.id)).summary, null, "a fallback is not stored as the summary");
});

test("internal notes never reach the summary model", async () => {
  const model = fakeModel("Clean summary.");
  const w = world({ model });
  const conv = await w.runtime.create(COMPANY_A, newConv(CHATBOT_A));
  await seedMessages(w.store, COMPANY_A, conv.id, ["public question"]);
  await w.store.insertMessage(COMPANY_A, conv.id, {
    id: nextId("note"),
    role: "staff",
    text: "SECRET-INTERNAL-NOTE",
    isInternalNote: true,
    createdAt: new Date(BASE.getTime() + 5000),
  });
  await w.runtime.summarize(COMPANY_A, conv.id, { force: true, ...OPTIONS });
  const sent = JSON.stringify(model.calls[0].request.messages);
  assert.equal(sent.includes("SECRET-INTERNAL-NOTE"), false);
  assert.equal(sent.includes("public question"), true);
});

test("summary of another company's conversation is empty and calls no model", async () => {
  const model = fakeModel("nope");
  const w = world({ model });
  const conv = await w.runtime.create(COMPANY_A, newConv(CHATBOT_A));
  await seedMessages(w.store, COMPANY_A, conv.id, ["private"]);
  assert.equal(await w.runtime.summarize(COMPANY_B, conv.id, { force: true, ...OPTIONS }), "");
  assert.equal(model.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Delivery status
// ---------------------------------------------------------------------------

async function outboundMessage(w, companyId, conversationId) {
  const row = await w.store.insertMessage(companyId, conversationId, {
    id: nextId("out"),
    role: "assistant",
    text: "reply",
    isInternalNote: false,
    createdAt: BASE,
  });
  return row.id;
}

test("delivery moves queued to sent to delivered and never backwards", async () => {
  const w = world();
  const conv = await w.runtime.create(COMPANY_A, newConv(CHATBOT_A));
  const msg = await outboundMessage(w, COMPANY_A, conv.id);

  const sent = await w.delivery.markSent(COMPANY_A, msg, "wamid-1");
  assert.equal(sent.status, "sent");
  assert.equal(sent.externalMessageId, "wamid-1");

  const delivered = await w.delivery.markDelivered(COMPANY_A, msg, null);
  assert.equal(delivered.status, "delivered");
  assert.equal(delivered.externalMessageId, "wamid-1", "a null provider id keeps the stored one");

  const late = await w.delivery.markSent(COMPANY_A, msg, null);
  assert.equal(late.status, "delivered", "a late sent receipt does not move the status back");
  assert.equal((await w.delivery.get(COMPANY_A, msg)).status, "delivered");
});

test("a failed delivery is recorded with a code and the raw provider text is dropped", async () => {
  const w = world();
  const conv = await w.runtime.create(COMPANY_A, newConv(CHATBOT_A));
  const msg = await outboundMessage(w, COMPANY_A, conv.id);

  const failed = await w.delivery.markFailed(COMPANY_A, msg, "channel:131047");
  assert.equal(failed.status, "failed");
  assert.equal(failed.failureReason, "channel:131047");

  const stored = await w.delivery.get(COMPANY_A, msg);
  assert.equal(stored.status, "failed");
  assert.equal(stored.failureReason, "channel:131047");

  const second = await outboundMessage(w, COMPANY_A, conv.id);
  const raw = await w.delivery.markFailed(COMPANY_A, second, "Your token abc123 is invalid for user jason@example.com");
  assert.equal(raw.failureReason, UNKNOWN_FAILURE_CODE);
  assert.equal(toFailureCode("provider timeout"), UNKNOWN_FAILURE_CODE);

  const again = await w.delivery.markFailed(COMPANY_A, msg, "provider_timeout");
  assert.equal(again.failureReason, "channel:131047", "a second failure does not overwrite the first reason");
});

test("a failed message must be retried before it can advance, and retry counts up", async () => {
  const w = world();
  const conv = await w.runtime.create(COMPANY_A, newConv(CHATBOT_A));
  const msg = await outboundMessage(w, COMPANY_A, conv.id);
  await w.delivery.markFailed(COMPANY_A, msg, "provider_timeout");

  await assert.rejects(w.delivery.markSent(COMPANY_A, msg, "x"), { code: "retry_required" });

  const retried = await w.delivery.retry(COMPANY_A, msg);
  assert.equal(retried.status, "queued");
  assert.equal(retried.retryCount, 1);
  assert.equal(retried.failureReason, null);

  await w.delivery.markSent(COMPANY_A, msg, "ok");
  await assert.rejects(w.delivery.retry(COMPANY_A, msg), DeliveryError);
});

test("delivery status of another company's message is absent and writes nothing", async () => {
  const w = world();
  const conv = await w.runtime.create(COMPANY_A, newConv(CHATBOT_A));
  const msg = await outboundMessage(w, COMPANY_A, conv.id);

  assert.equal(await w.delivery.get(COMPANY_B, msg), null);
  assert.equal(await w.delivery.markFailed(COMPANY_B, msg, "provider_timeout"), null);
  assert.equal(await w.delivery.markSent(COMPANY_B, msg, "x"), null);
  assert.equal(await w.delivery.get(COMPANY_A, msg), null, "no record was written under company A either");
});

test("delivery gives up with a conflict error when the stored status keeps moving", async () => {
  const w = world();
  const conv = await w.runtime.create(COMPANY_A, newConv(CHATBOT_A));
  const msg = await outboundMessage(w, COMPANY_A, conv.id);
  // A store that always reports a stale record and always refuses the write, as if another worker keeps winning.
  const racing = {
    find: async (companyId, messageId) => ({
      companyId,
      messageId,
      conversationId: conv.id,
      status: "delivered",
      externalMessageId: null,
      failureReason: null,
      retryCount: 0,
      updatedAt: BASE,
    }),
    compareAndSet: async () => false,
  };
  const runtime = createDeliveryStatusRuntime({ store: racing, messages: w.store, now: () => BASE });
  await assert.rejects(runtime.markFailed(COMPANY_A, msg, "provider_timeout"), { message: "delivery_conflict" });
});

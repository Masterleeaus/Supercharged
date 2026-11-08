// Conversational commerce adapters: cart, orders and catalogue readers, handoff outbox events, brand voice, and the
// marketplace write path. No network, no provider keys, no real database. Fakes stand in for every port.
//
// Run: NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types tests/modules/chatbot-commerce-conversational-adapters.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";

import { CartError } from "../../server/modules/chatbot/cart/index.ts";
import { CommerceError } from "../../server/modules/chatbot/commerce/conversational/errors.ts";
import {
  createCartReader,
  createOrderReader,
  createCatalogueReader,
} from "../../server/modules/chatbot/commerce/conversational/read-adapters.ts";
import {
  createHandoffEvents,
  handoffDedupeKey,
  HANDOFF_TOPIC,
} from "../../server/modules/chatbot/commerce/conversational/handoff-events.ts";
import {
  createBrandVoiceService,
  validateBrandVoice,
  toBrandGuide,
} from "../../server/modules/chatbot/commerce/conversational/brand-voice.ts";
import { createDrizzleBrandVoiceStore } from "../../server/modules/chatbot/commerce/conversational/brand-voice-store.ts";
import { createMarketplaceWritePath } from "../../server/modules/chatbot/commerce/conversational/marketplace-write-path.ts";
import { CONTRACT_FLAGS } from "../../server/modules/chatbot/contracts/index.ts";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const CHATBOT_A = "chatbot-a";
const CHATBOT_B = "chatbot-b";
const NOW = new Date("2026-11-09T01:00:00.000Z");

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function cartRecord(over = {}) {
  return {
    id: "cart-1",
    companyId: COMPANY_A,
    chatbotId: CHATBOT_A,
    conversationId: "sess-1",
    customerId: "cust-secret-1",
    status: "active",
    currency: "AUD",
    lines: [
      { lineKey: "line-1", variantId: "var-1", productId: "prod-1", sku: "SKU-1", name: "Widget", quantity: 2, unitPriceMinor: 1500, lineTotalMinor: 3000, currency: "AUD", customisation: {} },
    ],
    subtotalMinor: 3000,
    discountMinor: 0,
    totalMinor: 3000,
    version: 3,
    expiresAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function fakeCartService(resolve) {
  const calls = [];
  return {
    calls,
    async getOrCreateCart(scope) {
      calls.push(scope);
      return resolve(scope);
    },
  };
}

function orderRecord(over = {}) {
  return {
    id: "ord-1",
    companyId: COMPANY_A,
    orderNumber: "ORD-1001",
    chatbotId: CHATBOT_A,
    sessionId: "sess-1",
    customerIdentityId: null,
    status: "confirmed",
    fulfillmentStatus: "unfulfilled",
    currency: "AUD",
    total: 4200,
    placedAt: NOW,
    ...over,
  };
}

// A service that leaks: it returns every row it is given, so the adapter's own filter is what is tested.
function fakeOrderService(rows) {
  const calls = [];
  return {
    calls,
    async listOrdersForSession(companyId, scope, page) {
      calls.push({ companyId, scope, page });
      return rows;
    },
  };
}

function listingView(connectionId, externalListingId, over = {}) {
  return {
    connectionId,
    provider: "ebay",
    listing: { externalListingId, title: `Listing ${externalListingId}`, priceMinor: 999, currency: "AUD", quantity: 4, sourceHash: "h", raw: {}, ...over },
  };
}

function fakeReadRuntime() {
  const calls = { search: [], stored: [] };
  return {
    calls,
    async searchListings(companyId, query) {
      calls.search.push({ companyId, query });
      return { rows: [listingView("conn-a", "L-1")], errors: [{ connectionId: "conn-b", provider: "ebay", code: "rate_limited" }] };
    },
    async storedListing(companyId, connectionId, externalListingId) {
      calls.stored.push({ companyId, connectionId, externalListingId });
      return companyId === COMPANY_A && connectionId === "conn-a" && externalListingId === "L-1" ? listingView("conn-a", "L-1") : null;
    },
  };
}

// Records rows. Like the real store, a repeated dedupeKey returns the existing row and adds nothing.
function fakeOutbox() {
  const rows = [];
  let appendCalls = 0;
  return {
    rows,
    get appendCalls() {
      return appendCalls;
    },
    async append(companyId, event) {
      appendCalls += 1;
      const existing = rows.find((r) => r.companyId === companyId && r.dedupeKey === event.dedupeKey);
      if (existing) return existing;
      const row = { id: `evt-${rows.length + 1}`, status: "pending", attempts: 0, publishedAt: null, createdAt: NOW, ...event };
      rows.push(row);
      return row;
    },
    async claimBatch() {
      return [];
    },
    async markPublished() {},
    async markFailed() {},
  };
}

function fakeConversations(rows) {
  return {
    async find(companyId, conversationId) {
      return rows.find((r) => r.companyId === companyId && r.id === conversationId) ?? null;
    },
  };
}

function fakeBrandStore() {
  const map = new Map();
  const key = (companyId, chatbotId) => `${companyId}|${chatbotId}`;
  return {
    map,
    async find(companyId, chatbotId) {
      return map.get(key(companyId, chatbotId)) ?? null;
    },
    async upsert(profile) {
      map.set(key(profile.companyId, profile.chatbotId), profile);
    },
    async remove(companyId, chatbotId) {
      return map.delete(key(companyId, chatbotId));
    },
  };
}

function fakeWriteRuntime(opts = {}) {
  const log = [];
  return {
    log,
    async prepare(companyId, actor, input) {
      log.push(["prepare", companyId, input.operation]);
      return {
        proposal: { id: "prop-1", status: opts.preparedStatus ?? "prepared", conflicts: opts.conflicts ?? [] },
        confirmationToken: opts.preparedStatus === "conflict_blocked" ? null : "tok-1",
      };
    },
    async confirm(companyId, actor, proposalId, token) {
      log.push(["confirm", proposalId, token]);
      if (opts.confirmThrows) throw new Error("confirmation_invalid");
      return { id: proposalId, status: opts.confirmStatus ?? "approved" };
    },
    async execute(companyId, actor, proposalId) {
      log.push(["execute", proposalId]);
      return { id: proposalId, status: "executed", errorCode: null };
    },
    async approveForBatch() {
      throw new Error("not used");
    },
    async rollback() {
      throw new Error("not used");
    },
    signer: {},
  };
}

function recordingDb() {
  const statements = [];
  const client = {
    async query(config, values) {
      const text = typeof config === "string" ? config : config.text;
      const params = typeof config === "string" ? (values ?? []) : (config.values ?? values ?? []);
      statements.push({ text, params });
      return { rows: [], rowCount: 0, fields: [] };
    },
  };
  return { db: drizzle(client), statements };
}

const ownerA = { companyId: COMPANY_A, userId: "owner-1", role: "owner" };
const enabledEnv = { [CONTRACT_FLAGS.MARKETPLACE_WRITE_ENABLED]: "true" };

// ---------------------------------------------------------------------------
// Cart reader
// ---------------------------------------------------------------------------

test("cart reader returns this company's cart and passes the session as the conversation", async () => {
  const cart = fakeCartService(() => cartRecord());
  const reader = createCartReader(cart);
  const view = await reader.readSessionCart(COMPANY_A, CHATBOT_A, "sess-1");
  assert.equal(view.cartId, "cart-1");
  assert.equal(view.totalMinor, 3000);
  assert.equal(view.lines[0].name, "Widget");
  assert.deepEqual(cart.calls[0], { companyId: COMPANY_A, chatbotId: CHATBOT_A, conversationId: "sess-1" });
  assert.equal("customerId" in view, false, "customer identifiers are not part of the view");
});

test("cart reader never returns another company's cart", async () => {
  const cart = fakeCartService(() => cartRecord({ companyId: COMPANY_B }));
  assert.equal(await createCartReader(cart).readSessionCart(COMPANY_A, CHATBOT_A, "sess-1"), null);
});

test("cart reader returns null for a cart that belongs to another chatbot", async () => {
  const cart = fakeCartService(() => cartRecord({ chatbotId: CHATBOT_B }));
  assert.equal(await createCartReader(cart).readSessionCart(COMPANY_A, CHATBOT_A, "sess-1"), null);
});

test("cart reader maps a not_found from the cart service to null, and rethrows other cart errors", async () => {
  const missing = fakeCartService(() => {
    throw new CartError("not_found", "Cart not found.");
  });
  assert.equal(await createCartReader(missing).readSessionCart(COMPANY_A, CHATBOT_A, "sess-1"), null);

  const disabled = fakeCartService(() => {
    throw new CartError("feature_disabled", "off");
  });
  await assert.rejects(() => createCartReader(disabled).readSessionCart(COMPANY_A, CHATBOT_A, "sess-1"), (e) => e instanceof CartError && e.code === "feature_disabled");
});

test("cart reader refuses a blank company before it calls the cart service", async () => {
  const cart = fakeCartService(() => cartRecord());
  await assert.rejects(() => createCartReader(cart).readSessionCart("  ", CHATBOT_A, "sess-1"), CommerceError);
  assert.equal(cart.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Order reader
// ---------------------------------------------------------------------------

test("order reader lists only this company's and chatbot's orders", async () => {
  const orders = fakeOrderService([
    orderRecord({ id: "ord-1", orderNumber: "ORD-1001" }),
    orderRecord({ id: "ord-2", orderNumber: "ORD-2001", companyId: COMPANY_B }),
    orderRecord({ id: "ord-3", orderNumber: "ORD-3001", chatbotId: CHATBOT_B }),
  ]);
  const rows = await createOrderReader(orders).listSessionOrders(COMPANY_A, CHATBOT_A, { sessionId: "sess-1" });
  assert.deepEqual(rows.map((r) => r.orderNumber), ["ORD-1001"]);
  assert.equal(rows[0].totalMinor, 4200);
  assert.equal(orders.calls[0].companyId, COMPANY_A);
  assert.deepEqual(orders.calls[0].scope, { chatbotId: CHATBOT_A, sessionId: "sess-1", customerIdentityId: null });
});

test("order lookup by number does not return another company's order with the same number", async () => {
  const orders = fakeOrderService([orderRecord({ id: "ord-2", orderNumber: "ORD-1001", companyId: COMPANY_B })]);
  assert.equal(await createOrderReader(orders).findSessionOrder(COMPANY_A, CHATBOT_A, "ORD-1001", { sessionId: "sess-1" }), null);
});

test("order lookup matches the exact order number inside the session scope", async () => {
  const orders = fakeOrderService([orderRecord({ orderNumber: "ORD-1001" }), orderRecord({ id: "ord-9", orderNumber: "ORD-10010" })]);
  const reader = createOrderReader(orders);
  const hit = await reader.findSessionOrder(COMPANY_A, CHATBOT_A, " ORD-1001 ", { sessionId: "sess-1", customerIdentityId: "ident-7" });
  assert.equal(hit.id, "ord-1");
  assert.equal(orders.calls.at(-1).scope.customerIdentityId, "ident-7");
  assert.equal(await reader.findSessionOrder(COMPANY_A, CHATBOT_A, "   ", { sessionId: "sess-1" }), null);
});

// ---------------------------------------------------------------------------
// Catalogue reader
// ---------------------------------------------------------------------------

test("catalogue search goes through the read runtime with a clamped limit and reports provider errors", async () => {
  const read = fakeReadRuntime();
  const result = await createCatalogueReader(read).search(COMPANY_A, "  kettle  ", 500);
  assert.equal(read.calls.search[0].companyId, COMPANY_A);
  assert.equal(read.calls.search[0].query.keywords, "kettle");
  assert.equal(read.calls.search[0].query.limit, 20);
  assert.equal(result.rows[0].externalListingId, "L-1");
  assert.equal(result.errors[0].code, "rate_limited");
});

test("catalogue lookup reads the stored snapshot only and returns null when absent", async () => {
  const read = fakeReadRuntime();
  const reader = createCatalogueReader(read);
  const hit = await reader.lookup(COMPANY_A, "conn-a", "L-1");
  assert.equal(hit.title, "Listing L-1");
  assert.equal(hit.priceMinor, 999);
  assert.equal(await reader.lookup(COMPANY_B, "conn-a", "L-1"), null);
  assert.equal(read.calls.search.length, 0, "lookup never searches providers");
});

test("catalogue search refuses an over-long query", async () => {
  await assert.rejects(() => createCatalogueReader(fakeReadRuntime()).search(COMPANY_A, "x".repeat(201)), (e) => e instanceof CommerceError && e.code === "validation");
});

// ---------------------------------------------------------------------------
// Handoff events
// ---------------------------------------------------------------------------

const CONV_A = { id: "conv-a-1", companyId: COMPANY_A, chatbotId: CHATBOT_A };

test("a handoff writes exactly one conversation.handoff outbox event", async () => {
  const outbox = fakeOutbox();
  const writer = createHandoffEvents({ outbox, conversations: fakeConversations([CONV_A]), now: () => NOW });
  const event = await writer.recordHandoff(COMPANY_A, { conversationId: "conv-a-1", handoffId: "esc-1", reason: "Refund dispute", priority: "high", source: "ai" });
  assert.equal(outbox.appendCalls, 1);
  assert.equal(outbox.rows.length, 1);
  assert.equal(event.topic, HANDOFF_TOPIC);
  assert.equal(event.aggregateId, "conv-a-1");
  assert.equal(event.dedupeKey, handoffDedupeKey("conv-a-1", "esc-1"));
  assert.equal(event.payload.priority, "high");
  assert.equal(event.payload.occurred_at, NOW.toISOString());
});

test("a retried handoff with the same id still leaves one event", async () => {
  const outbox = fakeOutbox();
  const writer = createHandoffEvents({ outbox, conversations: fakeConversations([CONV_A]), now: () => NOW });
  const request = { conversationId: "conv-a-1", handoffId: "esc-1", reason: "Needs a person", priority: "normal", source: "customer_rule" };
  await writer.recordHandoff(COMPANY_A, request);
  await writer.recordHandoff(COMPANY_A, request);
  assert.equal(outbox.rows.filter((r) => r.topic === HANDOFF_TOPIC).length, 1);
});

test("a handoff for a conversation of another company appends nothing", async () => {
  const outbox = fakeOutbox();
  const writer = createHandoffEvents({ outbox, conversations: fakeConversations([{ ...CONV_A, companyId: COMPANY_B }]), now: () => NOW });
  await assert.rejects(
    () => writer.recordHandoff(COMPANY_A, { conversationId: "conv-a-1", handoffId: "esc-1", reason: "x", priority: "low", source: "ai" }),
    (e) => e instanceof CommerceError && e.code === "not_found",
  );
  assert.equal(outbox.appendCalls, 0);
});

test("a handoff with an invalid priority, source or reason appends nothing", async () => {
  const outbox = fakeOutbox();
  const writer = createHandoffEvents({ outbox, conversations: fakeConversations([CONV_A]), now: () => NOW });
  const base = { conversationId: "conv-a-1", handoffId: "esc-1", reason: "Needs a person", priority: "normal", source: "ai" };
  await assert.rejects(() => writer.recordHandoff(COMPANY_A, { ...base, priority: "urgent" }), CommerceError);
  await assert.rejects(() => writer.recordHandoff(COMPANY_A, { ...base, source: "webhook" }), CommerceError);
  await assert.rejects(() => writer.recordHandoff(COMPANY_A, { ...base, reason: " " }), CommerceError);
  assert.equal(outbox.appendCalls, 0);
});

test("the handoff payload carries no customer contact fields and caps the summary", async () => {
  const outbox = fakeOutbox();
  const writer = createHandoffEvents({ outbox, conversations: fakeConversations([CONV_A]), now: () => NOW });
  const event = await writer.recordHandoff(COMPANY_A, { conversationId: "conv-a-1", handoffId: "esc-2", reason: "Complaint", priority: "low", source: "ai", summary: "s".repeat(5000) });
  assert.equal(event.payload.summary.length, 1000);
  for (const key of ["email", "phone", "token", "customer_id"]) assert.equal(key in event.payload, false, key);
});

// ---------------------------------------------------------------------------
// Brand voice
// ---------------------------------------------------------------------------

const VALID_VOICE = {
  name: "Clean Smart house voice",
  tone: "Warm and plain",
  locale: "en-AU",
  preferredTerms: ["eco-friendly", "fully insured"],
  forbiddenTerms: ["cheapest"],
};

test("brand voice validation accepts a clean profile and trims it", () => {
  const checked = validateBrandVoice({ ...VALID_VOICE, name: "  Clean Smart  " });
  assert.equal(checked.name, "Clean Smart");
  assert.deepEqual(checked.forbiddenTerms, ["cheapest"]);
});

test("brand voice validation refuses bad input and names only the field", () => {
  const cases = [
    [{ ...VALID_VOICE, name: "bad\u0007name" }, "name"],
    [{ ...VALID_VOICE, locale: "english please" }, "locale"],
    [{ ...VALID_VOICE, preferredTerms: ["Fast", "fast"] }, "preferred_terms"],
    [{ ...VALID_VOICE, preferredTerms: ["cheapest"] }, "terms"],
    [{ ...VALID_VOICE, forbiddenTerms: Array.from({ length: 101 }, (_, i) => `t${i}`) }, "forbidden_terms"],
    [{ ...VALID_VOICE, forbiddenTerms: ["x".repeat(61)] }, "forbidden_terms"],
  ];
  for (const [input, field] of cases) {
    try {
      validateBrandVoice(input);
      assert.fail(`expected a refusal for ${field}`);
    } catch (error) {
      assert.ok(error instanceof CommerceError, field);
      assert.equal(error.code, "validation");
      assert.ok(Object.keys(error.fields).length > 0);
      assert.doesNotMatch(error.message, /cheapest|x{20}|bad/, "message does not echo the submitted value");
    }
  }
});

test("a brand voice profile saved for one company is not readable by another", async () => {
  const store = fakeBrandStore();
  const service = createBrandVoiceService({ store, now: () => NOW });
  await service.save(COMPANY_B, CHATBOT_A, VALID_VOICE, "staff-b");
  assert.equal(await service.get(COMPANY_A, CHATBOT_A), null);
  assert.equal(await service.remove(COMPANY_A, CHATBOT_A), false, "company A cannot remove company B's profile");
  assert.ok(await service.get(COMPANY_B, CHATBOT_A));
});

test("brand voice save then get returns the profile for the same company only", async () => {
  const store = fakeBrandStore();
  const service = createBrandVoiceService({ store, now: () => NOW });
  const saved = await service.save(COMPANY_A, CHATBOT_A, VALID_VOICE, "staff-a");
  assert.equal(saved.companyId, COMPANY_A);
  assert.equal(saved.updatedBy, "staff-a");
  const loaded = await service.get(COMPANY_A, CHATBOT_A);
  assert.deepEqual(loaded.preferredTerms, ["eco-friendly", "fully insured"]);
  assert.equal(await service.get(COMPANY_A, CHATBOT_B), null);
});

test("toBrandGuide maps a saved profile to the guide listing intelligence reads", () => {
  const guide = toBrandGuide({ preferredTerms: ["a"], forbiddenTerms: ["b"] });
  assert.deepEqual(guide, { preferredTerms: ["a"], forbiddenTerms: ["b"] });
});

test("brand voice Drizzle queries bind company_id, and the upsert conflicts only within the company", async () => {
  const { db, statements } = recordingDb();
  const store = createDrizzleBrandVoiceStore(db);
  assert.equal(await store.find(COMPANY_A, CHATBOT_A), null);
  await store.upsert({ ...VALID_VOICE, companyId: COMPANY_A, chatbotId: CHATBOT_A, updatedBy: "staff-a", updatedAt: NOW, preferredTerms: [], forbiddenTerms: [] });
  assert.equal(await store.remove(COMPANY_A, CHATBOT_A), false);
  assert.equal(statements.length, 3);
  for (const s of statements) {
    assert.match(s.text, /"company_id"/);
    assert.ok(s.params.includes(COMPANY_A), "companyId is bound");
    assert.ok(!s.params.includes(COMPANY_B));
  }
  const upsert = statements.find((s) => /^insert/i.test(s.text));
  assert.match(upsert.text, /on conflict \("company_id",\s*"chatbot_id"\)/i);
});

// ---------------------------------------------------------------------------
// Marketplace write path
// ---------------------------------------------------------------------------

test("with the marketplace write flag off, nothing reaches the marketplace runtime", async () => {
  for (const value of [undefined, "1", "yes", "TRUE", "false"]) {
    const runtime = fakeWriteRuntime();
    const path = createMarketplaceWritePath({ runtime, env: { [CONTRACT_FLAGS.MARKETPLACE_WRITE_ENABLED]: value } });
    await assert.rejects(() => path.prepare(COMPANY_A, ownerA, { connectionId: "c", externalListingId: "L", operation: "update_price", changes: {}, expectedSourceHash: "h", idempotencyKey: "k" }), (e) => e instanceof CommerceError && e.code === "flag_disabled");
    await assert.rejects(() => path.confirmAndExecute(COMPANY_A, ownerA, "prop-1", "tok-1"), (e) => e instanceof CommerceError && e.code === "flag_disabled");
    assert.deepEqual(runtime.log, [], `flag value ${value}`);
  }
});

test("prepare stores a proposal and returns the token, without confirming or executing", async () => {
  const runtime = fakeWriteRuntime();
  const path = createMarketplaceWritePath({ runtime, env: enabledEnv });
  const prepared = await path.prepare(COMPANY_A, ownerA, { connectionId: "c", externalListingId: "L-1", operation: "update_price", changes: { priceMinor: 1200 }, expectedSourceHash: "h", idempotencyKey: "k-1" });
  assert.equal(prepared.proposalId, "prop-1");
  assert.equal(prepared.confirmationToken, "tok-1");
  assert.deepEqual(runtime.log.map((l) => l[0]), ["prepare"]);
});

test("an approved write reaches the marketplace runtime only after confirmation", async () => {
  const runtime = fakeWriteRuntime();
  const path = createMarketplaceWritePath({ runtime, env: enabledEnv });
  const done = await path.confirmAndExecute(COMPANY_A, ownerA, "prop-1", "tok-1");
  assert.deepEqual(runtime.log.map((l) => l[0]), ["confirm", "execute"]);
  assert.equal(done.status, "executed");
});

test("a rejected token stops the write before execute", async () => {
  const runtime = fakeWriteRuntime({ confirmThrows: true });
  const path = createMarketplaceWritePath({ runtime, env: enabledEnv });
  await assert.rejects(() => path.confirmAndExecute(COMPANY_A, ownerA, "prop-1", "wrong-token"), /confirmation_invalid/);
  assert.deepEqual(runtime.log.map((l) => l[0]), ["confirm"]);
});

test("a confirm that does not approve the proposal never reaches execute", async () => {
  const runtime = fakeWriteRuntime({ confirmStatus: "conflict_blocked" });
  const path = createMarketplaceWritePath({ runtime, env: enabledEnv });
  await assert.rejects(() => path.confirmAndExecute(COMPANY_A, ownerA, "prop-1", "tok-1"), (e) => e instanceof CommerceError && e.code === "conflict");
  assert.ok(!runtime.log.some((l) => l[0] === "execute"));
});

test("a blocked proposal has no token, so confirmAndExecute refuses before the runtime is called", async () => {
  const runtime = fakeWriteRuntime({ preparedStatus: "conflict_blocked" });
  const path = createMarketplaceWritePath({ runtime, env: enabledEnv });
  const prepared = await path.prepare(COMPANY_A, ownerA, { connectionId: "c", externalListingId: "L-1", operation: "update_price", changes: { priceMinor: 1 }, expectedSourceHash: "h", idempotencyKey: "k-2" });
  assert.equal(prepared.confirmationToken, null);
  await assert.rejects(() => path.confirmAndExecute(COMPANY_A, ownerA, prepared.proposalId, ""), (e) => e instanceof CommerceError && e.code === "validation");
  assert.deepEqual(runtime.log.map((l) => l[0]), ["prepare"]);
});

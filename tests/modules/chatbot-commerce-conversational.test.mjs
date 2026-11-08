// Conversational commerce tests (node:test). No network, no provider keys, no real database.
// Fakes stand in for every port. Drizzle SQL is rendered with PgDialect and checked for company_id filters.
//
// Run: NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types tests/modules/chatbot-commerce-conversational.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { getTableColumns } from "drizzle-orm";

import { CommerceError } from "../../server/modules/chatbot/commerce/conversational/errors.ts";
import {
  APPROVAL_PERMISSION,
  assertCanApprove,
  communicationAuthority,
  resolveCommerceRole,
} from "../../server/modules/chatbot/commerce/conversational/authority.ts";
import {
  issueSessionToken,
  verifySessionToken,
  assertSessionRequest,
  requiredCapability,
} from "../../server/modules/chatbot/commerce/conversational/session-authority.ts";
import {
  createCommerceCredentialService,
  containsSecretKey,
  redactSecrets,
  normaliseCredentials,
} from "../../server/modules/chatbot/commerce/conversational/credentials.ts";
import { createConversationalCommerce } from "../../server/modules/chatbot/commerce/conversational/conversational-runtime.ts";
import { createCommunications, defaultPolicy } from "../../server/modules/chatbot/commerce/conversational/communications.ts";
import {
  createListingIntelligence,
  composeListing,
  scanListing,
  defaultComplianceRules,
} from "../../server/modules/chatbot/commerce/conversational/listing-intelligence.ts";
import { productCards, cartCard, approvalCard } from "../../server/modules/chatbot/commerce/conversational/cards.ts";
import {
  createDrizzleApprovalActionStore,
  createDrizzleCredentialRecordStore,
  createDrizzleCommunicationStore,
} from "../../server/modules/chatbot/commerce/conversational/drizzle-stores.ts";
import {
  chatbotCommerceApprovalActions,
  chatbotCommerceCredentials,
  chatbotCommerceCommThreads,
  chatbotCommerceCommMessages,
  chatbotCommerceCommPolicies,
  chatbotCommerceEscalations,
  chatbotCommerceListingProposals,
  chatbotCommerceListingRules,
  chatbotCommerceShoppingSessions,
} from "../../server/modules/chatbot/db/commerce-conversational.ts";
import { readFlag, CONTRACT_FLAGS } from "../../server/modules/chatbot/contracts/index.ts";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const CHATBOT_A = "chatbot-a";
const CHATBOT_B = "chatbot-b";
const SECRET = "s".repeat(40);
const NOW = new Date("2026-11-08T10:00:00Z");
const dialect = new PgDialect();

let counter = 0;
const newId = () => `id-${++counter}`;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function approvalFake() {
  const rows = new Map();
  return {
    rows,
    async findById(companyId, id) { const r = rows.get(id); return r && r.companyId === companyId ? { ...r } : null; },
    async findByIdempotencyKey(companyId, chatbotId, scope, key) {
      for (const r of rows.values()) {
        if (r.companyId === companyId && r.chatbotId === chatbotId && r.scope === scope && r.idempotencyKey === key) return { ...r };
      }
      return null;
    },
    async insert(a) { rows.set(a.id, { ...a }); },
    async transition(companyId, id, from, patch) {
      const r = rows.get(id);
      if (!r || r.companyId !== companyId || !from.includes(r.status)) return false;
      Object.assign(r, patch);
      return true;
    },
  };
}

function sessionFake() {
  const m = new Map();
  return {
    async load(c, b, s) { const v = m.get(`${c}|${b}|${s}`); return v ? { ...v } : null; },
    async save(state) { m.set(`${state.companyId}|${state.chatbotId}|${state.sessionId}`, { ...state }); },
  };
}

function catalogFake(products) {
  return {
    async search(companyId, chatbotId, query) {
      return products.filter((p) => p.companyId === companyId && p.chatbotId === chatbotId && p.name.toLowerCase().includes(query.toLowerCase()));
    },
    async findProducts(companyId, chatbotId, ids) {
      return products.filter((p) => p.companyId === companyId && p.chatbotId === chatbotId && ids.includes(p.id));
    },
  };
}

function cartFake() {
  const carts = new Map();
  const calls = { addLine: 0, applyCoupon: 0 };
  const cartKey = (c, b, s) => `${c}|${b}|${s}`;
  return {
    calls,
    carts,
    async getOrCreate(companyId, chatbotId, sessionId) {
      const key = cartKey(companyId, chatbotId, sessionId);
      if (!carts.has(key)) carts.set(key, { companyId, id: `cart-${carts.size + 1}`, sessionId, currency: "AUD", totalMinor: 0, version: 0, lines: [] });
      return structuredClone(carts.get(key));
    },
    async addLine(companyId, cartId, variantId, quantity) {
      calls.addLine += 1;
      const cart = [...carts.values()].find((c) => c.companyId === companyId && c.id === cartId);
      cart.lines.push({ variantId, name: "item", quantity, unitPriceMinor: 1000 });
      cart.totalMinor += 1000 * quantity;
      cart.version += 1;
      return structuredClone(cart);
    },
    async applyCoupon(companyId, cartId, code) {
      calls.applyCoupon += 1;
      const cart = [...carts.values()].find((c) => c.companyId === companyId && c.id === cartId);
      return structuredClone(cart);
    },
  };
}

const PRODUCTS = [
  { id: 1, companyId: COMPANY_A, chatbotId: CHATBOT_A, name: "Blue Kettle", priceMinor: 4500, currency: "AUD", shortDescription: "Steel kettle", active: true,
    variants: [{ id: 11, name: "1L", priceMinor: 4500, currency: "AUD", inStock: true }] },
  { id: 2, companyId: COMPANY_A, chatbotId: CHATBOT_A, name: "Red Mug", priceMinor: 1200, currency: "AUD", shortDescription: null, active: true,
    variants: [{ id: 21, name: "Std", priceMinor: 1200, currency: "AUD", inStock: true }, { id: 22, name: "Large", priceMinor: 1500, currency: "AUD", inStock: true }] },
  { id: 3, companyId: COMPANY_A, chatbotId: CHATBOT_A, name: "Retired Pot", priceMinor: 900, currency: "AUD", shortDescription: null, active: false,
    variants: [{ id: 31, name: "Std", priceMinor: 900, currency: "AUD", inStock: false }] },
  { id: 900, companyId: COMPANY_B, chatbotId: CHATBOT_B, name: "Rival Kettle", priceMinor: 100, currency: "AUD", shortDescription: null, active: true,
    variants: [{ id: 91, name: "Std", priceMinor: 100, currency: "AUD", inStock: true }] },
];

function buildShopping(overrides = {}) {
  const approvals = approvalFake();
  const cart = cartFake();
  const checkoutCalls = [];
  const deps = {
    approvals,
    sessions: sessionFake(),
    catalog: catalogFake(PRODUCTS),
    cart,
    budget: { async assertAllowed(_c, _b, _s, total) { if (total > (overrides.limitMinor ?? 1e9)) throw new CommerceError("validation", "Spend limit exceeded."); } },
    checkout: { async prepare(c, cartId, v, key) { checkoutCalls.push({ c, cartId, v, key }); return { checkoutId: "co-1", status: "ready", totalMinor: 0, currency: "AUD" }; } },
    orders: {
      orders: overrides.orders ?? [],
      async findScoped(companyId, chatbotId, orderNumber, scope) {
        return this.orders.find((o) => o.companyId === companyId && o.chatbotId === chatbotId && o.orderNumber === orderNumber
          && (o.sessionId === scope.sessionId || (scope.customerId !== null && o.customerId === scope.customerId))) ?? null;
      },
      async requestReturn() { return { rmaNumber: "RMA-1", status: "requested", requestedAmountMinor: 1200, currency: "AUD" }; },
    },
    now: () => NOW,
    newId,
  };
  return { rt: createConversationalCommerce(deps), approvals, cart, checkoutCalls, deps };
}

const STAFF_MANAGER = { type: "staff", role: "seller_steward", permissions: ["chatbot-ecommerce.manage-payments", "chatbot-ecommerce.manage-orders", "chatbot-ecommerce.manage-checkout", "chatbot-ecommerce.manage-pricing", "chatbot-ecommerce.manage-customer-communications"] };
const SHOPPER = { type: "customer" };

// ---------------------------------------------------------------------------
// Proposed actions wait for confirmation
// ---------------------------------------------------------------------------

test("prepared add-to-cart does not touch the cart until the shopper confirms", async () => {
  const { rt, cart } = buildShopping();
  const sid = "session-0000000001";
  await rt.search(COMPANY_A, CHATBOT_A, sid, "kettle");
  const prepared = await rt.prepareAddToCart(COMPANY_A, CHATBOT_A, sid, { productId: 1, variantId: null, quantity: 2 });
  assert.equal(prepared.status, "awaiting_approval");
  assert.ok(prepared.approvalToken, "a one-time token is returned to the shopper");
  assert.equal(cart.calls.addLine, 0, "nothing runs during preparation");

  const done = await rt.confirm(COMPANY_A, CHATBOT_A, sid, { actionId: prepared.action.id, approvalToken: prepared.approvalToken, approver: SHOPPER, approverId: "shopper" });
  assert.equal(done.replay, false);
  assert.equal(cart.calls.addLine, 1);
});

test("wrong token is refused and leaves the action unchanged", async () => {
  const { rt, cart, approvals } = buildShopping();
  const sid = "session-0000000002";
  await rt.search(COMPANY_A, CHATBOT_A, sid, "mug");
  const prepared = await rt.prepareAddToCart(COMPANY_A, CHATBOT_A, sid, { productId: 2, variantId: 21, quantity: 1 });
  await assert.rejects(
    () => rt.confirm(COMPANY_A, CHATBOT_A, sid, { actionId: prepared.action.id, approvalToken: "f".repeat(64), approver: SHOPPER, approverId: "shopper" }),
    (e) => e instanceof CommerceError && e.code === "invalid_token" && !e.message.includes("f".repeat(8)),
  );
  assert.equal(cart.calls.addLine, 0);
  assert.equal(approvals.rows.get(prepared.action.id).status, "awaiting_approval");
});

test("a confirmed action runs once; a second confirmation replays the stored result", async () => {
  const { rt, cart } = buildShopping();
  const sid = "session-0000000003";
  await rt.search(COMPANY_A, CHATBOT_A, sid, "mug");
  const prepared = await rt.prepareAddToCart(COMPANY_A, CHATBOT_A, sid, { productId: 2, variantId: 22, quantity: 1 });
  const conf = { actionId: prepared.action.id, approvalToken: prepared.approvalToken, approver: SHOPPER, approverId: "shopper" };
  await rt.confirm(COMPANY_A, CHATBOT_A, sid, conf);
  const replay = await rt.confirm(COMPANY_A, CHATBOT_A, sid, conf);
  assert.equal(replay.replay, true);
  assert.equal(cart.calls.addLine, 1, "the cart is changed once only");
});

test("an expired proposal is refused and marked expired", async () => {
  const { rt, cart, approvals } = buildShopping();
  const sid = "session-0000000004";
  await rt.search(COMPANY_A, CHATBOT_A, sid, "mug");
  const prepared = await rt.prepareAddToCart(COMPANY_A, CHATBOT_A, sid, { productId: 2, variantId: 21, quantity: 1 });
  const later = createConversationalCommerce({ ...buildShopping().deps, approvals, cart, now: () => new Date(NOW.getTime() + 16 * 60_000) });
  await assert.rejects(
    () => later.confirm(COMPANY_A, CHATBOT_A, sid, { actionId: prepared.action.id, approvalToken: prepared.approvalToken, approver: SHOPPER, approverId: "shopper" }),
    (e) => e.code === "expired",
  );
  assert.equal(approvals.rows.get(prepared.action.id).status, "expired");
  assert.equal(cart.calls.addLine, 0);
});

test("an action from another company or another session is reported as not found", async () => {
  const { rt } = buildShopping();
  const sid = "session-0000000005";
  await rt.search(COMPANY_A, CHATBOT_A, sid, "mug");
  const prepared = await rt.prepareAddToCart(COMPANY_A, CHATBOT_A, sid, { productId: 2, variantId: 21, quantity: 1 });
  const conf = { actionId: prepared.action.id, approvalToken: prepared.approvalToken, approver: SHOPPER, approverId: "x" };
  await assert.rejects(() => rt.confirm(COMPANY_B, CHATBOT_B, sid, conf), (e) => e.code === "not_found");
  await assert.rejects(() => rt.confirm(COMPANY_A, CHATBOT_A, "session-other-000001", conf), (e) => e.code === "not_found");
});

test("the product reference is never guessed when the session holds several results", async () => {
  const { rt } = buildShopping();
  const sid = "session-0000000006";
  await rt.search(COMPANY_A, CHATBOT_A, sid, "e"); // several matches, none selected
  await assert.rejects(() => rt.prepareAddToCart(COMPANY_A, CHATBOT_A, sid, { productId: null, variantId: null, quantity: 1 }), (e) => e.code === "validation");
});

test("a return can be proposed only for an order inside the session scope", async () => {
  const orders = [{ id: "o-1", companyId: COMPANY_A, chatbotId: CHATBOT_A, orderNumber: "A-100", sessionId: "session-owner-0001", customerId: 7 }];
  const { rt } = buildShopping({ orders });
  await assert.rejects(
    () => rt.prepareReturn(COMPANY_A, CHATBOT_A, "session-stranger-01", { orderNumber: "A-100", items: [], resolution: "refund", reason: null }),
    (e) => e.code === "not_found",
  );
  const ok = await rt.prepareReturn(COMPANY_A, CHATBOT_A, "session-owner-0001", { orderNumber: "A-100", items: [], resolution: "refund", reason: null });
  assert.equal(ok.status, "awaiting_approval");
});

test("the approval card carries no token hash and no company data from elsewhere", async () => {
  const { rt } = buildShopping();
  const sid = "session-0000000007";
  await rt.search(COMPANY_A, CHATBOT_A, sid, "mug");
  const prepared = await rt.prepareAddToCart(COMPANY_A, CHATBOT_A, sid, { productId: 2, variantId: 21, quantity: 1 });
  const text = JSON.stringify(prepared.ui);
  assert.ok(!text.includes("approval_token_hash") && !text.includes("approvalTokenHash"));
  assert.ok(!text.includes(prepared.approvalToken));
});

// ---------------------------------------------------------------------------
// Staff authority
// ---------------------------------------------------------------------------

test("a shopping-assistant staff role cannot approve anything", () => {
  assert.throws(() => assertCanApprove({ type: "staff", role: "shopping_assistant", permissions: ["chatbot-ecommerce.manage-payments"] }, "issue_refund"), (e) => e.code === "forbidden");
});

test("a staff member without the matching permission is refused, even with a valid role", () => {
  assert.throws(() => assertCanApprove({ type: "staff", role: "seller_steward", permissions: ["chatbot-ecommerce.manage-orders"] }, "issue_refund"), (e) => e.code === "forbidden");
  assertCanApprove({ type: "staff", role: "seller_steward", permissions: [APPROVAL_PERMISSION.issue_refund] }, "issue_refund");
});

test("a customer may confirm only shopping and return actions, never refunds or cancellations", () => {
  assertCanApprove(SHOPPER, "add_to_cart");
  assert.throws(() => assertCanApprove(SHOPPER, "issue_refund"), (e) => e.code === "forbidden");
  assert.throws(() => assertCanApprove(SHOPPER, "cancel_order"), (e) => e.code === "forbidden");
});

test("communications authority: refunds need a verified identity and a configured limit", () => {
  assert.equal(communicationAuthority("issue_refund", { identityVerified: true, amountMinor: 500, limits: { automatic_refund_limit: 1000 } }).level, "execute_within_limits");
  assert.equal(communicationAuthority("issue_refund", { identityVerified: false, amountMinor: 500, limits: { automatic_refund_limit: 1000 } }).level, "require_approval");
  assert.equal(communicationAuthority("issue_refund", { identityVerified: true, amountMinor: 500, limits: {} }).level, "require_approval");
  assert.equal(communicationAuthority("legal_threat").level, "human_only");
  assert.equal(communicationAuthority("something_new").level, "require_approval", "unknown actions fail closed");
});

test("role routing: support intents go to customer communications, shopping stays with the assistant", () => {
  assert.equal(resolveCommerceRole({ actorType: "customer", requestedRole: "shopping_assistant", intent: "tracking" }), "customer_communications");
  assert.equal(resolveCommerceRole({ actorType: "customer", requestedRole: "shopping_assistant", intent: "" }), "shopping_assistant");
  assert.equal(resolveCommerceRole({ actorType: "seller", requestedRole: "seller_steward", authenticated: false }), "shopping_assistant");
  assert.equal(resolveCommerceRole({ actorType: "seller", requestedRole: "seller_steward", authenticated: true }), "seller_steward");
});

// ---------------------------------------------------------------------------
// Customer communications
// ---------------------------------------------------------------------------

function buildComms(options = {}) {
  const threads = new Map();
  const messages = new Map();
  const escalations = [];
  const policies = new Map();
  const approvals = approvalFake();
  const refunds = [];
  const orderCalls = { cancel: 0, correctAddress: 0, requestReturn: 0 };
  const orders = [{ id: "ord-1", companyId: COMPANY_A, chatbotId: CHATBOT_A, orderNumber: "A-900", status: "paid", fulfilmentStatus: "unfulfilled", sessionId: "sess-comm-0000001", customerId: 42, shippingAddress: {} }];
  const store = {
    async findMessageByExternalId(c, b, ch, ext) { for (const m of messages.values()) if (m.companyId === c && m.chatbotId === b && m.channel === ch && m.externalMessageId === ext) return { ...m }; return null; },
    async findThreadByExternalId(c, b, ch, ext) { for (const t of threads.values()) if (t.companyId === c && t.chatbotId === b && t.channel === ch && t.externalThreadId === ext) return { ...t }; return null; },
    async findThread(c, id) { const t = threads.get(id); return t && t.companyId === c ? { ...t } : null; },
    async saveThread(t) { threads.set(t.id, { ...t }); },
    async insertThread(t) { threads.set(t.id, { ...t }); },
    async insertMessage(m) { messages.set(m.id, { ...m }); },
    async findMessage(c, id) { const m = messages.get(id); return m && m.companyId === c ? { ...m } : null; },
    async latestInbound(c, threadId) { const list = [...messages.values()].filter((m) => m.companyId === c && m.threadId === threadId && m.direction === "inbound"); return list.length ? { ...list[list.length - 1] } : null; },
    async getPolicy(c, b) { return policies.get(`${c}|${b}`) ?? null; },
    async insertEscalation(e) { escalations.push({ ...e }); },
  };
  if (options.policy) policies.set(`${COMPANY_A}|${CHATBOT_A}`, { ...defaultPolicy(COMPANY_A, CHATBOT_A), ...options.policy });
  const deps = {
    store,
    approvals,
    facts: {
      async load(c, b, scope) {
        const mine = orders.filter((o) => o.companyId === c && o.chatbotId === b && (o.sessionId === scope.sessionId || o.customerId === scope.customerId));
        return {
          activeCart: null,
          orders: mine.map((o) => ({ id: o.id, orderNumber: o.orderNumber, status: o.status })),
          payments: mine.length ? [{ id: "pay-1", status: "captured", capturedMinor: 5000, refundedMinor: 0, currency: "AUD" }] : [],
          fulfilments: [],
          returns: [],
        };
      },
    },
    orders: {
      async findScoped(c, b, orderId, scope) {
        return orders.find((o) => o.companyId === c && o.chatbotId === b && o.id === orderId && (o.sessionId === scope.sessionId || o.customerId === scope.customerId)) ?? null;
      },
      async requestReturn() { orderCalls.requestReturn += 1; return { rmaNumber: "RMA-7", status: "requested" }; },
      async cancel() { orderCalls.cancel += 1; return { status: "cancelled" }; },
      async correctAddress() { orderCalls.correctAddress += 1; return { status: "corrected" }; },
    },
    refunds: { async refund(c, paymentId, amountMinor, currency) { refunds.push({ c, paymentId, amountMinor, currency }); return { refundedMinor: amountMinor, status: "refunded" }; } },
    env: options.env ?? {},
    now: () => NOW,
    newId,
  };
  const comms = createCommunications(deps);
  return { comms, threads, messages, escalations, approvals, refunds, orderCalls };
}

const SHOP_SESSION = "sess-comm-0000001";

test("unverified identity: the draft shares no order, payment or return facts", async () => {
  const { comms } = buildComms();
  const ing = await comms.ingest(COMPANY_A, CHATBOT_A, { channel: "email", body: "Where is my order status?", externalThreadId: "t-1", sessionId: SHOP_SESSION, customerId: 42, identityVerified: false });
  const { draft } = await comms.draftReply(COMPANY_A, CHATBOT_A, ing.thread.id);
  assert.equal(draft.facts.orders.length, 0);
  assert.equal(draft.facts.payments.length, 0);
  assert.ok(!draft.text.includes("A-900"));
});

test("verified identity: the draft may state the order status it found", async () => {
  const { comms } = buildComms();
  const ing = await comms.ingest(COMPANY_A, CHATBOT_A, { channel: "email", body: "order status please", externalThreadId: "t-2", sessionId: SHOP_SESSION, customerId: 42, identityVerified: true });
  const { draft } = await comms.draftReply(COMPANY_A, CHATBOT_A, ing.thread.id);
  assert.ok(draft.text.includes("A-900"));
});

test("a duplicate external message id returns the stored message and writes nothing new", async () => {
  const { comms, messages } = buildComms();
  const first = await comms.ingest(COMPANY_A, CHATBOT_A, { channel: "whatsapp", body: "hello", externalMessageId: "wa-1", externalThreadId: "t-3" });
  const before = messages.size;
  const again = await comms.ingest(COMPANY_A, CHATBOT_A, { channel: "whatsapp", body: "hello", externalMessageId: "wa-1", externalThreadId: "t-3" });
  assert.equal(again.duplicate, true);
  assert.equal(again.message.id, first.message.id);
  assert.equal(messages.size, before);
});

test("a draft never sends, and auto-send stays off under the default policy", async () => {
  const { comms } = buildComms();
  const ing = await comms.ingest(COMPANY_A, CHATBOT_A, { channel: "web", body: "what is your return policy for kettles", externalThreadId: "t-4" });
  const { draft } = await comms.draftReply(COMPANY_A, CHATBOT_A, ing.thread.id);
  assert.equal(draft.canAutoSend, false);
  assert.equal(draft.constraints.do_not_invent_tracking_payment_or_refund_state, true);
});

test("a refund is proposed, not run, and the refund port stays idle until approval", async () => {
  const { comms, refunds } = buildComms({ env: { CHATBOT_PAYMENTS_ENABLED: "true" } });
  const ing = await comms.ingest(COMPANY_A, CHATBOT_A, { channel: "email", body: "refund status please", externalThreadId: "t-5", sessionId: SHOP_SESSION, customerId: 42, identityVerified: true });
  const prepared = await comms.prepareAction(COMPANY_A, CHATBOT_A, ing.thread.id, { actionType: "issue_refund", payload: { order_id: "ord-1", payment_id: "pay-1", amount_minor: 2000, currency: "AUD" }, idempotencyKey: "k-refund-1" });
  assert.equal(prepared.action.status, "awaiting_approval");
  assert.equal(refunds.length, 0);
  const done = await comms.executeApproved(COMPANY_A, CHATBOT_A, ing.thread.id, prepared.action.id, { approvalToken: prepared.approvalToken, approver: STAFF_MANAGER, approverId: "staff-1" });
  assert.equal(done.result.type, "payment_refunded");
  assert.equal(refunds.length, 1);
});

test("a refund is refused when CHATBOT_PAYMENTS_ENABLED is not exactly true", async () => {
  const { comms, refunds } = buildComms({ env: { CHATBOT_PAYMENTS_ENABLED: "yes" } });
  const ing = await comms.ingest(COMPANY_A, CHATBOT_A, { channel: "email", body: "refund please", externalThreadId: "t-6", sessionId: SHOP_SESSION, customerId: 42, identityVerified: true });
  const prepared = await comms.prepareAction(COMPANY_A, CHATBOT_A, ing.thread.id, { actionType: "issue_refund", payload: { order_id: "ord-1", payment_id: "pay-1", amount_minor: 2000 }, idempotencyKey: "k-refund-2" });
  await assert.rejects(
    () => comms.executeApproved(COMPANY_A, CHATBOT_A, ing.thread.id, prepared.action.id, { approvalToken: prepared.approvalToken, approver: STAFF_MANAGER, approverId: "staff-1" }),
    (e) => e.code === "flag_disabled",
  );
  assert.equal(refunds.length, 0);
});

test("a staff member with no payments permission cannot approve a refund", async () => {
  const { comms } = buildComms({ env: { CHATBOT_PAYMENTS_ENABLED: "true" } });
  const ing = await comms.ingest(COMPANY_A, CHATBOT_A, { channel: "email", body: "refund please", externalThreadId: "t-7", sessionId: SHOP_SESSION, customerId: 42, identityVerified: true });
  const prepared = await comms.prepareAction(COMPANY_A, CHATBOT_A, ing.thread.id, { actionType: "issue_refund", payload: { order_id: "ord-1", payment_id: "pay-1", amount_minor: 2000 }, idempotencyKey: "k-refund-3" });
  const weakStaff = { type: "staff", role: "customer_communications", permissions: ["chatbot-ecommerce.manage-orders"] };
  await assert.rejects(
    () => comms.executeApproved(COMPANY_A, CHATBOT_A, ing.thread.id, prepared.action.id, { approvalToken: prepared.approvalToken, approver: weakStaff, approverId: "staff-2" }),
    (e) => e.code === "forbidden",
  );
});

test("an action pointing at another customer's order is refused as not found", async () => {
  const { comms, orderCalls } = buildComms();
  const ing = await comms.ingest(COMPANY_A, CHATBOT_A, { channel: "email", body: "cancel my order", externalThreadId: "t-8", sessionId: "sess-stranger-0001", customerId: 99, identityVerified: true });
  const prepared = await comms.prepareAction(COMPANY_A, CHATBOT_A, ing.thread.id, { actionType: "cancel_order", payload: { order_id: "ord-1" }, idempotencyKey: "k-cancel-1" });
  // The shopper cannot cancel at all. A staff member with order rights still cannot reach another customer's order.
  await assert.rejects(
    () => comms.executeApproved(COMPANY_A, CHATBOT_A, ing.thread.id, prepared.action.id, { approvalToken: prepared.approvalToken, approver: SHOPPER, approverId: "x" }),
    (e) => e.code === "forbidden",
  );
  await assert.rejects(
    () => comms.executeApproved(COMPANY_A, CHATBOT_A, ing.thread.id, prepared.action.id, { approvalToken: prepared.approvalToken, approver: STAFF_MANAGER, approverId: "staff-3" }),
    (e) => e.code === "not_found",
  );
  assert.equal(orderCalls.cancel, 0);
});

test("a legal threat becomes a human-only handoff, not an action", async () => {
  const { comms, escalations } = buildComms();
  const ing = await comms.ingest(COMPANY_A, CHATBOT_A, { channel: "email", body: "I will sue you", externalThreadId: "t-9" });
  assert.equal(ing.authority.level, "human_only");
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].reason, "legal_threat");
  assert.equal(escalations[0].companyId, COMPANY_A);
});

test("a discount is never issued from here: it becomes a connected-system handoff", async () => {
  const { comms, approvals, escalations } = buildComms();
  const ing = await comms.ingest(COMPANY_A, CHATBOT_A, { channel: "email", body: "can I have a discount", externalThreadId: "t-10" });
  const out = await comms.prepareAction(COMPANY_A, CHATBOT_A, ing.thread.id, { actionType: "offer_discount", payload: {}, idempotencyKey: "k-disc-1" });
  assert.equal(out.action, null);
  assert.equal(approvals.rows.size, 0);
  assert.equal(escalations.at(-1).reason, "connected_system_required");
});

test("communications rows from another company are treated as absent", async () => {
  const { comms } = buildComms();
  const ing = await comms.ingest(COMPANY_A, CHATBOT_A, { channel: "web", body: "hi", externalThreadId: "t-11" });
  await assert.rejects(() => comms.draftReply(COMPANY_B, CHATBOT_B, ing.thread.id), (e) => e.code === "not_found");
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** SecretBox fake that binds companyId as associated data, as the contract requires. */
function secretBoxFake() {
  const key = "k".repeat(32);
  return {
    async encrypt(companyId, plaintext) {
      const ciphertext = Buffer.from(`${companyId}\u0000${plaintext}`).toString("base64");
      return { v: 1, alg: "aes-256-gcm", keyId: "v1", iv: "AA==", tag: "AA==", ciphertext };
    },
    async decrypt(companyId, sealed) {
      const [b64] = sealed.ciphertext.split(":");
      const raw = Buffer.from(b64, "base64").toString("utf8");
      const [bound, plain] = [raw.slice(0, raw.indexOf("\u0000")), raw.slice(raw.indexOf("\u0000") + 1)];
      if (bound !== companyId) throw new Error("associated data mismatch");
      return plain;
    },
  };
}

function credentialRecordsFake() {
  const rows = new Map();
  return {
    rows,
    async findById(c, id) { const r = rows.get(id); return r && r.companyId === c ? { ...r } : null; },
    async findByProvider(c, chatbotId, provider) { for (const r of rows.values()) if (r.companyId === c && r.chatbotId === chatbotId && r.provider === provider) return { ...r }; return null; },
    async save(r) { rows.set(r.id, { ...r }); },
  };
}

const OWNER = { companyId: COMPANY_A, chatbotId: CHATBOT_A, ownerUserId: "owner-1" };
const TOKEN_VALUE = "shpat_SUPERSECRETVALUE_1234567890";

test("stored credentials never appear in summaries, store results or errors", async () => {
  const records = credentialRecordsFake();
  const svc = createCommerceCredentialService({ records, secretBox: secretBoxFake(), now: () => NOW, newId });
  const summary = await svc.store(OWNER, "owner-1", "shopify", { access_token: TOKEN_VALUE }, { domain: "shop.example.test" });
  assert.ok(!JSON.stringify(summary).includes(TOKEN_VALUE));
  assert.ok(!JSON.stringify(await svc.summary(OWNER, "shopify")).includes(TOKEN_VALUE));
  assert.equal(summary.configured, true);
  const stored = JSON.stringify([...records.rows.values()]);
  assert.ok(!stored.includes(TOKEN_VALUE), "the row holds only the sealed form");
  await assert.rejects(() => svc.store(OWNER, "owner-1", "shopify", { access_token: "   " }), (e) => !String(e.message).includes(TOKEN_VALUE));
  await assert.rejects(
    () => svc.store(OWNER, "owner-1", "shopify", { access_token: TOKEN_VALUE }, { access_token: TOKEN_VALUE }),
    (e) => e.code === "validation" && !e.message.includes(TOKEN_VALUE),
  );
});

test("a credential opens for its own company only, and never for another", async () => {
  const records = credentialRecordsFake();
  const svc = createCommerceCredentialService({ records, secretBox: secretBoxFake(), now: () => NOW, newId });
  const summary = await svc.store(OWNER, "owner-1", "woocommerce", { consumer_key: "ck_1", consumer_secret: "cs_1" }, { domain: "shop.example.test" });
  const id = [...records.rows.keys()][0];
  const opened = await svc.load(COMPANY_A, id);
  assert.deepEqual(opened, { consumer_key: "ck_1", consumer_secret: "cs_1" });
  assert.equal(await svc.load(COMPANY_B, id), null, "another tenant sees nothing");
  assert.ok(summary.fingerprint && summary.fingerprint.length === 64);
});

test("only the owner can store or revoke credentials", async () => {
  const records = credentialRecordsFake();
  const svc = createCommerceCredentialService({ records, secretBox: secretBoxFake(), now: () => NOW, newId });
  await assert.rejects(() => svc.store(OWNER, "someone-else", "shopify", { access_token: TOKEN_VALUE }), (e) => e.code === "forbidden");
  await assert.rejects(() => svc.revoke(OWNER, "someone-else", "shopify"), (e) => e.code === "forbidden");
});

test("secret values are refused in configuration, and the error names no value", async () => {
  const records = credentialRecordsFake();
  const svc = createCommerceCredentialService({ records, secretBox: secretBoxFake(), now: () => NOW, newId });
  await assert.rejects(
    () => svc.store(OWNER, "owner-1", "shopify", { access_token: TOKEN_VALUE }, { nested: { api_key: TOKEN_VALUE } }),
    (e) => e.code === "validation" && !e.message.includes(TOKEN_VALUE) && !JSON.stringify(e.fields).includes(TOKEN_VALUE),
  );
});

test("connection test uses the injected probe and reports failure without the error detail", async () => {
  const records = credentialRecordsFake();
  const svc = createCommerceCredentialService({ records, secretBox: secretBoxFake(), now: () => NOW, newId });
  await svc.store(OWNER, "owner-1", "shopify", { access_token: TOKEN_VALUE }, { domain: "shop.example.test" });
  const seen = [];
  const http = async (req) => { seen.push(req); return { status: 200, headers: {}, body: "{}" }; };
  const probeOk = async (provider, domain, creds, client) => { await client({ method: "GET", url: `https://${domain}/x`, timeoutMs: 5000 }); return creds.access_token === TOKEN_VALUE; };
  const ok = await svc.testConnection(OWNER, "owner-1", "shopify", probeOk, http);
  assert.equal(ok.connected, true);
  assert.equal(seen[0].timeoutMs, 5000);

  const probeBoom = async () => { throw new Error(`leaked ${TOKEN_VALUE}`); };
  const bad = await svc.testConnection(OWNER, "owner-1", "shopify", probeBoom, http);
  assert.equal(bad.connected, false);
  assert.ok(!JSON.stringify(bad).includes(TOKEN_VALUE));
});

test("no global fetch is used during credential work", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("network is not allowed in tests"); };
  try {
    const records = credentialRecordsFake();
    const svc = createCommerceCredentialService({ records, secretBox: secretBoxFake(), now: () => NOW, newId });
    await svc.store(OWNER, "owner-1", "shopify", { access_token: TOKEN_VALUE });
    await svc.revoke(OWNER, "owner-1", "shopify");
  } finally {
    globalThis.fetch = original;
  }
});

test("redaction and secret-key detection", () => {
  assert.equal(containsSecretKey({ a: { consumer_secret: "x" } }), true);
  assert.equal(containsSecretKey({ domain: "x.test" }), false);
  assert.deepEqual(redactSecrets({ access_token: "abc", domain: "d" }), { access_token: "[REDACTED]", domain: "d" });
  assert.throws(() => normaliseCredentials("woocommerce", { consumer_key: "k" }), (e) => e.code === "validation");
});

test("the commerce session secret must be long enough", () => {
  assert.throws(() => issueSessionToken({ chatbot_id: 1, chatbot_uuid: "u", session_id: "session-0000000001", capabilities: ["cart:read"] }, "short"), (e) => e instanceof CommerceError);
});

// ---------------------------------------------------------------------------
// Session authority
// ---------------------------------------------------------------------------

test("session token round-trips and rejects tampering, a wrong secret, and expiry", () => {
  const claims = { chatbot_id: 1, chatbot_uuid: "chatbot-uuid-1", session_id: "session-0000000008", capabilities: ["cart:read"] };
  const { token, expiresIn } = issueSessionToken(claims, SECRET, { ttlSeconds: 600, nowSeconds: 1000 });
  assert.equal(expiresIn, 600);
  const verified = verifySessionToken(token, SECRET, 1100);
  assert.equal(verified.chatbot_id, 1);
  assert.throws(() => verifySessionToken(token, "x".repeat(40), 1100), (e) => e.code === "invalid_token");
  const [body] = token.split(".");
  const forged = `${Buffer.from(JSON.stringify({ ...verified, capabilities: ["checkout:prepare"] })).toString("base64url")}.${token.split(".")[1]}`;
  assert.throws(() => verifySessionToken(forged, SECRET, 1100), (e) => e.code === "invalid_token");
  assert.ok(body.length > 0);
  assert.throws(() => verifySessionToken(token, SECRET, 1000 + 601), (e) => e.code === "invalid_token");
});

test("a session request is refused for another chatbot, session, origin or capability", () => {
  const claims = { v: 1, chatbot_id: 1, chatbot_uuid: "u1", session_id: "session-0000000009", capabilities: ["cart:read"], iat: 0, exp: 9e9, jti: "j", origin: "shop.example.test" };
  const base = { chatbotId: 1, chatbotUuid: "u1", sessionId: "session-0000000009", origin: "shop.example.test", capability: "cart:read" };
  assertSessionRequest(claims, base);
  assert.throws(() => assertSessionRequest(claims, { ...base, chatbotId: 2 }), (e) => e.code === "forbidden");
  assert.throws(() => assertSessionRequest(claims, { ...base, sessionId: "session-other-00002" }), (e) => e.code === "forbidden");
  assert.throws(() => assertSessionRequest(claims, { ...base, origin: "evil.test" }), (e) => e.code === "forbidden");
  assert.throws(() => assertSessionRequest(claims, { ...base, capability: "payment:prepare" }), (e) => e.code === "forbidden");
});

test("route capability mapping follows the middleware fragments", () => {
  assert.equal(requiredCapability("api.cart.store", "POST"), "cart:write");
  assert.equal(requiredCapability("api.payments.intent", "POST"), "payment:prepare");
  assert.equal(requiredCapability("api.support.thread", "GET"), "support:read");
  assert.equal(requiredCapability("api.unknown", "GET"), "catalogue:read");
});

// ---------------------------------------------------------------------------
// Listing intelligence (output only)
// ---------------------------------------------------------------------------

function listingStoreFake() {
  const saved = [];
  return { saved, async rules() { return []; }, async saveProposal(p) { saved.push(p); } };
}

const PRODUCT_OK = {
  companyId: COMPANY_A, chatbotId: CHATBOT_A, productId: 1, canonicalName: "Blue Kettle", brand: "Titan", summary: "A steel kettle. Best ever value.",
  features: ["1 litre capacity", "Stainless steel"], attributes: { colour: "blue" }, claims: [{ claim: "Boils in 3 minutes", evidenceRefs: ["lab-report-7"] }], semanticTags: [],
};

test("listing intelligence exposes no publish, write or push function", () => {
  const li = createListingIntelligence({ store: listingStoreFake(), now: () => NOW, newId });
  assert.deepEqual(Object.keys(li).sort(), ["analyse", "generateRewrite"]);
});

test("a generated listing is saved as output with status ready or blocked, never published", async () => {
  const store = listingStoreFake();
  const li = createListingIntelligence({ store, now: () => NOW, newId });
  const proposal = await li.generateRewrite(COMPANY_A, CHATBOT_A, "amazon", PRODUCT_OK, { forbiddenTerms: ["best ever"], preferredTerms: [] });
  assert.equal(proposal.status, "ready");
  assert.equal(store.saved.length, 1);
  assert.ok(!JSON.stringify(proposal.proposedContent).includes("best ever"), "forbidden brand terms are removed");
  assert.ok(proposal.proposedContent.title.startsWith("Titan Blue Kettle"));
  assert.ok(proposal.proposedContent.bullet_points.length <= 5);
});

test("an unsupported claim or a health claim blocks the proposal", async () => {
  const li = createListingIntelligence({ store: listingStoreFake(), now: () => NOW, newId });
  const unsupported = await li.generateRewrite(COMPANY_A, CHATBOT_A, "ebay", { ...PRODUCT_OK, claims: [{ claim: "Lasts forever", evidenceRefs: [] }] }, { forbiddenTerms: [], preferredTerms: [] });
  assert.equal(unsupported.status, "blocked");
  const health = await li.generateRewrite(COMPANY_A, CHATBOT_A, "generic", { ...PRODUCT_OK, summary: "This will cure stress." }, { forbiddenTerms: [], preferredTerms: [] });
  assert.equal(health.status, "blocked");
  assert.ok(health.findings.some((f) => f.code === "unsupported_health_claim"));
});

test("listing generation refuses a product profile from another company", async () => {
  const li = createListingIntelligence({ store: listingStoreFake(), now: () => NOW, newId });
  await assert.rejects(() => li.generateRewrite(COMPANY_B, CHATBOT_B, "etsy", PRODUCT_OK, { forbiddenTerms: [], preferredTerms: [] }), (e) => e.code === "not_found");
});

test("the composer applies provider limits and the scanner flags guarantees", () => {
  const out = composeListing("etsy", PRODUCT_OK, { forbiddenTerms: [] });
  assert.ok(out.tags.length <= 13);
  const scan = scanListing({ title: "A guaranteed best deal" }, defaultComplianceRules(), { forbiddenTerms: [] });
  assert.ok(scan.findings.some((f) => f.code === "absolute_guarantee"));
  assert.equal(scan.publishable, true, "warnings do not block");
});

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

test("product cards contain only the caller's active products", () => {
  const card = productCards(COMPANY_A, PRODUCTS);
  const names = card.schema.products.map((p) => p.name);
  assert.deepEqual(names, ["Blue Kettle", "Red Mug"]);
  assert.ok(!card.fallback_text.includes("Rival Kettle"));
  assert.ok(!card.fallback_text.includes("Retired Pot"));
});

test("cart cards refuse another company's cart and approval cards hold no token", () => {
  const cart = { companyId: COMPANY_B, id: "c", currency: "AUD", totalMinor: 0, lines: [] };
  assert.equal(cartCard(cart, COMPANY_A), null);
  const card = approvalCard({ id: "a1", actionType: "add_to_cart", status: "awaiting_approval", amountMinor: 100, currency: "AUD", expiresAt: NOW, companyId: COMPANY_A, chatbotId: CHATBOT_A, scope: "conversational", subjectId: "s", authorityLevel: "require_approval", idempotencyKey: "k", approvedBy: null, executedBy: null, payload: {}, result: null, failureReason: null, createdAt: NOW, updatedAt: NOW }, "Add 1 x Kettle");
  assert.ok(!JSON.stringify(card).includes("approval_token"));
});

// ---------------------------------------------------------------------------
// Drizzle tables and queries (rendered, not executed)
// ---------------------------------------------------------------------------

test("every table has a company_id column and every unique index includes it", () => {
  const tables = [chatbotCommerceApprovalActions, chatbotCommerceCredentials, chatbotCommerceCommThreads, chatbotCommerceCommMessages, chatbotCommerceCommPolicies, chatbotCommerceEscalations, chatbotCommerceListingRules, chatbotCommerceListingProposals, chatbotCommerceShoppingSessions];
  for (const table of tables) {
    const cfg = getTableConfig(table);
    assert.ok(cfg.columns.some((c) => c.name === "company_id"), `${cfg.name} has company_id`);
    for (const idx of cfg.indexes) {
      if (idx.config.unique) {
        assert.ok(idx.config.columns.some((c) => c.name === "company_id"), `${idx.config.name} includes company_id`);
      }
    }
    for (const u of cfg.uniqueConstraints) {
      assert.ok(u.columns.some((c) => c.name === "company_id"), `${u.name} includes company_id`);
    }
  }
  assert.ok(Object.keys(getTableColumns(chatbotCommerceCredentials)).includes("sealed"));
  assert.ok(!Object.keys(getTableColumns(chatbotCommerceCredentials)).some((k) => /plain|secret_value|access_token|consumer_secret/i.test(k)), "no plaintext credential column");
});

test("listing proposals accept only ready or blocked as status", () => {
  const cfg = getTableConfig(chatbotCommerceListingProposals);
  const check = cfg.checks.find((c) => c.name === "chatbot_commerce_listing_proposals_status_check");
  const sql = dialect.sqlToQuery(check.value).sql;
  assert.match(sql, /'ready'/);
  assert.match(sql, /'blocked'/);
  assert.doesNotMatch(sql, /published/);
});

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

test("approval store queries carry company_id as a bound parameter", async () => {
  const { db, statements } = recordingDb();
  const store = createDrizzleApprovalActionStore(db);
  assert.equal(await store.findById(COMPANY_A, "a-1"), null);
  await store.findByIdempotencyKey(COMPANY_A, CHATBOT_A, "communication", "k");
  const changed = await store.transition(COMPANY_A, "a-1", ["awaiting_approval"], { status: "approved", approvedBy: "x", updatedAt: NOW });
  assert.equal(changed, false, "no row matched, so no transition");
  assert.ok(statements.length >= 3);
  for (const s of statements) {
    assert.match(s.text, /"company_id"/);
    assert.ok(s.params.includes(COMPANY_A), "companyId is bound");
    assert.ok(!s.params.includes(COMPANY_B));
  }
  const update = statements.find((s) => /^update/i.test(s.text));
  assert.match(update.text, /"status" in/i, "compare-and-set on status");
});

test("credential and communication queries are company-scoped", async () => {
  const { db, statements } = recordingDb();
  const creds = createDrizzleCredentialRecordStore(db);
  const comms = createDrizzleCommunicationStore(db);
  await creds.findById(COMPANY_A, "c-1");
  await creds.findByProvider(COMPANY_A, CHATBOT_A, "shopify");
  await comms.findThread(COMPANY_A, "t-1");
  await comms.latestInbound(COMPANY_A, "t-1");
  await comms.getPolicy(COMPANY_A, CHATBOT_A);
  for (const s of statements) {
    assert.match(s.text, /"company_id"/);
    assert.ok(s.params.includes(COMPANY_A));
  }
});

test("a unique-key collision on insert surfaces as a conflict, not a raw database error", async () => {
  const client = {
    async query() { const e = new Error("duplicate key"); e.code = "23505"; throw e; },
  };
  const store = createDrizzleApprovalActionStore(drizzle(client));
  await assert.rejects(
    () => store.insert({ id: "a-9", companyId: COMPANY_A, chatbotId: CHATBOT_A, scope: "conversational", subjectId: "s", actionType: "add_to_cart", status: "awaiting_approval", authorityLevel: "require_approval", amountMinor: 1, currency: "AUD", idempotencyKey: "dup", approvalTokenHash: null, approvedBy: null, executedBy: null, payload: {}, result: null, failureReason: null, expiresAt: NOW, createdAt: NOW, updatedAt: NOW }),
    (e) => e.code === "conflict",
  );
});

test("the refund flag reads only the exact string true", () => {
  assert.equal(readFlag(CONTRACT_FLAGS.PAYMENTS_ENABLED, { CHATBOT_PAYMENTS_ENABLED: "true" }), true);
  for (const v of ["1", "yes", "on", "TRUE", undefined]) {
    assert.equal(readFlag(CONTRACT_FLAGS.PAYMENTS_ENABLED, { CHATBOT_PAYMENTS_ENABLED: v }), false);
  }
});

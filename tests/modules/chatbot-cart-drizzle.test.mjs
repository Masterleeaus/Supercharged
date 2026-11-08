// Cart and checkout Drizzle storage tests (node:test). No database is reached.
// A recording client stands in for the pool. It captures every statement Drizzle sends and returns
// no rows, so the real DrizzleCartStorage methods run and their SQL can be asserted. Query builders are
// also rendered directly with PgDialect. The in-memory transaction is tested for the lock and rollback.
//
// Run: node --test --experimental-transform-types tests/modules/chatbot-cart-drizzle.test.mjs
// (drizzle-orm is not in builder-test-deps. Use NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs")
import test from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { ChatbotError } from "../../server/modules/chatbot/chatbot-scope.ts";
import { CART_CONSTRAINTS, chatbotCartIdempotencyKeys, chatbotCartLines, chatbotCarts, chatbotCheckoutSessions, chatbotSpendLimits } from "../../server/modules/chatbot/db/cart.ts";
import {
  CartError,
} from "../../server/modules/chatbot/cart/cart-types.ts";
import {
  DrizzleCartStorage,
  createMemoryCartStorage,
  insertOperationQuery,
  mapCartDatabaseError,
  selectCartQuery,
  selectSpendLimitsQuery,
  upsertCartQuery,
  upsertSpendLimitQuery,
  selectActiveCartQuery,
  selectCheckoutQuery,
  insertActiveCartIfAbsentQuery,
} from "../../server/modules/chatbot/cart/cart-storage.ts";
import { createCartService } from "../../server/modules/chatbot/cart/cart-service.ts";
import { passThroughLock } from "../../server/modules/chatbot/cart/keyed-lock.ts";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const dialect = new PgDialect();

/** Fake pg client. Records each statement and returns an empty result. No socket is opened. */
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

function render(query) {
  if (typeof query.getSQL === "function") return dialect.sqlToQuery(query.getSQL());
  return query.toSQL();
}

const isDml = (text) => /^\s*(select|insert|update|delete)\b/i.test(text);

function assertScoped(statement, companyId) {
  assert.ok(statement.params.includes(companyId), `company id not in params: ${statement.text}`);
  if (/^\s*insert\b/i.test(statement.text)) {
    assert.match(statement.text, /"company_id"/, statement.text);
  } else {
    assert.match(statement.text, /"company_id" = \$\d+/, statement.text);
  }
}

const AT = new Date("2026-11-08T10:00:00Z");

const line = (overrides = {}) => ({
  lineKey: "line-key-1",
  variantId: "variant-1",
  productId: "product-1",
  sku: "SKU-1",
  name: "Widget",
  quantity: 2,
  unitPriceMinor: 1250,
  lineTotalMinor: 2500,
  currency: "AUD",
  customisation: { size: "M" },
  ...overrides,
});

const cartRecord = (overrides = {}) => ({
  id: "cart-1",
  companyId: COMPANY_A,
  chatbotId: "bot-1",
  conversationId: "conv-1",
  customerId: null,
  status: "active",
  currency: "AUD",
  lines: [line()],
  subtotalMinor: 2500,
  discountMinor: 0,
  totalMinor: 2500,
  version: 1,
  expiresAt: new Date("2026-11-15T10:00:00Z"),
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

const checkoutRecord = (overrides = {}) => ({
  id: "checkout-1",
  companyId: COMPANY_A,
  cartId: "cart-1",
  chatbotId: "bot-1",
  conversationId: "conv-1",
  customerId: null,
  status: "open",
  currency: "AUD",
  lines: [line()],
  subtotalMinor: 2500,
  discountMinor: 0,
  totalMinor: 2500,
  contact: { email: "ann@example.com", phone: null, name: "Ann" },
  orderRequest: null,
  version: 1,
  expiresAt: new Date("2026-11-08T10:30:00Z"),
  submittedAt: null,
  cancelledAt: null,
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

const spendLimitRecord = (overrides = {}) => ({
  id: "limit-1",
  companyId: COMPANY_A,
  scopeType: "conversation",
  scopeId: "conv-1",
  currency: "AUD",
  maxOrderMinor: 10000,
  dailyLimitMinor: 50000,
  spentMinor: 0,
  periodDate: null,
  enabled: true,
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

test("schema: every cart table uses the chatbot_ prefix and carries a NOT NULL company_id", () => {
  for (const table of [chatbotCarts, chatbotCartLines, chatbotCartIdempotencyKeys, chatbotCheckoutSessions, chatbotSpendLimits]) {
    const config = getTableConfig(table);
    assert.match(config.name, /^chatbot_/, config.name);
    assert.ok(config.columns.some((column) => column.name === "company_id" && column.notNull), `${config.name} has no NOT NULL company_id`);
  }
});

test("schema: tables with a composite key lead with company_id", () => {
  for (const table of [chatbotCarts, chatbotCartLines, chatbotCheckoutSessions, chatbotSpendLimits]) {
    const config = getTableConfig(table);
    const pk = config.primaryKeys[0];
    assert.ok(pk, `${config.name} has no primary key`);
    assert.equal(pk.columns[0].name, "company_id", `${config.name} primary key must lead with company_id`);
  }
});

test("schema: one active cart per conversation, one open checkout per cart, both partial and company-scoped", () => {
  const cartIndex = getTableConfig(chatbotCarts).indexes.map((index) => index.config).find((index) => index.name === CART_CONSTRAINTS.activeCartPerConversation);
  assert.ok(cartIndex && cartIndex.unique && cartIndex.where, "active-cart index missing or not partial");
  assert.deepEqual(cartIndex.columns.map((column) => column.name), ["company_id", "conversation_id"]);

  const checkoutIndex = getTableConfig(chatbotCheckoutSessions).indexes.map((index) => index.config).find((index) => index.name === CART_CONSTRAINTS.openCheckoutPerCart);
  assert.ok(checkoutIndex && checkoutIndex.unique && checkoutIndex.where, "open-checkout index missing or not partial");
  assert.deepEqual(checkoutIndex.columns.map((column) => column.name), ["company_id", "cart_id"]);
});

test("schema: idempotency keys are unique per company, owner type and owner", () => {
  const index = getTableConfig(chatbotCartIdempotencyKeys).indexes.map((item) => item.config).find((item) => item.name === CART_CONSTRAINTS.idempotencyKey);
  assert.ok(index && index.unique);
  assert.deepEqual(index.columns.map((column) => column.name), ["company_id", "owner_type", "owner_id", "idempotency_key"]);
});

test("schema: spend limits are unique per company and scope, and cart lines are bounded to 1 to 999", () => {
  const scope = getTableConfig(chatbotSpendLimits).indexes.map((item) => item.config).find((item) => item.name === CART_CONSTRAINTS.spendLimitScope);
  assert.ok(scope && scope.unique);
  assert.deepEqual(scope.columns.map((column) => column.name), ["company_id", "scope_type", "scope_id"]);
  const checks = getTableConfig(chatbotCartLines).checks.map((check) => check.name);
  assert.ok(checks.includes("chatbot_cart_lines_quantity_check"));
});

test("schema: parent references point at the shared chatbot tables", () => {
  const targets = getTableConfig(chatbotCarts).foreignKeys.map((fk) => getTableConfig(fk.reference().foreignTable).name);
  assert.ok(targets.includes("chatbots"));
  assert.ok(targets.includes("chatbot_conversations"));
});

// ---------------------------------------------------------------------------
// Rendered SQL
// ---------------------------------------------------------------------------

test("sql: a locking cart read ends in FOR UPDATE, a plain one does not, and both are company-scoped", () => {
  const { db } = recordingDb();
  const locked = render(selectCartQuery(db, COMPANY_A, "cart-1", true));
  const plain = render(selectCartQuery(db, COMPANY_A, "cart-1", false));
  assert.match(locked.sql, /for update/i);
  assert.doesNotMatch(plain.sql, /for update/i);
  for (const rendered of [locked, plain]) {
    assert.match(rendered.sql, /"company_id" = \$1/);
    assert.ok(rendered.params.includes(COMPANY_A));
  }
});

test("sql: a locking checkout read ends in FOR UPDATE and is company-scoped", () => {
  const { db } = recordingDb();
  const rendered = render(selectCheckoutQuery(db, COMPANY_A, "checkout-1", true));
  assert.match(rendered.sql, /for update/i);
  assert.match(rendered.sql, /"company_id" = \$1/);
});

test("sql: spend-limit lock reads take their rows in a fixed order and filter each target by company", () => {
  const { db } = recordingDb();
  const rendered = render(
    selectSpendLimitsQuery(db, COMPANY_A, [{ scopeType: "conversation", scopeId: "conv-1" }, { scopeType: "customer", scopeId: "cust-1" }], true),
  );
  assert.match(rendered.sql, /order by "chatbot_spend_limits"\."scope_type" asc, "chatbot_spend_limits"\."scope_id" asc/i);
  assert.match(rendered.sql, /for update/i);
  assert.match(rendered.sql, /"company_id" = \$1/);
  assert.ok(rendered.params.includes(COMPANY_A));
  assert.ok(rendered.params.includes("cust-1"));
});

test("sql: the active-cart lookup and cart upsert are company-scoped, and the upsert targets (company_id, id)", () => {
  const { db } = recordingDb();
  const active = render(selectActiveCartQuery(db, COMPANY_A, "conv-1"));
  assert.match(active.sql, /"company_id" = \$1/);
  assert.match(active.sql, /"status" = \$3/);

  const upsert = render(upsertCartQuery(db, COMPANY_A, cartRecord()));
  assert.match(upsert.sql, /on conflict \("company_id", ?"id"\) do update/i);
  assert.ok(upsert.params.includes(COMPANY_A));
});

test("sql: the spend-limit upsert targets the company-scoped scope key", () => {
  const { db } = recordingDb();
  const rendered = render(upsertSpendLimitQuery(db, COMPANY_A, spendLimitRecord()));
  assert.match(rendered.sql, /on conflict \("company_id", ?"scope_type", ?"scope_id"\) do update/i);
});

test("sql: an idempotency row records its owner type, so a cart key and a checkout key never collide", () => {
  const { db } = recordingDb();
  const cartKey = render(insertOperationQuery(db, COMPANY_A, "cart", "cart-1", { idempotencyKey: "k1", requestHash: "h", operation: "add", createdAt: AT }));
  const checkoutKey = render(insertOperationQuery(db, COMPANY_A, "checkout", "checkout-1", { idempotencyKey: "k1", requestHash: "h", operation: "submit", createdAt: AT }));
  assert.ok(cartKey.params.includes("cart") && checkoutKey.params.includes("checkout"));
  assert.ok(cartKey.params.includes(COMPANY_A) && checkoutKey.params.includes(COMPANY_A));
});

// ---------------------------------------------------------------------------
// Storage methods against the recording client
// ---------------------------------------------------------------------------

test("storage: every statement from a full round trip is company-scoped", async () => {
  const { db, statements } = recordingDb();
  const storage = new DrizzleCartStorage(db);
  await storage.putCart(COMPANY_A, cartRecord());
  await storage.findActiveCart(COMPANY_A, "conv-1");
  await storage.getCart(COMPANY_A, "cart-1");
  await storage.findCartOperation(COMPANY_A, "cart-1", "key-1");
  await storage.putCartOperation(COMPANY_A, { companyId: COMPANY_A, cartId: "cart-1", idempotencyKey: "key-1", requestHash: "h", operation: "add", createdAt: AT });
  await storage.putCheckout(COMPANY_A, checkoutRecord());
  await storage.getCheckout(COMPANY_A, "checkout-1");
  await storage.findOpenCheckoutForCart(COMPANY_A, "cart-1");
  await storage.findCheckoutOperation(COMPANY_A, "checkout-1", "key-2");
  await storage.putCheckoutOperation(COMPANY_A, { companyId: COMPANY_A, checkoutId: "checkout-1", idempotencyKey: "key-2", requestHash: "h", operation: "submit", createdAt: AT });
  await storage.findSpendLimits(COMPANY_A, [{ scopeType: "conversation", scopeId: "conv-1" }]);
  await storage.putSpendLimit(COMPANY_A, spendLimitRecord());

  const dml = statements.filter((statement) => isDml(statement.text));
  assert.equal(dml.length, 14, "the round trip sends 14 data statements when no rows come back");
  for (const statement of dml) assertScoped(statement, COMPANY_A);
});

test("storage: a cart write is one transaction that replaces its lines, and the lines keep their order", async () => {
  const { db, statements } = recordingDb();
  const storage = new DrizzleCartStorage(db);
  await storage.putCart(COMPANY_A, cartRecord({ lines: [line({ lineKey: "a" }), line({ lineKey: "b" })] }));
  const texts = statements.map((statement) => statement.text);
  assert.equal(texts[0], "begin");
  assert.equal(texts[texts.length - 1], "commit");
  const upsert = texts.findIndex((text) => /^insert into "chatbot_carts"/i.test(text));
  const deleteLines = texts.findIndex((text) => /^delete from "chatbot_cart_lines"/i.test(text));
  const insertLines = texts.findIndex((text) => /^insert into "chatbot_cart_lines"/i.test(text));
  assert.ok(upsert < deleteLines && deleteLines < insertLines, "cart row, then old lines removed, then new lines written");
  const lineInsert = statements[insertLines];
  assert.match(lineInsert.text, /"position"/);
});

test("storage: a locked cart read inside transaction() sits between begin and commit", async () => {
  const { db, statements } = recordingDb();
  const storage = new DrizzleCartStorage(db);
  await storage.getCart(COMPANY_A, "cart-1");
  await storage.transaction(COMPANY_A, (tx) => tx.getCart(COMPANY_A, "cart-1"));

  const cartReads = statements.filter((statement) => /^select .* from "chatbot_carts"/i.test(statement.text));
  assert.equal(cartReads.length, 2);
  assert.doesNotMatch(cartReads[0].text, /for update/i);
  assert.match(cartReads[1].text, /for update/i);
  const begin = statements.findIndex((statement) => statement.text === "begin");
  const locked = statements.findIndex((statement) => /for update/i.test(statement.text));
  const commit = statements.findIndex((statement) => statement.text === "commit");
  assert.ok(begin < locked && locked < commit);
});

test("storage: checkout and spend-limit reads inside transaction() lock their rows", async () => {
  const { db, statements } = recordingDb();
  const storage = new DrizzleCartStorage(db);
  await storage.transaction(COMPANY_A, async (tx) => {
    await tx.getCheckout(COMPANY_A, "checkout-1");
    await tx.findSpendLimits(COMPANY_A, [{ scopeType: "customer", scopeId: "cust-1" }]);
  });
  const locked = statements.filter((statement) => /for update/i.test(statement.text));
  assert.equal(locked.length, 2);
  assert.match(locked[0].text, /"chatbot_checkout_sessions"/);
  assert.match(locked[1].text, /"chatbot_spend_limits"/);
});

test("storage: a throw inside transaction() rolls back and keeps the error", async () => {
  const { db, statements } = recordingDb();
  const storage = new DrizzleCartStorage(db);
  await assert.rejects(
    storage.transaction(COMPANY_A, async (tx) => {
      await tx.putCart(COMPANY_A, cartRecord());
      throw new CartError("spend_limit_exceeded", "Limit reached.");
    }),
    (error) => error instanceof CartError && error.code === "spend_limit_exceeded" && error.status === 422,
  );
  assert.ok(statements.some((statement) => statement.text === "rollback"));
  assert.ok(!statements.some((statement) => statement.text === "commit"));
});

test("storage: a checkout key and a cart key are looked up under their own owner type", async () => {
  const { db, statements } = recordingDb();
  const storage = new DrizzleCartStorage(db);
  await storage.findCartOperation(COMPANY_A, "owner-1", "same-key");
  await storage.findCheckoutOperation(COMPANY_A, "owner-1", "same-key");
  const [cartLookup, checkoutLookup] = statements.filter((statement) => isDml(statement.text));
  assert.ok(cartLookup.params.includes("cart") && !cartLookup.params.includes("checkout"));
  assert.ok(checkoutLookup.params.includes("checkout") && !checkoutLookup.params.includes("cart"));
});

test("storage: an empty spend-limit target list sends no SQL", async () => {
  const { db, statements } = recordingDb();
  const storage = new DrizzleCartStorage(db);
  assert.deepEqual(await storage.findSpendLimits(COMPANY_A, []), []);
  assert.equal(statements.length, 0);
});

test("storage: a company id that is not a UUID is refused before any SQL is sent", async () => {
  const { db, statements } = recordingDb();
  const storage = new DrizzleCartStorage(db);
  await assert.rejects(storage.getCart("company-1", "cart-1"), (error) => error instanceof ChatbotError && error.status === 403);
  await assert.rejects(storage.transaction("", async () => 1), (error) => error instanceof ChatbotError && error.status === 403);
  assert.equal(statements.length, 0);
});

test("storage: one company's reads never carry another company's id", async () => {
  const { db, statements } = recordingDb();
  const storage = new DrizzleCartStorage(db);
  await storage.getCart(COMPANY_A, "cart-1");
  await storage.getCart(COMPANY_B, "cart-1");
  const [first, second] = statements.filter((statement) => isDml(statement.text));
  assert.ok(first.params.includes(COMPANY_A) && !first.params.includes(COMPANY_B));
  assert.ok(second.params.includes(COMPANY_B) && !second.params.includes(COMPANY_A));
});

// ---------------------------------------------------------------------------
// Database errors
// ---------------------------------------------------------------------------

const wrap = (code, constraint) => Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("pg"), { code, constraint }) });

test("errors: a repeated idempotency key becomes idempotency_conflict (409)", () => {
  const mapped = mapCartDatabaseError(wrap("23505", CART_CONSTRAINTS.idempotencyKey));
  assert.ok(mapped instanceof CartError);
  assert.equal(mapped.code, "idempotency_conflict");
  assert.equal(mapped.status, 409);
});

test("errors: a second active cart or open checkout becomes conflict (409)", () => {
  for (const constraint of [CART_CONSTRAINTS.activeCartPerConversation, CART_CONSTRAINTS.openCheckoutPerCart, CART_CONSTRAINTS.spendLimitScope]) {
    const mapped = mapCartDatabaseError(wrap("23505", constraint));
    assert.equal(mapped.code, "conflict", constraint);
    assert.equal(mapped.status, 409);
  }
});

test("errors: a check violation becomes validation (422), and service errors pass through", () => {
  const check = mapCartDatabaseError(wrap("23514", "chatbot_cart_lines_quantity_check"));
  assert.equal(check.code, "validation");
  assert.equal(check.status, 422);
  const service = new CartError("cart_closed", "Cart is closed.");
  assert.equal(mapCartDatabaseError(service), service);
  const other = new Error("connection reset");
  assert.equal(mapCartDatabaseError(other), other);
});

// ---------------------------------------------------------------------------
// In-memory transaction: the in-process lock and rollback
// ---------------------------------------------------------------------------

test("memory: transaction() runs one company's work one at a time", async () => {
  const storage = createMemoryCartStorage();
  const order = [];
  const first = storage.transaction(COMPANY_A, async () => {
    order.push("first:start");
    await new Promise((resolve) => setTimeout(resolve, 15));
    order.push("first:end");
  });
  const second = storage.transaction(COMPANY_A, async () => {
    order.push("second:start");
    order.push("second:end");
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
});

test("memory: a failed transaction() restores the cart, the checkout and the spend limit", async () => {
  const storage = createMemoryCartStorage();
  await storage.putCart(COMPANY_A, cartRecord());
  await storage.putSpendLimit(COMPANY_A, spendLimitRecord({ spentMinor: 100 }));
  await assert.rejects(
    storage.transaction(COMPANY_A, async (tx) => {
      await tx.putCart(COMPANY_A, cartRecord({ status: "converted", version: 2 }));
      await tx.putCheckout(COMPANY_A, checkoutRecord());
      await tx.putSpendLimit(COMPANY_A, spendLimitRecord({ spentMinor: 9999 }));
      throw new CartError("spend_limit_exceeded", "Limit reached.");
    }),
    (error) => error instanceof CartError,
  );
  assert.equal((await storage.getCart(COMPANY_A, "cart-1")).status, "active");
  assert.equal(await storage.getCheckout(COMPANY_A, "checkout-1"), null);
  assert.equal((await storage.findSpendLimits(COMPANY_A, [{ scopeType: "conversation", scopeId: "conv-1" }]))[0].spentMinor, 100);
});

test("memory: transaction() for one company does not wait on another company", async () => {
  const storage = createMemoryCartStorage();
  let releaseA;
  const blockA = storage.transaction(COMPANY_A, () => new Promise((resolve) => (releaseA = resolve)));
  const bRan = await storage.transaction(COMPANY_B, async () => "b-done");
  assert.equal(bRan, "b-done");
  releaseA();
  await blockA;
});

// ---------------------------------------------------------------------------
// M-B: two first requests for one conversation share one cart
// ---------------------------------------------------------------------------

/** Positional row for the driver. Drizzle reads node-postgres rows by column position, in SELECT or RETURNING order. */
function positionalRows(text, fixture) {
  const list = /^select (.+?) from /is.exec(text)?.[1] ?? /returning (.+)$/is.exec(text)?.[1];
  if (!list) return [];
  const cols = list.split(",").map((c) => c.trim().replace(/"/g, ""));
  return [cols.map((c) => fixture[c.replace(/_([a-z])/g, (_, x) => x.toUpperCase())])];
}

test("M-B: the first cart is inserted ON CONFLICT DO NOTHING on the active-cart index, company-scoped", () => {
  const { db } = recordingDb();
  const rendered = render(insertActiveCartIfAbsentQuery(db, COMPANY_A, cartRecord({ lines: [] })));
  assert.match(rendered.sql, /^insert into "chatbot_carts"/i);
  assert.match(rendered.sql, /on conflict \("company_id", ?"conversation_id"\) where .*"status" = 'active' do nothing/i);
  assert.doesNotMatch(rendered.sql, /do update/i, "a conflict must not overwrite the winning cart");
  assert.ok(rendered.params.includes(COMPANY_A), "company id must be a bound parameter");
});

test("M-B: insertActiveCartOrFind is followed by a company-scoped SELECT of the active cart", async () => {
  const winner = cartRecord({ lines: [] });
  const statements = [];
  const client = {
    async query(config, values) {
      const text = typeof config === "string" ? config : config.text;
      statements.push({ text, params: values ?? config.values ?? [] });
      return { rows: /^select .* from "chatbot_carts"/i.test(text) ? positionalRows(text, winner) : [], rowCount: 0, fields: [] };
    },
  };
  const result = await new DrizzleCartStorage(drizzle(client)).insertActiveCartOrFind(COMPANY_A, cartRecord({ lines: [] }));
  assert.equal(result.id, "cart-1");
  const insertAt = statements.findIndex((s) => /^insert into "chatbot_carts"/i.test(s.text));
  const selectAt = statements.findIndex((s, i) => i > insertAt && /^select .* from "chatbot_carts"/i.test(s.text));
  assert.ok(insertAt >= 0 && selectAt > insertAt, "the insert must come before the SELECT");
  assert.match(statements[selectAt].text, /"company_id" = \$\d+/, "the read-back must carry the company predicate");
  assert.match(statements[selectAt].text, /"conversation_id" = \$\d+/);
  assert.ok(statements[selectAt].params.includes(COMPANY_A));
});

test("M-B: when a concurrent first request wins the insert, this request gets the winner's cart, not an error", async () => {
  const winner = cartRecord({ id: "cart-winner", lines: [] });
  const statements = [];
  let cartSelects = 0;
  const client = {
    async query(config) {
      const text = typeof config === "string" ? config : config.text;
      statements.push(text);
      if (/^select .* from "chatbot_carts"/i.test(text)) {
        cartSelects += 1;
        // First read: no active cart yet. Read after the conflicting insert: the winner's row.
        return { rows: cartSelects === 1 ? [] : positionalRows(text, winner), rowCount: 0, fields: [] };
      }
      return { rows: [], rowCount: 0, fields: [] };
    },
  };
  const service = createCartService({ storage: new DrizzleCartStorage(drizzle(client)), catalog: {}, lock: passThroughLock, enabled: true, now: () => AT, cartTtlDays: 7 });
  const cart = await service.getOrCreateCart({ companyId: COMPANY_A, chatbotId: "bot-1", conversationId: "conv-1", customerId: null });
  assert.equal(cart.id, "cart-winner");
  assert.ok(statements.some((text) => /on conflict/i.test(text)), "the create must be ON CONFLICT DO NOTHING");
});

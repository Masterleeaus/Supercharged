// Fulfilment Drizzle storage tests (node:test). No database is reached.
// A recording client stands in for the pool: it captures every statement Drizzle sends and returns
// no rows. That lets the tests run the real DrizzleFulfilmentStorage methods and the real inventory
// service, then assert on the SQL. Query builders are also rendered directly with PgDialect.
//
// Run: node --test --experimental-transform-types tests/modules/chatbot-fulfilment-drizzle.test.mjs
// (drizzle-orm is not in builder-test-deps. Use NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs")
import test from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { ChatbotError } from "../../server/modules/chatbot/chatbot-scope.ts";
import {
  DrizzleFulfilmentStorage,
  insertStockQuery,
  mapFulfilmentDatabaseError,
  pgErrorCode,
  selectDueReservationsQuery,
  selectStockQuery,
  updateStockQuery,
  upsertReservationQuery,
  selectActiveReservationsQuery,
} from "../../server/modules/chatbot/fulfilment/fulfilment-storage.ts";
import { createInventoryService } from "../../server/modules/chatbot/fulfilment/inventory.ts";
import {
  chatbotFulfilmentLocations,
  chatbotFulfilmentOrderLines,
  chatbotFulfilmentOrders,
  chatbotFulfilmentItems,
  chatbotFulfilments,
  chatbotInventoryAdjustments,
  chatbotInventoryReservations,
  chatbotInventoryStock,
} from "../../server/modules/chatbot/db/fulfilment.ts";

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

/** Renders a query builder to SQL and params without running it. */
function render(query) {
  if (typeof query.getSQL === "function") return dialect.sqlToQuery(query.getSQL());
  return query.toSQL();
}

const isDml = (text) => /^\s*(select|insert|update|delete)\b/i.test(text);

/** Every data statement must be scoped: a company_id predicate (or column, for inserts) and the id as a param. */
function assertScoped(statement, companyId) {
  assert.ok(statement.params.includes(companyId), `company id not in params: ${statement.text}`);
  if (/^\s*insert\b/i.test(statement.text)) {
    assert.match(statement.text, /"company_id"/, statement.text);
  } else {
    assert.match(statement.text, /"company_id" = \$\d+/, statement.text);
  }
}

const stockRecord = (overrides = {}) => ({
  companyId: COMPANY_A,
  variantId: "variant-1",
  locationId: null,
  quantity: 10,
  reserved: 0,
  committed: 0,
  allocated: 0,
  damaged: 0,
  safetyStock: 0,
  incoming: 0,
  lowStockThreshold: 0,
  allowBackorder: false,
  version: 1,
  ...overrides,
});

const reservationRecord = (overrides = {}) => ({
  id: "res-1",
  companyId: COMPANY_A,
  holderId: "cart-1",
  variantId: "variant-1",
  locationId: null,
  quantity: 2,
  status: "active",
  idempotencyKey: "key-1",
  expiresAt: new Date("2026-11-08T10:15:00Z"),
  committedAt: null,
  releasedAt: null,
  releaseReason: null,
  createdAt: new Date("2026-11-08T10:00:00Z"),
  ...overrides,
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

test("schema: every table uses the chatbot_ prefix and a company-scoped primary key", () => {
  const tables = [
    chatbotFulfilmentLocations,
    chatbotInventoryStock,
    chatbotInventoryReservations,
    chatbotInventoryAdjustments,
    chatbotFulfilmentOrders,
    chatbotFulfilmentOrderLines,
    chatbotFulfilments,
    chatbotFulfilmentItems,
  ];
  for (const table of tables) {
    const config = getTableConfig(table);
    assert.match(config.name, /^chatbot_/, config.name);
    assert.ok(config.columns.some((column) => column.name === "company_id" && column.notNull), `${config.name} has no NOT NULL company_id`);
    const pk = config.primaryKeys.map((key) => key.columns.map((column) => column.name));
    const idPk = config.columns.find((column) => column.primary);
    const scopedPk = pk.some((cols) => cols[0] === "company_id") || (idPk && idPk.name === "id");
    assert.ok(scopedPk, `${config.name} has no primary key led by company_id`);
  }
});

test("schema: stock has CHECK constraints so committed and reserved stock cannot go negative", () => {
  const names = getTableConfig(chatbotInventoryStock).checks.map((check) => check.name);
  assert.ok(names.includes("chatbot_inventory_stock_non_negative_check"));
  assert.ok(names.includes("chatbot_inventory_stock_allocated_within_committed_check"));
  assert.ok(names.includes("chatbot_inventory_stock_quantity_covers_holds_check"));
});

test("schema: null-location stock has its own partial unique index scoped by company", () => {
  const indexes = getTableConfig(chatbotInventoryStock).indexes.map((index) => index.config);
  const partial = indexes.find((index) => index.name === "chatbot_inventory_stock_company_variant_null_location_uidx");
  assert.ok(partial, "partial unique index for null location is missing");
  assert.equal(partial.unique, true);
  assert.equal(partial.columns[0].name, "company_id");
  assert.ok(partial.where, "partial index must have a WHERE clause");
});

test("schema: reservation idempotency key is unique per company", () => {
  const indexes = getTableConfig(chatbotInventoryReservations).indexes.map((index) => index.config);
  const key = indexes.find((index) => index.name === "chatbot_inventory_reservations_company_key_uidx");
  assert.ok(key && key.unique);
  assert.deepEqual(key.columns.map((column) => column.name), ["company_id", "idempotency_key"]);
});

// ---------------------------------------------------------------------------
// Rendered SQL
// ---------------------------------------------------------------------------

test("sql: a locking stock read ends in FOR UPDATE and is company-scoped", () => {
  const { db } = recordingDb();
  const locked = render(selectStockQuery(db, COMPANY_A, "variant-1", null, true));
  assert.match(locked.sql, /for update/i);
  assert.match(locked.sql, /"company_id" = \$1/);
  assert.match(locked.sql, /"location_id" is null/i);
  assert.deepEqual(locked.params.slice(0, 2), [COMPANY_A, "variant-1"]);
});

test("sql: a plain stock read takes no lock", () => {
  const { db } = recordingDb();
  const plain = render(selectStockQuery(db, COMPANY_A, "variant-1", "loc-1", false));
  assert.doesNotMatch(plain.sql, /for update/i);
  assert.match(plain.sql, /"location_id" = \$3/);
  assert.ok(plain.params.includes("loc-1"));
});

test("sql: every builder renders a company predicate and carries the company id", () => {
  const { db } = recordingDb();
  const now = new Date("2026-11-08T10:00:00Z");
  const reservation = reservationRecord();
  const stock = stockRecord({ locationId: "loc-1" });
  const builders = [
    ["select stock", selectStockQuery(db, COMPANY_A, "variant-1", "loc-1", true)],
    ["update stock", updateStockQuery(db, COMPANY_A, stock)],
    ["insert stock", insertStockQuery(db, COMPANY_A, stock)],
    ["select active reservations", selectActiveReservationsQuery(db, COMPANY_A, "variant-1", null)],
    ["select due reservations", selectDueReservationsQuery(db, COMPANY_A, now, 50)],
    ["upsert reservation", upsertReservationQuery(db, COMPANY_A, reservation)],
  ];
  for (const [label, query] of builders) {
    const rendered = render(query);
    assert.ok(rendered.params.includes(COMPANY_A), `${label}: company id missing from params`);
    assert.match(rendered.sql, /"company_id"/, `${label}: company_id not in SQL`);
  }
});

test("sql: upserts target the company-scoped primary key, so one tenant cannot overwrite another", () => {
  const { db } = recordingDb();
  const rendered = render(upsertReservationQuery(db, COMPANY_A, reservationRecord()));
  assert.match(rendered.sql, /on conflict \("company_id", ?"id"\) do update/i);
});

test("sql: due-reservation sweep orders oldest first and limits the batch", () => {
  const { db } = recordingDb();
  const rendered = render(selectDueReservationsQuery(db, COMPANY_A, new Date("2026-11-08T10:00:00Z"), 25));
  assert.match(rendered.sql, /order by "chatbot_inventory_reservations"\."expires_at" asc/i);
  assert.match(rendered.sql, /limit \$\d+/i);
  assert.ok(rendered.params.includes(25));
});

// ---------------------------------------------------------------------------
// Storage methods, run against the recording client
// ---------------------------------------------------------------------------

test("storage: every statement from a full storage round trip is company-scoped", async () => {
  const { db, statements } = recordingDb();
  const storage = new DrizzleFulfilmentStorage(db);
  await storage.saveLocation(COMPANY_A, { id: "loc-1", companyId: COMPANY_A, code: "MEL", name: "Melbourne", active: true, priority: 1 });
  await storage.getLocation(COMPANY_A, "loc-1");
  await storage.saveStock(COMPANY_A, stockRecord({ locationId: "loc-1" }));
  await storage.getStock(COMPANY_A, "variant-1", "loc-1");
  await storage.insertReservation(COMPANY_A, reservationRecord());
  await storage.saveReservation(COMPANY_A, reservationRecord({ status: "released", releaseReason: "customer" }));
  await storage.findReservationByKey(COMPANY_A, "key-1");
  await storage.listActiveReservations(COMPANY_A, "variant-1", null);
  await storage.listDueReservations(COMPANY_A, new Date("2026-11-08T11:00:00Z"), 10);
  await storage.insertAdjustment(COMPANY_A, {
    id: "adj-1",
    companyId: COMPANY_A,
    variantId: "variant-1",
    locationId: null,
    delta: 5,
    reason: "receipt",
    balanceAfter: 15,
    version: 2,
    actorId: "staff-1",
    idempotencyKey: "adj-key-1",
    createdAt: new Date("2026-11-08T10:00:00Z"),
  });
  await storage.findAdjustmentByKey(COMPANY_A, "adj-key-1");
  await storage.saveOrder(COMPANY_A, {
    id: "order-1",
    companyId: COMPANY_A,
    reference: "REF-1",
    createdAt: new Date("2026-11-08T10:00:00Z"),
    lines: [{ id: "line-1", variantId: "variant-1", productId: "p1", sku: "SKU-1", name: "Widget", quantity: 2 }],
  });
  await storage.getOrder(COMPANY_A, "order-1");
  await storage.insertFulfilment(COMPANY_A, {
    id: "ful-1",
    companyId: COMPANY_A,
    orderId: "order-1",
    status: "pending",
    methodType: "delivery",
    locationId: "loc-1",
    carrier: null,
    service: null,
    trackingNumber: null,
    trackingUrl: null,
    customerNote: null,
    internalNote: null,
    idempotencyKey: "ful-key-1",
    requestHash: "a".repeat(64),
    items: [{ orderLineId: "line-1", variantId: "variant-1", productId: "p1", sku: "SKU-1", name: "Widget", quantity: 2 }],
    processingAt: null,
    shippedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    createdAt: new Date("2026-11-08T10:00:00Z"),
    updatedAt: new Date("2026-11-08T10:00:00Z"),
  });
  await storage.getFulfilment(COMPANY_A, "ful-1");
  await storage.findFulfilmentByKey(COMPANY_A, "ful-key-1");
  await storage.listFulfilmentsForOrder(COMPANY_A, "order-1");

  const dml = statements.filter((statement) => isDml(statement.text));
  assert.ok(dml.length >= 20, `expected many statements, saw ${dml.length}`);
  for (const statement of dml) assertScoped(statement, COMPANY_A);
});

test("storage: a stock read inside transaction() locks the row, and outside it does not", async () => {
  const { db, statements } = recordingDb();
  const storage = new DrizzleFulfilmentStorage(db);
  await storage.getStock(COMPANY_A, "variant-1", null);
  await storage.transaction(COMPANY_A, (tx) => tx.getStock(COMPANY_A, "variant-1", null));

  const reads = statements.filter((statement) => /^\s*select .* from "chatbot_inventory_stock"/i.test(statement.text));
  assert.equal(reads.length, 2);
  assert.doesNotMatch(reads[0].text, /for update/i, "plain read should not lock");
  assert.match(reads[1].text, /for update/i, "transactional read must lock");

  const begin = statements.findIndex((statement) => statement.text === "begin");
  const lockedRead = statements.findIndex((statement) => /for update/i.test(statement.text));
  const commit = statements.findIndex((statement) => statement.text === "commit");
  assert.ok(begin >= 0 && begin < lockedRead && lockedRead < commit, "locked read must sit between begin and commit");
});

test("storage: a throw inside transaction() rolls back and keeps the ChatbotError", async () => {
  const { db, statements } = recordingDb();
  const storage = new DrizzleFulfilmentStorage(db);
  await assert.rejects(
    storage.transaction(COMPANY_A, async (tx) => {
      await tx.saveStock(COMPANY_A, stockRecord({ locationId: null }));
      throw new ChatbotError("Only 0 unit(s) are currently available.", 422);
    }),
    (error) => error instanceof ChatbotError && error.status === 422 && /Only 0 unit/.test(error.message),
  );
  assert.ok(statements.some((statement) => statement.text === "rollback"), "rollback was not sent");
  assert.ok(!statements.some((statement) => statement.text === "commit"), "must not commit a failed transaction");
});

test("storage: null-location stock is addressed with IS NULL, not = NULL", async () => {
  const { db, statements } = recordingDb();
  const storage = new DrizzleFulfilmentStorage(db);
  await storage.saveStock(COMPANY_A, stockRecord({ locationId: null }));
  const update = statements.find((statement) => /^\s*update "chatbot_inventory_stock"/i.test(statement.text));
  assert.ok(update, "saveStock should try an update first");
  assert.match(update.text, /"location_id" is null/i);
  assert.doesNotMatch(update.text, /"location_id" = \$/);
});

test("storage: saveStock inserts when the update matches no row", async () => {
  const { db, statements } = recordingDb();
  const storage = new DrizzleFulfilmentStorage(db);
  await storage.saveStock(COMPANY_A, stockRecord({ locationId: "loc-1" }));
  const kinds = statements.filter((statement) => isDml(statement.text)).map((statement) => statement.text.trim().split(/\s+/)[0].toLowerCase());
  assert.deepEqual(kinds, ["update", "insert"]);
});

test("storage: a company id that is not a UUID is refused before any SQL is sent", async () => {
  const { db, statements } = recordingDb();
  const storage = new DrizzleFulfilmentStorage(db);
  await assert.rejects(storage.getStock("company-1", "variant-1", null), (error) => error instanceof ChatbotError && error.status === 403);
  await assert.rejects(storage.transaction("", async () => 1), (error) => error instanceof ChatbotError && error.status === 403);
  assert.equal(statements.length, 0);
});

test("storage: one company's reads never carry another company's id", async () => {
  const { db, statements } = recordingDb();
  const storage = new DrizzleFulfilmentStorage(db);
  await storage.getStock(COMPANY_A, "variant-1", null);
  await storage.getStock(COMPANY_B, "variant-1", null);
  const [first, second] = statements.filter((statement) => isDml(statement.text));
  assert.ok(first.params.includes(COMPANY_A) && !first.params.includes(COMPANY_B));
  assert.ok(second.params.includes(COMPANY_B) && !second.params.includes(COMPANY_A));
});

// ---------------------------------------------------------------------------
// Service on top of the Drizzle storage
// ---------------------------------------------------------------------------

test("service: reserve against empty stock locks the row, refuses, and rolls back", async () => {
  const { db, statements } = recordingDb();
  const inventory = createInventoryService({
    storage: new DrizzleFulfilmentStorage(db),
    clock: { now: () => new Date("2026-11-08T10:00:00Z"), newId: () => "generated-id" },
  });
  await assert.rejects(
    inventory.reserve(COMPANY_A, {
      holderId: "cart-1",
      variantId: "variant-1",
      quantity: 2,
      holderQuantity: 2,
      idempotencyKey: "reserve-key-1",
    }),
    (error) => error instanceof ChatbotError && error.status === 422 && /Only 0 unit/.test(error.message),
  );
  const order = statements.map((statement) => statement.text);
  const begin = order.indexOf("begin");
  const lock = order.findIndex((text) => /for update/i.test(text));
  const rollback = order.indexOf("rollback");
  assert.ok(begin >= 0 && begin < lock && lock < rollback, "the stock row must be locked inside the transaction");
  assert.ok(!order.includes("commit"));
  for (const statement of statements.filter((item) => isDml(item.text))) assertScoped(statement, COMPANY_A);
});

test("storage: write order inside one transaction is lock, stock update, reservation insert, commit", async () => {
  // The recording client returns no rows. This checks the write order a successful reserve would follow:
  // lock, update stock, insert reservation, then commit.
  const { db, statements } = recordingDb();
  const storage = new DrizzleFulfilmentStorage(db);
  await storage.transaction(COMPANY_A, async (tx) => {
    await tx.getStock(COMPANY_A, "variant-1", null);
    await tx.saveStock(COMPANY_A, stockRecord({ reserved: 2, version: 2 }));
    await tx.insertReservation(COMPANY_A, reservationRecord());
  });
  const texts = statements.map((statement) => statement.text);
  const lock = texts.findIndex((text) => /for update/i.test(text));
  const stockUpdate = texts.findIndex((text) => /^update "chatbot_inventory_stock"/i.test(text));
  const insertReservation = texts.findIndex((text) => /^insert into "chatbot_inventory_reservations"/i.test(text));
  const commit = texts.indexOf("commit");
  assert.ok(lock < stockUpdate && stockUpdate < insertReservation && insertReservation < commit);
});

// ---------------------------------------------------------------------------
// Database error mapping
// ---------------------------------------------------------------------------

test("errors: a check violation (23514) becomes a 409 the caller can read", () => {
  const driverError = Object.assign(new Error("violates check constraint"), { code: "23514" });
  const wrapped = Object.assign(new Error("Failed query"), { cause: driverError });
  assert.equal(pgErrorCode(wrapped), "23514");
  const mapped = mapFulfilmentDatabaseError(wrapped);
  assert.ok(mapped instanceof ChatbotError);
  assert.equal(mapped.status, 409);
});

test("errors: a unique violation (23505) becomes a 409, and service errors pass through", () => {
  const unique = Object.assign(new Error("duplicate key"), { code: "23505" });
  assert.equal(mapFulfilmentDatabaseError(unique).status, 409);
  const service = new ChatbotError("Reservation cannot transition.", 422);
  assert.equal(mapFulfilmentDatabaseError(service), service);
  const other = new Error("connection reset");
  assert.equal(mapFulfilmentDatabaseError(other), other);
});

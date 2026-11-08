// Marketplace providers, order-ops store, thread linking and lifecycle (node:test).
// No network: every HTTP call goes to an injected fake, and the default HttpClient throws if anything uses it.
// Drizzle is checked by rendering the SQL with PgDialect and by a fake executor that can ignore its WHERE clause.
// The approval secret and the company ids below are test-only values.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  MarketplaceError,
  createGenericMarketplaceProvider,
  createMarketplaceRateLimiter,
  createMarketplaceReadRegistry,
  createMarketplaceWriteRegistry,
  createMarketplaceWriteRuntime,
  createMemoryMarketplaceProvider,
  createMemoryMarketplaceStore,
  normaliseListing,
  DEFAULT_RATE_LIMIT_CONFIG,
  GATEWAY_SIGNING_SECRET_KEY,
} from "../../server/modules/chatbot/commerce/marketplace/index.ts";
import {
  OrderOpsError,
  createCommerceLifecycle,
  createDrizzleOrderOpsStore,
  createMemoryLifecycleStore,
  createMemoryOrderOpsStore,
  createThreadLinker,
  LINK_THREAD_ACTION,
} from "../../server/modules/chatbot/commerce/order-ops/index.ts";
import { chatbotCommerceUnifiedOrders } from "../../server/modules/chatbot/db/commerce-order-ops.ts";
import { CONTRACT_FLAGS } from "../../server/modules/chatbot/contracts/index.ts";

// ---------- fixtures ----------

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const CHATBOT_A = "33333333-3333-4333-8333-333333333333";
const CHATBOT_B = "44444444-4444-4444-8444-444444444444";
const OWNER_A = "user-owner-a";
const OWNER_B = "user-owner-b";
const CONN_A = "conn-a";
const CONN_B = "conn-b";
const SECRET = "marketplace-ops-test-signing-0123456789abcdef";
const GATEWAY_SECRET = "gateway-test-signing-secret-0123456789abcdef";
const GATEWAY_URL = "https://gateway.example.test";
const FLAG_ON = { [CONTRACT_FLAGS.MARKETPLACE_WRITE_ENABLED]: "true" };
const START = new Date("2026-11-09T09:00:00.000Z");
const HASH = "a".repeat(64);
const noNetwork = async () => {
  throw new Error("network must not be used in tests");
};

function counterIds(prefix = "id") {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function clockOf(start = START) {
  let now = new Date(start);
  return { now: () => new Date(now), tick: (ms) => (now = new Date(now.getTime() + ms)) };
}

const ownerA = { companyId: COMPANY_A, userId: OWNER_A, role: "owner" };
const ownerB = { companyId: COMPANY_B, userId: OWNER_B, role: "owner" };

// ---------- marketplace world ----------

function connection(companyId, connectionId, ownerUserId) {
  return {
    companyId,
    connectionId,
    provider: "generic",
    ownerUserId,
    active: true,
    writeEnabled: true,
    capabilities: ["read_listings", "write_price", "write_inventory", "write_listing"],
  };
}

function marketplaceWorld(provider, http = noNetwork) {
  const clock = clockOf();
  const store = createMemoryMarketplaceStore();
  store.putConnection(connection(COMPANY_A, CONN_A, OWNER_A));
  store.putConnection(connection(COMPANY_B, CONN_B, OWNER_B));
  const rateLimit = createMarketplaceRateLimiter({ now: clock.now, ...DEFAULT_RATE_LIMIT_CONFIG });
  const runtime = createMarketplaceWriteRuntime({
    store,
    readRegistry: createMarketplaceReadRegistry({ generic: provider }),
    writeRegistry: createMarketplaceWriteRegistry({ generic: provider }),
    rateLimit,
    http,
    clock: clock.now,
    env: FLAG_ON,
    approvalSecret: SECRET,
    newId: counterIds("proposal"),
  });
  return { store, runtime, clock };
}

/** Puts a listing the seller has read into the store, so a write can be prepared against it. */
async function storeListing(world, companyId, connectionId, listing) {
  await world.store.saveListing({
    companyId,
    connectionId,
    provider: "generic",
    externalListingId: listing.externalListingId,
    sourceHash: listing.sourceHash,
    listing,
    firstSeenAt: world.clock.now(),
    lastSeenAt: world.clock.now(),
  });
}

function seedMemory(provider, companyId, connectionId, id = "L1", priceMinor = 1000) {
  return provider.seed(companyId, connectionId, { externalListingId: id, title: "Hose reel", priceMinor, currency: "AUD", quantity: 5, raw: { status: "active", description: "Reel", attributes: {} } });
}

function priceWrite(connectionId, listing, priceMinor, key) {
  return { connectionId, externalListingId: listing.externalListingId, operation: "update_price", changes: { priceMinor, currency: "AUD" }, expectedSourceHash: listing.sourceHash, idempotencyKey: key };
}

// ---------- marketplace: confirmation, tenancy, spend ----------

test("a marketplace write without a confirmation token is refused and the provider is never called", async () => {
  const provider = createMemoryMarketplaceProvider({ rateLimit: createMarketplaceRateLimiter({ now: () => START, ...DEFAULT_RATE_LIMIT_CONFIG }) });
  const world = marketplaceWorld(provider);
  const listing = seedMemory(provider, COMPANY_A, CONN_A);
  await storeListing(world, COMPANY_A, CONN_A, listing);

  const prepared = await world.runtime.prepare(COMPANY_A, ownerA, priceWrite(CONN_A, listing, 1100, "k-1"));
  assert.equal(prepared.proposal.status, "prepared");
  assert.equal(typeof prepared.confirmationToken, "string");

  await assert.rejects(
    world.runtime.execute(COMPANY_A, ownerA, prepared.proposal.id),
    (error) => error instanceof MarketplaceError && error.code === "confirmation_required",
  );
  assert.equal(provider.writes.length, 0, "no write may reach the provider before confirmation");
  assert.equal(provider.current(COMPANY_A, CONN_A, "L1").priceMinor, 1000);
});

test("a confirmation token from another company is refused, and only the proposal's own token reaches the provider", async () => {
  const provider = createMemoryMarketplaceProvider({ rateLimit: createMarketplaceRateLimiter({ now: () => START, ...DEFAULT_RATE_LIMIT_CONFIG }) });
  const world = marketplaceWorld(provider);
  const listingA = seedMemory(provider, COMPANY_A, CONN_A);
  const listingB = seedMemory(provider, COMPANY_B, CONN_B);
  await storeListing(world, COMPANY_A, CONN_A, listingA);
  await storeListing(world, COMPANY_B, CONN_B, listingB);

  const tokenA = (await world.runtime.prepare(COMPANY_A, ownerA, priceWrite(CONN_A, listingA, 1100, "a-1"))).confirmationToken;
  const preparedB = await world.runtime.prepare(COMPANY_B, ownerB, priceWrite(CONN_B, listingB, 1100, "b-1"));
  const tokenB = preparedB.confirmationToken;

  // Company B cannot see company A's proposal at all, so it is not found, whatever token it offers.
  const proposalA = (await world.store.findProposalByKey(COMPANY_A, CONN_A, "a-1")).id;
  await assert.rejects(world.runtime.confirm(COMPANY_B, ownerB, proposalA, tokenA), (e) => e instanceof MarketplaceError && e.code === "not_found");

  // Company A cannot confirm its own proposal with company B's token.
  await assert.rejects(world.runtime.confirm(COMPANY_A, ownerA, proposalA, tokenB), (e) => e instanceof MarketplaceError && e.code === "confirmation_invalid");
  assert.equal(provider.writes.length, 0);

  // Company A confirms with its own token and executes once.
  const approved = await world.runtime.confirm(COMPANY_A, ownerA, proposalA, tokenA);
  assert.equal(approved.status, "approved");
  const done = await world.runtime.execute(COMPANY_A, ownerA, proposalA);
  assert.equal(done.status, "executed");

  assert.equal(provider.writes.length, 1);
  assert.equal(provider.writes[0].companyId, COMPANY_A);
  const seen = JSON.stringify(provider.writes);
  assert.ok(!seen.includes(tokenA) && !seen.includes(tokenB), "no confirmation token may appear in what the provider received");
  assert.equal(provider.current(COMPANY_B, CONN_B, "L1").priceMinor, 1000, "company B's listing is untouched");
});

test("a price change over the spend cap is refused at prepare and no provider call is made", async () => {
  const provider = createMemoryMarketplaceProvider({ rateLimit: createMarketplaceRateLimiter({ now: () => START, ...DEFAULT_RATE_LIMIT_CONFIG }) });
  const world = marketplaceWorld(provider);
  const listing = seedMemory(provider, COMPANY_A, CONN_A);
  await storeListing(world, COMPANY_A, CONN_A, listing);
  await assert.rejects(world.runtime.prepare(COMPANY_A, ownerA, priceWrite(CONN_A, listing, 1500, "cap-1")), (e) => e.code === "spend_limit");
  assert.equal(provider.writes.length, 0);
});

test("the marketplace store returns only its own company's connections, listings and proposals", async () => {
  const store = createMemoryMarketplaceStore();
  store.putConnection(connection(COMPANY_A, CONN_A, OWNER_A));
  store.putConnection(connection(COMPANY_B, CONN_B, OWNER_B));
  await store.saveListing({ companyId: COMPANY_B, connectionId: CONN_B, provider: "generic", externalListingId: "X", sourceHash: HASH, listing: { externalListingId: "X", title: "t", priceMinor: 1, currency: "AUD", quantity: 1, sourceHash: HASH, raw: {} }, firstSeenAt: START, lastSeenAt: START });

  assert.equal(await store.getConnection(COMPANY_A, CONN_B), null);
  assert.deepEqual((await store.listConnections(COMPANY_A)).map((c) => c.connectionId), [CONN_A]);
  assert.equal(await store.getListing(COMPANY_A, CONN_B, "X"), null);
  assert.deepEqual(await store.listListings(COMPANY_A, CONN_B, 10), []);
  assert.equal(await store.getProposal(COMPANY_A, "missing"), null);
});

// ---------- generic provider over the injected HTTP client ----------

function json(status, value) {
  return { status, headers: {}, body: JSON.stringify(value) };
}

/**
 * A fake gateway. It checks the HMAC signature of every request, answers reads and writes from its own listings,
 * and records every request it receives. It never sees a token because the runtime never sends one.
 */
function gatewayFake(initial) {
  const listings = new Map(Object.entries(initial).map(([id, value]) => [id, structuredClone(value)]));
  const requests = [];
  const http = async (request) => {
    requests.push(request);
    const expected = createHmac("sha256", GATEWAY_SECRET).update(request.body, "utf8").digest("hex");
    if (request.headers["x-payload-signature"] !== expected) return json(401, { error_code: "bad_signature" });
    const body = JSON.parse(request.body);
    if (request.url.endsWith("/v1/marketplace/read")) {
      if (body.operation === "listings.get") return json(200, { item: listings.get(body.payload.external_listing_id) ?? null });
      if (body.operation === "listings.search") return json(200, { items: [...listings.values()], next_cursor: null });
      return json(500, {});
    }
    const current = listings.get(body.external_listing_id);
    if (!current) return json(404, { error_code: "not_found" });
    const currentHash = normaliseListing("generic", current).sourceHash;
    if (currentHash !== body.expected_source_hash) return json(409, { current_source_hash: currentHash });
    const changes = body.payload.changes;
    const next = structuredClone(current);
    let rollback = {};
    if (body.operation === "listing.price.update") {
      rollback = body.payload.mode === "execute" ? { priceMinor: current.price.amount, currency: current.price.currency } : {};
      if (body.payload.mode === "execute") next.price = { amount: changes.priceMinor, currency: changes.currency };
      else next.price = { amount: changes.priceMinor, currency: current.price.currency };
    } else if (body.operation === "listing.pause") {
      rollback = { status: current.status };
      next.status = "paused";
    } else if (body.operation === "listing.resume") {
      rollback = { status: current.status };
      next.status = "active";
    } else {
      return json(400, { error_code: "unsupported_operation" });
    }
    listings.set(body.external_listing_id, next);
    return json(200, body.payload.mode === "execute" ? { listing: next, rollback_state: rollback } : { listing: next });
  };
  return { http, requests, listings };
}

const GATEWAY_LISTING = { external_listing_id: "G1", title: "Hose reel", price: { amount: 1000, currency: "AUD" }, quantity: 5, status: "active", description: "Reel", attributes: {} };

function genericProvider(rateLimit, options = {}) {
  return createGenericMarketplaceProvider({
    baseUrl: GATEWAY_URL,
    rateLimit,
    loadCredentials: async (companyId, connectionId) => (companyId === COMPANY_A && connectionId === CONN_A ? { [GATEWAY_SIGNING_SECRET_KEY]: GATEWAY_SECRET } : null),
    ...options,
  });
}

test("the generic provider signs every request, sends a timeout and never puts a token in the body", async () => {
  const gateway = gatewayFake({ G1: GATEWAY_LISTING });
  const limiter = createMarketplaceRateLimiter({ now: () => START, ...DEFAULT_RATE_LIMIT_CONFIG });
  const provider = genericProvider(limiter);
  const ref = { companyId: COMPANY_A, connectionId: CONN_A, provider: "generic" };

  const listing = await provider.read.getListing(ref, "G1", gateway.http);
  assert.equal(listing.priceMinor, 1000);
  assert.equal(listing.currency, "AUD");
  assert.match(listing.sourceHash, /^[0-9a-f]{64}$/);

  const [request] = gateway.requests;
  assert.equal(request.method, "POST");
  assert.equal(request.url, `${GATEWAY_URL}/v1/marketplace/read`);
  assert.equal(request.timeoutMs, 20_000);
  const body = JSON.parse(request.body);
  assert.equal(body.operation, "listings.get");
  assert.ok(!Object.keys(body).some((key) => /token/i.test(key)), "no token field in the request");
});

test("the generic provider refuses to run without a signing secret, before any request is sent", async () => {
  const gateway = gatewayFake({ G1: GATEWAY_LISTING });
  const limiter = createMarketplaceRateLimiter({ now: () => START, ...DEFAULT_RATE_LIMIT_CONFIG });
  const provider = createGenericMarketplaceProvider({ baseUrl: GATEWAY_URL, rateLimit: limiter, loadCredentials: async () => ({ [GATEWAY_SIGNING_SECRET_KEY]: "too-short" }) });
  await assert.rejects(
    provider.read.getListing({ companyId: COMPANY_A, connectionId: CONN_A, provider: "generic" }, "G1", gateway.http),
    (e) => e instanceof MarketplaceError && e.code === "misconfigured",
  );
  assert.equal(gateway.requests.length, 0);
});

test("the generic gateway must be an https URL chosen by the operator", () => {
  const limiter = createMarketplaceRateLimiter({ now: () => START, ...DEFAULT_RATE_LIMIT_CONFIG });
  assert.throws(() => genericProvider(limiter, { baseUrl: "http://gateway.example.test" }), (e) => e.code === "misconfigured");
  assert.throws(() => genericProvider(limiter, { baseUrl: "not a url" }), (e) => e.code === "misconfigured");
});

test("a read-only generic provider has no write operations", () => {
  const limiter = createMarketplaceRateLimiter({ now: () => START, ...DEFAULT_RATE_LIMIT_CONFIG });
  assert.equal(genericProvider(limiter, { writable: false }).write, null);
});

test("prepare, confirm and execute through the generic provider send the reviewed change, and pause is a distinct operation", async () => {
  const gateway = gatewayFake({ G1: GATEWAY_LISTING });
  const ref = { companyId: COMPANY_A, connectionId: CONN_A, provider: "generic" };
  const provider = genericProvider(createMarketplaceRateLimiter({ now: () => START, ...DEFAULT_RATE_LIMIT_CONFIG }));
  const world = marketplaceWorld(provider, gateway.http);

  const listing = await provider.read.getListing(ref, "G1", gateway.http);
  await storeListing(world, COMPANY_A, CONN_A, listing);

  const prepared = await world.runtime.prepare(COMPANY_A, ownerA, { connectionId: CONN_A, externalListingId: "G1", operation: "update_price", changes: { priceMinor: 1100, currency: "AUD" }, expectedSourceHash: listing.sourceHash, idempotencyKey: "gw-1" });
  await world.runtime.confirm(COMPANY_A, ownerA, prepared.proposal.id, prepared.confirmationToken);
  const executed = await world.runtime.execute(COMPANY_A, ownerA, prepared.proposal.id);
  assert.equal(executed.status, "executed");
  assert.equal(gateway.listings.get("G1").price.amount, 1100);

  const writeBody = gateway.requests.map((r) => JSON.parse(r.body)).find((b) => b.operation === "listing.price.update");
  assert.deepEqual(writeBody.payload.changes, { priceMinor: 1100, currency: "AUD" });
  assert.equal(writeBody.idempotency_key, "gw-1");
  assert.ok(!gateway.requests.some((r) => r.body.includes(prepared.confirmationToken)), "the confirmation token is not sent to the gateway");

  // Pause is sent as its own operation, not as a listing update.
  const fresh = await provider.read.getListing(ref, "G1", gateway.http);
  await storeListing(world, COMPANY_A, CONN_A, fresh);
  const pause = await world.runtime.prepare(COMPANY_A, ownerA, { connectionId: CONN_A, externalListingId: "G1", operation: "pause_listing", changes: {}, expectedSourceHash: fresh.sourceHash, idempotencyKey: "gw-2" });
  await world.runtime.confirm(COMPANY_A, ownerA, pause.proposal.id, pause.confirmationToken);
  const paused = await world.runtime.execute(COMPANY_A, ownerA, pause.proposal.id);
  assert.equal(paused.status, "executed");
  assert.equal(gateway.listings.get("G1").status, "paused");
  assert.ok(gateway.requests.some((r) => JSON.parse(r.body).operation === "listing.pause"));
});

test("a gateway conflict is returned as a conflict, a definite rejection as rejected, and an unknown outcome throws", async () => {
  const limiter = createMarketplaceRateLimiter({ now: () => START, ...DEFAULT_RATE_LIMIT_CONFIG });
  const provider = genericProvider(limiter);
  const ref = { companyId: COMPANY_A, connectionId: CONN_A, provider: "generic" };
  const writeRequest = { externalListingId: "G1", operation: "write_price", providerOperation: "update_price", changes: { priceMinor: 1100, currency: "AUD" }, expectedSourceHash: HASH, idempotencyKey: "w-1" };

  const conflict = await provider.write.execute(ref, writeRequest, async () => json(409, { current_source_hash: "b".repeat(64) }));
  assert.deepEqual(conflict, { status: "conflict", currentSourceHash: "b".repeat(64) });

  const rejected = await provider.write.execute(ref, writeRequest, async () => json(422, { error_code: "Price Too Low <script>" }));
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.errorCode, "provider_rejected", "provider text that is not a code is never stored");

  await assert.rejects(provider.write.execute(ref, writeRequest, async () => json(502, {})), (e) => e.code === "provider_unavailable");
  await assert.rejects(
    provider.write.execute(ref, writeRequest, async () => json(200, { listing: GATEWAY_LISTING })),
    (e) => e.code === "provider_unavailable",
    "a success without the rollback state is an unknown outcome and must not be stored as applied",
  );
  const noOperation = await provider.write.execute(ref, { ...writeRequest, providerOperation: "update_colour" }, noNetwork);
  assert.equal(noOperation.errorCode, "unsupported_operation");
});

test("the in-memory provider applies a repeated idempotency key once and checks the expected source hash", async () => {
  const provider = createMemoryMarketplaceProvider({ rateLimit: createMarketplaceRateLimiter({ now: () => START, ...DEFAULT_RATE_LIMIT_CONFIG }) });
  const listing = seedMemory(provider, COMPANY_A, CONN_A);
  const ref = { companyId: COMPANY_A, connectionId: CONN_A, provider: "generic" };
  const request = { externalListingId: "L1", operation: "write_price", providerOperation: "update_price", changes: { priceMinor: 1100, currency: "AUD" }, expectedSourceHash: listing.sourceHash, idempotencyKey: "m-1" };

  const first = await provider.write.execute(ref, request, noNetwork);
  const second = await provider.write.execute(ref, request, noNetwork);
  assert.equal(first.status, "applied");
  assert.deepEqual(second, first);
  assert.equal(provider.current(COMPANY_A, CONN_A, "L1").priceMinor, 1100);

  const stale = await provider.write.execute(ref, { ...request, idempotencyKey: "m-2" }, noNetwork);
  assert.equal(stale.status, "conflict", "the listing moved on, so the old hash no longer matches");
  assert.equal(provider.current(COMPANY_A, CONN_A, "L1").priceMinor, 1100);
});

// ---------- order-ops Drizzle store ----------

/**
 * Fake executor. It records every query and the SQL that the store built. With honorWhere it keeps only rows whose
 * company id appears in the WHERE parameters. Without it, it returns every row, so the store's own check is tested.
 */
function fakeExecutor({ honorWhere }) {
  const tables = new Map();
  const recorded = [];
  const rowsOf = (table) => {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table);
  };
  const paramsOf = (condition) => (condition ? new PgDialect().sqlToQuery(condition).params : []);
  const select = (rows, rec) => {
    const query = {
      where(condition) {
        rec.where.push(condition);
        return query;
      },
      limit() {
        return query;
      },
      orderBy() {
        return query;
      },
      then(resolve, reject) {
        const scoped = honorWhere && rec.where.length > 0 ? rows().filter((row) => paramsOf(rec.where.at(-1)).includes(row.companyId)) : rows();
        return Promise.resolve(scoped.map((row) => ({ ...row }))).then(resolve, reject);
      },
    };
    return query;
  };
  const exec = {
    select() {
      const rec = { kind: "select", where: [] };
      recorded.push(rec);
      return {
        from(table) {
          rec.table = table;
          return select(() => rowsOf(table), rec);
        },
      };
    },
    insert(table) {
      const rec = { kind: "insert", where: [], table };
      recorded.push(rec);
      return {
        values(values) {
          const row = { ...values };
          rowsOf(table).push(row);
          const done = { returning: () => Promise.resolve([{ ...row }]), onConflictDoNothing: () => done };
          return done;
        },
      };
    },
    update(table) {
      const rec = { kind: "update", where: [], table };
      recorded.push(rec);
      return {
        set(patch) {
          rec.set = patch;
          return {
            where(condition) {
              rec.where.push(condition);
              return {
                returning: () => {
                  const rows = rowsOf(table).filter((row) => !honorWhere || paramsOf(condition).includes(row.companyId));
                  rows.forEach((row) => Object.assign(row, patch));
                  return Promise.resolve(rows.map((row) => ({ ...row })));
                },
              };
            },
          };
        },
      };
    },
    transaction: (work) => work(exec),
  };
  return { exec, recorded, tables, rowsOf };
}

function orderRow(chatbotId, sourceOrderId = "ORD-1") {
  return {
    chatbotId,
    sourceType: "native",
    sourceScope: "native",
    sourceOrderId,
    nativeOrderId: null,
    marketplaceOrderId: null,
    connectionId: null,
    externalAuthoritative: false,
    status: "confirmed",
    fulfillmentStatus: "unfulfilled",
    paymentStatus: "paid",
    currency: "AUD",
    grossTotal: 1000,
    discountTotal: 0,
    taxTotal: 0,
    shippingTotal: 0,
    refundTotal: 0,
    chargebackTotal: 0,
    feeTotal: 0,
    shippingCostTotal: 0,
    expectedNetPayout: 0,
    reportedNetPayout: 0,
    settlementVariance: 0,
    reconciliationStatus: "unreconciled",
    buyerDisplayName: null,
    shippingAddress: {},
    placedAt: START,
    sourceUpdatedAt: START,
    sourceSnapshot: {},
    sourceHash: HASH,
    metadata: {},
    lastProjectedAt: START,
  };
}

test("the Drizzle order-ops store returns only its own company's rows, even when the database returns more", async () => {
  for (const honorWhere of [true, false]) {
    const fake = fakeExecutor({ honorWhere });
    const store = createDrizzleOrderOpsStore(fake.exec, { newId: counterIds("ord") });
    const a = await store.unifiedOrders.insert(COMPANY_A, orderRow(CHATBOT_A, "A-1"));
    const b = await store.unifiedOrders.insert(COMPANY_B, orderRow(CHATBOT_B, "B-1"));

    const listedA = await store.unifiedOrders.list(COMPANY_A);
    assert.deepEqual(listedA.map((o) => o.id), [a.id], `list for company A (honorWhere=${honorWhere})`);
    assert.equal(await store.unifiedOrders.get(COMPANY_A, b.id), null);
    assert.equal(await store.unifiedOrders.find(COMPANY_A, (o) => o.sourceOrderId === "B-1"), null);
    assert.equal(await store.unifiedOrders.update(COMPANY_A, b.id, { status: "cancelled" }), null);
    if (honorWhere) {
      assert.equal((await store.unifiedOrders.get(COMPANY_B, b.id)).status, "confirmed", "a patch from company A must not change B's row when the database honours WHERE");
    }
  }
});

test("every Drizzle order-ops query carries the company id in its SQL, and a patch cannot move a row", async () => {
  const fake = fakeExecutor({ honorWhere: true });
  const store = createDrizzleOrderOpsStore(fake.exec, { newId: counterIds("ord") });
  const inserted = await store.unifiedOrders.insert(COMPANY_A, orderRow(CHATBOT_A));
  await store.unifiedOrders.get(COMPANY_A, inserted.id);
  await store.unifiedOrders.update(COMPANY_A, inserted.id, { id: "other", companyId: COMPANY_B, status: "fulfilled" });

  const dialect = new PgDialect();
  const withWhere = fake.recorded.filter((r) => r.where.length > 0);
  assert.ok(withWhere.length >= 2);
  for (const rec of withWhere) {
    const rendered = dialect.sqlToQuery(rec.where[0]);
    assert.match(rendered.sql, /"company_id"/, `${rec.kind} filters on company_id`);
    assert.ok(rendered.params.includes(COMPANY_A), `${rec.kind} binds the caller's company`);
  }
  const updated = fake.recorded.find((r) => r.kind === "update");
  assert.equal(updated.set.companyId, undefined, "companyId is stripped from the patch");
  assert.equal(updated.set.id, undefined, "id is stripped from the patch");
  assert.equal(fake.rowsOf(chatbotCommerceUnifiedOrders)[0].companyId, COMPANY_A);
});

test("the Drizzle store refuses a missing company before any query is built", async () => {
  const fake = fakeExecutor({ honorWhere: true });
  const store = createDrizzleOrderOpsStore(fake.exec);
  await assert.rejects(store.unifiedOrders.list(""), (e) => e.status === 403);
  await assert.rejects(store.unifiedOrders.get("not-a-uuid", "x"), (e) => e.status === 403);
  assert.equal(fake.recorded.length, 0);
});

test("the Drizzle store keeps the transaction boundary and nests it as a savepoint", async () => {
  const fake = fakeExecutor({ honorWhere: true });
  const store = createDrizzleOrderOpsStore(fake.exec);
  const result = await store.transaction(async (tx) => {
    await tx.transaction(async (inner) => inner.unifiedOrders.insert(COMPANY_A, orderRow(CHATBOT_A, "N-1")));
    return "done";
  });
  assert.equal(result, "done");
  assert.equal(fake.rowsOf(chatbotCommerceUnifiedOrders).length, 1);
});

test("the outbox insert is idempotent by dedupe key, in the in-memory store", async () => {
  const store = createMemoryOrderOpsStore(counterIds("out"));
  const row = { topic: "commerce.test", aggregateId: "agg", payload: {}, dedupeKey: "same", status: "pending", attempts: 0, availableAt: START, publishedAt: null, createdAt: START };
  const first = await store.outbox.insert(COMPANY_A, row);
  const again = await store.outbox.insert(COMPANY_A, row);
  assert.equal(again.id, first.id);
  assert.equal((await store.outbox.list(COMPANY_A)).length, 1);
  assert.equal((await store.outbox.list(COMPANY_B)).length, 0);
});

// ---------- thread linking ----------

function threadWorld() {
  const store = createMemoryOrderOpsStore(counterIds("row"));
  const threads = new Map([
    ["thread-1", { id: "thread-1", chatbotId: CHATBOT_A, companyId: COMPANY_A }],
    ["thread-2", { id: "thread-2", chatbotId: CHATBOT_A, companyId: COMPANY_A }],
    ["thread-b", { id: "thread-b", chatbotId: CHATBOT_B, companyId: COMPANY_B }],
  ]);
  const linker = createThreadLinker({
    store,
    threads: {
      find: async (companyId, chatbotId, threadId) => {
        const t = threads.get(threadId);
        return t && t.companyId === companyId && t.chatbotId === chatbotId ? { id: t.id, chatbotId: t.chatbotId } : null;
      },
    },
    now: () => START,
  });
  return { store, linker };
}

const ownerActor = { userId: OWNER_A, chatbotOwnerId: OWNER_A };

test("a communication thread links to an order once", async () => {
  const { store, linker } = threadWorld();
  const order1 = await store.unifiedOrders.insert(COMPANY_A, orderRow(CHATBOT_A, "ORD-1"));
  const order2 = await store.unifiedOrders.insert(COMPANY_A, orderRow(CHATBOT_A, "ORD-2"));

  const first = await linker.linkCommunicationThread(COMPANY_A, ownerActor, { chatbotId: CHATBOT_A, orderId: order1.id, threadId: "thread-1", idempotencyKey: "link-1" });
  assert.equal(first.actionType, LINK_THREAD_ACTION);
  assert.equal(first.status, "completed");
  assert.equal(await linker.linkedOrderFor(COMPANY_A, CHATBOT_A, "thread-1"), order1.id);

  // Same thread, same order, new key: the existing link comes back and nothing new is written.
  const again = await linker.linkCommunicationThread(COMPANY_A, ownerActor, { chatbotId: CHATBOT_A, orderId: order1.id, threadId: "thread-1", idempotencyKey: "link-2" });
  assert.equal(again.id, first.id);
  assert.equal((await store.actions.list(COMPANY_A, (a) => a.actionType === LINK_THREAD_ACTION)).length, 1);

  // Same thread to a different order is refused and writes nothing.
  await assert.rejects(
    linker.linkCommunicationThread(COMPANY_A, ownerActor, { chatbotId: CHATBOT_A, orderId: order2.id, threadId: "thread-1", idempotencyKey: "link-3" }),
    (e) => e instanceof OrderOpsError && e.status === 409,
  );
  assert.equal((await store.actions.list(COMPANY_A, (a) => a.actionType === LINK_THREAD_ACTION)).length, 1);
  assert.equal(await linker.linkedOrderFor(COMPANY_A, CHATBOT_A, "thread-1"), order1.id);
});

test("thread linking refuses another company's thread or order, a reused key, and a non-owner", async () => {
  const { store, linker } = threadWorld();
  const order = await store.unifiedOrders.insert(COMPANY_A, orderRow(CHATBOT_A, "ORD-1"));
  const other = await store.unifiedOrders.insert(COMPANY_B, orderRow(CHATBOT_B, "ORD-B"));

  await assert.rejects(linker.linkCommunicationThread(COMPANY_A, ownerActor, { chatbotId: CHATBOT_A, orderId: order.id, threadId: "thread-b", idempotencyKey: "x-1" }), (e) => e.status === 404);
  await assert.rejects(linker.linkCommunicationThread(COMPANY_A, ownerActor, { chatbotId: CHATBOT_A, orderId: other.id, threadId: "thread-1", idempotencyKey: "x-2" }), (e) => e.status === 404);
  await assert.rejects(linker.linkCommunicationThread(COMPANY_A, { userId: "someone-else", chatbotOwnerId: OWNER_A }, { chatbotId: CHATBOT_A, orderId: order.id, threadId: "thread-1", idempotencyKey: "x-3" }), (e) => e.status === 422);

  await linker.linkCommunicationThread(COMPANY_A, ownerActor, { chatbotId: CHATBOT_A, orderId: order.id, threadId: "thread-1", idempotencyKey: "reuse" });
  await assert.rejects(linker.linkCommunicationThread(COMPANY_A, ownerActor, { chatbotId: CHATBOT_A, orderId: order.id, threadId: "thread-2", idempotencyKey: "reuse" }), (e) => e.status === 422);
  assert.equal(await linker.linkedOrderFor(COMPANY_B, CHATBOT_B, "thread-1"), null);
});

// ---------- lifecycle ----------

function lifecycleWorld() {
  const clock = clockOf();
  const states = createMemoryLifecycleStore();
  return { lifecycle: createCommerceLifecycle({ states, now: clock.now }), states, clock };
}

test("the lifecycle starts enabled, records each change with an event, and keeps companies apart", async () => {
  const { lifecycle, states } = lifecycleWorld();
  assert.equal(await lifecycle.status(COMPANY_A), "enabled");
  assert.equal(await lifecycle.isEnabled(COMPANY_A), true);

  await lifecycle.ensureInstalled(COMPANY_A, "1.0.0");
  await lifecycle.disable(COMPANY_A, "Paused by seller.");
  assert.equal(await lifecycle.isEnabled(COMPANY_A), false);
  assert.equal(await lifecycle.status(COMPANY_B), "enabled", "company B is untouched");

  const again = await lifecycle.disable(COMPANY_A, "Paused by seller.");
  assert.equal(again.status, "disabled", "a repeated disable is a no-op");
  assert.equal(states.events.filter((e) => e.companyId === COMPANY_A).length, 2, "install and disable were recorded once each");

  await lifecycle.enable(COMPANY_A, "1.0.0");
  assert.equal(await lifecycle.isEnabled(COMPANY_A), true);
  assert.deepEqual(states.events.at(-1).to, "enabled");
});

test("an illegal lifecycle transition is refused and nothing is written", async () => {
  const { lifecycle, states } = lifecycleWorld();
  await lifecycle.ensureInstalled(COMPANY_A, "1.0.0");
  const eventsBefore = states.events.length;

  // Enabled cannot complete an uninstall without first beginning it.
  await assert.rejects(lifecycle.completeUninstall(COMPANY_A), (e) => e instanceof OrderOpsError && e.status === 409);
  assert.equal(await lifecycle.status(COMPANY_A), "enabled");
  assert.equal(states.events.length, eventsBefore);

  await lifecycle.beginUninstall(COMPANY_A, "Removing the extension.");
  await lifecycle.completeUninstall(COMPANY_A);
  // Uninstalled can only be reinstalled. Disabling it is illegal.
  await assert.rejects(lifecycle.disable(COMPANY_A), (e) => e.status === 409);
  await assert.rejects(lifecycle.beginUninstall(COMPANY_A), (e) => e.status === 409);
  assert.equal(await lifecycle.status(COMPANY_A), "uninstalled");

  await lifecycle.ensureInstalled(COMPANY_A, "1.1.0");
  assert.equal(await lifecycle.status(COMPANY_A), "enabled", "an uninstalled company is reinstalled at startup");
});

test("the lifecycle keeps order data on every transition, and an uninstall in progress can be cancelled", async () => {
  const { lifecycle, states } = lifecycleWorld();
  await lifecycle.ensureInstalled(COMPANY_A, "1.0.0");
  await lifecycle.beginUninstall(COMPANY_A, "Removing.");
  const cancelled = await lifecycle.enable(COMPANY_A, "1.0.0", "Uninstall cancelled.");
  assert.equal(cancelled.status, "enabled");
  assert.equal(cancelled.uninstallStartedAt, null);
  assert.ok(states.events.every((e) => e.dedupeKey.startsWith(`lifecycle:${COMPANY_A}:`)));
  assert.equal((await states.get(COMPANY_A)).preserveData, true);
});

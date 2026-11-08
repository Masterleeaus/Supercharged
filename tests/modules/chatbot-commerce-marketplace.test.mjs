// Marketplace read, write, bulk and rate-limit tests (node:test). No network: the provider is an in-process fake
// and the HTTP client throws if anything calls it. Tenancy, confirmation, role, spend and per-item rules are covered.
import test from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  MarketplaceError,
  createMarketplaceRateLimiter,
  createMarketplaceReadRegistry,
  createMarketplaceWriteRegistry,
  createMarketplaceReadRuntime,
  createMarketplaceWriteRuntime,
  createMarketplaceBulkRuntime,
  createApprovalSigner,
  createMemoryMarketplaceStore,
  assessConflicts,
  sanitiseChanges,
  selectBulkCandidates,
  priceImpact,
  canTransitionWrite,
} from "../../server/modules/chatbot/commerce/marketplace/index.ts";
import {
  listingWhere,
  proposalByKeyWhere,
  batchItemsWhere,
} from "../../server/modules/chatbot/commerce/marketplace/drizzle-queries.ts";
import {
  chatbotMarketplaceListings,
  chatbotMarketplaceWriteProposals,
  MARKETPLACE_CONSTRAINTS,
} from "../../server/modules/chatbot/db/commerce-marketplace.ts";
import { CONTRACT_FLAGS, readFlag } from "../../server/modules/chatbot/contracts/index.ts";

// ---------- fixtures ----------

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
// Test-only signing secret. Not a provider key.
const SECRET = "marketplace-test-signing-secret-0123456789";
const FLAG_ON = { [CONTRACT_FLAGS.MARKETPLACE_WRITE_ENABLED]: "true" };
const OWNER_A = { companyId: COMPANY_A, userId: "user-owner-a", role: "owner" };
const ADMIN_A_OTHER = { companyId: COMPANY_A, userId: "user-admin-a", role: "admin" };
const VIEWER_A = { companyId: COMPANY_A, userId: "user-owner-a", role: "viewer" };
const OWNER_B = { companyId: COMPANY_B, userId: "user-owner-b", role: "owner" };
const HOUR = 60 * 60 * 1000;
const noNetwork = async () => {
  throw new Error("network must not be used in tests");
};

function counterIds() {
  let n = 0;
  return () => `id-${++n}`;
}

function fakeEbay(state) {
  const calls = { search: [], get: [], write: [], rollback: [] };
  const listingOf = (connectionId, id) => state.listings.get(connectionId)?.get(id) ?? null;
  const provider = {
    key: "ebay",
    capabilities: () => ["read_listings", "write_price", "write_inventory", "write_listing"],
    read: {
      async searchListings(ref) {
        calls.search.push(ref.connectionId);
        return { rows: [...(state.listings.get(ref.connectionId)?.values() ?? [])].map((l) => ({ ...l })), nextCursor: null };
      },
      async getListing(ref, id) {
        calls.get.push(ref.connectionId);
        const found = listingOf(ref.connectionId, id);
        return found ? { ...found } : null;
      },
      async getInventory() {
        return [];
      },
      async importOrders() {
        return { orders: [], nextCursor: null };
      },
    },
    write: {
      async execute(ref, req) {
        calls.write.push({ connectionId: ref.connectionId, ...req });
        if (state.writeFails.has(req.externalListingId)) throw new Error("upstream 500 detail that must not leak");
        const current = listingOf(ref.connectionId, req.externalListingId);
        if (!current) return { status: "rejected", errorCode: "not_found", message: "missing" };
        if (current.sourceHash !== req.expectedSourceHash) return { status: "conflict", currentSourceHash: current.sourceHash };
        if (state.writeReject) return { status: "rejected", errorCode: state.writeReject, message: "refused" };
        const rollbackState = { priceMinor: current.priceMinor, quantity: current.quantity, title: current.title };
        if ("priceMinor" in req.changes) current.priceMinor = req.changes.priceMinor;
        if ("quantity" in req.changes) current.quantity = req.changes.quantity;
        if ("title" in req.changes) current.title = req.changes.title;
        current.sourceHash = `h-${++state.version}`;
        return { status: "applied", sourceHash: current.sourceHash, rollbackState };
      },
      async rollback(ref, req) {
        calls.rollback.push({ connectionId: ref.connectionId, ...req });
        const current = listingOf(ref.connectionId, req.externalListingId);
        if (!current) return { status: "rejected", errorCode: "not_found", message: "missing" };
        if (current.sourceHash !== req.expectedSourceHash) return { status: "conflict", currentSourceHash: current.sourceHash };
        Object.assign(current, req.rollbackState);
        current.sourceHash = `h-${++state.version}`;
        return { status: "applied", sourceHash: current.sourceHash, rollbackState: {} };
      },
    },
    rateLimit: {
      acquire: async () => ({ allowed: true, retryAfterMs: null, remaining: null }),
      observe: async () => {},
      recordFailure: async () => {},
    },
  };
  return { provider, calls, state };
}

function harness(options = {}) {
  let nowMs = Date.UTC(2026, 10, 8, 10, 0, 0);
  const clock = () => new Date(nowMs);
  const advance = (ms) => {
    nowMs += ms;
  };
  const store = createMemoryMarketplaceStore();
  const state = { listings: new Map(), writeFails: new Set(), writeReject: null, version: 0 };
  const ebay = fakeEbay(state);
  const readRegistry = createMarketplaceReadRegistry({ ebay: ebay.provider });
  const writeRegistry = createMarketplaceWriteRegistry({ ebay: ebay.provider });
  const rateLimit = createMarketplaceRateLimiter({
    now: clock,
    read: { perProvider: { limit: 60, windowMs: 60_000 }, perCompany: { limit: 240, windowMs: 60_000 } },
    write: { perProvider: { limit: options.writeLimit ?? 10, windowMs: 60_000 }, perCompany: { limit: 30, windowMs: 60_000 } },
    breaker: { failureThreshold: 5, failureWindowMs: 60_000, cooldownMs: 60_000 },
    defaultBackoffMs: 60_000,
  });
  const common = { store, readRegistry, writeRegistry, rateLimit, http: noNetwork, clock, approvalSecret: SECRET, newId: counterIds() };
  const write = createMarketplaceWriteRuntime({
    ...common,
    env: options.env ?? FLAG_ON,
    inventoryAvailable: options.inventoryAvailable,
    config: options.writeConfig,
  });
  const bulk = createMarketplaceBulkRuntime({
    store,
    writes: write,
    signer: write.signer,
    env: options.env ?? FLAG_ON,
    clock,
    config: { bulkEnabled: true, maxItems: 250, ...(options.bulkConfig ?? {}) },
    newId: counterIds(),
  });
  const reads = createMarketplaceReadRuntime({ store, registry: readRegistry, rateLimit, http: noNetwork, clock });

  const companyOf = { "conn-a": COMPANY_A, "conn-b": COMPANY_B };
  async function seed(connectionId, externalListingId, extra = {}) {
    const listing = {
      externalListingId,
      title: `Item ${externalListingId}`,
      priceMinor: 1000,
      currency: "AUD",
      quantity: 5,
      sourceHash: `seed-${externalListingId}`,
      raw: { status: "active", attributes: { brand: "Acme", category: "tools" }, description: "d" },
      ...extra,
    };
    state.listings.set(connectionId, state.listings.get(connectionId) ?? new Map());
    state.listings.get(connectionId).set(externalListingId, listing);
    await store.saveListing({
      companyId: companyOf[connectionId],
      connectionId,
      provider: "ebay",
      externalListingId,
      sourceHash: listing.sourceHash,
      listing: { ...listing },
      firstSeenAt: clock(),
      lastSeenAt: clock(),
    });
    return listing;
  }

  store.putConnection({
    companyId: COMPANY_A,
    connectionId: "conn-a",
    provider: "ebay",
    ownerUserId: "user-owner-a",
    active: true,
    writeEnabled: true,
    capabilities: ["read_listings", "write_price", "write_inventory", "write_listing"],
  });
  store.putConnection({
    companyId: COMPANY_B,
    connectionId: "conn-b",
    provider: "ebay",
    ownerUserId: "user-owner-b",
    active: true,
    writeEnabled: true,
    capabilities: ["read_listings", "write_price", "write_inventory", "write_listing"],
  });

  return { store, state, ebay, write, bulk, reads, rateLimit, clock, advance, seed, signer: write.signer };
}

function priceInput(overrides = {}) {
  return {
    connectionId: "conn-a",
    externalListingId: "L1",
    operation: "update_price",
    changes: { priceMinor: 1100, currency: "AUD" },
    expectedSourceHash: "seed-L1",
    idempotencyKey: "key-price-1",
    ...overrides,
  };
}

// ---------- registries ----------

test("registries normalise keys, refuse unknown providers and read-only writes", () => {
  const readOnly = { key: "generic", capabilities: () => ["read_listings"], read: {}, write: null, rateLimit: {} };
  const readRegistry = createMarketplaceReadRegistry({ generic: readOnly });
  assert.equal(readRegistry.get("  GENERIC ").key, "generic");
  assert.deepEqual(readRegistry.keys(), ["generic"]);
  assert.throws(() => readRegistry.get("etsy"), (e) => e instanceof MarketplaceError && e.code === "unsupported_provider");
  const writeRegistry = createMarketplaceWriteRegistry({ generic: readOnly });
  assert.throws(() => writeRegistry.get("generic"), (e) => e.code === "read_only_provider");
  assert.equal(writeRegistry.hasWrite("generic"), false);
  const wrongKey = createMarketplaceReadRegistry({ ebay: readOnly });
  assert.throws(() => wrongKey.get("ebay"), (e) => e.code === "provider_mismatch");
});

// ---------- rate limiter ----------

test("rate limiter blocks over the window and frees a slot when the window slides", async () => {
  let now = Date.UTC(2026, 10, 8);
  const limiter = createMarketplaceRateLimiter({
    now: () => new Date(now),
    read: { perProvider: { limit: 2, windowMs: 60_000 }, perCompany: { limit: 10, windowMs: 60_000 } },
    write: { perProvider: { limit: 2, windowMs: 60_000 }, perCompany: { limit: 10, windowMs: 60_000 } },
    breaker: { failureThreshold: 5, failureWindowMs: 60_000, cooldownMs: 60_000 },
    defaultBackoffMs: 60_000,
  });
  assert.equal((await limiter.acquire(COMPANY_A, "ebay", "write_price")).allowed, true);
  now += 10_000;
  assert.equal((await limiter.acquire(COMPANY_A, "ebay", "write_price")).allowed, true);
  const denied = await limiter.acquire(COMPANY_A, "ebay", "write_price");
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterMs, 50_000, "retry is when the oldest hit leaves the window");
  // A denied call consumes no slot, so after the first hit leaves the window one slot is free again.
  now += 50_001;
  assert.equal((await limiter.acquire(COMPANY_A, "ebay", "write_price")).allowed, true);
  assert.equal((await limiter.acquire(COMPANY_A, "ebay", "write_price")).allowed, false, "both slots in use again");
});

test("rate limiter applies the company bucket across providers and keeps companies apart", async () => {
  let now = Date.UTC(2026, 10, 8);
  const limiter = createMarketplaceRateLimiter({
    now: () => new Date(now),
    read: { perProvider: { limit: 5, windowMs: 60_000 }, perCompany: { limit: 5, windowMs: 60_000 } },
    write: { perProvider: { limit: 5, windowMs: 60_000 }, perCompany: { limit: 1, windowMs: 60_000 } },
    breaker: { failureThreshold: 5, failureWindowMs: 60_000, cooldownMs: 60_000 },
    defaultBackoffMs: 60_000,
  });
  assert.equal((await limiter.acquire(COMPANY_A, "ebay", "write_price")).allowed, true);
  assert.equal((await limiter.acquire(COMPANY_A, "etsy", "write_price")).allowed, false, "company bucket shared across providers");
  assert.equal((await limiter.acquire(COMPANY_B, "ebay", "write_price")).allowed, true, "other company unaffected");
});

test("a 429 pauses the provider for the company and repeated failures open the breaker", async () => {
  let now = Date.UTC(2026, 10, 8);
  const limiter = createMarketplaceRateLimiter({
    now: () => new Date(now),
    read: { perProvider: { limit: 50, windowMs: 60_000 }, perCompany: { limit: 50, windowMs: 60_000 } },
    write: { perProvider: { limit: 50, windowMs: 60_000 }, perCompany: { limit: 50, windowMs: 60_000 } },
    breaker: { failureThreshold: 2, failureWindowMs: 60_000, cooldownMs: 30_000 },
    defaultBackoffMs: 60_000,
  });
  await limiter.observe(COMPANY_A, "ebay", "read_listings", { status: 429, headers: { "retry-after": "120" } });
  const paused = await limiter.acquire(COMPANY_A, "ebay", "read_listings");
  assert.equal(paused.allowed, false);
  assert.equal(paused.retryAfterMs, 120_000);
  now += 121_000;
  await limiter.recordFailure(COMPANY_A, "ebay", "read_listings", "timeout");
  await limiter.recordFailure(COMPANY_A, "ebay", "read_listings", "timeout");
  assert.equal((await limiter.acquire(COMPANY_A, "ebay", "read_listings")).allowed, false, "breaker open");
  now += 30_001;
  assert.equal((await limiter.acquire(COMPANY_A, "ebay", "read_listings")).allowed, true, "breaker closed after cooldown");
});

// ---------- reads ----------

test("marketplace search returns only the caller's company and never calls another company's connection", async () => {
  const h = harness();
  await h.seed("conn-a", "A-1");
  await h.seed("conn-b", "B-1");
  const forB = await h.reads.searchListings(COMPANY_B, { keywords: "x", limit: 10 });
  assert.deepEqual(forB.rows.map((r) => r.listing.externalListingId), ["B-1"]);
  assert.equal(h.ebay.calls.search.includes("conn-a"), false, "company A connection never called for company B");
  const forA = await h.reads.searchListings(COMPANY_A, { limit: 10 });
  assert.deepEqual(forA.rows.map((r) => r.listing.externalListingId), ["A-1"]);
});

test("listing lookup with another company's connection id returns null and calls no provider", async () => {
  const h = harness();
  await h.seed("conn-a", "A-1");
  const found = await h.reads.getListing(COMPANY_B, "conn-a", "A-1");
  assert.equal(found, null);
  assert.equal(h.ebay.calls.get.length, 0);
  assert.equal(await h.reads.storedListing(COMPANY_B, "conn-a", "A-1"), null, "stored snapshot is company scoped");
  const own = await h.reads.getListing(COMPANY_A, "conn-a", "A-1");
  assert.equal(own.listing.externalListingId, "A-1");
});

test("a provider that returns a different listing is rejected, not stored", async () => {
  const h = harness();
  await h.seed("conn-a", "A-1");
  h.ebay.provider.read.getListing = async () => ({ externalListingId: "OTHER", title: "x", priceMinor: 1, currency: "AUD", quantity: 1, sourceHash: "z", raw: {} });
  await assert.rejects(h.reads.getListing(COMPANY_A, "conn-a", "A-1"), (e) => e.code === "provider_mismatch");
});

test("a failing provider is reported without its error text, and a rate-limited one is not called", async () => {
  const h = harness();
  await h.seed("conn-a", "A-1");
  h.ebay.provider.read.searchListings = async () => {
    throw new Error("secret-upstream-token-xyz");
  };
  const failed = await h.reads.searchListings(COMPANY_A, { limit: 5 });
  assert.equal(failed.errors[0].code, "provider_unavailable");
  assert.equal(JSON.stringify(failed).includes("secret-upstream-token-xyz"), false);

  const limited = createMarketplaceRateLimiter({
    now: h.clock,
    read: { perProvider: { limit: 0, windowMs: 60_000 }, perCompany: { limit: 0, windowMs: 60_000 } },
    write: { perProvider: { limit: 1, windowMs: 60_000 }, perCompany: { limit: 1, windowMs: 60_000 } },
    breaker: { failureThreshold: 5, failureWindowMs: 60_000, cooldownMs: 60_000 },
    defaultBackoffMs: 60_000,
  });
  const reads = createMarketplaceReadRuntime({
    store: h.store,
    registry: createMarketplaceReadRegistry({ ebay: h.ebay.provider }),
    rateLimit: limited,
    http: noNetwork,
    clock: h.clock,
  });
  h.ebay.calls.search.length = 0;
  h.ebay.provider.read.searchListings = async (ref) => {
    h.ebay.calls.search.push(ref.connectionId);
    return { rows: [], nextCursor: null };
  };
  const blocked = await reads.searchListings(COMPANY_A, { limit: 5 });
  assert.equal(blocked.errors[0].code, "rate_limited");
  assert.equal(h.ebay.calls.search.length, 0);
});

// ---------- writes ----------

test("a write that was never confirmed is refused and the provider is not called", async () => {
  const h = harness();
  await h.seed("conn-a", "L1");
  const { proposal, confirmationToken } = await h.write.prepare(COMPANY_A, OWNER_A, priceInput());
  assert.equal(proposal.status, "prepared");
  assert.ok(confirmationToken, "a token is issued for the seller to confirm");
  await assert.rejects(h.write.execute(COMPANY_A, OWNER_A, proposal.id), (e) => e.code === "confirmation_required");
  assert.equal(h.ebay.calls.write.length, 0);
});

test("writes are refused when CHATBOT_MARKETPLACE_WRITE_ENABLED is not exactly \"true\"", async () => {
  for (const value of [undefined, "1", "yes", "on", "TRUE"]) {
    const env = value === undefined ? {} : { [CONTRACT_FLAGS.MARKETPLACE_WRITE_ENABLED]: value };
    const h = harness({ env });
    await h.seed("conn-a", "L1");
    await assert.rejects(h.write.prepare(COMPANY_A, OWNER_A, priceInput()), (e) => e.code === "disabled", `flag value ${value}`);
  }
  assert.equal(readFlag(CONTRACT_FLAGS.MARKETPLACE_WRITE_ENABLED, FLAG_ON), true);
});

test("the approval signer fails closed on a missing or short secret", () => {
  assert.throws(() => createApprovalSigner(""), (e) => e.code === "misconfigured");
  assert.throws(() => createApprovalSigner("short"), (e) => e.code === "misconfigured");
  assert.doesNotThrow(() => createApprovalSigner(SECRET));
});

test("prepare, confirm and execute apply the change once and record the new source hash", async () => {
  const h = harness();
  await h.seed("conn-a", "L1");
  const { proposal, confirmationToken } = await h.write.prepare(COMPANY_A, OWNER_A, priceInput());
  const approved = await h.write.confirm(COMPANY_A, OWNER_A, proposal.id, confirmationToken);
  assert.equal(approved.status, "approved");
  const done = await h.write.execute(COMPANY_A, OWNER_A, proposal.id);
  assert.equal(done.status, "executed");
  assert.equal(h.ebay.calls.write.length, 1);
  assert.equal(h.ebay.calls.write[0].operation, "write_price");
  assert.equal(h.ebay.calls.write[0].idempotencyKey, "key-price-1");
  assert.equal(done.afterSourceHash.startsWith("h-"), true);
  assert.equal(h.state.listings.get("conn-a").get("L1").priceMinor, 1100);
  const again = await h.write.execute(COMPANY_A, OWNER_A, proposal.id);
  assert.equal(again.status, "executed", "a repeated execute does not write twice");
  assert.equal(h.ebay.calls.write.length, 1);
});

test("a confirmation token for another action, a bad token, or an expired one is refused", async () => {
  const h = harness();
  await h.seed("conn-a", "L1");
  const first = await h.write.prepare(COMPANY_A, OWNER_A, priceInput());
  const second = await h.write.prepare(COMPANY_A, OWNER_A, priceInput({ idempotencyKey: "key-price-2", changes: { priceMinor: 1050, currency: "AUD" } }));
  await assert.rejects(h.write.confirm(COMPANY_A, OWNER_A, second.proposal.id, first.confirmationToken), (e) => e.code === "confirmation_invalid");
  await assert.rejects(h.write.confirm(COMPANY_A, OWNER_A, first.proposal.id, "not.a-token"), (e) => e.code === "confirmation_invalid");
  h.advance(11 * 60_000);
  await assert.rejects(h.write.confirm(COMPANY_A, OWNER_A, first.proposal.id, first.confirmationToken), (e) => e.code === "confirmation_expired");
});

test("a tampered token signature is refused by the signer", () => {
  const signer = createApprovalSigner(SECRET);
  const token = signer.issue({ kind: "write", subjectId: "p1", actionHash: "a", companyId: COMPANY_A, userId: "u" }, 60_000, Date.now());
  const [body, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ kind: "write", subjectId: "p2", actionHash: "a", companyId: COMPANY_A, userId: "u", jti: "x", expiresAtMs: Date.now() + 1e9 })).toString("base64url");
  assert.throws(() => signer.verify(`${forged}.${sig}`, Date.now()), (e) => e.code === "confirmation_invalid");
  assert.equal(signer.verify(token, Date.now()).subjectId, "p1");
});

test("role and ownership checks refuse viewers, other owners and other companies", async () => {
  const h = harness();
  await h.seed("conn-a", "L1");
  await assert.rejects(h.write.prepare(COMPANY_A, VIEWER_A, priceInput()), (e) => e.code === "forbidden");
  await assert.rejects(h.write.prepare(COMPANY_A, ADMIN_A_OTHER, priceInput()), (e) => e.code === "forbidden", "admin who does not own the connection");
  await assert.rejects(h.write.prepare(COMPANY_B, OWNER_A, priceInput()), (e) => e.code === "forbidden", "actor from another company");
  await assert.rejects(h.write.prepare(COMPANY_B, OWNER_B, priceInput()), (e) => e.code === "not_found", "connection of company A is absent for company B");
});

test("spend check refuses a price change larger than the allowed relative limit", async () => {
  const h = harness({ writeConfig: { maxPriceChangeBps: 2000 } });
  await h.seed("conn-a", "L1");
  await assert.rejects(h.write.prepare(COMPANY_A, OWNER_A, priceInput({ changes: { priceMinor: 1500, currency: "AUD" } })), (e) => e.code === "spend_limit");
  const ok = await h.write.prepare(COMPANY_A, OWNER_A, priceInput({ changes: { priceMinor: 1200, currency: "AUD" } }));
  assert.equal(ok.proposal.status, "prepared");
});

test("a stale snapshot or a changed listing blocks the write before it reaches the provider", async () => {
  const h = harness();
  await h.seed("conn-a", "L1");
  const stale = await h.write.prepare(COMPANY_A, OWNER_A, priceInput({ idempotencyKey: "stale-1" }));
  assert.equal(stale.proposal.status, "prepared");
  h.advance(301_000);
  const old = await h.write.prepare(COMPANY_A, OWNER_A, priceInput({ idempotencyKey: "stale-2" }));
  assert.equal(old.proposal.status, "conflict_blocked");
  assert.equal(old.confirmationToken, null);
  assert.ok(old.proposal.conflicts.some((c) => c.code === "stale_snapshot"));

  const mismatch = await h.write.prepare(COMPANY_A, OWNER_A, priceInput({ idempotencyKey: "mismatch-1", expectedSourceHash: "other" }));
  assert.equal(mismatch.proposal.status, "conflict_blocked");
});

test("execute re-reads the listing: a change made after confirmation is caught before the write", async () => {
  const h = harness();
  await h.seed("conn-a", "L1");
  const { proposal, confirmationToken } = await h.write.prepare(COMPANY_A, OWNER_A, priceInput({ idempotencyKey: "race-1" }));
  await h.write.confirm(COMPANY_A, OWNER_A, proposal.id, confirmationToken);
  h.state.listings.get("conn-a").get("L1").sourceHash = "moved-on";
  const result = await h.write.execute(COMPANY_A, OWNER_A, proposal.id);
  assert.equal(result.status, "conflict_blocked");
  assert.equal(h.ebay.calls.write.length, 0);
});

test("inventory above internal stock is blocked, and a provider rejection marks the proposal failed", async () => {
  const h = harness({ inventoryAvailable: async () => 3 });
  await h.seed("conn-a", "L1");
  const over = await h.write.prepare(COMPANY_A, OWNER_A, {
    connectionId: "conn-a", externalListingId: "L1", operation: "update_inventory", changes: { quantity: 4 }, expectedSourceHash: "seed-L1", idempotencyKey: "inv-1",
  });
  assert.equal(over.proposal.status, "conflict_blocked");
  assert.ok(over.proposal.conflicts.some((c) => c.code === "inventory_exceeds_available"));

  const h2 = harness();
  await h2.seed("conn-a", "L1");
  h2.state.writeReject = "catalogue_locked";
  const p = await h2.write.prepare(COMPANY_A, OWNER_A, priceInput({ idempotencyKey: "rej-1" }));
  await h2.write.confirm(COMPANY_A, OWNER_A, p.proposal.id, p.confirmationToken);
  const failed = await h2.write.execute(COMPANY_A, OWNER_A, p.proposal.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "catalogue_locked");
});

test("a provider exception fails the proposal without leaking the provider message", async () => {
  const h = harness();
  await h.seed("conn-a", "L1");
  h.state.writeFails.add("L1");
  const p = await h.write.prepare(COMPANY_A, OWNER_A, priceInput({ idempotencyKey: "boom-1" }));
  await h.write.confirm(COMPANY_A, OWNER_A, p.proposal.id, p.confirmationToken);
  const failed = await h.write.execute(COMPANY_A, OWNER_A, p.proposal.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "provider_unavailable");
  assert.equal(JSON.stringify(failed).includes("must not leak"), false);
});

test("the same idempotency key returns the same proposal, and a different action on that key is refused", async () => {
  const h = harness();
  await h.seed("conn-a", "L1");
  const a = await h.write.prepare(COMPANY_A, OWNER_A, priceInput({ idempotencyKey: "idem-1" }));
  const b = await h.write.prepare(COMPANY_A, OWNER_A, priceInput({ idempotencyKey: "idem-1" }));
  assert.equal(b.proposal.id, a.proposal.id);
  await assert.rejects(
    h.write.prepare(COMPANY_A, OWNER_A, priceInput({ idempotencyKey: "idem-1", changes: { priceMinor: 1150, currency: "AUD" } })),
    (e) => e.code === "idempotency_conflict",
  );
});

test("a write over the rate limit is refused and stays approved so it can be retried", async () => {
  const h = harness({ writeLimit: 1 });
  await h.seed("conn-a", "L1");
  await h.seed("conn-a", "L2");
  const first = await h.write.prepare(COMPANY_A, OWNER_A, priceInput({ idempotencyKey: "rl-1" }));
  await h.write.confirm(COMPANY_A, OWNER_A, first.proposal.id, first.confirmationToken);
  await h.write.execute(COMPANY_A, OWNER_A, first.proposal.id);
  const second = await h.write.prepare(COMPANY_A, OWNER_A, priceInput({ idempotencyKey: "rl-2", externalListingId: "L2", expectedSourceHash: "seed-L2" }));
  await h.write.confirm(COMPANY_A, OWNER_A, second.proposal.id, second.confirmationToken);
  await assert.rejects(h.write.execute(COMPANY_A, OWNER_A, second.proposal.id), (e) => e.code === "rate_limited" && e.retryAfterMs > 0);
  const stored = await h.store.getProposal(COMPANY_A, second.proposal.id);
  assert.equal(stored.status, "approved");
});

test("rollback restores the saved state only when the listing still matches the result of the write", async () => {
  const h = harness();
  await h.seed("conn-a", "L1");
  const p = await h.write.prepare(COMPANY_A, OWNER_A, priceInput({ idempotencyKey: "rb-1" }));
  await h.write.confirm(COMPANY_A, OWNER_A, p.proposal.id, p.confirmationToken);
  await h.write.execute(COMPANY_A, OWNER_A, p.proposal.id);
  h.state.listings.get("conn-a").get("L1").sourceHash = "someone-else";
  await assert.rejects(h.write.rollback(COMPANY_A, OWNER_A, p.proposal.id), (e) => e.code === "stale_or_conflict");
  assert.equal(h.ebay.calls.rollback.length, 0);

  h.state.listings.get("conn-a").get("L1").sourceHash = (await h.store.getProposal(COMPANY_A, p.proposal.id)).afterSourceHash;
  const rolled = await h.write.rollback(COMPANY_A, OWNER_A, p.proposal.id);
  assert.equal(rolled.status, "rolled_back");
  assert.equal(h.state.listings.get("conn-a").get("L1").priceMinor, 1000);
});

test("write-side validation rejects floats, bad currency and empty listing edits", () => {
  assert.throws(() => sanitiseChanges("update_price", { priceMinor: 10.5, currency: "AUD" }), (e) => e.code === "invalid_changes");
  assert.throws(() => sanitiseChanges("update_price", { priceMinor: 100, currency: "australia" }), (e) => e.code === "invalid_changes");
  assert.throws(() => sanitiseChanges("update_listing", {}), (e) => e.code === "invalid_changes");
  assert.deepEqual(sanitiseChanges("update_price", { priceMinor: 100, currency: " aud " }), { priceMinor: 100, currency: "AUD" });
  assert.equal(canTransitionWrite("prepared", "executed"), false, "no skipping approval");
});

test("assessConflicts reports a missing observation time and a stale snapshot", () => {
  const now = new Date("2026-11-08T10:00:00Z");
  const missing = assessConflicts({ operation: "update_price", changes: {}, expectedSourceHash: "a", currentSourceHash: "a", lastSeenAt: null, now, maximumSnapshotAgeSeconds: 300, internalAvailable: null, allowOversell: false });
  assert.ok(missing.conflicts.some((c) => c.code === "missing_snapshot_time"));
  const stale = assessConflicts({ operation: "update_price", changes: {}, expectedSourceHash: "a", currentSourceHash: "a", lastSeenAt: new Date(now.getTime() - 400_000), now, maximumSnapshotAgeSeconds: 300, internalAvailable: null, allowOversell: false });
  assert.equal(stale.conflicts[0].code, "stale_snapshot");
});

// ---------- bulk ----------

test("bulk writes are off by default and refused while the flag is off", async () => {
  const h = harness({ bulkConfig: { bulkEnabled: false } });
  await h.seed("conn-a", "L1");
  await assert.rejects(
    h.bulk.preview(COMPANY_A, OWNER_A, { connectionId: "conn-a", operation: "update_price", filters: {}, changeTemplate: { mode: "fixed_delta", value: 10 }, idempotencyKey: "b0" }),
    (e) => e.code === "disabled",
  );
});

test("a bulk selection over the size cap is refused before any batch is written", async () => {
  const h = harness({ bulkConfig: { maxItems: 2 } });
  for (const id of ["L1", "L2", "L3"]) await h.seed("conn-a", id);
  await assert.rejects(
    h.bulk.preview(COMPANY_A, OWNER_A, { connectionId: "conn-a", operation: "update_price", filters: {}, changeTemplate: { mode: "fixed_delta", value: 10 }, idempotencyKey: "cap-1" }),
    (e) => e.code === "bulk_cap",
  );
  assert.equal(await h.store.findBatchByKey(COMPANY_A, "conn-a", "cap-1"), null);
});

test("a bulk spend cap and an empty selection are refused", async () => {
  const h = harness({ bulkConfig: { maxAbsDeltaMinor: 150 } });
  for (const id of ["L1", "L2"]) await h.seed("conn-a", id);
  await assert.rejects(
    h.bulk.preview(COMPANY_A, OWNER_A, { connectionId: "conn-a", operation: "update_price", filters: {}, changeTemplate: { mode: "fixed_delta", value: 100 }, idempotencyKey: "spend-1" }),
    (e) => e.code === "spend_limit",
  );
  await assert.rejects(
    h.bulk.preview(COMPANY_A, OWNER_A, { connectionId: "conn-a", operation: "update_price", filters: { brand: "nobody" }, changeTemplate: { mode: "fixed_delta", value: 10 }, idempotencyKey: "none-1" }),
    (e) => e.code === "no_match",
  );
});

test("a failed item does not roll back the other items and each item keeps its own result", async () => {
  const h = harness();
  for (const id of ["L1", "L2", "L3"]) await h.seed("conn-a", id);
  h.state.writeFails.add("L2");
  const preview = await h.bulk.preview(COMPANY_A, OWNER_A, {
    connectionId: "conn-a", operation: "update_price", filters: {}, changeTemplate: { mode: "fixed_delta", value: 50 }, idempotencyKey: "bulk-1",
  });
  assert.equal(preview.batch.status, "ready");
  assert.equal(preview.batch.eligibleCount, 3);
  assert.equal(preview.batch.impactSummary.totalDeltaMinor, 150);
  const confirmed = await h.bulk.confirm(COMPANY_A, OWNER_A, preview.batch.id, preview.confirmationToken);
  assert.equal(confirmed.status, "approved");
  const done = await h.bulk.execute(COMPANY_A, OWNER_A, preview.batch.id);
  const items = await h.store.listBatchItems(COMPANY_A, preview.batch.id);
  const byListing = Object.fromEntries(items.map((i) => [i.externalListingId, i.status]));
  assert.deepEqual(byListing, { L1: "succeeded", L2: "failed", L3: "succeeded" });
  assert.equal(done.status, "partially_completed");
  assert.equal(done.succeededCount, 2);
  assert.equal(done.failedCount, 1);
  assert.equal(h.state.listings.get("conn-a").get("L1").priceMinor, 1050);
  assert.equal(h.state.listings.get("conn-a").get("L3").priceMinor, 1050);
});

test("bulk execute cannot run before the batch is confirmed", async () => {
  const h = harness();
  await h.seed("conn-a", "L1");
  const preview = await h.bulk.preview(COMPANY_A, OWNER_A, {
    connectionId: "conn-a", operation: "update_price", filters: {}, changeTemplate: { mode: "fixed_delta", value: 10 }, idempotencyKey: "bulk-2",
  });
  await assert.rejects(h.bulk.execute(COMPANY_A, OWNER_A, preview.batch.id), (e) => e.code === "invalid_state");
  assert.equal(h.ebay.calls.write.length, 0);
  await assert.rejects(h.bulk.confirm(COMPANY_A, ADMIN_A_OTHER, preview.batch.id, preview.confirmationToken), (e) => e.code === "forbidden");
  await assert.rejects(h.bulk.confirm(COMPANY_B, OWNER_B, preview.batch.id, preview.confirmationToken), (e) => e.code === "forbidden" || e.code === "not_found");
});

test("a blocked listing in a bulk batch is recorded on its item and the rest still run", async () => {
  const h = harness();
  await h.seed("conn-a", "L1");
  await h.seed("conn-a", "L2");
  const preview = await h.bulk.preview(COMPANY_A, OWNER_A, {
    connectionId: "conn-a", operation: "update_price", filters: {}, changeTemplate: { mode: "fixed_delta", value: 20 }, idempotencyKey: "bulk-3",
  });
  // Move L2 on the marketplace after the preview, so its reviewed hash is stale at execute time.
  h.state.listings.get("conn-a").get("L2").sourceHash = "moved";
  await h.bulk.confirm(COMPANY_A, OWNER_A, preview.batch.id, preview.confirmationToken);
  const done = await h.bulk.execute(COMPANY_A, OWNER_A, preview.batch.id);
  const items = await h.store.listBatchItems(COMPANY_A, preview.batch.id);
  const byListing = Object.fromEntries(items.map((i) => [i.externalListingId, i.status]));
  assert.deepEqual(byListing, { L1: "succeeded", L2: "blocked" });
  assert.equal(done.status, "partially_completed");
});

test("bulk rollback reverses only the items that succeeded", async () => {
  const h = harness();
  for (const id of ["L1", "L2"]) await h.seed("conn-a", id);
  h.state.writeFails.add("L2");
  const preview = await h.bulk.preview(COMPANY_A, OWNER_A, {
    connectionId: "conn-a", operation: "update_price", filters: {}, changeTemplate: { mode: "fixed_delta", value: 30 }, idempotencyKey: "bulk-4",
  });
  await h.bulk.confirm(COMPANY_A, OWNER_A, preview.batch.id, preview.confirmationToken);
  await h.bulk.execute(COMPANY_A, OWNER_A, preview.batch.id);
  const rolled = await h.bulk.rollback(COMPANY_A, OWNER_A, preview.batch.id);
  const items = await h.store.listBatchItems(COMPANY_A, preview.batch.id);
  const byListing = Object.fromEntries(items.map((i) => [i.externalListingId, i.status]));
  assert.deepEqual(byListing, { L1: "rolled_back", L2: "failed" });
  assert.equal(rolled.status, "partially_rolled_back");
  assert.equal(h.state.listings.get("conn-a").get("L1").priceMinor, 1000);
});

// ---------- Drizzle query rendering ----------

test("company-scoped Drizzle conditions render with company_id as the first filter", () => {
  const dialect = new PgDialect();
  const render = (where) => dialect.sqlToQuery(where);
  const listing = render(listingWhere(COMPANY_A, "conn-a", "L1"));
  assert.match(listing.sql, /"company_id" = \$1/);
  assert.equal(listing.params[0], COMPANY_A);
  const key = render(proposalByKeyWhere(COMPANY_A, "conn-a", "key-1"));
  assert.equal(key.params[0], COMPANY_A);
  assert.match(key.sql, /"idempotency_key" = \$3/);
  const items = render(batchItemsWhere(COMPANY_B, "batch-1"));
  assert.equal(items.params[0], COMPANY_B);
  assert.throws(() => listingWhere("", "conn-a", "L1"), (e) => e.code === "forbidden");
});

test("every marketplace table carries company_id and tenant-scoped unique keys", () => {
  for (const table of [chatbotMarketplaceListings, chatbotMarketplaceWriteProposals]) {
    assert.ok(table.companyId, "company_id column present");
  }
  assert.match(MARKETPLACE_CONSTRAINTS.proposalIdempotency, /company/);
  assert.match(MARKETPLACE_CONSTRAINTS.batchIdempotency, /company/);
});

test("price impact supports basis-point percentages and refuses negative results", () => {
  assert.deepEqual(priceImpact(1000, { mode: "percentage_bps", value: 1000 }), { before: 1000, after: 1100, delta: 100 });
  assert.deepEqual(priceImpact(1000, { mode: "fixed_delta", value: -250 }), { before: 1000, after: 750, delta: -250 });
  assert.throws(() => priceImpact(100, { mode: "fixed_delta", value: -500 }), (e) => e.code === "invalid_changes");
  const picked = selectBulkCandidates(
    [
      { externalListingId: "a", provider: "ebay", status: "active", brand: "Acme", category: "x", priceMinor: 500 },
      { externalListingId: "b", provider: "ebay", status: "paused", brand: "Acme", category: "x", priceMinor: 500 },
    ],
    { status: "active" },
  );
  assert.deepEqual(picked.map((c) => c.externalListingId), ["a"]);
});

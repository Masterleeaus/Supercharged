// Public widget, completed (node:test). No network: HTTP is a fake fetch, every port is an in-memory fake.
// Covers: trusted proxy handling, the shared rate limit across instances (memory and Drizzle store),
// the bundle source, the send endpoint refusing untrusted origins, the reply-runtime port, polling and the
// stream, the Express factories, and the browser sync (stream first, poll fallback).
// Run: NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types tests/modules/chatbot-widget-public.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { CONTRACT_FLAGS } from "../../server/modules/chatbot/contracts/index.ts";
import { createWidgetHandlers } from "../../server/modules/chatbot/widget/handlers.ts";
import { createEmbedTokenIssuer, createEmbedTokenVerifier } from "../../server/modules/chatbot/widget/embed-token.ts";
import { createFixedWindowLimiter } from "../../server/modules/chatbot/widget/rate-limit.ts";
import {
  createMemoryRateLimitStore,
  createDrizzleRateLimitStore,
  createSharedRateLimiter,
  decideWindow,
  rateLimitHitQuery,
  widgetRateLimits,
} from "../../server/modules/chatbot/widget/rate-limit-store.ts";
import {
  canonicalIp,
  parseTrustedProxies,
  resolveClientIp,
} from "../../server/modules/chatbot/widget/proxy.ts";
import {
  formatSseMessage,
  readFeedCursor,
  toPublicFeedMessage,
  SSE_HEARTBEAT,
  SSE_OPEN,
} from "../../server/modules/chatbot/widget/stream.ts";
import { createReplyRuntimeMessagePort } from "../../server/modules/chatbot/widget/reply-port.ts";
import { createWidgetExpressHandlers, toWidgetRequest } from "../../server/modules/chatbot/widget/express.ts";
import { ChatbotError } from "../../server/modules/chatbot/chatbot-scope.ts";
import { createWidgetApi, parseFeedMessage, WidgetRequestError } from "../../client/src/widget/api.ts";
import { createMessageSync, parseSseFrames } from "../../client/src/widget/sync.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WIDGET_CLIENT_DIR = join(HERE, "..", "..", "client", "src", "widget");

// ---------- fixtures ----------

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const PUBLIC_ID = "9b1f6c2e-3a4d-4e5f-8a6b-7c8d9e0f1a2b";
const CHATBOT_ID = "33333333-3333-4333-8333-333333333333";
const TRUSTED = "https://shop.example.com";
const UNTRUSTED = "https://evil.example.net";
const VISITOR = "visitor_abcdefgh12345678";
const NOW = Date.UTC(2026, 10, 9, 10, 0, 0);
const NOW_SECONDS = Math.floor(NOW / 1000);
const ENV_ON = { [CONTRACT_FLAGS.WIDGET_ENABLED]: "true" };
const FIXTURE_KEY = "fixture-signing-material-not-a-secret";
const clock = () => new Date(NOW);
const ONE_MINUTE = 60_000;

/** Trusted-domain state per chatbot. Tests change it to simulate revocation. */
function newTrustState(domains = ["shop.example.com"]) {
  return new Map([[PUBLIC_ID, { companyId: COMPANY_A, domains: [...domains] }]]);
}

function baseRecord(domains) {
  return {
    companyId: COMPANY_A,
    chatbotId: CHATBOT_ID,
    publicId: PUBLIC_ID,
    title: "Shop helper",
    welcomeMessage: "Hi",
    launcherText: "Chat",
    primaryColor: "#123abc",
    launcherPosition: "bottom-right",
    language: "en",
    voiceEnabled: false,
    generativeUiEnabled: false,
    allowedOrigins: domains,
  };
}

const generous = () => ({ take: () => ({ allowed: true, remaining: 999, retryAfterSeconds: 0 }) });

/**
 * Builds one widget server instance. Instances built from the same store and the same trust state behave as
 * separate processes that share a database: their per-process limiters are separate, the shared limiter is common.
 */
function instance({ store, trust = newTrustState(), policy = { limit: 1000, windowMs: ONE_MINUTE }, feed, runtime, limits } = {}) {
  const trust$ = {
    async trustedDomainsFor(companyId, publicId) {
      const entry = trust.get(publicId);
      return entry && entry.companyId === companyId ? entry.domains : null;
    },
  };
  const keys = {
    async signingKeyFor(companyId) {
      return companyId === COMPANY_A ? FIXTURE_KEY : null;
    },
  };
  const verifier = createEmbedTokenVerifier({ keys, trust: trust$ });
  const issuer = createEmbedTokenIssuer({ keys, trust: trust$ }, clock);
  const sent = [];
  const reply = runtime ?? (async (input) => {
    sent.push(input);
    return { id: "reply-1", text: "Hello back" };
  });
  const handlers = createWidgetHandlers({
    env: ENV_ON,
    chatbots: {
      async findByPublicId(publicId) {
        const entry = trust.get(publicId);
        return entry ? baseRecord(entry.domains) : null;
      },
    },
    verifier,
    issuer,
    messages: createReplyRuntimeMessagePort({ reply }),
    feed,
    limits: limits ?? { config: generous(), session: generous(), message: generous(), feed: generous() },
    shared: store
      ? {
          config: createSharedRateLimiter(store, policy, () => NOW),
          session: createSharedRateLimiter(store, policy, () => NOW),
          message: createSharedRateLimiter(store, policy, () => NOW),
          feed: createSharedRateLimiter(store, policy, () => NOW),
        }
      : undefined,
    assetBaseUrl: "https://cdn.example.com/widget",
    now: clock,
  });
  return { handlers, issuer, sent, trust };
}

async function tokenFor(inst, origin = TRUSTED, visitorId = VISITOR) {
  return inst.issuer.issue(
    { companyId: COMPANY_A, chatbotPublicId: PUBLIC_ID, visitorId, origin, scope: ["chat"] },
    900,
  );
}

const widgetReq = ({ token, origin = TRUSTED, body, query, ip = "203.0.113.7" } = {}) => ({
  params: { publicId: PUBLIC_ID },
  headers: { origin, ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body,
  query,
  ip,
});

/** Fake Drizzle database. Applies the same window rule to the upsert's positional parameters. */
function fakeRateLimitDb() {
  const rows = new Map();
  const calls = [];
  const dialect = new PgDialect();
  return {
    calls,
    rows,
    async execute(query) {
      const { sql: text, params } = dialect.sqlToQuery(query);
      calls.push({ text, params });
      // Parameter order is fixed by rateLimitHitQuery: company, key, now, windowMs, now, windowMs, now, limit + 1.
      const [companyId, key, now, windowMs, , , , limitPlusOne] = params;
      const id = `${companyId}\u0000${key}`;
      let row = rows.get(id);
      if (!row || row.start + windowMs <= now) {
        row = { start: now, hits: 1 };
      } else {
        row = { start: row.start, hits: Math.min(row.hits + 1, limitPlusOne) };
      }
      rows.set(id, row);
      return { rows: [{ window_start_ms: row.start, hits: row.hits }] };
    },
  };
}

async function waitFor(predicate, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not met in time");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- trusted proxies ----------

test("a forwarded address is ignored when the peer is not a configured proxy", () => {
  const trusted = parseTrustedProxies("10.0.0.5").proxies;
  const ip = resolveClientIp({ remoteAddress: "203.0.113.9", forwardedFor: "198.51.100.1", trustedProxies: trusted });
  assert.equal(ip, "203.0.113.9", "a spoofed header from an unknown peer must not change the client address");
});

test("a forwarded address is used when the peer is a configured proxy", () => {
  const trusted = parseTrustedProxies("10.0.0.5").proxies;
  const ip = resolveClientIp({ remoteAddress: "10.0.0.5", forwardedFor: "198.51.100.1", trustedProxies: trusted });
  assert.equal(ip, canonicalIp("198.51.100.1"));
});

test("a client cannot pick its own address by adding entries to the left of the real one", () => {
  const trusted = parseTrustedProxies("10.0.0.5").proxies;
  const ip = resolveClientIp({ remoteAddress: "10.0.0.5", forwardedFor: "1.1.1.1, 198.51.100.1", trustedProxies: trusted });
  assert.equal(ip, canonicalIp("198.51.100.1"));
});

test("trusted hops inside a CIDR block are skipped when walking the chain", () => {
  const trusted = parseTrustedProxies("10.0.0.0/8").proxies;
  const ip = resolveClientIp({ remoteAddress: "10.0.0.5", forwardedFor: "198.51.100.1, 10.9.8.7", trustedProxies: trusted });
  assert.equal(ip, canonicalIp("198.51.100.1"));
});

test("a malformed chain from a trusted peer falls back to the peer address", () => {
  const trusted = parseTrustedProxies("10.0.0.5").proxies;
  assert.equal(resolveClientIp({ remoteAddress: "10.0.0.5", forwardedFor: "garbage, 1.2.3.4", trustedProxies: trusted }), canonicalIp("10.0.0.5"));
  const long = Array.from({ length: 40 }, () => "1.2.3.4").join(", ");
  assert.equal(resolveClientIp({ remoteAddress: "10.0.0.5", forwardedFor: long, trustedProxies: trusted }), canonicalIp("10.0.0.5"));
});

test("a chain where every hop is a trusted proxy returns the furthest named address", () => {
  const trusted = parseTrustedProxies("10.0.0.0/8").proxies;
  const ip = resolveClientIp({ remoteAddress: "10.0.0.1", forwardedFor: "10.0.0.9, 10.0.0.8", trustedProxies: trusted });
  assert.equal(ip, canonicalIp("10.0.0.9"));
});

test("proxy configuration refuses wildcards, /0 and garbage, and keeps the valid entries", () => {
  const parsed = parseTrustedProxies("*, 0.0.0.0/0, nonsense, 10.0.0.0/8, 2001:db8::/32, 10.1.2.3/40");
  assert.equal(parsed.proxies.length, 2);
  assert.equal(parsed.rejected.length, 4);
  assert.deepEqual(parseTrustedProxies("").proxies, []);
  assert.deepEqual(parseTrustedProxies(undefined).proxies, []);
});

test("different spellings of one address share one canonical form", () => {
  assert.equal(canonicalIp("::ffff:198.51.100.1"), canonicalIp("198.51.100.1"));
  assert.equal(canonicalIp("2001:DB8:0::1"), canonicalIp("2001:db8::1"));
  assert.equal(canonicalIp("[2001:db8::1]"), canonicalIp("2001:db8::1"));
  assert.equal(canonicalIp("not-an-ip"), null);
});

test("an IPv6 proxy entry trusts only addresses inside its prefix", () => {
  const trusted = parseTrustedProxies("2001:db8::/32").proxies;
  assert.equal(resolveClientIp({ remoteAddress: "2001:db8:1::5", forwardedFor: "198.51.100.1", trustedProxies: trusted }), canonicalIp("198.51.100.1"));
  assert.equal(resolveClientIp({ remoteAddress: "2001:db9::5", forwardedFor: "198.51.100.1", trustedProxies: trusted }), canonicalIp("2001:db9::5"));
});

test("a missing peer address yields no client address", () => {
  assert.equal(resolveClientIp({ remoteAddress: undefined, trustedProxies: [] }), null);
});

test("the Express request builder takes the address from the socket and the trusted chain only", () => {
  const trusted = parseTrustedProxies("10.0.0.5").proxies;
  const direct = toWidgetRequest(
    { params: { publicId: PUBLIC_ID }, headers: { "x-forwarded-for": ["198.51.100.1"] }, socket: { remoteAddress: "203.0.113.9" } },
    trusted,
  );
  assert.equal(direct.ip, canonicalIp("203.0.113.9"));
  const proxied = toWidgetRequest(
    { params: { publicId: PUBLIC_ID }, headers: { "x-forwarded-for": ["198.51.100.1"] }, socket: { remoteAddress: "10.0.0.5" } },
    trusted,
  );
  assert.equal(proxied.ip, canonicalIp("198.51.100.1"));
});

// ---------- shared rate limit ----------

test("two instances on one store share the limit", async () => {
  const store = createMemoryRateLimitStore();
  const policy = { limit: 2, windowMs: ONE_MINUTE };
  const a = createSharedRateLimiter(store, policy, () => NOW);
  const b = createSharedRateLimiter(store, policy, () => NOW);
  assert.equal((await a.take(COMPANY_A, "message:ip:x")).allowed, true);
  assert.equal((await b.take(COMPANY_A, "message:ip:x")).allowed, true);
  const third = await a.take(COMPANY_A, "message:ip:x");
  assert.equal(third.allowed, false);
  assert.ok(third.retryAfterSeconds >= 1);
  assert.equal((await b.take(COMPANY_A, "message:ip:x")).allowed, false);
});

test("the Drizzle store counts across instances through one database", async () => {
  const db = fakeRateLimitDb();
  const policy = { limit: 2, windowMs: ONE_MINUTE };
  const a = createSharedRateLimiter(createDrizzleRateLimitStore(db), policy, () => NOW);
  const b = createSharedRateLimiter(createDrizzleRateLimitStore(db), policy, () => NOW);
  assert.deepEqual([(await a.take(COMPANY_A, "k")).allowed, (await b.take(COMPANY_A, "k")).allowed], [true, true]);
  assert.equal((await a.take(COMPANY_A, "k")).allowed, false);
  assert.equal((await b.take(COMPANY_A, "k")).allowed, false);
  // After the window ends a new window starts for both instances.
  const later = createSharedRateLimiter(createDrizzleRateLimitStore(db), policy, () => NOW + ONE_MINUTE);
  assert.equal((await later.take(COMPANY_A, "k")).allowed, true);
});

test("buckets are per company: the same key in another company starts fresh", async () => {
  const store = createMemoryRateLimitStore();
  const limiter = createSharedRateLimiter(store, { limit: 1, windowMs: ONE_MINUTE }, () => NOW);
  assert.equal((await limiter.take(COMPANY_A, "k")).allowed, true);
  assert.equal((await limiter.take(COMPANY_A, "k")).allowed, false);
  assert.equal((await limiter.take(COMPANY_B, "k")).allowed, true);
});

test("the Drizzle store refuses a missing or malformed company before any query", async () => {
  const db = fakeRateLimitDb();
  const store = createDrizzleRateLimitStore(db);
  await assert.rejects(() => store.hit("not-a-uuid", "k", { limit: 1, windowMs: ONE_MINUTE }, NOW), ChatbotError);
  assert.equal(db.calls.length, 0);
});

test("an over-long bucket key is refused without a query", async () => {
  const db = fakeRateLimitDb();
  const decision = await createDrizzleRateLimitStore(db).hit(COMPANY_A, "x".repeat(300), { limit: 5, windowMs: ONE_MINUTE }, NOW);
  assert.equal(decision.allowed, false);
  assert.equal(db.calls.length, 0);
});

test("the rate-limit upsert is keyed on company and bucket, and counts atomically in one statement", () => {
  const { sql: text } = new PgDialect().sqlToQuery(rateLimitHitQuery(COMPANY_A, "k", { limit: 2, windowMs: ONE_MINUTE }, NOW));
  assert.match(text, /on conflict \(company_id, bucket_key\) do update/);
  assert.match(text, /returning window_start_ms, hits/);
});

test("the rate-limit table carries company_id in its primary key and as a column", () => {
  const config = getTableConfig(widgetRateLimits);
  assert.ok(config.columns.some((c) => c.name === "company_id" && c.notNull));
  const pk = config.primaryKeys[0];
  assert.ok(pk.columns.some((c) => c.name === "company_id"), "company_id is part of the composite key");
  assert.ok(config.indexes.some((i) => i.config.columns.some((c) => c.name === "company_id")));
});

test("the window rule is the same for any store", () => {
  const policy = { limit: 2, windowMs: 10_000 };
  assert.equal(decideWindow(policy, 0, 2, 5_000).allowed, true);
  const refused = decideWindow(policy, 0, 3, 5_000);
  assert.equal(refused.allowed, false);
  assert.equal(refused.retryAfterSeconds, 5);
});

test("the shared limit applies to the message endpoint across two server instances", async () => {
  const store = createMemoryRateLimitStore();
  const trust = newTrustState();
  const policy = { limit: 2, windowMs: ONE_MINUTE };
  const first = instance({ store, trust, policy });
  const second = instance({ store, trust, policy });
  const token = await tokenFor(first);
  const statuses = [];
  for (const inst of [first, second, first]) {
    statuses.push((await inst.handlers.sendMessage(widgetReq({ token, body: { text: "hi" } }))).status);
  }
  assert.deepEqual(statuses, [200, 200, 429]);
  assert.equal((await second.handlers.sendMessage(widgetReq({ token, body: { text: "again" } }))).status, 429);
});

test("the shared limit on the Drizzle store also holds across two server instances", async () => {
  const db = fakeRateLimitDb();
  const trust = newTrustState();
  const policy = { limit: 1, windowMs: ONE_MINUTE };
  const first = instance({ store: createDrizzleRateLimitStore(db), trust, policy });
  const second = instance({ store: createDrizzleRateLimitStore(db), trust, policy });
  const token = await tokenFor(first);
  assert.equal((await first.handlers.sendMessage(widgetReq({ token, body: { text: "one" } }))).status, 200);
  assert.equal((await second.handlers.sendMessage(widgetReq({ token, body: { text: "two" } }))).status, 429);
});

// ---------- send endpoint ----------

test("the send endpoint refuses an origin that is not trusted, even with a token issued for a trusted origin", async () => {
  const inst = instance();
  const token = await tokenFor(inst, TRUSTED);
  const refused = await inst.handlers.sendMessage(widgetReq({ token, origin: UNTRUSTED, body: { text: "hi" } }));
  assert.equal(refused.status, 403);
  assert.equal(inst.sent.length, 0, "the reply runtime is never reached");
});

test("the send endpoint refuses a request with no Origin header", async () => {
  const inst = instance();
  const token = await tokenFor(inst);
  const refused = await inst.handlers.sendMessage({ ...widgetReq({ token, body: { text: "hi" } }), headers: { authorization: `Bearer ${token}` } });
  assert.equal(refused.status, 403);
  assert.equal(inst.sent.length, 0);
});

test("removing an origin from the trusted list refuses the send at once", async () => {
  const trust = newTrustState();
  const inst = instance({ trust });
  const token = await tokenFor(inst);
  assert.equal((await inst.handlers.sendMessage(widgetReq({ token, body: { text: "hi" } }))).status, 200);
  trust.set(PUBLIC_ID, { companyId: COMPANY_A, domains: [] });
  assert.equal((await inst.handlers.sendMessage(widgetReq({ token, body: { text: "hi again" } }))).status, 403);
});

test("a trusted send reaches the reply runtime with the verified company and returns only id and text", async () => {
  const seen = [];
  const inst = instance({
    runtime: async (input) => {
      seen.push(input);
      return { id: "reply-9", text: "Sure", staffId: "staff-1", internalNote: true };
    },
  });
  const token = await tokenFor(inst);
  const res = await inst.handlers.sendMessage(widgetReq({ token, body: { text: "  hello  " } }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { message: { id: "reply-9", role: "assistant", text: "Sure" } });
  assert.equal(seen[0].companyId, COMPANY_A);
  assert.equal(seen[0].text, "hello");
  assert.equal(seen[0].visitorId, VISITOR);
});

test("a reply runtime that returns a bad reply fails closed with a generic 503", async () => {
  const inst = instance({ runtime: async () => ({ id: 5, text: "x" }) });
  const token = await tokenFor(inst);
  const res = await inst.handlers.sendMessage(widgetReq({ token, body: { text: "hi" } }));
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, { error: "unavailable" });
});

test("a token check answers validity, expiry and scope, and never returns claims", async () => {
  const inst = instance();
  const token = await tokenFor(inst);
  const ok = await inst.handlers.checkToken(widgetReq({ token }));
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.body).sort(), ["expiresAt", "scope", "valid"]);
  assert.equal(ok.body.expiresAt, NOW_SECONDS + 900);
  assert.equal(JSON.stringify(ok.body).includes(COMPANY_A), false);
  const bad = await inst.handlers.checkToken(widgetReq({ token: "v1.bad.token", origin: TRUSTED }));
  assert.equal(bad.status, 401);
});

// ---------- feed: polling and stream ----------

test("the feed keeps only public fields", () => {
  const out = toPublicFeedMessage({ id: "m-1", role: "assistant", text: "Hi", createdAt: new Date(NOW), staffId: "s", internal: true });
  assert.deepEqual(Object.keys(out).sort(), ["createdAt", "id", "role", "text"]);
  assert.equal(toPublicFeedMessage({ id: "bad id", role: "assistant", text: "x", createdAt: new Date(NOW) }), null);
  assert.equal(toPublicFeedMessage({ id: "m-2", role: "customer", text: "x", createdAt: new Date(NOW) }), null);
});

test("a cursor that is not a plain id is refused, and an empty cursor starts at the beginning", () => {
  assert.equal(readFeedCursor(undefined), null);
  assert.equal(readFeedCursor("m-1"), "m-1");
  assert.equal(readFeedCursor("a b"), "invalid");
  assert.equal(readFeedCursor(["x"]), "invalid");
});

test("polling returns messages after the cursor for the verified scope only", async () => {
  const calls = [];
  const feed = {
    async listAfter(scope, afterId, limit) {
      calls.push({ scope, afterId, limit });
      return [{ id: "m-2", role: "assistant", text: "Hi", createdAt: "2026-11-09T10:00:00.000Z" }];
    },
    subscribe: () => () => undefined,
  };
  const inst = instance({ feed });
  const token = await tokenFor(inst);
  const res = await inst.handlers.listMessages(widgetReq({ token, query: { after: "m-1" } }));
  assert.equal(res.status, 200);
  assert.equal(res.body.messages.length, 1);
  assert.deepEqual(calls[0].scope, { companyId: COMPANY_A, chatbotPublicId: PUBLIC_ID, visitorId: VISITOR });
  assert.equal(calls[0].afterId, "m-1");
  const refused = await inst.handlers.listMessages(widgetReq({ token, origin: UNTRUSTED, query: {} }));
  assert.equal(refused.status, 403);
});

test("a stream opens for a verified scope and is refused for an untrusted origin", async () => {
  const feed = { listAfter: async () => [], subscribe: () => () => undefined };
  const inst = instance({ feed });
  const token = await tokenFor(inst);
  const open = await inst.handlers.openStream(widgetReq({ token }));
  assert.equal(open.status, 200);
  assert.deepEqual(open.stream.scope, { companyId: COMPANY_A, chatbotPublicId: PUBLIC_ID, visitorId: VISITOR });
  const refused = await inst.handlers.openStream(widgetReq({ token, origin: UNTRUSTED }));
  assert.equal(refused.status, 403);
  assert.equal(refused.stream, undefined);
});

test("with no feed wired, polling and the stream answer 404", async () => {
  const inst = instance();
  const token = await tokenFor(inst);
  assert.equal((await inst.handlers.listMessages(widgetReq({ token, query: {} }))).status, 404);
  assert.equal((await inst.handlers.openStream(widgetReq({ token }))).status, 404);
});

test("an SSE frame cannot carry a newline inside its id", () => {
  const frame = formatSseMessage({ id: "a\nb", role: "assistant", text: "line one\nline two", createdAt: "2026-11-09T10:00:00.000Z" });
  assert.equal(frame.split("\n").some((line) => line.startsWith("id:")), false, "an invalid id is left out");
  assert.ok(frame.endsWith("\n\n"));
  assert.equal(frame.split("\n\n").length, 2, "one frame, one terminator");
});

test("the Express stream writes frames, sends heartbeats, and unsubscribes when the client closes", async () => {
  const listeners = new Set();
  let unsubscribed = 0;
  const feed = {
    listAfter: async () => [],
    subscribe(scope, listener) {
      listeners.add(listener);
      return () => {
        unsubscribed += 1;
        listeners.delete(listener);
      };
    },
  };
  const inst = instance({ feed });
  const token = await tokenFor(inst);
  const routes = createWidgetExpressHandlers({ handlers: inst.handlers, trustedProxies: [], heartbeatMs: 5 });
  const closeListeners = [];
  const res = {
    statusCode: 0,
    headers: {},
    chunks: [],
    status(code) { this.statusCode = code; return this; },
    set(h) { Object.assign(this.headers, h); return this; },
    json() { throw new Error("a stream must not send JSON"); },
    end() { return this; },
    write(chunk) { this.chunks.push(chunk); return true; },
    on(event, fn) { if (event === "close") closeListeners.push(fn); return this; },
  };
  const req = {
    params: { publicId: PUBLIC_ID },
    headers: { origin: TRUSTED, authorization: `Bearer ${token}` },
    socket: { remoteAddress: "203.0.113.9" },
  };
  await routes.stream(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Content-Type"], "text/event-stream");
  assert.equal(res.chunks[0], SSE_OPEN);
  assert.equal(listeners.size, 1);
  for (const listener of listeners) listener({ id: "r-1", role: "assistant", text: "Hi", createdAt: "2026-11-09T10:00:00.000Z" });
  assert.ok(res.chunks.some((c) => c.startsWith("id: r-1\nevent: message\ndata: ")));
  await waitFor(() => res.chunks.includes(SSE_HEARTBEAT));
  for (const fn of closeListeners) fn();
  assert.equal(unsubscribed, 1);
  assert.equal(listeners.size, 0);
  const countAfterClose = res.chunks.length;
  await sleep(30);
  assert.equal(res.chunks.length, countAfterClose, "no writes after the client has gone");
});

// ---------- Express factories ----------

test("the Express config handler keys its rate limit on the resolved client address", async () => {
  const keys = [];
  const recording = { take: (key) => (keys.push(key), { allowed: true, remaining: 9, retryAfterSeconds: 0 }) };
  const inst = instance({ limits: { config: recording, session: generous(), message: generous(), feed: generous() } });
  const routes = createWidgetExpressHandlers({ handlers: inst.handlers, trustedProxies: parseTrustedProxies("10.0.0.5").proxies });
  const res = {
    statusCode: 0,
    headers: {},
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    set(h) { Object.assign(this.headers, h); return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
    write() { return true; },
    on() { return this; },
  };
  await routes.config({ params: { publicId: PUBLIC_ID }, headers: { origin: TRUSTED, "x-forwarded-for": "198.51.100.1" }, socket: { remoteAddress: "203.0.113.9" } }, res);
  assert.equal(keys[0], `config:${canonicalIp("203.0.113.9")}:${PUBLIC_ID}`, "forged header from an unknown peer is not used");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.publicId, PUBLIC_ID);
  assert.equal(res.body.assetBaseUrl, "https://cdn.example.com/widget");
});

test("the Express handler set mounts nothing: it exports handler functions only", () => {
  const inst = instance();
  const routes = createWidgetExpressHandlers({ handlers: inst.handlers, trustedProxies: [] });
  for (const name of ["config", "session", "message", "check", "messages", "stream", "preflight"]) {
    assert.equal(typeof routes[name], "function", name);
  }
  assert.equal(Object.keys(routes).length, 7);
});

// ---------- bundle source ----------

test("the widget bundle source contains no secret, key or credential literal", () => {
  const files = readdirSync(WIDGET_CLIENT_DIR).filter((f) => f.endsWith(".ts"));
  assert.ok(files.includes("sync.ts") && files.includes("index.ts"));
  const forbidden = [
    /CHATBOT_SECRET_KEY/,
    /process\.env/,
    /signingKey|signing_key|SecretBox/i,
    /BEGIN [A-Z ]*PRIVATE KEY/,
    /\bsk_(live|test)_/,
    /api[_-]?key\s*[:=]/i,
    /client[_-]?secret/i,
  ];
  for (const file of files) {
    const source = readFileSync(join(WIDGET_CLIENT_DIR, file), "utf8");
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${file} matches ${pattern}`);
    // A long quoted run assigned to a key-like name is treated as a hard-coded credential.
    for (const line of source.split("\n")) {
      if (/(key|token|secret|credential|password)/i.test(line)) {
        assert.doesNotMatch(line, /["'`][A-Za-z0-9+/_=-]{32,}["'`]/, `${file} has a credential-like literal`);
      }
    }
  }
});

// ---------- browser: feed parsing and sync ----------

test("the browser parses only well-formed feed messages", () => {
  assert.deepEqual(
    parseFeedMessage({ id: "m-1", role: "staff", text: "Hi", createdAt: "x", extra: 1 }),
    { id: "m-1", role: "staff", text: "Hi", createdAt: "x" },
  );
  assert.equal(parseFeedMessage({ id: "m 1", role: "staff", text: "Hi", createdAt: "x" }), null);
  assert.equal(parseFeedMessage({ id: "m-1", role: "customer", text: "Hi", createdAt: "x" }), null);
  assert.equal(parseFeedMessage(null), null);
});

test("parseSseFrames keeps an unfinished frame for the next chunk and skips comments", () => {
  const out = parseSseFrames(": keep-alive\n\nevent: message\ndata: {\"a\":1}\n\ndata: pa");
  assert.equal(out.frames.length, 1);
  assert.deepEqual(out.frames[0], { event: "message", data: "{\"a\":1}" });
  assert.equal(out.rest, "data: pa");
});

/** Client api over a fake fetch. Routes by path: "/stream" and "/messages". */
function clientRig({ streamStatus = 200, frames = [], pollQueue = [] } = {}) {
  const calls = { stream: 0, polls: 0 };
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/stream")) {
      calls.stream += 1;
      if (streamStatus !== 200) return new Response("", { status: streamStatus });
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    calls.polls += 1;
    const next = pollQueue.length > 0 ? pollQueue.shift() : [];
    return new Response(JSON.stringify({ messages: next }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const api = createWidgetApi({ baseUrl: "https://widget.example.com", publicId: PUBLIC_ID, fetchImpl });
  return { api, calls };
}

const frameFor = (m) => `id: ${m.id}\nevent: message\ndata: ${JSON.stringify(m)}\n\n`;
const M1 = { id: "r-1", role: "assistant", text: "First", createdAt: "2026-11-09T10:00:00.000Z" };
const M2 = { id: "r-2", role: "staff", text: "Second", createdAt: "2026-11-09T10:01:00.000Z" };

test("the browser sync uses the stream when the server offers it, and shows each reply once", async () => {
  const { api, calls } = clientRig({ frames: [frameFor(M1)] });
  const delivered = [];
  const modes = [];
  const sync = createMessageSync({
    api,
    getToken: async () => "tok",
    onMessage: (m) => {
      delivered.push(m.id);
      modes.push(sync.mode());
    },
    reconnectMs: 10,
    pollIntervalMs: 10,
    streamSupported: () => true,
  });
  sync.start();
  await waitFor(() => calls.stream >= 2);
  sync.stop();
  assert.deepEqual(delivered, ["r-1"], "a reconnect re-sends the same frame, and it is shown once");
  assert.deepEqual(modes, ["stream"]);
});

test("the browser sync falls back to polling when the stream is not offered", async () => {
  const { api, calls } = clientRig({ streamStatus: 404, pollQueue: [[M2], []] });
  const delivered = [];
  const sync = createMessageSync({
    api,
    getToken: async () => "tok",
    onMessage: (m) => delivered.push(m.id),
    reconnectMs: 10,
    pollIntervalMs: 10,
    streamSupported: () => true,
  });
  sync.start();
  await waitFor(() => delivered.length === 1 && calls.polls >= 2);
  sync.stop();
  assert.deepEqual(delivered, ["r-2"]);
  assert.equal(calls.stream, 1, "a refused stream is not retried");
  assert.equal(sync.mode(), "idle");
});

test("the browser sync polls only when streaming is turned off or unsupported", async () => {
  const { api, calls } = clientRig({ frames: [frameFor(M1)], pollQueue: [[M2]] });
  const delivered = [];
  const sync = createMessageSync({
    api,
    getToken: async () => "tok",
    onMessage: (m) => delivered.push(m.id),
    pollIntervalMs: 10,
    preferStream: false,
  });
  sync.start();
  await waitFor(() => delivered.length === 1);
  sync.stop();
  assert.equal(calls.stream, 0);
  assert.deepEqual(delivered, ["r-2"]);
});

test("the browser sync skips a reply the widget already shows", async () => {
  const { api } = clientRig({ streamStatus: 404, pollQueue: [[M1]] });
  const delivered = [];
  const sync = createMessageSync({
    api,
    getToken: async () => "tok",
    onMessage: (m) => delivered.push(m.id),
    pollIntervalMs: 10,
    preferStream: false,
  });
  sync.markSeen("r-1");
  sync.start();
  await sleep(40);
  sync.stop();
  assert.deepEqual(delivered, []);
});

test("the stream open refuses an error status as a typed error", async () => {
  const { api } = clientRig({ streamStatus: 403 });
  await assert.rejects(
    () => api.openStream("tok", new AbortController().signal),
    (err) => err instanceof WidgetRequestError && err.status === 403,
  );
});

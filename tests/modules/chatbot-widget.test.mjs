// Public widget tests (node:test). No network: every port is a fake, and HTTP is never called.
// Covers the server handlers, the embed token, the rate limiter, the Drizzle query shapes, the browser client,
// and a scan of the widget source for secrets.
// Run: NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types tests/modules/chatbot-widget.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { CONTRACT_FLAGS } from "../../server/modules/chatbot/contracts/index.ts";
import {
  createWidgetHandlers,
  WIDGET_SESSION_TTL_SECONDS,
} from "../../server/modules/chatbot/widget/handlers.ts";
import { toWidgetPublicConfig, WIDGET_PUBLIC_CONFIG_KEYS } from "../../server/modules/chatbot/widget/config.ts";
import { createEmbedTokenIssuer, createEmbedTokenVerifier, EmbedTokenIssueError } from "../../server/modules/chatbot/widget/embed-token.ts";
import { createFixedWindowLimiter } from "../../server/modules/chatbot/widget/rate-limit.ts";
import { isTrustedOrigin, normaliseOrigin, normaliseTrustedDomain } from "../../server/modules/chatbot/widget/origin.ts";
import {
  DrizzleWidgetStorage,
  selectActiveSigningKeyQuery,
  selectTrustedDomainsQuery,
} from "../../server/modules/chatbot/widget/storage.ts";
import { widgetChatbotConfigs, widgetEmbedKeys } from "../../server/modules/chatbot/db/widget.ts";
import { createWidgetApi, parseWidgetConfig, WidgetRequestError } from "../../client/src/widget/api.ts";
import { getVisitorId, newVisitorId } from "../../client/src/widget/visitor.ts";

// ---------- fixtures ----------

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const PUBLIC_ID = "9b1f6c2e-3a4d-4e5f-8a6b-7c8d9e0f1a2b";
const OTHER_PUBLIC_ID = "5c2e7d1a-8b3f-4a6e-9d2c-1f0e9a8b7c6d";
const CHATBOT_ID = "33333333-3333-4333-8333-333333333333";
const TRUSTED = "https://shop.example.com";
const UNTRUSTED = "https://evil.example.net";
const VISITOR = "visitor_abcdefgh12345678";
const NOW = Date.UTC(2026, 10, 8, 10, 0, 0);
const NOW_SECONDS = Math.floor(NOW / 1000);
const ENV_ON = { [CONTRACT_FLAGS.WIDGET_ENABLED]: "true" };
const FIXTURE_KEY = "fixture-signing-material-not-a-secret";

const clock = () => new Date(NOW);

function baseRecord(overrides = {}) {
  return {
    companyId: COMPANY_A,
    chatbotId: CHATBOT_ID,
    publicId: PUBLIC_ID,
    title: "Shop helper",
    welcomeMessage: "Hi, how can we help?",
    launcherText: "Chat",
    primaryColor: "#123abc",
    launcherPosition: "bottom-right",
    language: "en",
    voiceEnabled: false,
    generativeUiEnabled: true,
    allowedOrigins: ["shop.example.com"],
    ...overrides,
  };
}

/** Builds handlers over in-memory fakes. Records message sends and chatbot lookups. */
function setup({ env = ENV_ON, record = baseRecord(), keyFor = () => FIXTURE_KEY, reply } = {}) {
  const lookups = { count: 0 };
  const sent = [];
  const chatbotsByPublic = new Map(record ? [[record.publicId, record]] : []);
  const trust = {
    async trustedDomainsFor(companyId, publicId) {
      const r = chatbotsByPublic.get(publicId);
      return r && r.companyId === companyId ? r.allowedOrigins : null;
    },
  };
  const keys = {
    async signingKeyFor(companyId) {
      return keyFor(companyId);
    },
  };
  const verifier = createEmbedTokenVerifier({ keys, trust });
  const issuer = createEmbedTokenIssuer({ keys, trust }, clock);
  const handlers = createWidgetHandlers({
    env,
    chatbots: {
      async findByPublicId(publicId) {
        lookups.count += 1;
        return chatbotsByPublic.get(publicId) ?? null;
      },
    },
    verifier,
    issuer,
    messages: {
      async send(input) {
        sent.push(input);
        return reply ?? { id: "msg-1", text: "Hello back" };
      },
    },
    limits: {
      config: createFixedWindowLimiter({ limit: 100, windowMs: 60_000 }, () => NOW),
      session: createFixedWindowLimiter({ limit: 100, windowMs: 60_000 }, () => NOW),
      message: createFixedWindowLimiter({ limit: 100, windowMs: 60_000 }, () => NOW),
    },
    assetBaseUrl: "https://cdn.example.com/widget",
    now: clock,
  });
  return { handlers, verifier, issuer, lookups, sent, chatbotsByPublic, trust };
}

const req = (overrides = {}) => ({
  params: { publicId: PUBLIC_ID },
  headers: { origin: TRUSTED },
  body: undefined,
  ip: "203.0.113.7",
  ...overrides,
});

// ---------- config endpoint ----------

test("config endpoint never returns a token, key or credential", async () => {
  // A record that carries secret fields, as a careless projection would. The public config must drop them.
  const leaky = { ...baseRecord(), embedToken: "v1.leak.leak", apiKey: "fixture-api-key-value", shopifyAccessToken: "shpat_fixture" };
  const { handlers } = setup({ record: leaky });
  const res = await handlers.getConfig(req());
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), [...WIDGET_PUBLIC_CONFIG_KEYS].sort());
  const text = JSON.stringify(res.body);
  assert.doesNotMatch(text, /v1\.leak/);
  assert.doesNotMatch(text, /fixture-api-key-value/);
  assert.doesNotMatch(text, /shpat_/);
  assert.doesNotMatch(text, /companyId|chatbotId|apiKey|token/i);
});

test("config response carries no token after a session token has been issued", async () => {
  const { handlers } = setup();
  const session = await handlers.createSession(req({ body: { visitorId: VISITOR } }));
  assert.equal(session.status, 200);
  const cfg = await handlers.getConfig(req());
  assert.equal(cfg.status, 200);
  assert.equal(JSON.stringify(cfg.body).includes(session.body.token), false);
});

test("config uses the asset base from server configuration, not from the tenant", async () => {
  const { handlers } = setup({ record: baseRecord({ welcomeMessage: "x" }) });
  const res = await handlers.getConfig(req());
  assert.equal(res.body.assetBaseUrl, "https://cdn.example.com/widget");
  assert.equal(res.body.publicId, PUBLIC_ID);
});

test("config projection sanitises colour, position and language", () => {
  const cfg = toWidgetPublicConfig(
    baseRecord({ primaryColor: "red;background:url(x)", launcherPosition: "top", language: "<script>", title: "  Ok\u0007 " }),
    "https://cdn.example.com",
  );
  assert.equal(cfg.primaryColor, "#763ed1");
  assert.equal(cfg.launcherPosition, "bottom-right");
  assert.equal(cfg.language, "en");
  assert.equal(cfg.title, "Ok");
});

test("config response is cacheable only per origin and is never a wildcard", async () => {
  const { handlers } = setup();
  const res = await handlers.getConfig(req());
  assert.equal(res.headers["Access-Control-Allow-Origin"], TRUSTED);
  assert.notEqual(res.headers["Access-Control-Allow-Origin"], "*");
  assert.match(res.headers.Vary, /Origin/);
});

// ---------- flag and unknown ids ----------

test("every endpoint answers 404 when CHATBOT_WIDGET_ENABLED is not exactly true", async () => {
  for (const flagValue of [undefined, "1", "yes", "on", "TRUE"]) {
    const { handlers } = setup({ env: { [CONTRACT_FLAGS.WIDGET_ENABLED]: flagValue } });
    assert.equal(handlers.enabled(), false);
    assert.equal((await handlers.getConfig(req())).status, 404);
    assert.equal((await handlers.createSession(req({ body: { visitorId: VISITOR } }))).status, 404);
    assert.equal((await handlers.sendMessage(req())).status, 404);
    assert.equal((await handlers.preflight(req())).status, 404);
  }
});

test("a malformed or unknown public id gets a plain 404", async () => {
  const { handlers } = setup();
  assert.equal((await handlers.getConfig(req({ params: { publicId: "not-an-id" } }))).status, 404);
  const unknown = await handlers.getConfig(req({ params: { publicId: OTHER_PUBLIC_ID } }));
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, { error: "not_found" });
});

// ---------- trusted origins ----------

test("an origin not on the trusted list is refused on the config endpoint", async () => {
  const { handlers } = setup();
  const res = await handlers.getConfig(req({ headers: { origin: UNTRUSTED } }));
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: "origin_not_trusted" });
  assert.equal(res.headers["Access-Control-Allow-Origin"], undefined);
});

test("a request with no Origin header is refused, not treated as trusted", async () => {
  const { handlers } = setup();
  assert.equal((await handlers.getConfig(req({ headers: {} }))).status, 403);
  assert.equal((await handlers.createSession(req({ headers: {}, body: { visitorId: VISITOR } }))).status, 403);
});

test("an empty trusted list refuses every origin (fails closed)", async () => {
  const { handlers } = setup({ record: baseRecord({ allowedOrigins: [] }) });
  assert.equal((await handlers.getConfig(req())).status, 403);
  assert.equal(isTrustedOrigin(TRUSTED, []), false);
});

test("session issuance is refused for an untrusted origin", async () => {
  const { handlers } = setup();
  const res = await handlers.createSession(req({ headers: { origin: UNTRUSTED }, body: { visitorId: VISITOR } }));
  assert.equal(res.status, 403);
  assert.equal(res.body.token, undefined);
});

test("a token issued for one origin is refused when presented from another", async () => {
  const { handlers, verifier, issuer } = setup({ record: baseRecord({ allowedOrigins: ["shop.example.com", "other.example.org"] }) });
  const session = await handlers.createSession(req({ body: { visitorId: VISITOR } }));
  const verified = await verifier.verify(session.body.token, "https://other.example.org", "chat", NOW_SECONDS);
  assert.deepEqual(verified, { ok: false, reason: "origin_mismatch" });
  await assert.rejects(issuer.issue({ companyId: COMPANY_A, chatbotPublicId: PUBLIC_ID, visitorId: VISITOR, origin: UNTRUSTED, scope: ["chat"] }, 60), (err) => {
    assert.ok(err instanceof EmbedTokenIssueError);
    assert.equal(err.code, "origin_not_trusted");
    return true;
  });
});

test("preflight echoes only a trusted origin and never a wildcard", async () => {
  const { handlers } = setup();
  const ok = await handlers.preflight(req({ headers: { origin: TRUSTED } }));
  assert.equal(ok.status, 204);
  assert.equal(ok.headers["Access-Control-Allow-Origin"], TRUSTED);
  const bad = await handlers.preflight(req({ headers: { origin: UNTRUSTED } }));
  assert.equal(bad.status, 403);
  assert.equal(bad.headers["Access-Control-Allow-Origin"], undefined);
});

test("origin normalisation rejects paths, credentials and plain http except localhost", () => {
  assert.equal(normaliseOrigin("https://Shop.Example.com"), "https://shop.example.com");
  assert.equal(normaliseOrigin("http://shop.example.com"), null);
  assert.equal(normaliseOrigin("http://localhost:3000"), "http://localhost:3000");
  assert.equal(normaliseOrigin("https://shop.example.com/path"), null);
  assert.equal(normaliseOrigin("https://user:pw@shop.example.com"), null);
  assert.equal(normaliseTrustedDomain("*.example.com"), null);
  assert.equal(normaliseTrustedDomain("https://shop.example.com/"), "shop.example.com");
  assert.equal(normaliseTrustedDomain("shop.example.com:99999"), null);
});

// ---------- embed tokens ----------

test("a valid token verifies for its own origin, chatbot and scope", async () => {
  const { issuer, verifier } = setup();
  const token = await issuer.issue({ companyId: COMPANY_A, chatbotPublicId: PUBLIC_ID, visitorId: VISITOR, origin: TRUSTED, scope: ["chat"] }, 300);
  const result = await verifier.verify(token, TRUSTED, "chat", NOW_SECONDS + 10);
  assert.equal(result.ok, true);
  assert.equal(result.claims.companyId, COMPANY_A);
  assert.equal(result.claims.visitorId, VISITOR);
});

test("a tampered payload fails the signature check", async () => {
  const { issuer, verifier } = setup();
  const token = await issuer.issue({ companyId: COMPANY_A, chatbotPublicId: PUBLIC_ID, visitorId: VISITOR, origin: TRUSTED, scope: ["chat"] }, 300);
  const [v, payload, sig] = token.split(".");
  const forged = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  forged.scope = ["chat", "voice"];
  const tampered = `${v}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${sig}`;
  assert.deepEqual(await verifier.verify(tampered, TRUSTED, "chat", NOW_SECONDS), { ok: false, reason: "signature_invalid" });
});

test("expired, out-of-scope and malformed tokens are refused with the right reason", async () => {
  const { issuer, verifier } = setup();
  const token = await issuer.issue({ companyId: COMPANY_A, chatbotPublicId: PUBLIC_ID, visitorId: VISITOR, origin: TRUSTED, scope: ["chat"] }, 60);
  assert.deepEqual(await verifier.verify(token, TRUSTED, "chat", NOW_SECONDS + 3600), { ok: false, reason: "expired" });
  assert.deepEqual(await verifier.verify(token, TRUSTED, "voice", NOW_SECONDS), { ok: false, reason: "scope_denied" });
  assert.deepEqual(await verifier.verify("nonsense", TRUSTED, "chat", NOW_SECONDS), { ok: false, reason: "malformed" });
  assert.deepEqual(await verifier.verify("", TRUSTED, "chat", NOW_SECONDS), { ok: false, reason: "malformed" });
});

test("a company with no signing key fails closed, both to issue and to verify", async () => {
  let keyAvailable = true;
  const { issuer, verifier, handlers } = setup({ keyFor: () => (keyAvailable ? FIXTURE_KEY : null) });
  const token = await issuer.issue({ companyId: COMPANY_A, chatbotPublicId: PUBLIC_ID, visitorId: VISITOR, origin: TRUSTED, scope: ["chat"] }, 60);
  keyAvailable = false;
  assert.deepEqual(await verifier.verify(token, TRUSTED, "chat", NOW_SECONDS), { ok: false, reason: "signature_invalid" });
  await assert.rejects(issuer.issue({ companyId: COMPANY_A, chatbotPublicId: PUBLIC_ID, visitorId: VISITOR, origin: TRUSTED, scope: ["chat"] }, 60), (err) => err.code === "signing_key_missing");
  const session = await handlers.createSession(req({ body: { visitorId: VISITOR } }));
  assert.equal(session.status, 503);
});

test("a token from one company cannot be verified under another company's key", async () => {
  const keys = { [COMPANY_A]: "key-a-fixture", [COMPANY_B]: "key-b-fixture" };
  const { issuer, verifier } = setup({ keyFor: (c) => keys[c] ?? null });
  const token = await issuer.issue({ companyId: COMPANY_A, chatbotPublicId: PUBLIC_ID, visitorId: VISITOR, origin: TRUSTED, scope: ["chat"] }, 60);
  const [v, payload] = token.split(".");
  const moved = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  moved.companyId = COMPANY_B;
  const rebound = `${v}.${Buffer.from(JSON.stringify(moved)).toString("base64url")}.${token.split(".")[2]}`;
  assert.deepEqual(await verifier.verify(rebound, TRUSTED, "chat", NOW_SECONDS), { ok: false, reason: "signature_invalid" });
});

test("issuing rejects a TTL outside 1 to 3600 seconds", async () => {
  const { issuer } = setup();
  for (const ttl of [0, -5, 3601, 1.5]) {
    await assert.rejects(issuer.issue({ companyId: COMPANY_A, chatbotPublicId: PUBLIC_ID, visitorId: VISITOR, origin: TRUSTED, scope: ["chat"] }, ttl), (err) => err.code === "invalid_ttl");
  }
});

// ---------- message endpoint ----------

test("a visitor message is sent only with a valid token for this chatbot and origin", async () => {
  const { handlers, sent } = setup();
  const session = await handlers.createSession(req({ body: { visitorId: VISITOR } }));
  assert.equal(session.body.scope[0], "chat");
  assert.equal(session.body.expiresAt, NOW_SECONDS + WIDGET_SESSION_TTL_SECONDS);

  const auth = { authorization: `Bearer ${session.body.token}`, origin: TRUSTED };
  const ok = await handlers.sendMessage(req({ headers: auth, body: { text: "  where is my order? " } }));
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { message: { id: "msg-1", role: "assistant", text: "Hello back" } });
  assert.deepEqual(sent, [{ companyId: COMPANY_A, chatbotPublicId: PUBLIC_ID, visitorId: VISITOR, text: "where is my order?" }]);

  assert.equal((await handlers.sendMessage(req({ headers: { origin: TRUSTED } }))).status, 401);
  assert.equal((await handlers.sendMessage(req({ headers: { ...auth, origin: UNTRUSTED } }))).status, 403);
  assert.equal((await handlers.sendMessage(req({ headers: auth, body: { text: "   " } }))).status, 400);
  assert.equal((await handlers.sendMessage(req({ headers: auth, body: { text: "x".repeat(2001) } }))).status, 400);
  assert.equal(sent.length, 1);
});

test("a token for one chatbot cannot be used against another chatbot's path", async () => {
  const pair = setup();
  pair.chatbotsByPublic.set(OTHER_PUBLIC_ID, baseRecord({ publicId: OTHER_PUBLIC_ID }));
  const session = await pair.handlers.createSession(req({ body: { visitorId: VISITOR } }));
  const res = await pair.handlers.sendMessage(req({
    params: { publicId: OTHER_PUBLIC_ID },
    headers: { origin: TRUSTED, authorization: `Bearer ${session.body.token}` },
    body: { text: "hi" },
  }));
  assert.equal(res.status, 401);
  assert.equal(pair.sent.length, 0);
});

test("the embed token storage is tenant-scoped: another company sees no trusted domains", async () => {
  const { trust } = setup();
  assert.equal(await trust.trustedDomainsFor(COMPANY_B, PUBLIC_ID), null);
  assert.deepEqual(await trust.trustedDomainsFor(COMPANY_A, PUBLIC_ID), ["shop.example.com"]);
});

// ---------- rate limit ----------

test("the rate limiter blocks a burst and resets after the window", () => {
  let t = 0;
  const limiter = createFixedWindowLimiter({ limit: 3, windowMs: 10_000 }, () => t);
  assert.equal(limiter.take("k").allowed, true);
  assert.equal(limiter.take("k").allowed, true);
  const third = limiter.take("k");
  assert.equal(third.allowed, true);
  assert.equal(third.remaining, 0);
  const blocked = limiter.take("k");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1);
  assert.equal(limiter.take("other").allowed, true);
  t = 10_000;
  assert.equal(limiter.take("k").allowed, true);
});

test("the config endpoint returns 429 with Retry-After when a burst passes the limit", async () => {
  let lookups = 0;
  const record = baseRecord();
  const handlers = createWidgetHandlers({
    env: ENV_ON,
    chatbots: { async findByPublicId() { lookups += 1; return record; } },
    verifier: { verify: async () => ({ ok: false, reason: "malformed" }) },
    issuer: { issue: async () => "unused" },
    messages: { send: async () => ({ id: "x", text: "x" }) },
    limits: {
      config: createFixedWindowLimiter({ limit: 2, windowMs: 60_000 }, () => NOW),
      session: createFixedWindowLimiter({ limit: 2, windowMs: 60_000 }, () => NOW),
      message: createFixedWindowLimiter({ limit: 2, windowMs: 60_000 }, () => NOW),
    },
    assetBaseUrl: "https://cdn.example.com",
    now: clock,
  });
  assert.equal((await handlers.getConfig(req())).status, 200);
  assert.equal((await handlers.getConfig(req())).status, 200);
  const blocked = await handlers.getConfig(req());
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers["Retry-After"]) >= 1);
  assert.equal(lookups, 2, "a blocked request does not reach storage");
});

// ---------- Drizzle query shapes ----------

const dialect = new PgDialect();
function recordingDb() {
  const statements = [];
  const client = {
    async query(config, values) {
      const text = typeof config === "string" ? config : config.text;
      statements.push({ text, params: typeof config === "string" ? (values ?? []) : (config.values ?? []) });
      return { rows: [], rowCount: 0, fields: [] };
    },
  };
  return { db: drizzle(client), statements };
}

test("the trusted-domain and signing-key queries filter on company_id", () => {
  const { db } = recordingDb();
  const trusted = dialect.sqlToQuery(selectTrustedDomainsQuery(db, COMPANY_A, PUBLIC_ID).getSQL());
  assert.match(trusted.sql, /"company_id" = \$1/);
  assert.match(trusted.sql, /"public_id" = \$2/);
  assert.deepEqual(trusted.params.slice(0, 2), [COMPANY_A, PUBLIC_ID]);

  const key = dialect.sqlToQuery(selectActiveSigningKeyQuery(db, COMPANY_A).getSQL());
  assert.match(key.sql, /"company_id" = \$1/);
  assert.match(key.sql, /"revoked_at" is null/i);
  assert.match(key.sql, /order by "widget_embed_keys"\."created_at" desc/i);
  assert.equal(key.params[0], COMPANY_A);
});

test("the widget tables carry company_id and never store a plaintext key column", () => {
  for (const table of [widgetChatbotConfigs, widgetEmbedKeys]) {
    const columns = getTableConfig(table).columns.map((c) => c.name);
    assert.ok(columns.includes("company_id"), "company_id column");
    assert.ok(!columns.some((c) => /plain|raw_key|secret_value/.test(c)), "no plaintext key column");
  }
  assert.ok(getTableConfig(widgetEmbedKeys).columns.some((c) => c.name === "sealed"));
});

/** A stand-in for the Drizzle chain. Each select resolves to the given rows. No database is reached. */
function fakeRowsDb(rows) {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => rows,
  };
  return { select: () => chain };
}

test("the storage returns no signing key when decryption fails (fails closed)", async () => {
  const storage = new DrizzleWidgetStorage(fakeRowsDb([{ sealed: { v: 1 } }]), {
    async encrypt() { throw new Error("unused"); },
    async decrypt() { throw new Error("wrong company"); },
  });
  assert.equal(await storage.signingKeyFor(COMPANY_A), null);
});

test("the storage opens the sealed key under the requesting company only", async () => {
  const seen = [];
  const storage = new DrizzleWidgetStorage(fakeRowsDb([{ sealed: { v: 1, keyId: "k1" } }]), {
    async encrypt() { throw new Error("unused"); },
    async decrypt(companyId) { seen.push(companyId); return FIXTURE_KEY; },
  });
  assert.equal(await storage.signingKeyFor(COMPANY_A), FIXTURE_KEY);
  assert.deepEqual(seen, [COMPANY_A]);
});

test("the storage refuses a malformed company id before any query", async () => {
  const storage = new DrizzleWidgetStorage({ select: () => { throw new Error("must not query"); } }, {
    async encrypt() { throw new Error("unused"); },
    async decrypt() { throw new Error("unused"); },
  });
  await assert.rejects(storage.trustedDomainsFor("not-a-company", PUBLIC_ID));
  await assert.rejects(storage.signingKeyFor(""));
});

// ---------- browser client ----------

test("the browser config parser rejects a config for another chatbot or with a bad shape", () => {
  const good = toWidgetPublicConfig(baseRecord(), "https://cdn.example.com");
  assert.ok(parseWidgetConfig(JSON.parse(JSON.stringify(good)), PUBLIC_ID));
  assert.equal(parseWidgetConfig(good, OTHER_PUBLIC_ID), null);
  assert.equal(parseWidgetConfig({ ...good, primaryColor: "url(javascript:x)" }, PUBLIC_ID), null);
  assert.equal(parseWidgetConfig(null, PUBLIC_ID), null);
});

test("the browser client returns null for a refused config and never throws", async () => {
  const api = createWidgetApi({
    baseUrl: "https://chat.example.com",
    publicId: PUBLIC_ID,
    fetchImpl: async () => new Response("{}", { status: 403 }),
  });
  assert.equal(await api.loadConfig(), null);
});

test("the browser client sends no cookies and calls only the configured origin", async () => {
  const calls = [];
  const api = createWidgetApi({
    baseUrl: "https://chat.example.com/",
    publicId: PUBLIC_ID,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ token: "t", expiresAt: 1 }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await api.createSession(VISITOR);
  assert.equal(calls[0].url, `https://chat.example.com/api/v2/widget/${PUBLIC_ID}/session`);
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.method, "POST");
});

test("the browser client times out instead of waiting forever", async () => {
  const api = createWidgetApi({
    baseUrl: "https://chat.example.com",
    publicId: PUBLIC_ID,
    timeoutMs: 20,
    fetchImpl: (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))),
  });
  await assert.rejects(api.createSession(VISITOR), (err) => err instanceof WidgetRequestError && err.status === 0);
});

test("the visitor id is random, well formed and reused from storage", () => {
  const id = newVisitorId();
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  const store = new Map();
  const kv = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const first = getVisitorId(kv);
  assert.equal(getVisitorId(kv), first);
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.match(getVisitorId(broken), /^[A-Za-z0-9_-]{22}$/);
});

// ---------- widget source scan ----------

const here = dirname(fileURLToPath(import.meta.url));
const WIDGET_SRC = join(here, "..", "..", "client", "src", "widget");

function widgetSources() {
  return readdirSync(WIDGET_SRC)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ file: f, text: readFileSync(join(WIDGET_SRC, f), "utf8") }));
}

test("the widget source contains no secret, API key or provider credential", () => {
  const forbidden = [
    /sk-[A-Za-z0-9_-]{8,}/,
    /\bapi[_-]?key\b/i,
    /\bapikey\b/i,
    /secret/i,
    /CHATBOT_SECRET_KEY/,
    /OPENAI|ANTHROPIC|GEMINI/,
    /password/i,
    /bearer\s+[A-Za-z0-9._-]{12,}/i,
  ];
  const sources = widgetSources();
  assert.ok(sources.length >= 5, "widget source files found");
  for (const { file, text } of sources) {
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, `${file} matches ${pattern}`);
    }
  }
});

test("the widget source runs no inline script, uses no innerHTML and imports no server runtime", () => {
  for (const { file, text } of widgetSources()) {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function\(/, file);
    assert.doesNotMatch(text, /from\s+["']node:/, file);
    assert.doesNotMatch(text, /from\s+["'](express|drizzle-orm|pg)["']/, file);
  }
});

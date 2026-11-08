// Instagram channel and review flow tests (node:test). No network: every HTTP call goes to a fake HttpClient.
// Drizzle queries are captured by a recording client, so the real storage methods run and their SQL is checked.
//
// Run: NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types tests/modules/chatbot-instagram-reviews.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  INSTAGRAM_SCOPES,
  OAUTH_STATE_TTL_MS,
  DrizzleInstagramAccountStorage,
  DrizzleOauthStateStorage,
  answerSubscriptionChallenge,
  completeInstagramOAuth,
  computeSignatureHeader,
  createInstagramCredentialSource,
  createInstagramProvider,
  createMemoryInstagramAccountStorage,
  createMemoryOauthStateStorage,
  openCredentials,
  publicAccountView,
  refreshInstagramAccountToken,
  sealCredentials,
  startInstagramOAuth,
} from "../../server/modules/chatbot/channels/instagram/index.ts";
import {
  DEFAULT_REVIEW_DELAY_MINUTES,
  DrizzleReviewStorage,
  createMemoryReviewStorage,
  createReviewService,
  hashReviewToken,
  validateComment,
  validateRating,
} from "../../server/modules/chatbot/reviews/index.ts";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const APP_SECRET = "APP-SECRET-test-0123456789";
const APP = { appId: "900001", appSecret: APP_SECRET, verifyToken: "VERIFY-test-token", redirectUri: "https://desk.example/oauth/instagram/callback" };
const PAGE_TOKEN = "PAGE-TOKEN-qqq-test";
const LONG_TOKEN = "LONG-TOKEN-xyz-test";
const SHORT_TOKEN = "SHORT-TOKEN-abc-test";
const IG_ID = "17841400000000001";
const dialect = new PgDialect();

/** AES-256-GCM with the company id as associated data. Test-only key, generated per run. */
function testSecretBox() {
  const key = randomBytes(32);
  return {
    async encrypt(companyId, plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(companyId, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return { v: 1, alg: "aes-256-gcm", keyId: "v1", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
    },
    async decrypt(companyId, sealed) {
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
        decipher.setAAD(Buffer.from(companyId, "utf8"));
        decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
        return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64")), decipher.final()]).toString("utf8");
      } catch {
        const error = new Error("decrypt failed");
        error.code = "SECRET_DECRYPT_FAILED";
        throw error;
      }
    },
  };
}

/** Fake HttpClient. Records every request and answers from a router. Never touches the network. */
function fakeHttp(router) {
  const calls = [];
  const http = async (request) => {
    calls.push(request);
    const answer = router(request);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  http.calls = calls;
  return http;
}
const json = (status, body) => ({ status, headers: {}, body: JSON.stringify(body) });

/** Routes Meta's OAuth and Graph calls for a happy-path sign-in. */
function metaRouter(overrides = {}) {
  return (request) => {
    if (overrides.all) return overrides.all(request);
    if (request.url.includes("/oauth/access_token")) {
      const isExchange = request.body?.includes("fb_exchange_token");
      return isExchange
        ? json(200, { access_token: LONG_TOKEN, expires_in: 5184000 })
        : json(200, { access_token: SHORT_TOKEN });
    }
    if (request.url.includes("/me/accounts")) {
      return json(200, {
        data: [
          { id: "p0", name: "No Instagram", access_token: "PAGE-TOKEN-none" },
          { id: "p1", name: "Shop Page", access_token: PAGE_TOKEN, connected_instagram_account: { id: IG_ID } },
        ],
      });
    }
    if (request.url.includes(`/${IG_ID}?`)) {
      return json(200, { id: IG_ID, name: "Shop", username: "shop_test", profile_picture_url: "https://cdn.example/p.jpg" });
    }
    return json(404, { error: { code: 100 } });
  };
}

function oauthDeps(overrides = {}) {
  let clock = new Date("2026-11-08T10:00:00Z");
  const accounts = createMemoryInstagramAccountStorage();
  const states = createMemoryOauthStateStorage();
  const http = overrides.http ?? fakeHttp(metaRouter());
  return {
    deps: { accounts, states, box: testSecretBox(), http, now: () => clock, randomBytes: (n) => randomBytes(n), ...overrides.deps },
    accounts,
    states,
    http,
    setNow(value) {
      clock = value;
    },
  };
}

function signedRaw(body, secret = APP_SECRET, headerOverride) {
  return {
    headers: { "x-hub-signature-256": headerOverride ?? computeSignatureHeader(secret, body) },
    rawBody: body,
    receivedAt: new Date("2026-11-08T10:00:00Z"),
  };
}

function metaPayload(events, id = IG_ID) {
  return JSON.stringify({ object: "instagram", entry: [{ id, time: 1, messaging: events }] });
}

const CREDS = { instagram_id: IG_ID, access_token: PAGE_TOKEN, app_secret: APP_SECRET, verify_token: APP.verifyToken, page_id: "p1" };

// ---------------------------------------------------------------------------
// Instagram: webhook signatures
// ---------------------------------------------------------------------------

test("instagram: a correctly signed post verifies", async () => {
  const provider = createInstagramProvider();
  const body = metaPayload([]);
  const result = await provider.verifyWebhook(COMPANY_A, IG_ID, signedRaw(body), CREDS);
  assert.deepEqual(result, { ok: true });
});

test("instagram: refuses when the app secret is missing, even with a header", async () => {
  const provider = createInstagramProvider();
  const body = metaPayload([]);
  const result = await provider.verifyWebhook(COMPANY_A, IG_ID, signedRaw(body), { ...CREDS, app_secret: "" });
  assert.deepEqual(result, { ok: false, reason: "credentials_missing" });
});

test("instagram: refuses a request with no signature header", async () => {
  const provider = createInstagramProvider();
  const raw = { headers: {}, rawBody: metaPayload([]), receivedAt: new Date() };
  const result = await provider.verifyWebhook(COMPANY_A, IG_ID, raw, CREDS);
  assert.deepEqual(result, { ok: false, reason: "signature_missing" });
});

test("instagram: refuses a bad, unprefixed, short or tampered signature", async () => {
  const provider = createInstagramProvider();
  const body = metaPayload([]);
  const good = computeSignatureHeader(APP_SECRET, body);
  const digestOnly = good.slice("sha256=".length);
  const cases = [
    signedRaw(body, APP_SECRET, "sha256=" + "0".repeat(64)),
    signedRaw(body, APP_SECRET, digestOnly),
    signedRaw(body, APP_SECRET, "sha256=abc"),
    signedRaw(body, "some-other-secret"),
    { headers: { "x-hub-signature-256": good }, rawBody: body + " ", receivedAt: new Date() },
  ];
  for (const raw of cases) {
    const result = await provider.verifyWebhook(COMPANY_A, IG_ID, raw, CREDS);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "signature_invalid");
  }
});

test("instagram: refuses a payload for a different account than the credentials", async () => {
  const provider = createInstagramProvider();
  const body = metaPayload([], "99999");
  const result = await provider.verifyWebhook(COMPANY_A, IG_ID, signedRaw(body), CREDS);
  assert.deepEqual(result, { ok: false, reason: "account_unknown" });
});

test("instagram: resolveAccount reads the entry id and returns null for junk", () => {
  const provider = createInstagramProvider();
  assert.equal(provider.resolveAccount({ headers: {}, rawBody: metaPayload([]), receivedAt: new Date() }), IG_ID);
  assert.equal(provider.resolveAccount({ headers: {}, rawBody: "not json", receivedAt: new Date() }), null);
  assert.equal(provider.resolveAccount({ headers: {}, rawBody: "{}", receivedAt: new Date() }), null);
});

// ---------------------------------------------------------------------------
// Instagram: subscription challenge
// ---------------------------------------------------------------------------

test("instagram: the subscription challenge is echoed only for the right token", () => {
  const ok = answerSubscriptionChallenge({ "hub.mode": "subscribe", "hub.verify_token": APP.verifyToken, "hub.challenge": "12345" }, APP.verifyToken);
  assert.deepEqual(ok, { ok: true, body: "12345" });

  const wrongToken = answerSubscriptionChallenge({ "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "1" }, APP.verifyToken);
  const wrongMode = answerSubscriptionChallenge({ "hub.mode": "unsubscribe", "hub.verify_token": APP.verifyToken, "hub.challenge": "1" }, APP.verifyToken);
  const noExpected = answerSubscriptionChallenge({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "1" }, undefined);
  const noChallenge = answerSubscriptionChallenge({ "hub.mode": "subscribe", "hub.verify_token": APP.verifyToken }, APP.verifyToken);
  for (const result of [wrongToken, wrongMode, noExpected, noChallenge]) {
    assert.deepEqual(result, { ok: false, status: 403 });
  }
});

// ---------------------------------------------------------------------------
// Instagram: inbound parsing
// ---------------------------------------------------------------------------

test("instagram: parses text, quick reply, image and sticker events in order", () => {
  const provider = createInstagramProvider();
  const body = metaPayload([
    { sender: { id: "u1" }, recipient: { id: IG_ID }, timestamp: 1762596000000, message: { mid: "m1", text: "hello" } },
    { sender: { id: "u1" }, recipient: { id: IG_ID }, timestamp: 1762596001000, message: { mid: "m2", quick_reply: { payload: "PRICES" } } },
    { sender: { id: "u1" }, recipient: { id: IG_ID }, timestamp: 1762596002000, message: { mid: "m3", attachments: [{ type: "image", payload: { url: "https://cdn.example/a.jpg" } }] } },
    { sender: { id: "u1" }, recipient: { id: IG_ID }, timestamp: 1762596003000, message: { mid: "m4", attachments: [{ type: "story_mention", payload: {} }] } },
  ]);
  const results = provider.parseInbound({ headers: {}, rawBody: body, receivedAt: new Date("2026-11-08T10:00:00Z") }, IG_ID);
  assert.equal(results.length, 4);
  const [first, second, third, fourth] = results;
  assert.equal(first.kind, "message");
  assert.equal(first.message.contentKind, "text");
  assert.equal(first.message.text, "hello");
  assert.equal(first.message.externalThreadId, "u1");
  assert.equal(first.message.sentAt.getTime(), 1762596000000);
  assert.equal(second.message.contentKind, "interactive");
  assert.equal(second.message.text, "PRICES");
  assert.equal(third.message.contentKind, "image");
  assert.deepEqual(third.message.attachments, [{ kind: "image", externalRef: "https://cdn.example/a.jpg", mimeType: null, sizeBytes: null }]);
  assert.equal(fourth.message.contentKind, "unknown");
  assert.deepEqual(fourth.message.attachments, []);
});

test("instagram: echoes, junk and foreign objects never become messages", () => {
  const provider = createInstagramProvider();
  const raw = (rawBody) => ({ headers: {}, rawBody, receivedAt: new Date() });
  const echo = provider.parseInbound(raw(metaPayload([{ sender: { id: IG_ID }, message: { mid: "e1", text: "our reply", is_echo: true } }])), IG_ID);
  assert.deepEqual(echo, [{ kind: "ignored", reason: "echo" }]);
  assert.deepEqual(provider.parseInbound(raw("{{{"), IG_ID), [{ kind: "ignored", reason: "invalid_json" }]);
  const page = provider.parseInbound(raw(JSON.stringify({ object: "page", entry: [{ id: IG_ID, messaging: [] }] })), IG_ID);
  assert.deepEqual(page, [{ kind: "ignored", reason: "object_not_instagram" }]);
});

test("instagram: parses every entry, not only the first", () => {
  const provider = createInstagramProvider();
  const body = JSON.stringify({
    object: "instagram",
    entry: [
      { id: "other", messaging: [{ sender: { id: "x" }, message: { mid: "x1", text: "wrong account" } }] },
      { id: IG_ID, messaging: [{ sender: { id: "y" }, message: { mid: "y1", text: "second entry" } }] },
    ],
  });
  const results = provider.parseInbound({ headers: {}, rawBody: body, receivedAt: new Date() }, IG_ID);
  assert.equal(results[0].reason, "account_mismatch");
  assert.equal(results[1].kind, "message");
  assert.equal(results[1].message.text, "second entry");
});

test("instagram: delivery and read receipts become status updates", () => {
  const provider = createInstagramProvider();
  const body = metaPayload([
    { sender: { id: "u1" }, delivery: { mids: ["m1", "m2"], watermark: 1762596000000 } },
    { sender: { id: "u1" }, read: { mid: "m1", watermark: 1762596005000 } },
  ]);
  const results = provider.parseInbound({ headers: {}, rawBody: body, receivedAt: new Date() }, IG_ID);
  assert.deepEqual(results.map((item) => [item.kind, item.update.externalMessageId, item.update.status]), [
    ["status", "m1", "delivered"],
    ["status", "m2", "delivered"],
    ["status", "m1", "read"],
  ]);
});

// ---------------------------------------------------------------------------
// Instagram: sending
// ---------------------------------------------------------------------------

function outbound(overrides = {}) {
  return {
    channel: "instagram",
    accountId: IG_ID,
    recipient: "u1",
    contentKind: "text",
    text: "Thanks for asking",
    attachmentUrl: null,
    templateName: null,
    templateParams: null,
    replyToExternalMessageId: null,
    idempotencyKey: "msg-1",
    ...overrides,
  };
}

test("instagram: send posts text with the token in a header, never in the URL", async () => {
  const http = fakeHttp(() => json(200, { recipient_id: "u1", message_id: "mid.123" }));
  const provider = createInstagramProvider();
  const result = await provider.send(COMPANY_A, outbound(), CREDS, http);
  assert.deepEqual(result, { status: "sent", externalMessageId: "mid.123" });
  const call = http.calls[0];
  assert.equal(call.method, "POST");
  assert.equal(call.url, `https://graph.facebook.com/v18.0/${IG_ID}/messages`);
  assert.equal(call.headers.Authorization, `Bearer ${PAGE_TOKEN}`);
  assert.equal(call.timeoutMs > 0, true);
  assert.equal(call.url.includes(PAGE_TOKEN), false);
  assert.deepEqual(JSON.parse(call.body).recipient, { id: "u1" });
});

test("instagram: send refuses bad input before any HTTP call", async () => {
  const provider = createInstagramProvider();
  const http = fakeHttp(() => json(200, { message_id: "x" }));
  const cases = [
    [outbound({ contentKind: "image" }), "unsupported_content"],
    [outbound({ text: "   " }), "empty_text"],
    [outbound({ text: "x".repeat(1001) }), "text_too_long"],
    [outbound({ accountId: "other" }), "account_mismatch"],
    [outbound({ recipient: "" }), "recipient_missing"],
  ];
  for (const [message, code] of cases) {
    const result = await provider.send(COMPANY_A, message, CREDS, http);
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, code);
    assert.equal(result.retryable, false);
  }
  const noToken = await provider.send(COMPANY_A, outbound(), { instagram_id: IG_ID }, http);
  assert.equal(noToken.errorCode, "credentials_missing");
  assert.equal(http.calls.length, 0);
});

test("instagram: send maps Meta and transport failures to retryable flags", async () => {
  const provider = createInstagramProvider();
  const run = async (answer) => provider.send(COMPANY_A, outbound(), CREDS, fakeHttp(() => answer));

  const rejected = await run(json(400, { error: { code: 10, message: "outside window" } }));
  assert.equal(rejected.status, "failed");
  assert.equal(rejected.errorCode, "http_400");
  assert.equal(rejected.retryable, false);

  const limited = await run(json(429, {}));
  assert.equal(limited.retryable, true);

  const broken = await run(json(503, {}));
  assert.equal(broken.retryable, true);

  const timedOut = await run(Object.assign(new Error("slow"), { kind: "timeout" }));
  assert.equal(timedOut.errorCode, "timeout");
  assert.equal(timedOut.retryable, true);

  const noId = await run(json(200, { recipient_id: "u1" }));
  assert.equal(noId.errorCode, "unexpected_response");
  assert.equal(noId.retryable, false);
});

test("instagram: a send result never carries the token", async () => {
  const provider = createInstagramProvider();
  const failure = await provider.send(COMPANY_A, outbound(), CREDS, fakeHttp(() => json(401, { error: { message: `bad ${PAGE_TOKEN}` } })));
  assert.equal(JSON.stringify(failure).includes(PAGE_TOKEN), false);
});

// ---------------------------------------------------------------------------
// Instagram: OAuth
// ---------------------------------------------------------------------------

test("instagram: OAuth start returns a URL with a one-time state and the Meta scopes", async () => {
  const env = oauthDeps();
  const started = await startInstagramOAuth(env.deps, COMPANY_A, APP);
  assert.equal(started.ok, true);
  const url = new URL(started.authorizeUrl);
  assert.equal(url.origin, "https://www.facebook.com");
  assert.equal(url.searchParams.get("client_id"), APP.appId);
  assert.equal(url.searchParams.get("scope"), INSTAGRAM_SCOPES.join(","));
  assert.equal(started.authorizeUrl.includes(APP_SECRET), false);
  assert.equal(started.expiresAt.getTime() - new Date("2026-11-08T10:00:00Z").getTime(), OAUTH_STATE_TTL_MS);
});

test("instagram: OAuth start refuses an app that is not configured", async () => {
  const env = oauthDeps();
  const result = await startInstagramOAuth(env.deps, COMPANY_A, { ...APP, appSecret: "" });
  assert.deepEqual(result, { ok: false, reason: "app_not_configured" });
});

test("instagram: OAuth completes with the matching state and stores credentials sealed", async () => {
  const env = oauthDeps();
  const started = await startInstagramOAuth(env.deps, COMPANY_A, APP);
  const state = new URL(started.authorizeUrl).searchParams.get("state");
  const result = await completeInstagramOAuth(env.deps, COMPANY_A, APP, { code: "auth-code-1", state });
  assert.equal(result.ok, true);
  assert.equal(result.account.instagramId, IG_ID);
  assert.equal(result.account.username, "shop_test");

  // Nothing returned to the caller carries a token or the app secret.
  const returned = JSON.stringify(result);
  for (const secret of [PAGE_TOKEN, LONG_TOKEN, SHORT_TOKEN, APP_SECRET]) {
    assert.equal(returned.includes(secret), false);
  }
  // Every outbound URL is free of tokens and secrets. Tokens go in bodies or headers only.
  for (const call of env.http.calls) {
    assert.equal(call.url.includes(PAGE_TOKEN) || call.url.includes(LONG_TOKEN) || call.url.includes(APP_SECRET), false);
  }
  // Stored form is ciphertext.
  const [row] = env.accounts.rowsFor(COMPANY_A);
  const stored = JSON.stringify(row.sealedCredentials);
  assert.equal(stored.includes(PAGE_TOKEN), false);
  assert.equal(stored.includes(APP_SECRET), false);
  const opened = await openCredentials(env.deps.box, COMPANY_A, row.sealedCredentials);
  assert.equal(opened.access_token, PAGE_TOKEN);
});

test("instagram: OAuth refuses a missing, wrong, reused or expired state before any exchange", async () => {
  const env = oauthDeps();
  const started = await startInstagramOAuth(env.deps, COMPANY_A, APP);
  const state = new URL(started.authorizeUrl).searchParams.get("state");

  const missing = await completeInstagramOAuth(env.deps, COMPANY_A, APP, { code: "c", state: undefined });
  assert.deepEqual(missing, { ok: false, reason: "state_mismatch" });

  const wrong = await completeInstagramOAuth(env.deps, COMPANY_A, APP, { code: "c", state: "not-the-state" });
  assert.deepEqual(wrong, { ok: false, reason: "state_mismatch" });
  assert.equal(env.http.calls.length, 0);

  const first = await completeInstagramOAuth(env.deps, COMPANY_A, APP, { code: "c", state });
  assert.equal(first.ok, true);
  const reused = await completeInstagramOAuth(env.deps, COMPANY_A, APP, { code: "c", state });
  assert.deepEqual(reused, { ok: false, reason: "state_mismatch" });

  const expiring = oauthDeps();
  const started2 = await startInstagramOAuth(expiring.deps, COMPANY_A, APP);
  const state2 = new URL(started2.authorizeUrl).searchParams.get("state");
  expiring.setNow(new Date(new Date("2026-11-08T10:00:00Z").getTime() + OAUTH_STATE_TTL_MS + 1));
  const late = await completeInstagramOAuth(expiring.deps, COMPANY_A, APP, { code: "c", state: state2 });
  assert.deepEqual(late, { ok: false, reason: "state_mismatch" });
});

test("instagram: a state issued to one company cannot complete sign-in for another", async () => {
  const env = oauthDeps();
  const started = await startInstagramOAuth(env.deps, COMPANY_A, APP);
  const state = new URL(started.authorizeUrl).searchParams.get("state");
  const result = await completeInstagramOAuth(env.deps, COMPANY_B, APP, { code: "c", state });
  assert.deepEqual(result, { ok: false, reason: "state_mismatch" });
  assert.equal(env.accounts.rowsFor(COMPANY_B).length, 0);
});

test("instagram: a missing code is refused after the state is consumed, with no exchange", async () => {
  const env = oauthDeps();
  const started = await startInstagramOAuth(env.deps, COMPANY_A, APP);
  const state = new URL(started.authorizeUrl).searchParams.get("state");
  const result = await completeInstagramOAuth(env.deps, COMPANY_A, APP, { code: "", state });
  assert.deepEqual(result, { ok: false, reason: "code_missing" });
  assert.equal(env.http.calls.length, 0);
});

test("instagram: a failed exchange returns a reason and leaks no response body", async () => {
  const env = oauthDeps({ http: fakeHttp(() => json(400, { error: { message: `secret ${APP_SECRET}` } })) });
  const started = await startInstagramOAuth(env.deps, COMPANY_A, APP);
  const state = new URL(started.authorizeUrl).searchParams.get("state");
  const result = await completeInstagramOAuth(env.deps, COMPANY_A, APP, { code: "c", state });
  assert.deepEqual(result, { ok: false, reason: "exchange_failed" });
  assert.equal(JSON.stringify(result).includes(APP_SECRET), false);
});

test("instagram: refresh re-seals the token and returns only the new expiry", async () => {
  const env = oauthDeps();
  const started = await startInstagramOAuth(env.deps, COMPANY_A, APP);
  const state = new URL(started.authorizeUrl).searchParams.get("state");
  await completeInstagramOAuth(env.deps, COMPANY_A, APP, { code: "c", state });

  const before = JSON.stringify(env.accounts.rowsFor(COMPANY_A)[0].sealedCredentials);
  const refreshed = await refreshInstagramAccountToken(env.deps, COMPANY_A, IG_ID);
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.tokenExpiresAt instanceof Date, true);
  assert.equal(JSON.stringify(refreshed).includes(LONG_TOKEN), false);
  const after = JSON.stringify(env.accounts.rowsFor(COMPANY_A)[0].sealedCredentials);
  assert.notEqual(before, after);

  const other = await refreshInstagramAccountToken(env.deps, COMPANY_B, IG_ID);
  assert.deepEqual(other, { ok: false, reason: "account_not_connected" });
});

test("instagram: sealed credentials do not open for another company", async () => {
  const box = testSecretBox();
  const accounts = createMemoryInstagramAccountStorage();
  const sealed = await sealCredentials(box, COMPANY_A, CREDS);
  assert.equal(await openCredentials(box, COMPANY_A, sealed) !== null, true);
  assert.equal(await openCredentials(box, COMPANY_B, sealed), null);

  // The credential source hides another company's account even when the id matches.
  await accounts.upsert(COMPANY_A, {
    companyId: COMPANY_A, id: IG_ID, pageId: "p1", username: "shop", sealedCredentials: sealed,
    tokenExpiresAt: null, createdAt: new Date(), updatedAt: new Date(),
  });
  const source = createInstagramCredentialSource(accounts, box);
  assert.equal(await source.load(COMPANY_B, "instagram", IG_ID), null);
  assert.equal((await source.load(COMPANY_A, "instagram", IG_ID)).access_token, PAGE_TOKEN);
  assert.equal(await source.load(COMPANY_A, "whatsapp", IG_ID), null);
});

test("instagram: public account view never includes the token or app secret", () => {
  const view = publicAccountView({ ...CREDS, username: "shop_test" });
  const text = JSON.stringify(view);
  assert.equal(text.includes(PAGE_TOKEN), false);
  assert.equal(text.includes(APP_SECRET), false);
  assert.equal(view.username, "shop_test");
});

// ---------------------------------------------------------------------------
// Instagram: Drizzle SQL
// ---------------------------------------------------------------------------

/** Fake pg client. Records each statement and returns no rows. No socket is opened. */
function recordingDb(rows = []) {
  const statements = [];
  const client = {
    async query(config, values) {
      const text = typeof config === "string" ? config : config.text;
      const params = typeof config === "string" ? (values ?? []) : (config.values ?? values ?? []);
      statements.push({ text, params });
      return { rows, rowCount: rows.length, fields: [] };
    },
  };
  return { db: drizzle(client), statements };
}

test("instagram: Drizzle account reads filter on company_id", async () => {
  const { db, statements } = recordingDb();
  const storage = new DrizzleInstagramAccountStorage(db);
  const found = await storage.get(COMPANY_A, IG_ID);
  assert.equal(found, null);
  const sql = statements.at(-1);
  assert.match(sql.text, /"company_id"\s*=/);
  assert.equal(sql.params.includes(COMPANY_A), true);
  assert.equal(sql.params.includes(COMPANY_B), false);
});

test("instagram: Drizzle state consume is a delete scoped to company, hash and expiry", async () => {
  const { db, statements } = recordingDb([]);
  const storage = new DrizzleOauthStateStorage(db);
  const consumed = await storage.consume(COMPANY_A, "abc123", new Date("2026-11-08T10:00:00Z"));
  assert.equal(consumed, false);
  const sql = statements.at(-1);
  assert.match(sql.text, /^delete from "chatbot_instagram_oauth_states"/);
  assert.match(sql.text, /"company_id"/);
  assert.match(sql.text, /"expires_at"\s*>/);
  assert.equal(sql.params.includes(COMPANY_A), true);
});

test("instagram: Drizzle state insert ignores duplicates", async () => {
  const { db, statements } = recordingDb([]);
  const storage = new DrizzleOauthStateStorage(db);
  assert.equal(await storage.insert(COMPANY_A, "h1", new Date()), false);
  assert.match(statements.at(-1).text, /on conflict do nothing/);
});

test("instagram: a non-UUID company id is refused before any SQL", async () => {
  const { db, statements } = recordingDb();
  const storage = new DrizzleInstagramAccountStorage(db);
  await assert.rejects(() => storage.get("not-a-company", IG_ID));
  assert.equal(statements.length, 0);
});

// ---------------------------------------------------------------------------
// Reviews: validation
// ---------------------------------------------------------------------------

test("reviews: ratings outside 1 to 5 and non-integers are refused", () => {
  for (const bad of [0, 6, -1, 3.5, NaN, Infinity, "4", null, undefined, true]) {
    assert.deepEqual(validateRating(bad), { ok: false, reason: "rating_invalid" }, `value ${String(bad)}`);
  }
  for (const good of [1, 2, 3, 4, 5]) {
    assert.deepEqual(validateRating(good), { ok: true, rating: good });
  }
});

test("reviews: comments are trimmed, blank becomes null, and long text is refused", () => {
  assert.deepEqual(validateComment("  great help  "), { ok: true, comment: "great help" });
  assert.deepEqual(validateComment("   "), { ok: true, comment: null });
  assert.deepEqual(validateComment(undefined), { ok: true, comment: null });
  assert.deepEqual(validateComment(42), { ok: false, reason: "comment_invalid" });
  assert.deepEqual(validateComment("x".repeat(2001)), { ok: false, reason: "comment_too_long" });
});

// ---------------------------------------------------------------------------
// Reviews: scheduling, form and submission
// ---------------------------------------------------------------------------

const CLOSED_AT = new Date("2026-11-08T09:00:00Z");

function reviewEnv(start = "2026-11-08T09:00:00Z") {
  let clock = new Date(start);
  const storage = createMemoryReviewStorage();
  let counter = 0;
  const service = createReviewService({
    storage,
    now: () => clock,
    newId: () => `id-${++counter}`,
    random: (size) => randomBytes(size),
  });
  return {
    storage,
    service,
    setNow(value) {
      clock = new Date(value);
    },
  };
}

const CONVERSATION = { id: "conv-1", chatbotId: "bot-1", channel: "instagram", closedAt: CLOSED_AT };

test("reviews: no request while reviews are off or the conversation is still open", async () => {
  const env = reviewEnv();
  const off = await env.service.scheduleReviewRequest(COMPANY_A, CONVERSATION, { reviewEnabled: false });
  assert.deepEqual(off, { status: "skipped", reason: "review_disabled" });
  const open = await env.service.scheduleReviewRequest(COMPANY_A, { ...CONVERSATION, closedAt: null }, { reviewEnabled: true });
  assert.deepEqual(open, { status: "skipped", reason: "conversation_open" });
});

test("reviews: a request is due after the delay, and only its hash is stored", async () => {
  const env = reviewEnv();
  const scheduled = await env.service.scheduleReviewRequest(COMPANY_A, CONVERSATION, { reviewEnabled: true });
  assert.equal(scheduled.status, "scheduled");
  assert.equal(scheduled.request.dueAt.getTime(), CLOSED_AT.getTime() + DEFAULT_REVIEW_DELAY_MINUTES * 60_000);
  const stored = env.storage.outboxFor(COMPANY_A);
  assert.deepEqual(stored, []);
  const row = await env.storage.findRequestByTokenHash(COMPANY_A, hashReviewToken(scheduled.token));
  assert.equal(row.id, scheduled.request.id);
  assert.equal(JSON.stringify(row).includes(scheduled.token), false);
});

test("reviews: one request per conversation", async () => {
  const env = reviewEnv();
  await env.service.scheduleReviewRequest(COMPANY_A, CONVERSATION, { reviewEnabled: true });
  const again = await env.service.scheduleReviewRequest(COMPANY_A, CONVERSATION, { reviewEnabled: true });
  assert.deepEqual(again, { status: "skipped", reason: "already_requested" });
});

test("reviews: the form stays closed until the request is due", async () => {
  const env = reviewEnv("2026-11-08T09:00:00Z");
  const { token } = await env.service.scheduleReviewRequest(COMPANY_A, CONVERSATION, { reviewEnabled: true, delayMinutes: 30 });
  assert.deepEqual((await env.service.getReviewForm(COMPANY_A, token)).reason, "not_due");
  env.setNow("2026-11-08T09:31:00Z");
  const form = await env.service.getReviewForm(COMPANY_A, token);
  assert.equal(form.ok, true);
  assert.deepEqual(form.form.ratings, [1, 2, 3, 4, 5]);
});

test("reviews: an unknown or other-company token reads as not found", async () => {
  const env = reviewEnv();
  const { token } = await env.service.scheduleReviewRequest(COMPANY_A, CONVERSATION, { reviewEnabled: true, delayMinutes: 0 });
  assert.deepEqual(await env.service.getReviewForm(COMPANY_A, "not-a-token"), { ok: false, reason: "not_found" });
  assert.deepEqual(await env.service.getReviewForm(COMPANY_B, token), { ok: false, reason: "not_found" });
  const submitted = await env.service.submitReview(COMPANY_B, { token, rating: 5 });
  assert.deepEqual(submitted, { ok: false, reason: "not_found" });
});

test("reviews: a rating outside 1 to 5 is refused and nothing is stored", async () => {
  const env = reviewEnv();
  const { token } = await env.service.scheduleReviewRequest(COMPANY_A, CONVERSATION, { reviewEnabled: true, delayMinutes: 0 });
  for (const rating of [0, 6, 2.5, "5", undefined]) {
    const result = await env.service.submitReview(COMPANY_A, { token, rating });
    assert.deepEqual(result, { ok: false, reason: "rating_invalid" });
  }
  assert.equal(await env.storage.findReviewForConversation(COMPANY_A, CONVERSATION.id), null);
  assert.equal(env.storage.outboxFor(COMPANY_A).length, 0);
});

test("reviews: a valid review is stored with one outbox event and no token in the output", async () => {
  const env = reviewEnv();
  const { token } = await env.service.scheduleReviewRequest(COMPANY_A, CONVERSATION, { reviewEnabled: true, delayMinutes: 0 });
  const result = await env.service.submitReview(COMPANY_A, { token, rating: 5, comment: "  Quick and friendly  " });
  assert.equal(result.ok, true);
  assert.equal(result.rating, 5);
  assert.equal(JSON.stringify(result).includes(token), false);
  const stored = await env.storage.findReviewForConversation(COMPANY_A, CONVERSATION.id);
  assert.equal(stored.comment, "Quick and friendly");
  const events = env.storage.outboxFor(COMPANY_A);
  assert.equal(events.length, 1);
  assert.equal(events[0].topic, "review.submitted");
  assert.equal(JSON.stringify(events[0]).includes("Quick and friendly"), false);
});

test("reviews: a second review for the same conversation is refused and the first is kept", async () => {
  const env = reviewEnv();
  const { token } = await env.service.scheduleReviewRequest(COMPANY_A, CONVERSATION, { reviewEnabled: true, delayMinutes: 0 });
  const first = await env.service.submitReview(COMPANY_A, { token, rating: 4, comment: "ok" });
  assert.equal(first.ok, true);
  const second = await env.service.submitReview(COMPANY_A, { token, rating: 1, comment: "changed my mind" });
  assert.deepEqual(second, { ok: false, reason: "already_reviewed" });
  const kept = await env.storage.findReviewForConversation(COMPANY_A, CONVERSATION.id);
  assert.equal(kept.rating, 4);
  assert.equal(env.storage.outboxFor(COMPANY_A).length, 1);
  assert.deepEqual(await env.service.getReviewForm(COMPANY_A, token), { ok: false, reason: "already_reviewed" });
});

test("reviews: two simultaneous submissions produce one review", async () => {
  const env = reviewEnv();
  const { token } = await env.service.scheduleReviewRequest(COMPANY_A, CONVERSATION, { reviewEnabled: true, delayMinutes: 0 });
  const [a, b] = await Promise.all([
    env.service.submitReview(COMPANY_A, { token, rating: 5 }),
    env.service.submitReview(COMPANY_A, { token, rating: 3 }),
  ]);
  const outcomes = [a.ok, b.ok].sort();
  assert.deepEqual(outcomes, [false, true]);
  assert.equal(env.storage.outboxFor(COMPANY_A).length, 1);
});

test("reviews: a cancelled request cannot be reviewed", async () => {
  const env = reviewEnv();
  const scheduled = await env.service.scheduleReviewRequest(COMPANY_A, CONVERSATION, { reviewEnabled: true, delayMinutes: 0 });
  // Simulate the owner cancelling the request by replacing it in the memory store.
  const cancelled = { ...scheduled.request, status: "cancelled" };
  const storage = env.storage;
  const originalFind = storage.findRequestByTokenHash.bind(storage);
  storage.findRequestByTokenHash = async (companyId, hash) => (hash === cancelled.tokenHash ? cancelled : originalFind(companyId, hash));
  assert.deepEqual(await env.service.submitReview(COMPANY_A, { token: scheduled.token, rating: 5 }), { ok: false, reason: "cancelled" });
});

test("reviews: a bad delay is a programming error and throws", async () => {
  const env = reviewEnv();
  await assert.rejects(() => env.service.scheduleReviewRequest(COMPANY_A, CONVERSATION, { reviewEnabled: true, delayMinutes: -5 }), RangeError);
  await assert.rejects(() => env.service.scheduleReviewRequest(COMPANY_A, CONVERSATION, { reviewEnabled: true, delayMinutes: 1.5 }), RangeError);
});

// ---------------------------------------------------------------------------
// Reviews: Drizzle SQL
// ---------------------------------------------------------------------------

test("reviews: Drizzle request lookup filters on company_id", async () => {
  const { db, statements } = recordingDb();
  const storage = new DrizzleReviewStorage(db, async () => {});
  assert.equal(await storage.findRequestForConversation(COMPANY_A, "conv-1"), null);
  const sql = statements.at(-1);
  assert.match(sql.text, /"company_id"\s*=/);
  assert.equal(sql.params.includes(COMPANY_A), true);
  assert.equal(sql.params.includes(COMPANY_B), false);
});

test("reviews: Drizzle review insert is conflict-safe and writes no outbox event on conflict", async () => {
  const { db, statements } = recordingDb([]);
  let outboxWrites = 0;
  const transactional = { transaction: async (fn) => fn(db) };
  const storage = new DrizzleReviewStorage(transactional, async () => {
    outboxWrites += 1;
  });
  const written = await storage.insertReviewWithOutbox(
    COMPANY_A,
    { companyId: COMPANY_A, id: "r1", requestId: "q1", conversationId: "conv-1", chatbotId: "bot-1", rating: 5, comment: null, submittedAt: new Date() },
    { companyId: COMPANY_A, topic: "review.submitted", aggregateId: "r1", payload: {}, dedupeKey: "k", availableAt: new Date() },
  );
  assert.equal(written, false);
  assert.equal(outboxWrites, 0);
  assert.match(statements.find((item) => /insert into "chatbot_reviews"/.test(item.text)).text, /on conflict do nothing/);
});

test("reviews: Drizzle review table carries company_id on every table and the one-per-conversation index", async () => {
  const { chatbotReviews, chatbotReviewRequests } = await import("../../server/modules/chatbot/reviews/index.ts");
  const { getTableConfig } = await import("drizzle-orm/pg-core");
  for (const table of [chatbotReviews, chatbotReviewRequests]) {
    const config = getTableConfig(table);
    assert.equal(config.columns.some((column) => column.name === "company_id" && column.notNull), true, config.name);
  }
  const indexNames = getTableConfig(chatbotReviews).indexes.map((item) => item.config.name);
  assert.equal(indexNames.includes("chatbot_reviews_one_per_conversation_uidx"), true);
});

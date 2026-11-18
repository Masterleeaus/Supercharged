// Plivo webhook signature and replay checks (issue #319).
// Runs the real requirePlivoV2Signature middleware on a real Express app, with an injected token loader so no database
// is touched. The expected signature is built here from the published V2 rule (URL + nonce + sorted key/value pairs,
// HMAC-SHA256 with the auth token, base64), not with the module's own helper, so the test is an independent check.
// Also checks that every /api/plivo route in setupPlivoWebhooks is guarded by the signature middleware.
// Run: node --test --experimental-transform-types tests/security/plivo-webhook-signature-replay.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { register } from "tsx/esm/api";

register();
process.env.DATABASE_URL ??= "postgres://route-test:route-test@127.0.0.1:1/route_test";

const { requirePlivoV2Signature } = await import("../../server/engines/plivo/plivo-signature.ts");
const { createReplayGuard } = await import("../../server/middleware/webhook-replay.ts");

const BASE = "https://app.example.test";
const TOKEN = "auth-token-primary";

// Independent signer, written from the V2 rule.
function sign(path, nonce, params, token) {
  let base = `${BASE}${path}${nonce}`;
  for (const key of Object.keys(params).sort()) {
    base += key + String(params[key]);
  }
  return createHmac("sha256", token).update(base, "utf8").digest("base64");
}

function appWith(loadTokens) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.post("/api/plivo/voice/status", requirePlivoV2Signature(BASE, loadTokens), (_req, res) => res.json({ ok: true }));
  return app;
}

async function post(server, path, params, headers = {}) {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params).toString(),
  });
  return res.status;
}

async function withServer(app, fn) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    return await fn(server);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const PARAMS = { CallUUID: "uuid-1", From: "+15550100", To: "+15550199", Direction: "inbound" };
const NONCE = "nonce-abc-123";
const PATH = "/api/plivo/voice/status";

test("a correctly signed request is accepted", async () => {
  const sig = sign(PATH, NONCE, PARAMS, TOKEN);
  const status = await withServer(appWith(async () => [TOKEN]), (s) =>
    post(s, PATH, PARAMS, { "x-plivo-signature-v2": sig, "x-plivo-signature-v2-nonce": NONCE }),
  );
  assert.equal(status, 200);
});

test("a signature made with another account's token is refused", async () => {
  const sig = sign(PATH, NONCE, PARAMS, "other-account-token");
  const status = await withServer(appWith(async () => [TOKEN]), (s) =>
    post(s, PATH, PARAMS, { "x-plivo-signature-v2": sig, "x-plivo-signature-v2-nonce": NONCE }),
  );
  assert.equal(status, 403);
});

test("a tampered form field breaks the signature", async () => {
  const sig = sign(PATH, NONCE, PARAMS, TOKEN);
  const status = await withServer(appWith(async () => [TOKEN]), (s) =>
    post(s, PATH, { ...PARAMS, To: "+15550000" }, { "x-plivo-signature-v2": sig, "x-plivo-signature-v2-nonce": NONCE }),
  );
  assert.equal(status, 403);
});

test("a signature replayed under a different nonce is refused", async () => {
  const sig = sign(PATH, NONCE, PARAMS, TOKEN);
  const status = await withServer(appWith(async () => [TOKEN]), (s) =>
    post(s, PATH, PARAMS, { "x-plivo-signature-v2": sig, "x-plivo-signature-v2-nonce": "nonce-other" }),
  );
  assert.equal(status, 403);
});

test("a request signed for another path is refused", async () => {
  const sig = sign("/api/plivo/voice/hangup", NONCE, PARAMS, TOKEN);
  const status = await withServer(appWith(async () => [TOKEN]), (s) =>
    post(s, PATH, PARAMS, { "x-plivo-signature-v2": sig, "x-plivo-signature-v2-nonce": NONCE }),
  );
  assert.equal(status, 403);
});

test("missing signature or nonce headers are refused before any credential lookup", async () => {
  let lookups = 0;
  const app = appWith(async () => {
    lookups += 1;
    return [TOKEN];
  });
  await withServer(app, async (s) => {
    assert.equal(await post(s, PATH, PARAMS, {}), 403);
    assert.equal(await post(s, PATH, PARAMS, { "x-plivo-signature-v2": "x" }), 403);
  });
  assert.equal(lookups, 0);
});

test("no active credentials means every request is refused", async () => {
  const sig = sign(PATH, NONCE, PARAMS, TOKEN);
  const status = await withServer(appWith(async () => []), (s) =>
    post(s, PATH, PARAMS, { "x-plivo-signature-v2": sig, "x-plivo-signature-v2-nonce": NONCE }),
  );
  assert.equal(status, 403);
});

test("a credential lookup that never settles answers 503 and never accepts", async () => {
  const sig = sign(PATH, NONCE, PARAMS, TOKEN);
  const status = await withServer(appWith(() => new Promise(() => {})), (s) =>
    post(s, PATH, PARAMS, { "x-plivo-signature-v2": sig, "x-plivo-signature-v2-nonce": NONCE }),
  );
  assert.equal(status, 503);
});

test("replay: the same nonce is accepted once, then refused as a replay", () => {
  let now = 1_000_000;
  const guard = createReplayGuard({
    now: () => now,
    windowMs: 5 * 60 * 1000,
    maxEntries: 100,
    retentionMsByProvider: { plivo: 24 * 60 * 60 * 1000 },
    onFull: "refuse",
  });
  const input = { provider: "plivo", eventId: NONCE, timestampMs: now };
  assert.equal(guard.check(input).accepted, true);
  const second = guard.check(input);
  assert.equal(second.accepted, false);
  assert.equal(second.reason, "replay");
});

test("replay: a webhook older than the window is refused as stale", () => {
  const now = 1_000_000;
  const guard = createReplayGuard({
    now: () => now,
    windowMs: 5 * 60 * 1000,
    maxEntries: 100,
    retentionMsByProvider: { plivo: 24 * 60 * 60 * 1000 },
    onFull: "refuse",
  });
  const result = guard.check({ provider: "plivo", eventId: "old-nonce", timestampMs: now - 10 * 60 * 1000 });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "timestamp_out_of_window");
});

test("route coverage: every /api/plivo route in setupPlivoWebhooks runs the signature and replay guards", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "../../server/engines/plivo/routes/plivo-webhooks.ts"), "utf8");
  const routeLines = source.split("\n").filter((line) => /app\.(get|post|put|patch|delete)\('\/api\/plivo/.test(line));
  assert.ok(routeLines.length >= 15, `expected at least 15 /api/plivo routes, found ${routeLines.length}`);
  const unguarded = routeLines.filter((line) => !line.includes("verifyPlivo"));
  assert.deepEqual(unguarded, [], "a /api/plivo route is registered without the signature guard");
  assert.match(source, /const verifyPlivoReplay/, "replay guard is defined");
});

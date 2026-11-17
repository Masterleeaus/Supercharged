// Plivo voice webhook routing at runtime (issue #319).
// Loads the real setupPlivoWebhooks from server/engines/plivo/routes/plivo-webhooks.ts, so the registration order is
// the one the app uses. Each registered route is re-mounted on a real Express router with its signature and replay
// middleware swapped for a pass-through and its handler swapped for a marker, so this test checks which route Express
// picks for each path. Signature and replay checks are covered elsewhere (plivo-signature and webhook-replay tests).
// Run: node --test --experimental-transform-types tests/security/plivo-voice-routing-runtime.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { register } from "tsx/esm/api";

register();
// The route module opens a DB pool when imported. Nothing is queried here, so a placeholder URL is enough.
process.env.DATABASE_URL ??= "postgres://route-test:route-test@127.0.0.1:1/route_test";

const { setupPlivoWebhooks } = await import("../../server/engines/plivo/routes/plivo-webhooks.ts");

const METHODS = ["get", "post", "put", "patch", "delete"];

// Record every route the real setup function registers, in order, and mount it on a real Express router.
function mountRecordedRoutes(router) {
  const recorded = [];
  const proxy = new Proxy(
    {},
    {
      get(_target, prop) {
        if (METHODS.includes(prop)) {
          return (path, ...handlers) => {
            if (typeof path !== "string") return proxy;
            recorded.push({ method: prop.toUpperCase(), path });
            const label = `${prop.toUpperCase()} ${path}`;
            // Drop the middleware chain (signature and replay checks); keep only the route identity.
            router[prop](path, (req, res) => res.json({ matched: path, method: req.method, label }));
            return proxy;
          };
        }
        if (prop === "use") return (...args) => { router.use(...args); return proxy; };
        return undefined;
      },
    },
  );
  setupPlivoWebhooks(proxy, "https://routing.test.invalid");
  return recorded;
}

const router = express.Router();
const recorded = mountRecordedRoutes(router);
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(router);
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  // Pools and timers opened by the route module keep the event loop alive. The test is finished.
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

const LITERAL_POST = [
  "/api/plivo/voice/answer",
  "/api/plivo/voice/status",
  "/api/plivo/voice/recording",
  "/api/plivo/voice/transfer",
  "/api/plivo/voice/hangup",
  "/api/plivo/voice/post-stream",
];

async function hit(method, path) {
  const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/x-www-form-urlencoded" }, body: method === "POST" ? "CallUUID=test" : undefined });
  return { status: res.status, body: await res.json() };
}

test("every literal POST voice webhook is answered by its own route, not by the :callId route", async () => {
  for (const path of LITERAL_POST) {
    const { status, body } = await hit("POST", path);
    assert.equal(body.matched, path, `POST ${path} was answered by ${body.matched}`);
    assert.notEqual(body.matched, "/api/plivo/voice/:callId");
    assert.equal(status, 200);
  }
});

test("GET transfer is answered by its own route", async () => {
  const { body } = await hit("GET", "/api/plivo/voice/transfer");
  assert.equal(body.matched, "/api/plivo/voice/transfer");
});

test("a call id path is answered by the :callId route", async () => {
  const { body } = await hit("POST", "/api/plivo/voice/abc123");
  assert.equal(body.matched, "/api/plivo/voice/:callId");
});

test("the registration list has one GET and one POST for transfer, and :callId is registered last among voice POST routes", () => {
  const transferGets = recorded.filter((r) => r.method === "GET" && r.path === "/api/plivo/voice/transfer");
  assert.equal(transferGets.length, 1);
  const callIdIdx = recorded.findIndex((r) => r.method === "POST" && r.path === "/api/plivo/voice/:callId");
  assert.ok(callIdIdx >= 0);
  for (const path of LITERAL_POST) {
    const idx = recorded.findIndex((r) => r.method === "POST" && r.path === path);
    assert.ok(idx >= 0 && idx < callIdIdx, `${path} is not registered before :callId`);
  }
});

// Negative check on the real app wiring (no route swap): an unsigned POST to any literal voice webhook is refused
// by the signature check before its handler runs. No database is touched on this path.
test("unsigned POSTs to literal voice webhooks are refused with 403 by the real signature check", async () => {
  const realApp = express();
  realApp.use(express.urlencoded({ extended: false }));
  setupPlivoWebhooks(realApp, "https://routing.test.invalid");
  const realServer = realApp.listen(0, "127.0.0.1");
  await new Promise((resolve) => realServer.once("listening", resolve));
  try {
    const realBase = `http://127.0.0.1:${realServer.address().port}`;
    for (const path of LITERAL_POST) {
      const res = await fetch(`${realBase}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "CallUUID=test" });
      assert.equal(res.status, 403, `POST ${path} without a signature returned ${res.status}`);
      assert.equal(await res.text(), "Forbidden");
    }
  } finally {
    realServer.close();
  }
});

// Signed callback paths (issue #319). Uses the real requirePlivoV2Signature with an injected token list, so no DB is
// needed. The signature is computed here with node:crypto directly, following the V2 signing rule, so the test does not
// depend on the helper it checks. Signed requests must reach their own literal route; bad or missing signatures must not.
import { createHmac } from "node:crypto";
const { requirePlivoV2Signature } = await import("../../server/engines/plivo/plivo-signature.ts");

const SIGN_BASE = "https://routing.test.invalid";
const FAKE_TOKEN = "fake-plivo-auth-token-for-route-tests";

function v2Signature(path, nonce, form) {
  let base = `${SIGN_BASE}${path}${nonce}`;
  for (const key of Object.keys(form).sort()) base += key + form[key];
  return createHmac("sha256", FAKE_TOKEN).update(base, "utf8").digest("base64");
}

const signedRouter = express.Router();
const signedRecorded = [];
{
  const sigGate = requirePlivoV2Signature(SIGN_BASE, async () => [FAKE_TOKEN]);
  const proxy = new Proxy({}, {
    get(_t, prop) {
      if (METHODS.includes(prop)) {
        return (path, ...handlers) => {
          if (typeof path !== "string") return proxy;
          signedRecorded.push({ method: prop.toUpperCase(), path });
          signedRouter[prop](path, sigGate, (req, res) => res.json({ matched: path }));
          return proxy;
        };
      }
      if (prop === "use") return (...args) => { signedRouter.use(...args); return proxy; };
      return undefined;
    },
  });
  setupPlivoWebhooks(proxy, SIGN_BASE);
}

const signedApp = express();
signedApp.use(express.urlencoded({ extended: false }));
signedApp.use(signedRouter);
const signedServer = signedApp.listen(0, "127.0.0.1");
await new Promise((resolve) => signedServer.once("listening", resolve));
const signedBase = `http://127.0.0.1:${signedServer.address().port}`;
test.after(() => signedServer.close());

async function postSigned(path, form, { signature, nonce = "nonce-1" } = {}) {
  const body = new URLSearchParams(form).toString();
  const sig = signature ?? v2Signature(path, nonce, form);
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  if (signature !== null) {
    headers["x-plivo-signature-v2"] = sig;
    headers["x-plivo-signature-v2-nonce"] = nonce;
  }
  const res = await fetch(`${signedBase}${path}`, { method: "POST", headers, body });
  return { status: res.status, text: await res.text() };
}

test("correctly signed callbacks reach their own literal route", async () => {
  for (const path of ["/api/plivo/voice/status", "/api/plivo/voice/recording", "/api/plivo/voice/hangup", "/api/plivo/voice/post-stream", "/api/plivo/voice/transfer"]) {
    const res = await postSigned(path, { CallUUID: "uuid-1", CallStatus: "completed" });
    assert.equal(res.status, 200, `signed POST ${path} returned ${res.status}`);
    assert.equal(JSON.parse(res.text).matched, path);
  }
});

test("a signed call-id callback reaches the :callId route", async () => {
  const res = await postSigned("/api/plivo/voice/abc123", { CallUUID: "uuid-2" }, { nonce: "nonce-2" });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.text).matched, "/api/plivo/voice/:callId");
});

test("a signature made over a different path is refused on a literal callback", async () => {
  const sig = v2Signature("/api/plivo/voice/answer", "nonce-3", { CallUUID: "uuid-3" });
  const res = await postSigned("/api/plivo/voice/status", { CallUUID: "uuid-3" }, { signature: sig, nonce: "nonce-3" });
  assert.equal(res.status, 403);
});

test("a signature over different form values is refused", async () => {
  const sig = v2Signature("/api/plivo/voice/status", "nonce-4", { CallUUID: "uuid-4" });
  const res = await postSigned("/api/plivo/voice/status", { CallUUID: "tampered" }, { signature: sig, nonce: "nonce-4" });
  assert.equal(res.status, 403);
});

test("a callback with no signature headers never reaches its handler", async () => {
  const res = await postSigned("/api/plivo/voice/status", { CallUUID: "uuid-5" }, { signature: null });
  assert.equal(res.status, 403);
  assert.equal(res.text, "Forbidden");
});

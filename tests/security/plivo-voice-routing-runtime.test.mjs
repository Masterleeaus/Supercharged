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

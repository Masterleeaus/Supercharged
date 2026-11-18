// Plivo webhook route coverage for inbound, outbound, failover and negative cases (issue #319).
// Uses the real setupPlivoWebhooks from server/engines/plivo/routes/plivo-webhooks.ts. Route handlers are swapped
// for markers (the middleware chain is kept only where it is needed), so each test checks which registration Express
// would pick. The URLs under test are the ones plivo-phone.service.ts (configureWebhooks) and plivo-call.service.ts
// hand to Plivo, so the callback map here follows the live configuration.
// Run: node --test --experimental-transform-types tests/security/plivo-webhook-route-coverage.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import { register } from "tsx/esm/api";

register();
process.env.DATABASE_URL ??= "postgres://route-test:route-test@127.0.0.1:1/route_test";

const { setupPlivoWebhooks } = await import("../../server/engines/plivo/routes/plivo-webhooks.ts");

const METHODS = ["get", "post", "put", "patch", "delete"];
const BASE = "https://routing.test.invalid";

// Record each registration in order, as the real setup function registers it.
function recordRoutes() {
  const recorded = [];
  const proxy = new Proxy({}, {
    get(_t, prop) {
      if (METHODS.includes(prop)) {
        return (path, ...handlers) => {
          if (typeof path === "string") recorded.push({ method: prop.toUpperCase(), path, handlerCount: handlers.length });
          return proxy;
        };
      }
      if (prop === "use") return () => proxy;
      return undefined;
    },
  });
  setupPlivoWebhooks(proxy, BASE);
  return recorded;
}

// Express matching for these patterns: ":name" matches one path segment, everything else is literal.
function expressMatches(pattern, requestPath) {
  const re = new RegExp("^" + pattern.replace(/:[A-Za-z]+/g, "[^/]+") + "/?$");
  return re.test(requestPath);
}

// First registration Express would select for a request (method and path).
function firstMatch(recorded, method, requestPath) {
  return recorded.find((r) => r.method === method && expressMatches(r.path, requestPath)) ?? null;
}

// A concrete request path for a registration pattern.
function samplePath(pattern) {
  return pattern.replace(/:[A-Za-z]+/g, "abc123");
}

const recorded = recordRoutes();

// Real app with the real middleware chain, so unsigned requests are refused before any handler or DB access.
const realApp = express();
realApp.use(express.urlencoded({ extended: false }));
setupPlivoWebhooks(realApp, BASE);
const realServer = realApp.listen(0, "127.0.0.1");
await new Promise((resolve) => realServer.once("listening", resolve));
const realBase = `http://127.0.0.1:${realServer.address().port}`;

test.after(() => {
  realServer.close();
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

// Callback map from plivo-phone.service.ts configureWebhooks (inbound) and plivo-call.service.ts (outbound).
const INBOUND_ANSWER = "/api/plivo/incoming";
const INBOUND_FALLBACK = "/api/plivo/incoming"; // fallbackAnswerUrl is set to answerUrl in configureWebhooks
const INBOUND_HANGUP = "/api/plivo/voice/status";
const OUTBOUND_ANSWER = "/api/plivo/voice/:callId";
const OUTBOUND_STATUS = "/api/plivo/status/:callId";
const OUTBOUND_RECORDING = "/api/plivo/recording/:callId";

test("inbound: the answer URL and its failover URL both reach the incoming POST route", () => {
  for (const url of [INBOUND_ANSWER, INBOUND_FALLBACK]) {
    const hit = firstMatch(recorded, "POST", url);
    assert.ok(hit, `POST ${url} has no registration`);
    assert.equal(hit.path, "/api/plivo/incoming", `POST ${url} was matched by ${hit.path}`);
  }
});

test("inbound: the hangup URL reaches the status POST route, not the :callId route", () => {
  const hit = firstMatch(recorded, "POST", INBOUND_HANGUP);
  assert.equal(hit?.path, "/api/plivo/voice/status");
});

test("outbound: the answer, status and recording callbacks for a call id reach their own routes", () => {
  assert.equal(firstMatch(recorded, "POST", "/api/plivo/voice/call-42")?.path, OUTBOUND_ANSWER);
  assert.equal(firstMatch(recorded, "POST", "/api/plivo/status/call-42")?.path, OUTBOUND_STATUS);
  assert.equal(firstMatch(recorded, "POST", "/api/plivo/recording/call-42")?.path, OUTBOUND_RECORDING);
});

test("every registered Plivo webhook path is matched by its own registration on a concrete request", () => {
  for (const r of recorded) {
    const sample = samplePath(r.path);
    const hit = firstMatch(recorded, r.method, sample);
    assert.ok(hit, `${r.method} ${sample} matched nothing`);
    // The first matching registration must be this one or an earlier identical pattern with the same method.
    assert.equal(hit.path, r.path, `${r.method} ${sample} was matched by ${hit.path}, not ${r.path}`);
  }
});

test("the :callId voice route is registered after every literal voice POST route", () => {
  const callIdIdx = recorded.findIndex((r) => r.method === "POST" && r.path === OUTBOUND_ANSWER);
  assert.ok(callIdIdx >= 0);
  const literal = recorded.filter((r) => r.method === "POST" && r.path.startsWith("/api/plivo/voice/") && !r.path.includes(":"));
  assert.ok(literal.length >= 5, "expected the literal voice POST routes to be registered");
  for (const r of literal) {
    assert.ok(recorded.indexOf(r) < callIdIdx, `${r.path} is registered after :callId`);
  }
});

test("negative: an unsigned POST to every registered POST webhook is refused with 403 before its handler runs", async () => {
  const posts = recorded.filter((r) => r.method === "POST");
  assert.ok(posts.length > 0);
  for (const r of posts) {
    const res = await fetch(`${realBase}${samplePath(r.path)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "CallUUID=test",
    });
    assert.equal(res.status, 403, `unsigned POST ${r.path} returned ${res.status}`);
    assert.equal(await res.text(), "Forbidden");
  }
});

test("negative: an unsigned GET to the guarded transfer route is refused with 403", async () => {
  const res = await fetch(`${realBase}/api/plivo/voice/transfer?CallUUID=test`);
  assert.equal(res.status, 403);
});

test("negative: a method the webhook does not register is not answered by a webhook handler", async () => {
  const res = await fetch(`${realBase}/api/plivo/voice/status`, { method: "PUT" });
  assert.equal(res.status, 404, `PUT /api/plivo/voice/status returned ${res.status}`);
  assert.equal(firstMatch(recorded, "PUT", "/api/plivo/voice/status"), null);
});

test("the duplicate GET transfer handler is gone from the source; the guarded GET stays", () => {
  const src = fs.readFileSync(new URL("../../server/engines/plivo/routes/plivo-webhooks.ts", import.meta.url), "utf8");
  const gets = [...src.matchAll(/app\.get\(\s*'\/api\/plivo\/voice\/transfer'/g)];
  assert.equal(gets.length, 1);
});

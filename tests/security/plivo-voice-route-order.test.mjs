// Plivo voice route order (issue #319).
// Express answers a request with the first registered route whose method and path match.
// The generic /api/plivo/voice/:callId route must come after every literal /api/plivo/voice/* route,
// so that Plivo's status, recording, transfer, hangup and post-stream callbacks reach their handlers.
// Static source test: reads plivo-webhooks.ts and simulates Express matching. No server or database.
// Run: node --test --experimental-transform-types tests/security/plivo-voice-route-order.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const SRC = new URL("../../server/engines/plivo/routes/plivo-webhooks.ts", import.meta.url);
const src = fs.readFileSync(SRC, "utf8").replace(/\r\n/g, "\n");

// Registrations in source order: method, path, and the handler text that follows the guard.
function registrations(text) {
  const re = /app\.(get|post)\(\s*'(\/api\/plivo\/voice\/[^']*)'\s*,\s*([^\n]*)/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push({ method: m[1].toUpperCase(), path: m[2], rest: m[3] });
  return out;
}

// Express path matching for these patterns: ':name' matches one segment, everything else is literal.
function expressMatches(pattern, requestPath) {
  const re = new RegExp("^" + pattern.replace(/:[A-Za-z]+/g, "[^/]+") + "/?$");
  return re.test(requestPath);
}

// The route that answers a request is the first registration that matches it, as in Express.
function firstMatch(regs, method, requestPath) {
  return regs.find((r) => r.method === method && expressMatches(r.path, requestPath)) ?? null;
}

const regs = registrations(src);
const callIdIndex = regs.findIndex((r) => r.path === "/api/plivo/voice/:callId");
const literalPostPaths = regs
  .filter((r) => r.method === "POST" && !r.path.includes(":"))
  .map((r) => r.path);

test(":callId route is registered once and after every literal POST voice route", () => {
  assert.ok(callIdIndex >= 0, "missing /api/plivo/voice/:callId registration");
  assert.equal(regs.filter((r) => r.path === "/api/plivo/voice/:callId").length, 1);
  for (const path of literalPostPaths) {
    const idx = regs.findIndex((r) => r.method === "POST" && r.path === path);
    assert.ok(idx < callIdIndex, `${path} is registered after /api/plivo/voice/:callId`);
  }
});

test("each literal Plivo voice webhook path reaches its own handler, not the :callId handler", () => {
  for (const path of ["/api/plivo/voice/status", "/api/plivo/voice/recording", "/api/plivo/voice/hangup", "/api/plivo/voice/post-stream", "/api/plivo/voice/transfer"]) {
    const hit = firstMatch(regs, "POST", path);
    assert.ok(hit, `no route matches POST ${path}`);
    assert.equal(hit.path, path, `POST ${path} is answered by ${hit.path}`);
  }
});

test("a call id path still reaches the :callId handler", () => {
  const hit = firstMatch(regs, "POST", "/api/plivo/voice/abc123");
  assert.equal(hit?.path, "/api/plivo/voice/:callId");
});

test("the shadowed duplicate GET transfer handler is removed; the guarded GET stays", () => {
  const gets = regs.filter((r) => r.method === "GET" && r.path === "/api/plivo/voice/transfer");
  assert.equal(gets.length, 1);
  assert.match(gets[0].rest, /^verifyPlivo,\s*handleTransferWebhook/);
});

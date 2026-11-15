/**
 * Builder mode gate (issue #48). The builder mount runs the Desk mode guard first, so the Synced (comms) host reaches
 * it and the workforce host and unknown hosts get 404 before authentication runs.
 *
 * Run: node --test --experimental-transform-types tests/modules/chatbot-builder-mode.test.mjs
 * (needs express; see tests/modules/chatbot-builder-routes.test.mjs for the local dependency note)
 */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";

const { mountChatbotModule } = await import("../../server/modules/chatbot/wiring/mount.ts");
const { deskModeMiddleware, requireModule, buildModeConfig } = await import("../../server/modules/desk-modes/index.ts");

const config = buildModeConfig({ workforceHosts: "superchargedat.work", commsHosts: "syncedat.work" });
const CO = "11111111-1111-4111-8111-111111111111";
const ENV = { CHATBOT_BUILDER_ENABLED: "true" };

// A fake Desk db. The avatars handler reaches storage and fails on it, which is fine: these tests only check
// whether the guard let the request through (a guard refusal is a 404 with error "not_found").
const fakeDb = new Proxy({}, { get: () => () => { throw new Error("no db in unit test"); } });

function appWith(guard) {
  const app = express();
  const deps = {
    db: fakeDb,
    env: ENV,
    authenticate: (req, _res, next) => { req.user = { id: "u1", role: "admin", companyId: CO }; next(); },
    requireCompanyScope: (_req, res, next) => { res.locals.companyId = CO; next(); },
    requireRole: () => (_req, _res, next) => next(),
    ...(guard === undefined ? {} : { builderModeGuard: guard }),
  };
  mountChatbotModule(app, deps);
  return app;
}

function get(app, host, path = "/api/chatbot/builder/avatars") {
  // node:http, not fetch: fetch does not let the test set the Host header.
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const req = http.request({ host: "127.0.0.1", port: server.address().port, path, headers: { host } }, (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          server.close();
          let body = null;
          try { body = JSON.parse(raw); } catch { body = null; }
          resolve({ status: res.statusCode, body });
        });
      });
      req.on("error", (err) => { server.close(); reject(err); });
      req.end();
    });
  });
}

const guard = [deskModeMiddleware(config), requireModule("chatbot")];

test("comms host reaches the builder (not refused by the mode guard)", async () => {
  const r = await get(appWith(guard), "syncedat.work");
  assert.notDeepEqual(r.body, { error: "not_found" });
  assert.notEqual(r.status, 404);
});

test("workforce host is refused by the mode guard before authentication", async () => {
  const r = await get(appWith(guard), "superchargedat.work");
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { error: "not_found" });
});

test("unknown host is refused by the mode guard", async () => {
  const r = await get(appWith(guard), "evil.example.com");
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { error: "not_found" });
});

test("builder mount with no mode guard supplied fails closed on every host", async () => {
  const r = await get(appWith(undefined), "syncedat.work");
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { error: "not_found" });
});

test("the builder guard does not touch other /api/chatbot paths", async () => {
  // A workforce-host request to a non-builder path must fall through, not get the builder guard's refusal.
  const r = await get(appWith(guard), "superchargedat.work", "/api/chatbot/other-surface");
  assert.notDeepEqual(r.body, { error: "not_found" });
});

test("builder path on the comms host is served by the builder router (real path, not /builder/builder)", async () => {
  const r = await get(appWith(guard), "syncedat.work", "/api/chatbot/builder/builder/avatars");
  assert.equal(r.status, 404, "the doubled path must not exist");
});

/**
 * Mount test for the chatbot module (server/modules/chatbot). Builds a real express app, mounts the module
 * with a stub authenticate and the real requireCompanyScope, and makes real HTTP requests on an ephemeral port.
 * Storage is the module's in-memory option (createMemoryChatbotStorage), so no database is touched.
 * Run: node --test --experimental-transform-types tests/modules/chatbot-mount.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import express from "express";

// The chatbot router imports requireRole from server/middleware/auth.ts. That file cannot load under
// node --experimental-transform-types: it uses an extensionless import and value-imports express types
// (Request, Response, NextFunction), which Node's ESM loader rejects. The hook below resolves extensionless
// relative imports to .ts, and swaps auth.ts for a stand-in whose requireRole mirrors the real one.
// The identity itself comes from this file's stub authenticate, not from auth.ts.
const AUTH_STUB = `
export function requireRole(...roles) {
  return (req, res, next) => {
    if (req.userRole === 'admin' || roles.includes(req.userRole)) return next();
    return res.status(403).json({ error: 'Insufficient permissions' });
  };
}
export function authenticateToken(req, res, next) { return res.status(401).json({ error: 'Authentication required' }); }
`;
const RESOLVE_HOOK = `
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const AUTH_STUB = ${JSON.stringify(AUTH_STUB)};
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && /\\/middleware\\/auth(\\.ts)?$/.test(specifier)) {
    return { url: 'data:text/javascript,' + encodeURIComponent(AUTH_STUB), format: 'module', shortCircuit: true };
  }
  if (specifier.startsWith('.') && !/\\.[cm]?[jt]s$/.test(specifier)) {
    for (const candidate of [specifier + '.ts', specifier + '/index.ts']) {
      const url = new URL(candidate, context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
  }
  return next(specifier, context);
}
`;
register("data:text/javascript," + encodeURIComponent(RESOLVE_HOOK), import.meta.url);

const { registerChatbotModule } = await import("../../server/modules/chatbot/index.ts");
const { createMemoryChatbotStorage } = await import("../../server/modules/chatbot/chatbot-storage.ts");
const { requireCompanyScope } = await import("../../server/middleware/company-scope.ts");

const CO_A = "11111111-1111-4111-8111-111111111111";
const CO_B = "22222222-2222-4222-8222-222222222222";
const USER_A = { userId: "u-a", role: "admin", companyId: CO_A };
const USER_NO_COMPANY = { userId: "u-x", role: "admin" };

// Stub authenticate: the identity arrives in the x-test-user header. No header means refused, as authenticateToken does.
const stubAuthenticate = (req, res, next) => {
  const raw = req.headers["x-test-user"];
  if (!raw) return res.status(401).json({ error: "Authentication required" });
  const u = JSON.parse(raw);
  req.userId = u.userId;
  req.userRole = u.role;
  req.user = { id: u.userId, role: u.role, companyId: u.companyId };
  next();
};

async function start() {
  const storage = createMemoryChatbotStorage();
  const app = express();
  app.use(express.json());
  const mounted = registerChatbotModule(app, {
    storage,
    authenticate: stubAuthenticate,
    requireCompanyScope: requireCompanyScope(),
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    service: mounted.service,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
    call: (method, path, user, body) =>
      fetch(base + path, {
        method,
        headers: { "content-type": "application/json", ...(user ? { "x-test-user": JSON.stringify(user) } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) })),
  };
}

test("mount: a user with no company gets 403 on every chatbot route family", async () => {
  const h = await start();
  try {
    const list = await h.call("GET", "/api/chatbot/chatbots", USER_NO_COMPANY);
    assert.equal(list.status, 403);
    assert.equal(list.body.error, "Company scope required");

    const create = await h.call("POST", "/api/chatbot/chatbots", USER_NO_COMPANY, { title: "Front desk" });
    assert.equal(create.status, 403);

    const unread = await h.call("GET", "/api/chatbot/unread-counts", USER_NO_COMPANY);
    assert.equal(unread.status, 403);
  } finally {
    await h.close();
  }
});

test("mount: an unauthenticated request is refused with 401 and does not reach the router", async () => {
  const h = await start();
  try {
    const list = await h.call("GET", "/api/chatbot/chatbots", undefined);
    assert.equal(list.status, 401);

    const create = await h.call("POST", "/api/chatbot/chatbots", undefined, { title: "Sneaky" });
    assert.equal(create.status, 401);

    // Nothing was written for any company.
    assert.deepEqual(await h.service.listChatbots(CO_A), []);
    assert.deepEqual(await h.service.listChatbots(CO_B), []);
  } finally {
    await h.close();
  }
});

test("mount: a companyId in the request body is rejected or ignored and never moves the row to another tenant", async () => {
  const h = await start();
  try {
    const attempt = await h.call("POST", "/api/chatbot/chatbots", USER_A, { title: "Spoof", companyId: CO_B });
    // The body schema is strict, so a companyId key is a 400. Either way, nothing may be written to CO_B.
    assert.ok(attempt.status === 400 || attempt.status === 201, `unexpected status ${attempt.status}`);
    if (attempt.status === 201) assert.equal(attempt.body.companyId, CO_A);
    assert.deepEqual(await h.service.listChatbots(CO_B), []);
  } finally {
    await h.close();
  }
});

test("mount: a companyId in the query string does not change which tenant is listed", async () => {
  const h = await start();
  try {
    await h.service.createChatbot(CO_A, { title: "A bot" });
    await h.service.createChatbot(CO_B, { title: "B bot" });

    const res = await h.call("GET", `/api/chatbot/chatbots?companyId=${CO_B}`, USER_A);
    assert.equal(res.status, 200, "scoped user A must be served (positive control)");
    assert.ok(Array.isArray(res.body), "response must be a list");
    assert.ok(res.body.length > 0, "user A must see at least one of its own chatbots");
    for (const bot of res.body) {
      assert.equal(bot.companyId, CO_A, "every row returned must belong to company A");
    }
  } finally {
    await h.close();
  }
});

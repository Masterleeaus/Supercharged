/**
 * Tests for the content admin HTTP layer (server/modules/chatbot/content-admin): canned responses, knowledge-base
 * articles, contacts and analytics. Builds a real express app, mounts the router on an ephemeral port and makes
 * real HTTP requests against the in-memory storage. No network leaves the process.
 *
 * Run:
 *   NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" \
 *     node --test --experimental-transform-types tests/modules/chatbot-content-admin.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

const { createContentAdminRouter, CONTENT_ADMIN_ROUTES_FLAG } = await import(
  "../../server/modules/chatbot/content-admin/router.ts"
);
const { createMemoryContentAdminStorage } = await import("../../server/modules/chatbot/content-admin/memory-storage.ts");

const CO_A = "11111111-1111-4111-8111-111111111111";
const CO_B = "22222222-2222-4222-8222-222222222222";
const BOT_A = "bot-a-1";
const BOT_B = "bot-b-1";
const ENABLED = { [CONTENT_ADMIN_ROUTES_FLAG]: "true" };
const BASE = "/api/chatbot/content";
const FIXED_NOW = new Date("2026-11-08T09:00:00.000Z");

const ADMIN_A = { role: "admin", companyId: CO_A, userId: "user-a" };
const AGENT_A = { role: "agent", companyId: CO_A, userId: "user-a2" };
const ADMIN_B = { role: "admin", companyId: CO_B, userId: "user-b" };

// Identity arrives in x-test-user. No header means 401, as authenticateToken answers.
const authenticate = (req, res, next) => {
  const raw = req.headers["x-test-user"];
  if (!raw) return res.status(401).json({ error: "Authentication required" });
  const user = JSON.parse(raw);
  res.locals.companyId = user.companyId;
  res.locals.userId = user.userId;
  req.authRole = user.role;
  return next();
};
const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.authRole) ? next() : res.status(403).json({ error: "Forbidden" });

function makeStorage() {
  const inner = createMemoryContentAdminStorage({ chatbots: { [CO_A]: [BOT_A], [CO_B]: [BOT_B] } });
  const calls = [];
  const spy = new Proxy(inner, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== "function") return value;
      return async (...args) => {
        calls.push({ name: String(prop), companyId: args[0] });
        return value.apply(target, args);
      };
    },
  });
  return { storage: spy, calls };
}

async function start(options = {}) {
  const app = express();
  const { storage, calls } = makeStorage();
  const analyticsCalls = [];
  const analytics = options.analytics ?? {
    async run(companyId, query) {
      analyticsCalls.push({ companyId, query });
      return [{ bucket: null, values: { conversations: 3 } }];
    },
  };
  app.use(
    "/api/chatbot",
    createContentAdminRouter({
      storage,
      contacts: options.contacts,
      analytics: options.noAnalytics ? undefined : analytics,
      authenticate,
      requireRole,
      now: () => FIXED_NOW,
      env: options.env ?? ENABLED,
    }),
  );
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, user, body) => {
    const headers = {};
    if (user) headers["x-test-user"] = JSON.stringify(user);
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  };
  return { call, calls, analyticsCalls, close: () => new Promise((r) => server.close(r)) };
}

/* ---------- flag ---------- */

test("every route answers 404 when the flag is off", async () => {
  const h = await start({ env: {} });
  try {
    assert.equal((await h.call("GET", `${BASE}/canned-responses`, ADMIN_A)).status, 404);
    assert.equal((await h.call("GET", `${BASE}/knowledge-base-articles`, ADMIN_A)).status, 404);
  } finally {
    await h.close();
  }
});

test("the flag is on only for the exact string true", async () => {
  for (const value of ["1", "yes", "on", "TRUE"]) {
    const h = await start({ env: { [CONTENT_ADMIN_ROUTES_FLAG]: value } });
    try {
      assert.equal((await h.call("GET", `${BASE}/canned-responses`, ADMIN_A)).status, 404, value);
    } finally {
      await h.close();
    }
  }
});

/* ---------- auth and roles ---------- */

test("unauthenticated requests answer 401 and agents cannot write articles", async () => {
  const h = await start();
  try {
    assert.equal((await h.call("GET", `${BASE}/canned-responses`, null)).status, 401);
    const denied = await h.call("POST", `${BASE}/knowledge-base-articles`, AGENT_A, {
      title: "Hours",
      description: "Opening hours",
    });
    assert.equal(denied.status, 403);
  } finally {
    await h.close();
  }
});

/* ---------- canned responses: scope ---------- */

test("canned responses from another company are never returned, changed or deleted", async () => {
  const h = await start();
  try {
    const created = await h.call("POST", `${BASE}/canned-responses`, ADMIN_A, {
      title: "Greeting",
      content: "Hello from A",
    });
    assert.equal(created.status, 201);
    const id = created.body.id;
    assert.equal(created.body.companyId, CO_A);
    assert.equal(created.body.userId, "user-a");

    const listB = await h.call("GET", `${BASE}/canned-responses`, ADMIN_B);
    assert.deepEqual(listB.body, []);

    assert.equal((await h.call("GET", `${BASE}/canned-responses/${id}`, ADMIN_B)).status, 404);
    assert.equal((await h.call("PATCH", `${BASE}/canned-responses/${id}`, ADMIN_B, { title: "x" })).status, 404);
    assert.equal((await h.call("DELETE", `${BASE}/canned-responses/${id}`, ADMIN_B)).status, 404);

    // Company A's row is untouched by company B's attempts.
    const still = await h.call("GET", `${BASE}/canned-responses/${id}`, ADMIN_A);
    assert.equal(still.status, 200);
    assert.equal(still.body.title, "Greeting");
    assert.equal(still.body.content, "Hello from A");
  } finally {
    await h.close();
  }
});

test("canned response update and delete work inside the owning company", async () => {
  const h = await start();
  try {
    const { body } = await h.call("POST", `${BASE}/canned-responses`, AGENT_A, { title: "Old", content: "Text" });
    const patched = await h.call("PATCH", `${BASE}/canned-responses/${body.id}`, AGENT_A, { title: "New" });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.title, "New");
    assert.equal(patched.body.content, "Text");
    const removed = await h.call("DELETE", `${BASE}/canned-responses/${body.id}`, AGENT_A);
    assert.equal(removed.status, 204);
    assert.equal((await h.call("GET", `${BASE}/canned-responses/${body.id}`, AGENT_A)).status, 404);
  } finally {
    await h.close();
  }
});

/* ---------- articles: scope and links ---------- */

test("articles from another company are never returned, changed or deleted", async () => {
  const h = await start();
  try {
    const created = await h.call("POST", `${BASE}/knowledge-base-articles`, ADMIN_A, {
      title: "Refunds",
      description: "How refunds work",
      content: "Refunds take 5 days.",
      chatbotIds: [BOT_A],
    });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.chatbotIds, [BOT_A]);
    const id = created.body.id;

    assert.deepEqual((await h.call("GET", `${BASE}/knowledge-base-articles`, ADMIN_B)).body, []);
    assert.equal((await h.call("GET", `${BASE}/knowledge-base-articles/${id}`, ADMIN_B)).status, 404);
    assert.equal(
      (await h.call("PATCH", `${BASE}/knowledge-base-articles/${id}`, ADMIN_B, { title: "x" })).status,
      404,
    );
    assert.equal((await h.call("DELETE", `${BASE}/knowledge-base-articles/${id}`, ADMIN_B)).status, 404);
    assert.equal((await h.call("GET", `${BASE}/knowledge-base-articles/${id}`, ADMIN_A)).body.title, "Refunds");
  } finally {
    await h.close();
  }
});

test("an article cannot link to a chatbot of another company", async () => {
  const h = await start();
  try {
    const refused = await h.call("POST", `${BASE}/knowledge-base-articles`, ADMIN_A, {
      title: "Shipping",
      description: "Shipping info",
      chatbotIds: [BOT_B],
    });
    assert.equal(refused.status, 400);
    assert.deepEqual(await h.call("GET", `${BASE}/knowledge-base-articles`, ADMIN_A).then((r) => r.body), []);

    const { body } = await h.call("POST", `${BASE}/knowledge-base-articles`, ADMIN_A, {
      title: "Shipping",
      description: "Shipping info",
    });
    const patched = await h.call("PATCH", `${BASE}/knowledge-base-articles/${body.id}`, ADMIN_A, {
      chatbotIds: [BOT_A, BOT_B],
    });
    assert.equal(patched.status, 400);
    assert.deepEqual((await h.call("GET", `${BASE}/knowledge-base-articles/${body.id}`, ADMIN_A)).body.chatbotIds, []);
  } finally {
    await h.close();
  }
});

test("article update replaces links and delete is company-scoped", async () => {
  const h = await start();
  try {
    const { body } = await h.call("POST", `${BASE}/knowledge-base-articles`, ADMIN_A, {
      title: "Booking",
      description: "How to book",
      chatbotIds: [BOT_A],
      isFeatured: true,
    });
    assert.equal(body.isFeatured, true);
    const patched = await h.call("PATCH", `${BASE}/knowledge-base-articles/${body.id}`, ADMIN_A, { chatbotIds: [] });
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.body.chatbotIds, []);
    assert.equal(patched.body.isFeatured, true);
    assert.equal((await h.call("DELETE", `${BASE}/knowledge-base-articles/${body.id}`, ADMIN_A)).status, 204);
  } finally {
    await h.close();
  }
});

/* ---------- invalid input ---------- */

test("invalid canned and article input is refused with 400", async () => {
  const h = await start();
  try {
    const cases = [
      [`${BASE}/canned-responses`, { title: "", content: "x" }],
      [`${BASE}/canned-responses`, { title: "t".repeat(256), content: "x" }],
      [`${BASE}/canned-responses`, { title: "t", content: "x", companyId: CO_B }],
      [`${BASE}/canned-responses`, { title: "t", content: "x", userId: "someone-else" }],
      [`${BASE}/canned-responses`, { title: "t" }],
      [`${BASE}/knowledge-base-articles`, { title: "t", description: "" }],
      [`${BASE}/knowledge-base-articles`, { title: "t", description: "d", isFeatured: "yes" }],
      [`${BASE}/knowledge-base-articles`, { title: "t", description: "d", chatbotIds: ["bad id!"] }],
      [`${BASE}/knowledge-base-articles`, { title: "t", description: "d", companyId: CO_A }],
    ];
    for (const [path, body] of cases) {
      const res = await h.call("POST", path, ADMIN_A, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    // Malformed JSON and empty PATCH bodies are refused too.
    assert.equal((await h.call("POST", `${BASE}/canned-responses`, ADMIN_A, "{not json")).status, 400);
    const { body } = await h.call("POST", `${BASE}/canned-responses`, ADMIN_A, { title: "t", content: "x" });
    assert.equal((await h.call("PATCH", `${BASE}/canned-responses/${body.id}`, ADMIN_A, {})).status, 400);
    assert.equal((await h.call("GET", `${BASE}/canned-responses/${encodeURIComponent("a/b")}`, ADMIN_A)).status, 400);
  } finally {
    await h.close();
  }
});

/* ---------- contacts ---------- */

test("contacts answer 501 when no reader is injected, and are company-scoped when it is", async () => {
  const none = await start();
  try {
    assert.equal((await none.call("GET", `${BASE}/contacts`, ADMIN_A)).status, 501);
  } finally {
    await none.close();
  }

  const contactRows = { [CO_A]: [{ id: "c1", companyId: CO_A, name: "Ana" }], [CO_B]: [] };
  const contacts = {
    async listContacts(companyId) {
      return contactRows[companyId] ?? [];
    },
    async findContact(companyId, id) {
      return (contactRows[companyId] ?? []).find((c) => c.id === id) ?? null;
    },
  };
  const h = await start({ contacts });
  try {
    assert.equal((await h.call("GET", `${BASE}/contacts`, ADMIN_A)).body.length, 1);
    assert.deepEqual((await h.call("GET", `${BASE}/contacts`, ADMIN_B)).body, []);
    assert.equal((await h.call("GET", `${BASE}/contacts/c1`, ADMIN_B)).status, 404);
    assert.equal((await h.call("GET", `${BASE}/contacts/c1`, ADMIN_A)).body.name, "Ana");
  } finally {
    await h.close();
  }
});

/* ---------- analytics ---------- */

test("analytics answers 501 without the port and passes the caller's company when it is mounted", async () => {
  const none = await start({ noAnalytics: true });
  try {
    assert.equal((await none.call("GET", `${BASE}/analytics?from=2026-11-01&to=2026-11-07`, ADMIN_A)).status, 501);
  } finally {
    await none.close();
  }

  const h = await start();
  try {
    const res = await h.call("GET", `${BASE}/analytics?from=2026-11-01&to=2026-11-07&groupBy=day&metrics=conversations`, ADMIN_A);
    assert.equal(res.status, 200);
    assert.equal(res.body.rows[0].values.conversations, 3);
    assert.equal(h.analyticsCalls[0].companyId, CO_A);
    assert.deepEqual(h.analyticsCalls[0].query.metrics, ["conversations"]);
    assert.equal(h.analyticsCalls[0].query.groupBy, "day");
    assert.equal(h.analyticsCalls[0].query.to.toISOString(), "2026-11-07T23:59:59.999Z");
  } finally {
    await h.close();
  }
});

test("analytics refuses bad ranges, unknown metrics and agents", async () => {
  const h = await start();
  try {
    assert.equal((await h.call("GET", `${BASE}/analytics?from=2026-11-07&to=2026-11-01`, ADMIN_A)).status, 400);
    assert.equal((await h.call("GET", `${BASE}/analytics?from=2025-01-01&to=2026-11-07`, ADMIN_A)).status, 400);
    assert.equal((await h.call("GET", `${BASE}/analytics?from=2026-11-01&to=2026-11-07&metrics=secrets`, ADMIN_A)).status, 400);
    assert.equal((await h.call("GET", `${BASE}/analytics?from=2026-11-01&to=2026-11-07&companyId=x`, ADMIN_A)).status, 400);
    assert.equal((await h.call("GET", `${BASE}/analytics?from=2026-11-01&to=2026-11-07`, AGENT_A)).status, 403);
    assert.equal(h.analyticsCalls.length, 0);
  } finally {
    await h.close();
  }
});

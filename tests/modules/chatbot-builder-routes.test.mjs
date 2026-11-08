/**
 * Tests for the chatbot builder HTTP layer (server/modules/chatbot/builder-routes). Builds a real express app,
 * mounts the router on an ephemeral port and makes real HTTP requests. Storage is the in-memory implementation,
 * wrapped in a spy that records each call and its company id, so cross-company checks exercise real scoping.
 *
 * Run (express and zod are not installed in this repo; see DECISIONS.md for the preload hook):
 *   NODE_OPTIONS="--import /home/claude/builder-test-deps/register.mjs" \
 *     node --test --experimental-transform-types tests/modules/chatbot-builder-routes.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

const { createBuilderRouter, BUILDER_ROUTES, BUILDER_ROUTES_FLAG } = await import(
  "../../server/modules/chatbot/builder-routes/builder-router.ts"
);
const { createMemoryBuilderStorage } = await import("../../server/modules/chatbot/builder-routes/builder-storage.ts");
const { saveIssues } = await import("../../server/modules/chatbot/builder-routes/builder-schemas.ts");

const CO_A = "11111111-1111-4111-8111-111111111111";
const CO_B = "22222222-2222-4222-8222-222222222222";
const ADMIN_A = { role: "admin", companyId: CO_A };
const AGENT_A = { role: "agent", companyId: CO_A };
const ADMIN_B = { role: "admin", companyId: CO_B };
const ENABLED = { [BUILDER_ROUTES_FLAG]: "true" };
const BASE = "/api/chatbot";
const FIXED_NOW = new Date("2026-11-08T09:00:00.000Z");
const PRESET_AVATAR = "/uploads/avatars/presets/bot-1.png";

/* ---------- spy around the in-memory storage: records each call with its company id ---------- */

function createSpyStorage() {
  const inner = createMemoryBuilderStorage();
  const calls = [];
  const wrap = (name) => async (...args) => {
    calls.push({ name, companyId: args[0] });
    return inner[name](...args);
  };
  return {
    inner,
    calls,
    findBuilderState: wrap("findBuilderState"),
    updateBuilderState: wrap("updateBuilderState"),
    listChatbotAvatars: wrap("listChatbotAvatars"),
  };
}

/* ---------- stubs for the injected auth and role functions ---------- */

// Identity arrives in x-test-user. No header means 401, as authenticateToken answers.
const authenticate = (req, res, next) => {
  const raw = req.headers["x-test-user"];
  if (!raw) return res.status(401).json({ error: "Authentication required" });
  const user = JSON.parse(raw);
  req.authRole = user.role;
  req.authCompanyId = user.companyId;
  return next();
};

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.authRole) ? next() : res.status(403).json({ error: "Insufficient permissions" });

const getCompanyId = (req) => req.authCompanyId;

async function withServer({ env = ENABLED, storage = createSpyStorage(), withRoles = true, demoMode = false } = {}, fn) {
  const app = express();
  const deps = { storage, authenticate, getCompanyId, env, now: () => FIXED_NOW, demoMode };
  if (withRoles) deps.requireRole = requireRole;
  app.use(BASE, createBuilderRouter(deps));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();

  const request = async (method, path, { user, body, raw } = {}) => {
    const headers = {};
    if (user) headers["x-test-user"] = JSON.stringify(user);
    let payload;
    if (raw !== undefined) {
      headers["content-type"] = "application/json";
      payload = raw;
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(`http://127.0.0.1:${port}${BASE}${path}`, { method, headers, body: payload });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  };

  try {
    return await fn({ request, storage });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * Seeds a chatbot for company A and returns its id and the stored state. The default settings carry a bubble
 * message, because a save needs one (see saveIssues). Tests that need it missing pass {} explicitly.
 */
function seedA(storage, input = {}, settings = { bubbleMessage: "Hello" }) {
  return storage.inner.seedChatbot(CO_A, { title: "Original", welcomeMessage: "Hi", instructions: "Be kind", ...input }, settings);
}

/* ---------- flag, authentication and roles ---------- */

test("flag off: every builder route answers 404 and reaches no storage", async () => {
  await withServer({ env: {} }, async ({ request, storage }) => {
    const seeded = seedA(storage);
    for (const [method, path, body] of [
      ["GET", "/builder/avatars"],
      ["POST", "/builder/avatars"],
      ["GET", `/builder/${seeded.chatbot.id}`],
      ["PATCH", `/builder/${seeded.chatbot.id}`, { configure: { title: "X" } }],
      ["POST", `/builder/${seeded.chatbot.id}/uploads`],
    ]) {
      const res = await request(method, path, { user: ADMIN_A, body });
      assert.equal(res.status, 404, `${method} ${path}`);
    }
    assert.equal(storage.calls.length, 0);
  });
});

test("flag must be the literal string true", async () => {
  await withServer({ env: { [BUILDER_ROUTES_FLAG]: "1" } }, async ({ request }) => {
    const res = await request("GET", "/builder/avatars", { user: ADMIN_A });
    assert.equal(res.status, 404);
  });
});

test("unauthenticated requests are rejected with 401 before any storage call", async () => {
  await withServer({}, async ({ request, storage }) => {
    const seeded = seedA(storage);
    const probes = [
      ["GET", "/builder/avatars"],
      ["POST", "/builder/avatars"],
      ["GET", `/builder/${seeded.chatbot.id}`],
      ["PATCH", `/builder/${seeded.chatbot.id}`, { configure: { title: "X" } }],
      ["POST", `/builder/${seeded.chatbot.id}/uploads`],
    ];
    for (const [method, path, body] of probes) {
      const res = await request(method, path, { body });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
    assert.equal(storage.calls.length, 0);
  });
});

test("agent role can read the builder but cannot write or upload", async () => {
  await withServer({}, async ({ request, storage }) => {
    const seeded = seedA(storage);
    const read = await request("GET", `/builder/${seeded.chatbot.id}`, { user: AGENT_A });
    assert.equal(read.status, 200);

    const patch = await request("PATCH", `/builder/${seeded.chatbot.id}`, { user: AGENT_A, body: { configure: { title: "X" } } });
    assert.equal(patch.status, 403);
    const upload = await request("POST", `/builder/${seeded.chatbot.id}/uploads`, { user: AGENT_A });
    assert.equal(upload.status, 403);
    const avatar = await request("POST", "/builder/avatars", { user: AGENT_A });
    assert.equal(avatar.status, 403);
    assert.equal(storage.calls.filter((c) => c.name === "updateBuilderState").length, 0);
    const after = await storage.findBuilderState(CO_A, seeded.chatbot.id);
    assert.equal(after.chatbot.title, "Original");
  });
});

test("roles: a router built without requireRole refuses every authenticated request with 403", async () => {
  await withServer({ withRoles: false }, async ({ request, storage }) => {
    const seeded = seedA(storage);
    const read = await request("GET", `/builder/${seeded.chatbot.id}`, { user: ADMIN_A });
    const patch = await request("PATCH", `/builder/${seeded.chatbot.id}`, { user: ADMIN_A, body: { configure: { title: "X" } } });
    assert.equal(read.status, 403);
    assert.equal(patch.status, 403);
    assert.equal(storage.calls.filter((c) => c.name === "updateBuilderState").length, 0);
    const after = await storage.findBuilderState(CO_A, seeded.chatbot.id);
    assert.equal(after.chatbot.title, "Original");
  });
});

test("a missing or malformed company scope is refused with 403", async () => {
  await withServer({}, async ({ request, storage }) => {
    const seeded = seedA(storage);
    for (const user of [{ role: "admin", companyId: null }, { role: "admin", companyId: "not-a-uuid" }]) {
      const res = await request("GET", `/builder/${seeded.chatbot.id}`, { user });
      assert.equal(res.status, 403);
    }
    assert.equal(storage.calls.length, 0);
  });
});

/* ---------- tenancy ---------- */

test("a companyId in the body is rejected with 400 and never reaches storage", async () => {
  await withServer({}, async ({ request, storage }) => {
    const seeded = seedA(storage);
    const res = await request("PATCH", `/builder/${seeded.chatbot.id}`, {
      user: ADMIN_A,
      body: { companyId: CO_B, configure: { title: "Hijacked" } },
    });
    assert.equal(res.status, 400);
    assert.equal(storage.calls.filter((c) => c.name === "updateBuilderState").length, 0);
    const after = await storage.findBuilderState(CO_A, seeded.chatbot.id);
    assert.equal(after.chatbot.title, "Original");
  });
});

test("a companyId nested inside a group is rejected too", async () => {
  await withServer({}, async ({ request, storage }) => {
    const seeded = seedA(storage);
    const res = await request("PATCH", `/builder/${seeded.chatbot.id}`, {
      user: ADMIN_A,
      body: { customize: { companyId: CO_B, color: "#3B82F6" } },
    });
    assert.equal(res.status, 400);
    assert.equal(storage.calls.filter((c) => c.name === "updateBuilderState").length, 0);
  });
});

test("every storage call uses the company from the session", async () => {
  await withServer({}, async ({ request, storage }) => {
    const seeded = seedA(storage);
    await request("GET", `/builder/${seeded.chatbot.id}`, { user: ADMIN_A });
    await request("PATCH", `/builder/${seeded.chatbot.id}`, { user: ADMIN_A, body: { configure: { title: "New" } } });
    await request("GET", "/builder/avatars", { user: ADMIN_A });
    assert.ok(storage.calls.length >= 3);
    assert.ok(storage.calls.every((c) => c.companyId === CO_A));
  });
});

test("cross-company GET, PATCH and upload return 404 and leave the record unchanged", async () => {
  await withServer({}, async ({ request, storage }) => {
    const seeded = seedA(storage);
    const id = seeded.chatbot.id;

    const get = await request("GET", `/builder/${id}`, { user: ADMIN_B });
    assert.equal(get.status, 404);

    const patch = await request("PATCH", `/builder/${id}`, { user: ADMIN_B, body: { configure: { title: "Hijacked" } } });
    assert.equal(patch.status, 404);

    const upload = await request("POST", `/builder/${id}/uploads`, { user: ADMIN_B });
    assert.equal(upload.status, 404);

    const after = await storage.findBuilderState(CO_A, id);
    assert.equal(after.chatbot.title, "Original");
  });
});

test("an unknown id returns 404, the same as another company's id", async () => {
  await withServer({}, async ({ request }) => {
    const res = await request("GET", "/builder/does-not-exist", { user: ADMIN_A });
    assert.equal(res.status, 404);
    assert.equal(res.json.error, "Chatbot not found");
  });
});

/* ---------- validation ---------- */

test("an invalid id returns 400", async () => {
  await withServer({}, async ({ request }) => {
    const res = await request("GET", "/builder/bad_id", { user: ADMIN_A });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "Invalid id");
  });
});

test("an empty PATCH body returns 400", async () => {
  await withServer({}, async ({ request, storage }) => {
    const seeded = seedA(storage);
    const res = await request("PATCH", `/builder/${seeded.chatbot.id}`, { user: ADMIN_A, body: {} });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "Invalid input");
    assert.ok(Array.isArray(res.json.issues) && res.json.issues.length > 0);
  });
});

test("a bad enum value returns 400 with issues", async () => {
  await withServer({}, async ({ request, storage }) => {
    const seeded = seedA(storage);
    const res = await request("PATCH", `/builder/${seeded.chatbot.id}`, {
      user: ADMIN_A,
      body: { customize: { position: "top" } },
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "Invalid input");
    assert.ok(res.json.issues.some((issue) => issue.path.includes("position")));
  });
});

test("each invalid input returns 400 and writes nothing", async () => {
  const cases = [
    { configure: { title: "   " } },
    { configure: { title: "x".repeat(201) } },
    { configure: { bubbleMessage: "x".repeat(201) } },
    { configure: { bubbleDesign: "neon" } },
    { configure: { promoBannerButtonLink: "javascript:alert(1)" } },
    { configure: { suggestedPrompts: Array.from({ length: 21 }, () => ({ name: "a", prompt: "b" })) } },
    { configure: { unknownKey: true } },
    { customize: { color: "blue" } },
    { customize: { headerBgGradient: "url(http://x)" } },
    { customize: { headerBgGradient: "linear-gradient(red, blue);}</style>" } },
    { customize: { triggerAvatarSize: "500px" } },
    { customize: { footerLink: "ftp://example.com" } },
    { customize: { logo: `/uploads/chatbot/${CO_B}/logo.png` } },
    { customize: { logo: `/uploads/chatbot/${CO_A}/../../etc.png` } },
    { customize: { avatar: "/uploads/avatars/other-company/x.png" } },
    { embed: { trustedDomains: ["not a host"] } },
    { embed: { trustedDomains: ["example.com/path"] } },
    { embed: { uuid: "11111111-2222-4333-8444-555555555555" } },
    { train: {} },
  ];
  await withServer({}, async ({ request, storage }) => {
    const seeded = seedA(storage);
    for (const body of cases) {
      const res = await request("PATCH", `/builder/${seeded.chatbot.id}`, { user: ADMIN_A, body });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(storage.calls.filter((c) => c.name === "updateBuilderState").length, 0);
  });
});

test("malformed JSON is refused and writes nothing", async () => {
  await withServer({}, async ({ request, storage }) => {
    const seeded = seedA(storage);
    const res = await request("PATCH", `/builder/${seeded.chatbot.id}`, { user: ADMIN_A, raw: "{not json" });
    assert.equal(res.status, 400);
    assert.equal(storage.calls.filter((c) => c.name === "updateBuilderState").length, 0);
  });
});

/* ---------- reads and writes ---------- */

test("GET returns the snapshot with defaults for keys never saved", async () => {
  await withServer({}, async ({ request, storage }) => {
    const seeded = seedA(storage, { welcomeMessage: null, instructions: null });
    const res = await request("GET", `/builder/${seeded.chatbot.id}`, { user: ADMIN_A });
    assert.equal(res.status, 200);
    assert.equal(res.json.id, seeded.chatbot.id);
    assert.equal(res.json.updatedAt, "2026-11-01T00:00:00.000Z");
    assert.equal(res.json.state.configure.welcomeMessage, "");
    assert.equal(res.json.state.configure.bubbleDesign, "blank");
    assert.equal(res.json.state.customize.position, "right");
    assert.equal(res.json.state.customize.triggerAvatarSize, "60px");
    assert.equal(res.json.state.customize.showLogo, true);
    assert.deepEqual(res.json.state.embed.trustedDomains, []);
    assert.equal(res.json.state.embed.uuid, seeded.publicUuid);
    assert.deepEqual(res.json.state.train, {});
    assert.deepEqual(res.json.state.channel, {});
  });
});

test("a valid PATCH writes the classic columns and the settings, then returns the snapshot", async () => {
  await withServer({}, async ({ request, storage }) => {
    const seeded = seedA(storage);
    const res = await request("PATCH", `/builder/${seeded.chatbot.id}`, {
      user: ADMIN_A,
      body: {
        configure: {
          title: "  Support  ",
          bubbleDesign: "promo_banner",
          promoBannerButtonLink: "https://example.com/offer",
        },
        customize: { color: "#3B82F6", position: "left", isEmoji: true },
        embed: { trustedDomains: ["https://Example.com/", "example.com", "shop.example.com:8080"] },
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.state.configure.title, "Support");
    assert.equal(res.json.state.configure.bubbleDesign, "promo_banner");
    assert.equal(res.json.state.configure.promoBannerButtonLink, "https://example.com/offer");
    assert.equal(res.json.state.customize.color, "#3B82F6");
    assert.equal(res.json.state.customize.position, "left");
    assert.equal(res.json.state.customize.isEmoji, true);
    assert.deepEqual(res.json.state.embed.trustedDomains, ["example.com", "shop.example.com:8080"]);
    assert.equal(res.json.state.embed.uuid, seeded.publicUuid);

    const stored = await storage.findBuilderState(CO_A, seeded.chatbot.id);
    assert.equal(stored.chatbot.title, "Support");
  });
});

test("a partial PATCH keeps the keys it does not mention", async () => {
  await withServer({}, async ({ request, storage }) => {
    const seeded = seedA(storage);
    const id = seeded.chatbot.id;
    await request("PATCH", `/builder/${id}`, { user: ADMIN_A, body: { customize: { color: "#112233" } } });
    await request("PATCH", `/builder/${id}`, { user: ADMIN_A, body: { customize: { position: "left" } } });
    const res = await request("GET", `/builder/${id}`, { user: ADMIN_A });
    assert.equal(res.json.state.customize.color, "#112233");
    assert.equal(res.json.state.customize.position, "left");
    assert.equal(res.json.state.configure.welcomeMessage, "Hi");
  });
});

test("embed.uuid cannot be written", async () => {
  await withServer({}, async ({ request, storage }) => {
    const seeded = seedA(storage);
    const res = await request("PATCH", `/builder/${seeded.chatbot.id}`, {
      user: ADMIN_A,
      body: { embed: { uuid: "11111111-2222-4333-8444-555555555555" } },
    });
    assert.equal(res.status, 400);
    const after = await storage.findBuilderState(CO_A, seeded.chatbot.id);
    assert.equal(after.publicUuid, seeded.publicUuid);
  });
});

test("an image path from this company's upload folder is accepted", async () => {
  await withServer({}, async ({ request, storage }) => {
    const seeded = seedA(storage);
    const res = await request("PATCH", `/builder/${seeded.chatbot.id}`, {
      user: ADMIN_A,
      body: { customize: { logo: `/uploads/chatbot/${CO_A}/logo-1.png` } },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.state.customize.logo, `/uploads/chatbot/${CO_A}/logo-1.png`);
  });
});

test("an avatar must be a preset or one of this company's uploads", async () => {
  await withServer({}, async ({ request, storage }) => {
    const seeded = seedA(storage);
    storage.inner.seedAvatar(null, PRESET_AVATAR);
    const ownPath = `/uploads/avatars/${CO_A}/mine.png`;
    const otherPath = `/uploads/avatars/${CO_B}/theirs.png`;
    storage.inner.seedAvatar(CO_A, ownPath);
    storage.inner.seedAvatar(CO_B, otherPath);

    const other = await request("PATCH", `/builder/${seeded.chatbot.id}`, {
      user: ADMIN_A,
      body: { customize: { avatar: otherPath } },
    });
    assert.equal(other.status, 400);

    const preset = await request("PATCH", `/builder/${seeded.chatbot.id}`, {
      user: ADMIN_A,
      body: { customize: { avatar: PRESET_AVATAR } },
    });
    assert.equal(preset.status, 200);
    assert.equal(preset.json.state.customize.avatar, PRESET_AVATAR);
  });
});

test("GET /builder/avatars lists presets and this company's uploads only, and is not read as an id", async () => {
  await withServer({}, async ({ request, storage }) => {
    storage.inner.seedAvatar(null, PRESET_AVATAR);
    storage.inner.seedAvatar(CO_A, `/uploads/avatars/${CO_A}/mine.png`);
    storage.inner.seedAvatar(CO_B, `/uploads/avatars/${CO_B}/theirs.png`);

    const res = await request("GET", "/builder/avatars", { user: ADMIN_A });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json));
    assert.deepEqual(
      res.json.map((a) => a.path),
      [PRESET_AVATAR, `/uploads/avatars/${CO_A}/mine.png`],
    );
    assert.ok(res.json.every((a) => typeof a.id === "string" && typeof a.url === "string" && !("companyId" in a)));
  });
});

/* ---------- external endpoints: 501 with a reason ---------- */

test("POST /builder/avatars answers 501 not_implemented with a reason", async () => {
  await withServer({}, async ({ request }) => {
    const res = await request("POST", "/builder/avatars", { user: ADMIN_A });
    assert.equal(res.status, 501);
    assert.equal(res.json.error, "not_implemented");
    assert.equal(typeof res.json.reason, "string");
    assert.ok(res.json.reason.length > 0);
  });
});

test("POST /builder/:id/uploads answers 501 not_implemented for an own chatbot", async () => {
  await withServer({}, async ({ request, storage }) => {
    const seeded = seedA(storage);
    const res = await request("POST", `/builder/${seeded.chatbot.id}/uploads`, { user: ADMIN_A });
    assert.equal(res.status, 501);
    assert.equal(res.json.error, "not_implemented");
    assert.equal(typeof res.json.reason, "string");
  });
});

test("the 501 answers do not claim success or write anything", async () => {
  await withServer({}, async ({ request, storage }) => {
    const seeded = seedA(storage);
    await request("POST", `/builder/avatars`, { user: ADMIN_A });
    await request("POST", `/builder/${seeded.chatbot.id}/uploads`, { user: ADMIN_A });
    assert.equal(storage.calls.filter((c) => c.name === "updateBuilderState").length, 0);
  });
});

/* ---------- save rule (M4): welcome, bubble and instructions, as PHP requires on save ---------- */

test("save: a patch that blanks the welcome message is refused with 400 and writes nothing", async () => {
  await withServer({}, async ({ request, storage }) => {
    const seeded = seedA(storage);
    for (const welcomeMessage of ["", "   "]) {
      const res = await request("PATCH", `/builder/${seeded.chatbot.id}`, {
        user: ADMIN_A,
        body: { configure: { welcomeMessage } },
      });
      assert.equal(res.status, 400, JSON.stringify(welcomeMessage));
      assert.ok(res.json.issues.some((issue) => issue.path.join(".") === "configure.welcomeMessage"));
    }
    assert.equal(storage.calls.filter((c) => c.name === "updateBuilderState").length, 0);
  });
});

test("save: a chatbot with no stored bubble message cannot be saved until one is sent", async () => {
  await withServer({}, async ({ request, storage }) => {
    const seeded = seedA(storage, {}, {});
    const refused = await request("PATCH", `/builder/${seeded.chatbot.id}`, {
      user: ADMIN_A,
      body: { customize: { color: "#3B82F6" } },
    });
    assert.equal(refused.status, 400);
    assert.ok(refused.json.issues.some((issue) => issue.path.join(".") === "configure.bubbleMessage"));
    assert.equal(storage.calls.filter((c) => c.name === "updateBuilderState").length, 0);

    const accepted = await request("PATCH", `/builder/${seeded.chatbot.id}`, {
      user: ADMIN_A,
      body: { configure: { bubbleMessage: "Chat with us" }, customize: { color: "#3B82F6" } },
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.json.state.configure.bubbleMessage, "Chat with us");
  });
});

test("save: instructions are required outside demo mode", async () => {
  await withServer({}, async ({ request, storage }) => {
    const seeded = seedA(storage, { instructions: null });
    const res = await request("PATCH", `/builder/${seeded.chatbot.id}`, {
      user: ADMIN_A,
      body: { configure: { title: "Support" } },
    });
    assert.equal(res.status, 400);
    assert.ok(res.json.issues.some((issue) => issue.path.join(".") === "configure.instructions"));
    assert.equal(storage.calls.filter((c) => c.name === "updateBuilderState").length, 0);
  });
});

test("save: demo mode drops only the instructions rule", async () => {
  await withServer({ demoMode: true }, async ({ request, storage }) => {
    const seeded = seedA(storage, { instructions: null });
    const demo = await request("PATCH", `/builder/${seeded.chatbot.id}`, {
      user: ADMIN_A,
      body: { configure: { title: "Support" } },
    });
    assert.equal(demo.status, 200);

    const blankWelcome = await request("PATCH", `/builder/${seeded.chatbot.id}`, {
      user: ADMIN_A,
      body: { configure: { welcomeMessage: " " } },
    });
    assert.equal(blankWelcome.status, 400, "welcome message is still required in demo mode");
  });
});

test("save: a patch that leaves a stored field alone is checked against the stored value", async () => {
  await withServer({}, async ({ request, storage }) => {
    const seeded = seedA(storage, { welcomeMessage: null });
    const res = await request("PATCH", `/builder/${seeded.chatbot.id}`, {
      user: ADMIN_A,
      body: { customize: { position: "left" } },
    });
    assert.equal(res.status, 400);
    assert.ok(res.json.issues.some((issue) => issue.path.join(".") === "configure.welcomeMessage"));
  });
});

test("save rule: saveIssues reports each missing field once, with its path", () => {
  const stored = { welcomeMessage: null, instructions: "  ", settings: {} };
  const issues = saveIssues(stored, {}, { demoMode: false });
  assert.deepEqual(
    issues.map((i) => i.path.join(".")),
    ["configure.welcomeMessage", "configure.bubbleMessage", "configure.instructions"],
  );
  assert.ok(issues.every((i) => i.code === "custom" && i.message === "required on save"));
});

test("save rule: a patch value replaces the stored value before the check", () => {
  const stored = { welcomeMessage: "Hi", instructions: "Be kind", settings: { bubbleMessage: "Hello" } };
  assert.deepEqual(saveIssues(stored, {}, { demoMode: false }), []);
  const issues = saveIssues(stored, { configure: { instructions: "", bubbleMessage: "\t" } }, { demoMode: false });
  assert.deepEqual(issues.map((i) => i.path.join(".")), ["configure.bubbleMessage", "configure.instructions"]);
});

test("save rule: demo mode skips instructions only", () => {
  const stored = { welcomeMessage: "", instructions: null, settings: {} };
  const issues = saveIssues(stored, {}, { demoMode: true });
  assert.deepEqual(issues.map((i) => i.path.join(".")), ["configure.welcomeMessage", "configure.bubbleMessage"]);
});

test("the demo flag defaults to off, so instructions are required", async () => {
  const app = express();
  const storage = createSpyStorage();
  const seeded = seedA(storage, { instructions: null });
  app.use(BASE, createBuilderRouter({ storage, authenticate, requireRole, getCompanyId, env: ENABLED, now: () => FIXED_NOW }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${BASE}/builder/${seeded.chatbot.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-test-user": JSON.stringify(ADMIN_A) },
      body: JSON.stringify({ configure: { title: "Support" } }),
    });
    assert.equal(res.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/* ---------- route table ---------- */

test("the route table lists exactly the five builder routes, avatars before the id route", () => {
  assert.deepEqual(
    BUILDER_ROUTES.map((r) => `${r.method} ${r.path}`),
    [
      "GET /builder/avatars",
      "POST /builder/avatars",
      "GET /builder/:id",
      "PATCH /builder/:id",
      "POST /builder/:id/uploads",
    ],
  );
});

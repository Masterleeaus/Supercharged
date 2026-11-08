// Chatbot module tests (node:test). No database, no Express, no node_modules.
// Covers company scope, conversation isolation, the generative UI validator and normaliser,
// plus the composer, export and conversation-list behaviour ported from the Chatbot extension.
import test from "node:test";
import assert from "node:assert/strict";
import { ChatbotError, createChatbotService } from "../../server/modules/chatbot/chatbot-service.ts";
import { createMemoryChatbotStorage, createDrizzleChatbotStorage } from "../../server/modules/chatbot/chatbot-storage.ts";
import { exportConversation } from "../../server/modules/chatbot/conversation-export.ts";
import {
  augmentPrompt,
  composeResponse,
  createBuilderRegistry,
  decodeEnvelope,
  encodeEnvelope,
  normaliseSpec,
  repairSpec,
  shouldGenerate,
  validateSpec,
} from "../../server/modules/chatbot/generative-ui/index.ts";
import { BuilderRegistryError } from "../../server/modules/chatbot/generative-ui/builder-registry.ts";

// ---------- fixtures ----------

const registry = createBuilderRegistry({
  manifest: {
    allowed_actions: ["navigate", "open-modal", "filter", "state.set", "form.submit-preview", "ui.expand"],
    surface_profiles: { chat: { density: "compact" } },
  },
  collections: {
    components: {
      stack: { id: "stack", category: "Layout", name: "Stack" },
      card: { id: "card", category: "Layout", name: "Card" },
      alert: { id: "alert", category: "Feedback", name: "Alert" },
      text: { id: "text", category: "Typography", name: "Text" },
      button: { id: "button", category: "Actions", name: "Button" },
      table: { id: "table", category: "Data", name: "Table" },
    },
    "mock-data": {
      "cleaning-business": { jobs: { open: 3 }, summary: { title: "Today" } },
    },
  },
});

function goodSpec() {
  return {
    version: "1.1",
    authority: "presentation-only",
    surface: "chat",
    root: "root",
    state: {},
    elements: {
      root: { type: "stack", props: { gap: "md" }, children: ["title", "open"] },
      title: { type: "text", props: { value: "Open jobs" } },
      open: { type: "button", props: { label: "View" }, on: { press: { action: "navigate", params: { to: "/jobs" } } } },
    },
  };
}

function clock(start = "2026-11-01T10:00:00.000Z") {
  let current = Date.parse(start);
  return {
    now: () => new Date(current),
    advance(ms) {
      current += ms;
    },
  };
}

function makeService({ generativeUi, storage = createMemoryChatbotStorage(), time = clock() } = {}) {
  return { storage, time, service: createChatbotService({ storage, now: time.now, generativeUi }) };
}

// Company ids are UUIDs everywhere; requireCompanyId rejects anything else.
const COMPANY_A = "6f1c2a3e-9b7d-4c5a-8e21-0a1b2c3d4e51";
const COMPANY_B = "b2d4f6a8-1c3e-4f50-9a7b-6c5d4e3f2a12";

// ---------- company scope ----------

test("company scope is required: every service call rejects a missing, empty or malformed companyId", async () => {
  const { service } = makeService();
  const badValues = [undefined, null, "", "   ", "has space", "../escape", 42, {}];
  for (const bad of badValues) {
    await assert.rejects(service.listChatbots(bad), (error) => error instanceof ChatbotError && error.status === 403);
    await assert.rejects(service.createChatbot(bad, { title: "x" }), (error) => error.status === 403);
    await assert.rejects(service.listConversations(bad), (error) => error.status === 403);
    await assert.rejects(service.getConversation(bad, "c1"), (error) => error.status === 403);
    await assert.rejects(service.recordUserMessage(bad, "c1", "hi"), (error) => error.status === 403);
    await assert.rejects(service.unreadCounts(bad), (error) => error.status === 403);
    await assert.rejects(service.exportConversation(bad, "c1", "txt"), (error) => error.status === 403);
  }
});

test("storage enforces company scope on its own, without the service", async () => {
  const storage = createMemoryChatbotStorage();
  await assert.rejects(storage.listChatbots(""), (error) => error.status === 403);
  await assert.rejects(storage.findConversation(undefined, "c1"), (error) => error.status === 403);
  await assert.rejects(storage.insertMessage(null, { conversationId: "c1", role: "user", message: "m", createdAt: new Date() }), (error) => error.status === 403);
});

test("a companyId supplied in the input is ignored; the scope argument decides the tenant", async () => {
  const { service } = makeService();
  const created = await service.createChatbot(COMPANY_A, { title: "Front desk", companyId: COMPANY_B });
  assert.equal(created.companyId, COMPANY_A);
  assert.equal((await service.listChatbots(COMPANY_A)).length, 1);
  assert.equal((await service.listChatbots(COMPANY_B)).length, 0);
});

test("the Drizzle storage is used and does not throw on construction", () => {
  // The chatbot tables are promoted, so this is the real storage, not a placeholder. Construction must not
  // touch the database: the handle is resolved lazily on first use.
  let storage;
  assert.doesNotThrow(() => {
    storage = createDrizzleChatbotStorage();
  });
  for (const method of ["listChatbots", "findConversation", "insertMessage"]) {
    assert.equal(typeof storage[method], "function", `Drizzle storage exposes ${method}`);
  }
});

// ---------- conversation isolation ----------

test("conversations, messages and chatbots from one company are invisible and immutable to another", async () => {
  const { service } = makeService();
  const chatbot = await service.createChatbot(COMPANY_A, { title: "A bot" });
  const conversation = await service.startConversation(COMPANY_A, { chatbotId: chatbot.id, sessionId: "s-1" });
  await service.recordUserMessage(COMPANY_A, conversation.id, "Secret from A");

  assert.deepEqual(await service.listConversations(COMPANY_B), { data: [], total: 0, page: 1, perPage: 30 });
  await assert.rejects(service.getConversation(COMPANY_B, conversation.id), (e) => e.status === 404);
  await assert.rejects(service.recordUserMessage(COMPANY_B, conversation.id, "injected"), (e) => e.status === 404);
  await assert.rejects(service.updateConversationState(COMPANY_B, conversation.id, { pinned: true }), (e) => e.status === 404);
  await assert.rejects(service.markConversationRead(COMPANY_B, conversation.id), (e) => e.status === 404);
  await assert.rejects(service.exportConversation(COMPANY_B, conversation.id, "json"), (e) => e.status === 404);
  await assert.rejects(service.startConversation(COMPANY_B, { chatbotId: chatbot.id, sessionId: "s-2" }), (e) => e.status === 404);
  await assert.rejects(service.getChatbot(COMPANY_B, chatbot.id), (e) => e.status === 404);
  await assert.rejects(service.updateChatbot(COMPANY_B, chatbot.id, { title: "hijacked" }), (e) => e.status === 404);

  assert.deepEqual(await service.unreadCounts(COMPANY_B), { agent: 0, ai: 0, all: 0 });

  // Company A's data is unchanged by the attempts above.
  const own = await service.getConversation(COMPANY_A, conversation.id);
  assert.equal(own.conversation.pinned, false);
  assert.equal(own.messages.length, 1);
  assert.equal((await service.getChatbot(COMPANY_A, chatbot.id)).title, "A bot");
});

test("storage refuses to attach a message to another company's conversation", async () => {
  const storage = createMemoryChatbotStorage();
  const time = clock();
  const service = createChatbotService({ storage, now: time.now });
  const chatbot = await service.createChatbot(COMPANY_A, { title: "A bot" });
  const conversation = await service.startConversation(COMPANY_A, { chatbotId: chatbot.id, sessionId: "s" });
  const row = await storage.insertMessage(COMPANY_B, { conversationId: conversation.id, role: "user", message: "x", createdAt: time.now() });
  assert.equal(row, null);
});

test("each company keeps its own unread counts and search results", async () => {
  const { service } = makeService();
  for (const company of [COMPANY_A, COMPANY_B]) {
    const bot = await service.createChatbot(company, { title: `${company} bot` });
    const conv = await service.startConversation(company, { chatbotId: bot.id, sessionId: `${company}-s` });
    await service.recordUserMessage(company, conv.id, `hello from ${company}`);
  }
  assert.deepEqual(await service.unreadCounts(COMPANY_A), { agent: 0, ai: 1, all: 1 });
  const search = await service.listConversations(COMPANY_A, { search: COMPANY_A.toUpperCase() });
  assert.equal(search.total, 1);
  assert.equal((await service.listConversations(COMPANY_A, { search: COMPANY_B })).total, 0);
});

// ---------- generative UI: validator ----------

test("validator accepts a well-formed spec", () => {
  const result = validateSpec(goodSpec(), registry);
  assert.equal(result.valid, true);
  assert.deepEqual(result.issues.filter((i) => i.severity === "error"), []);
});

test("validator rejects malformed specs", () => {
  const cases = {
    "unregistered component type": () => {
      const s = goodSpec();
      s.elements.title.type = "iframe";
      return s;
    },
    "props missing": () => {
      const s = goodSpec();
      delete s.elements.title.props;
      return s;
    },
    "action outside the allow-list": () => {
      const s = goodSpec();
      s.elements.open.on.press.action = "workcore.jobs.create";
      return s;
    },
    "raw HTML property": () => {
      const s = goodSpec();
      s.elements.title.props.html = "<b>x</b>";
      return s;
    },
    "child references a missing element": () => {
      const s = goodSpec();
      s.elements.root.children.push("ghost");
      return s;
    },
    "root missing": () => {
      const s = goodSpec();
      s.root = "nowhere";
      return s;
    },
    "elements given as a list": () => ({ root: "root", elements: [{ type: "text", props: {} }] }),
    "cycle in the element tree": () => ({
      root: "a",
      elements: {
        a: { type: "card", props: {}, children: ["b"] },
        b: { type: "card", props: {}, children: ["a"] },
      },
    }),
    "watch key that is not a safe pointer": () => {
      const s = goodSpec();
      s.elements.open.watch = { "/a/../b": [{ action: "state.set" }] };
      return s;
    },
    "visibility condition with no source": () => {
      const s = goodSpec();
      s.elements.title.visible = { $foo: 1 };
      return s;
    },
    "repeat without a statePath": () => {
      const s = goodSpec();
      s.elements.title.repeat = { key: "id" };
      return s;
    },
    "element key containing a dot": () => {
      const s = goodSpec();
      s.elements["a.b"] = { type: "text", props: {} };
      s.elements.root.children.push("a.b");
      return s;
    },
    "integer-like element key": () => {
      const s = goodSpec();
      s.elements["1"] = { type: "text", props: {} };
      return s;
    },
    "authority other than presentation-only": () => {
      const s = goodSpec();
      s.authority = "executes-actions";
      return s;
    },
    "more than 250 elements": () => {
      const elements = Object.fromEntries(Array.from({ length: 251 }, (_, i) => [`e${i}`, { type: "text", props: {} }]));
      return { root: "e0", elements };
    },
    "action chain longer than 12": () => {
      const s = goodSpec();
      s.elements.open.on.press = Array.from({ length: 13 }, () => ({ action: "navigate", params: {} }));
      return s;
    },
    "string longer than 20000 bytes": () => {
      const s = goodSpec();
      s.elements.title.props.value = "x".repeat(20001);
      return s;
    },
    "props nested beyond the depth limit": () => {
      const s = goodSpec();
      let value = "leaf";
      for (let i = 0; i < 35; i += 1) value = { n: value };
      s.elements.title.props.deep = value;
      return s;
    },
  };

  for (const [name, build] of Object.entries(cases)) {
    const result = validateSpec(build(), registry);
    assert.equal(result.valid, false, `expected rejection: ${name}`);
    assert.ok(result.issues.some((i) => i.severity === "error"), `expected an error issue: ${name}`);
  }
});

test("validator reports an unreachable element as a warning, not an error", () => {
  const s = goodSpec();
  s.elements.orphan = { type: "text", props: { value: "unused" } };
  const result = validateSpec(s, registry);
  assert.equal(result.valid, true);
  assert.ok(result.issues.some((i) => i.severity === "warning" && i.path === "/elements/orphan"));
});

test("validator does not treat prototype names as elements", () => {
  const spec = { root: "constructor", elements: { root: { type: "stack", props: {} } } };
  assert.equal(validateSpec(spec, registry).valid, false);
});

test("a JSON key named __proto__ is handled as data, not as a prototype write", () => {
  const spec = JSON.parse('{"root":"__proto__","elements":{"__proto__":{"type":"stack","props":{}}}}');
  assert.equal(validateSpec(spec, registry).valid, true);
  const { spec: repaired } = repairSpec(spec, registry);
  assert.equal(Object.getPrototypeOf(repaired.elements), Object.prototype);
  assert.equal(({}).type, undefined);
});

// ---------- generative UI: normaliser idempotence ----------

const messyInputs = [
  {
    surface: "weird",
    root: "root",
    elements: {
      root: { type: "card", props: {}, children: ["a", "missing"] },
      a: { type: "nope", props: {}, on: { press: { action: "bogus" } } },
    },
  },
  { elements: [{ type: "stack" }] },
  {
    root: "x",
    state: "not-an-object",
    persistence: true,
    elements: {
      x: { type: "table", props: { rows: 2 }, watch: { "/jobs": [{ action: "state.set", params: { a: 1 } }, { action: "bogus" }] } },
    },
  },
  { elements: Object.fromEntries(Array.from({ length: 260 }, (_, i) => [`e${i}`, { type: "text", props: { value: String(i) } }])) },
  {},
];

test("normaliseSpec is idempotent", () => {
  for (const input of messyInputs) {
    const once = normaliseSpec(input);
    const twice = normaliseSpec(once);
    assert.deepEqual(twice, once);
  }
});

test("repairSpec is idempotent: a second pass changes nothing and still validates", () => {
  for (const input of messyInputs) {
    const first = repairSpec(input, registry);
    const second = repairSpec(first.spec, registry);
    assert.deepEqual(second.changes, [], `second pass changed something for ${JSON.stringify(input).slice(0, 60)}`);
    assert.deepEqual(second.spec, first.spec);
    assert.equal(validateSpec(first.spec, registry).valid, true);
  }
});

test("repairSpec replaces unknown components with a safe alert and drops bad bindings", () => {
  const { spec, changes } = repairSpec(messyInputs[0], registry);
  assert.equal(spec.elements.a.type, "alert");
  assert.equal(spec.elements.a.on, undefined);
  assert.deepEqual(spec.elements.root.children, ["a"]);
  assert.ok(changes.some((c) => c.path === "/elements/a/type"));
  assert.ok(changes.some((c) => c.path === "/elements/root/children"));
});

// ---------- BuilderRegistry ----------

test("BuilderRegistry finds only safe slugs and rejects everything else", () => {
  assert.equal(registry.find("components", "stack").id, "stack");
  assert.equal(registry.find("components", "Stack"), null);
  assert.equal(registry.find("components", "../stack"), null);
  assert.equal(registry.find("components", "constructor"), null);
  assert.throws(() => registry.all("secrets"), BuilderRegistryError);
});

test("BuilderRegistry lists components sorted and resolves section data through dot paths", () => {
  const categories = registry.all("components").map((c) => c.category);
  assert.deepEqual(categories, [...categories].sort());
  assert.equal(registry.componentIds().includes("table"), true);
  assert.equal(registry.resolveSectionData({ data_source: "jobs.open" }, registry.mockData("cleaning-business")), 3);
  assert.deepEqual(registry.resolveSectionData({ data: [1] }, {}), [1]);
});

test("BuilderRegistry without a manifest throws instead of guessing", () => {
  const bare = createBuilderRegistry({ collections: {} });
  assert.throws(() => bare.manifest(), /Builder definition not found/);
  assert.throws(() => bare.actionIds(), /Builder definition not found/);
});

// ---------- response composer ----------

test("shouldGenerate honours explicit commands, natural language and the enabled flags", () => {
  assert.equal(shouldGenerate("/ui show my jobs"), true);
  assert.equal(shouldGenerate("please build a dashboard for open jobs"), true);
  assert.equal(shouldGenerate("what is the weather"), false);
  assert.equal(shouldGenerate("/ui show my jobs", { enabled: false, naturalLanguageTriggers: true, preferredChatElements: 50 }), false);
  assert.equal(shouldGenerate("please build a dashboard", { enabled: true, naturalLanguageTriggers: false, preferredChatElements: 50 }), false);
});

test("augmentPrompt lists the allowed catalogue and ends with the user request", () => {
  const prompt = augmentPrompt("show jobs", registry, "chat");
  // Sorted by category, then name, as in the PHP registry.
  assert.match(prompt, /Allowed components: button, table, alert, card, stack, text\./);
  assert.match(prompt, /Allowed action intents: navigate, open-modal/);
  assert.ok(prompt.endsWith("USER REQUEST:\nshow jobs"));
});

test("composeResponse accepts a valid fence and keeps the surrounding text", () => {
  const reply = `Here you go.\n\`\`\`titan-ui\n${JSON.stringify(goodSpec())}\n\`\`\``;
  const result = composeResponse(reply, registry);
  assert.equal(result.accepted, true);
  assert.equal(result.fallbackText, "Here you go.");
  assert.equal(result.spec.authority, "presentation-only");
});

test("composeResponse falls back to text for plain replies, bad JSON and rejected specs", () => {
  assert.deepEqual(
    { accepted: composeResponse("Just text.", registry).accepted, text: composeResponse("Just text.", registry).fallbackText },
    { accepted: false, text: "Just text." },
  );
  const badJson = composeResponse("Sorry\n```titan-ui\n{not json\n```", registry);
  assert.equal(badJson.accepted, false);
  assert.equal(badJson.fallbackText, "Sorry");

  const unsafe = { ...goodSpec() };
  unsafe.elements.title = { type: "text", props: { script: "alert(1)" } };
  const rejected = composeResponse("Result\n```titan-ui\n" + JSON.stringify(unsafe) + "\n```", registry);
  assert.equal(rejected.accepted, false);
  assert.ok(rejected.issues.length > 0);
});

test("composeResponse notes when presentation drift was repaired", () => {
  const drifted = goodSpec();
  drifted.elements.open.type = "carousel-3d";
  const result = composeResponse("Ok\n```titan-ui\n" + JSON.stringify(drifted) + "\n```", registry);
  assert.equal(result.accepted, true);
  assert.match(result.fallbackText, /Minor presentation-schema drift was repaired/);
});

test("envelope round-trips and a tampered envelope is refused", () => {
  const payload = encodeEnvelope("Here", goodSpec());
  const decoded = decodeEnvelope(payload, registry);
  assert.equal(decoded.fallbackText, "Here");
  assert.equal(decoded.spec.root, "root");

  const tampered = JSON.parse(payload);
  tampered.spec.elements.title.type = "script-runner";
  assert.equal(decodeEnvelope(JSON.stringify(tampered), registry), null);
  assert.equal(decodeEnvelope("not json", registry), null);
});

// ---------- service: conversation list and handover ----------

test("listConversations orders pinned first and filters by handler, status and search", async () => {
  const { service, time } = makeService();
  const bot = await service.createChatbot(COMPANY_A, { title: "Front" });
  const make = async (session, text) => {
    time.advance(60_000);
    const conv = await service.startConversation(COMPANY_A, { chatbotId: bot.id, sessionId: session });
    if (text) await service.recordUserMessage(COMPANY_A, conv.id, text);
    return conv;
  };
  const older = await make("s1", "quote for gutters");
  const newer = await make("s2", "invoice question");
  const pinned = await make("s3", "pool cleaning");

  await service.updateConversationState(COMPANY_A, pinned.id, { pinned: true });
  await service.updateConversationState(COMPANY_A, newer.id, { connectAgent: true });
  await service.updateConversationState(COMPANY_A, older.id, { ticketStatus: "closed" });

  const all = await service.listConversations(COMPANY_A);
  assert.equal(all.data[0].id, pinned.id, "pinned conversation comes first");
  assert.equal(all.total, 3);

  const human = await service.listConversations(COMPANY_A, { handler: "human" });
  assert.deepEqual(human.data.map((c) => c.id), [newer.id]);

  const closed = await service.listConversations(COMPANY_A, { ticketStatus: "closed" });
  assert.deepEqual(closed.data.map((c) => c.id), [older.id]);

  const searched = await service.listConversations(COMPANY_A, { search: "POOL" });
  assert.deepEqual(searched.data.map((c) => c.id), [pinned.id]);
});

test("listConversations paginates with the default page size of 30 and a hard cap of 100", async () => {
  const { service, time } = makeService();
  const bot = await service.createChatbot(COMPANY_A, { title: "Bulk" });
  for (let i = 0; i < 35; i += 1) {
    time.advance(1000);
    await service.startConversation(COMPANY_A, { chatbotId: bot.id, sessionId: `bulk-${i}` });
  }
  const first = await service.listConversations(COMPANY_A);
  assert.equal(first.data.length, 30);
  assert.equal(first.total, 35);
  const second = await service.listConversations(COMPANY_A, { page: 2 });
  assert.equal(second.data.length, 5);
  assert.equal((await service.listConversations(COMPANY_A, { perPage: 500 })).perPage, 100);
});

test("connecting an agent keeps the first handover time, and disconnecting clears it", async () => {
  const { service, time } = makeService();
  const bot = await service.createChatbot(COMPANY_A, { title: "Desk" });
  const conv = await service.startConversation(COMPANY_A, { chatbotId: bot.id, sessionId: "h" });
  await service.recordUserMessage(COMPANY_A, conv.id, "need a human");

  time.advance(5000);
  const first = await service.updateConversationState(COMPANY_A, conv.id, { connectAgent: true });
  time.advance(5000);
  const again = await service.updateConversationState(COMPANY_A, conv.id, { connectAgent: true });
  assert.equal(again.connectAgentAt.getTime(), first.connectAgentAt.getTime());

  assert.deepEqual(await service.unreadCounts(COMPANY_A), { agent: 1, ai: 0, all: 1 });
  await service.markConversationRead(COMPANY_A, conv.id);
  assert.deepEqual(await service.unreadCounts(COMPANY_A), { agent: 0, ai: 0, all: 1 });

  const released = await service.updateConversationState(COMPANY_A, conv.id, { connectAgent: false });
  assert.equal(released.connectAgentAt, null);
});

test("startConversation refuses an inactive chatbot", async () => {
  const { service } = makeService();
  const bot = await service.createChatbot(COMPANY_A, { title: "Off", active: false });
  await assert.rejects(service.startConversation(COMPANY_A, { chatbotId: bot.id, sessionId: "x" }), (e) => e.status === 409);
});

test("recordAssistantReply stores an accepted spec as titan-ui and everything else as text", async () => {
  const { service } = makeService({ generativeUi: { registry } });
  const bot = await service.createChatbot(COMPANY_A, { title: "Gen" });
  const off = await service.createChatbot(COMPANY_A, { title: "Plain", generativeUiEnabled: false });
  const conv = await service.startConversation(COMPANY_A, { chatbotId: bot.id, sessionId: "g" });
  const plainConv = await service.startConversation(COMPANY_A, { chatbotId: off.id, sessionId: "p" });

  const fenced = `Summary.\n\`\`\`titan-ui\n${JSON.stringify(goodSpec())}\n\`\`\``;
  const accepted = await service.recordAssistantReply(COMPANY_A, conv.id, fenced, "chat");
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.message.contentType, "titan-ui");
  assert.equal(accepted.message.uiSpec.root, "root");
  assert.equal(accepted.message.message, "Summary.");

  const ignored = await service.recordAssistantReply(COMPANY_A, plainConv.id, fenced, "chat");
  assert.equal(ignored.message.contentType, "text");
  assert.equal(ignored.message.uiSpec, null);
  // Raw UI JSON must never reach the visitor as text.
  assert.equal(ignored.message.message, "Summary.");
});

// ---------- export ----------

const exportFixture = (() => {
  const t0 = new Date("2026-11-01T09:00:00.000Z");
  const conversation = { id: "conv-1", companyId: COMPANY_A, chatbotId: "bot", sessionId: "s", channel: "web", connectAgentAt: null, isShownOnHistory: true, ticketStatus: "new", pinned: false, lastActivityAt: t0, createdAt: t0, updatedAt: t0 };
  const row = (id, role, message, extra = {}) => ({ id, companyId: COMPANY_A, conversationId: "conv-1", role, message, contentType: "text", uiSpec: null, mediaUrl: null, mediaName: null, isInternalNote: false, readAt: null, createdAt: new Date(t0.getTime() + Number(id) * 1000), ...extra });
  const messages = [
    row("1", "user", 'Need "gutter", clean'),
    row("2", "assistant", "Booked."),
    row("3", "assistant", "Staff only", { isInternalNote: true }),
  ];
  return { conversation, messages, now: new Date("2026-11-02T00:00:00.000Z") };
})();

test("txt export lists visible messages and skips internal notes", () => {
  const file = exportConversation({ ...exportFixture, chatbotTitle: "Front" }, "txt");
  assert.equal(file.fileName, "conversation-conv-1.txt");
  assert.equal(file.body, "[2026-11-01 09:00:01] [USER] Need \"gutter\", clean\n\n[2026-11-01 09:00:02] [ASSISTANT] Booked.\n\n");
  assert.equal(file.body.includes("Staff only"), false);
});

test("csv export quotes fields that need it and doubles embedded quotes", () => {
  const file = exportConversation({ ...exportFixture, chatbotTitle: "Front" }, "csv");
  const lines = file.body.trimEnd().split("\n");
  assert.equal(lines[0], "Timestamp,Role,Message");
  // fputcsv() also quotes fields that contain a space, so the timestamp is quoted.
  assert.equal(lines[1], '"2026-11-01 09:00:01",USER,"Need ""gutter"", clean"');
  assert.equal(lines.length, 3);
});

test("json export keeps the snake_case keys the extension's consumers expect", () => {
  const data = JSON.parse(exportConversation({ ...exportFixture, chatbotTitle: null }, "json").body);
  assert.deepEqual(Object.keys(data), ["conversation_id", "chatbot", "exported_at", "messages"]);
  assert.equal(data.chatbot, "Chatbot");
  assert.deepEqual(Object.keys(data.messages[0]), ["role", "message", "media_url", "media_name", "timestamp"]);
  assert.equal(data.messages.length, 2);
});

test("PDF export is refused in this port", async () => {
  const { service } = makeService();
  const bot = await service.createChatbot(COMPANY_A, { title: "Bot" });
  const conv = await service.startConversation(COMPANY_A, { chatbotId: bot.id, sessionId: "pdf" });
  await assert.rejects(service.exportConversation(COMPANY_A, conv.id, "pdf"), (e) => e.status === 501);
});

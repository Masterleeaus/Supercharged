// Conversation and reply runtime tests (node:test). No network, no provider keys, no database.
// Storage, writer, providers and retriever are in-memory fakes. Drizzle SQL is captured with a recording pg client.
//
// Run: NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types tests/modules/chatbot-runtime.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { createReplyRuntime } from "../../server/modules/chatbot/runtime/reply-runtime.ts";
import { createStreamingRuntime } from "../../server/modules/chatbot/runtime/streaming-runtime.ts";
import { createDraftRuntime } from "../../server/modules/chatbot/runtime/draft-runtime.ts";
import { summarizeConversation, transcriptOf } from "../../server/modules/chatbot/runtime/summary.ts";
import { knowledgeBlock, buildReplyMessages } from "../../server/modules/chatbot/runtime/prompt-builder.ts";
import { createMemoryReplyTurnStore, createDrizzleReplyTurnStore } from "../../server/modules/chatbot/runtime/turn-store.ts";
import { createMemoryStaffDraftStore, createDrizzleStaffDraftStore } from "../../server/modules/chatbot/runtime/staff-draft-store.ts";
import { createBuilderRegistry } from "../../server/modules/chatbot/generative-ui/builder-registry.ts";
import { CONTRACT_FLAGS, readFlag } from "../../server/modules/chatbot/contracts/index.ts";
import { chatbotReplyTurns, chatbotStaffDrafts } from "../../server/modules/chatbot/db/runtime.ts";
import { advanceDelivery, DeliveryError, markFailedDelivery, retryDelivery } from "../../server/modules/chatbot/runtime/delivery-rules.ts";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const KNOWLEDGE_ON = { [CONTRACT_FLAGS.KNOWLEDGE_ENABLED]: "true" };
const NOW = new Date("2026-11-08T10:00:00Z");
const OPTIONS = { timeoutMs: 5000 };

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeWorld(seed = {}) {
  const state = {
    chatbots: seed.chatbots ?? [],
    conversations: seed.conversations ?? [],
    messages: seed.messages ?? [],
    nextId: 1,
  };
  const storage = {
    async findConversation(companyId, id) {
      return state.conversations.find((c) => c.id === id && c.companyId === companyId) ?? null;
    },
    async findChatbot(companyId, id) {
      return state.chatbots.find((c) => c.id === id && c.companyId === companyId) ?? null;
    },
    async listMessages(companyId, conversationId) {
      return state.messages.filter((m) => m.companyId === companyId && m.conversationId === conversationId);
    },
  };
  const writerCalls = [];
  const writer = {
    async recordAssistantReply(companyId, conversationId, rawText, surface) {
      writerCalls.push({ companyId, conversationId, rawText, surface });
      const message = msg({ id: `a-${state.nextId++}`, companyId, conversationId, role: "assistant", message: rawText.trim() });
      state.messages.push(message);
      return { message, accepted: false, changes: [], issues: [] };
    },
  };
  return { state, storage, writer, writerCalls };
}

function msg(fields) {
  return {
    id: fields.id,
    companyId: fields.companyId,
    conversationId: fields.conversationId,
    role: fields.role,
    message: fields.message,
    contentType: "text",
    uiSpec: null,
    mediaUrl: null,
    mediaName: null,
    isInternalNote: fields.isInternalNote ?? false,
    readAt: null,
    createdAt: NOW,
  };
}

function chatbot(companyId, id, overrides = {}) {
  return {
    id,
    companyId,
    title: overrides.title ?? `Bot ${id}`,
    language: "en",
    welcomeMessage: overrides.welcomeMessage ?? null,
    instructions: overrides.instructions ?? null,
    generativeUiEnabled: overrides.generativeUiEnabled ?? false,
    active: true,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function conversation(companyId, id, chatbotId) {
  return {
    id,
    companyId,
    chatbotId,
    sessionId: `session-${id}`,
    channel: "web",
    connectAgentAt: null,
    isShownOnHistory: true,
    ticketStatus: "new",
    pinned: false,
    lastActivityAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function fakeProvider(key, { reply = "Hello there.", error = null, events = null } = {}) {
  const calls = [];
  return {
    key,
    calls,
    async complete(companyId, request) {
      calls.push({ companyId, request, method: "complete" });
      if (error) throw error;
      return {
        provider: key,
        model: request.model,
        text: reply,
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 7, outputTokens: 3 },
        providerRequestId: null,
      };
    },
    stream(companyId, request) {
      calls.push({ companyId, request, method: "stream" });
      return (async function* () {
        for (const event of events ?? []) yield event;
      })();
    },
    async embed() {
      throw new Error("embed is not used by the runtime");
    },
  };
}

function providerError(provider, code, retryable) {
  return { provider, status: retryable ? 503 : 401, code, retryable, message: "provider said no" };
}

function fakeRetriever(byCompany) {
  const calls = [];
  return {
    calls,
    async retrieve(query) {
      calls.push(query);
      return (byCompany[query.companyId] ?? []).filter((chunk) => chunk.chatbotId === query.chatbotId);
    },
  };
}

const EMBEDDING = { provider: "openai", model: "text-embedding-test", dimensions: 3 };

function runtimeFor(world, providers, extra = {}) {
  const events = [];
  const runtime = createReplyRuntime({
    storage: world.storage,
    writer: world.writer,
    turns: extra.turns ?? createMemoryReplyTurnStore(),
    route: { providers, models: { openai: "gpt-test", anthropic: "claude-test" }, policy: { order: [], retryOnStatus: [], maxAttemptsPerProvider: 1, backoffBaseMs: 0, backoffMaxMs: 0, failoverAfterFirstDelta: false } },
    retriever: extra.retriever,
    embeddingModel: extra.retriever ? EMBEDDING : undefined,
    composer: extra.composer,
    streaming: extra.streaming,
    env: extra.env ?? {},
    onEvent: (event) => events.push(event),
    now: () => NOW,
  });
  return { runtime, events };
}

/** Recording pg client. Captures every statement Drizzle sends. Returns no rows. */
function recordingDb() {
  const statements = [];
  const client = {
    async query(config, values) {
      const text = typeof config === "string" ? config : config.text;
      const params = typeof config === "string" ? (values ?? []) : (config.values ?? values ?? []);
      statements.push({ text, params });
      return { rows: [], rowCount: 0, fields: [] };
    },
  };
  return { db: drizzle(client), statements };
}

function lastPrompt(provider) {
  return provider.calls[provider.calls.length - 1].request.messages;
}

/** Two companies, each with its own bot, conversation, history and knowledge. */
function twoCompanyWorld() {
  return fakeWorld({
    chatbots: [
      chatbot(COMPANY_A, "bot-a", { instructions: "Be formal. Company A rules.", welcomeMessage: "Welcome to A" }),
      chatbot(COMPANY_B, "bot-b", { instructions: "Be casual. Company B rules." }),
    ],
    conversations: [conversation(COMPANY_A, "conv-a", "bot-a"), conversation(COMPANY_B, "conv-b", "bot-b")],
    messages: [
      msg({ id: "m-a1", companyId: COMPANY_A, conversationId: "conv-a", role: "user", message: "What are your opening hours?" }),
      msg({ id: "m-b1", companyId: COMPANY_B, conversationId: "conv-b", role: "user", message: "What are your prices?" }),
    ],
  });
}

const KNOWLEDGE_A = [{ chunkId: "ka-1", sourceId: "src-a", sourceTitle: "A hours", ordinal: 0, text: "Company A is open 9 to 5 on weekdays. SECRET-A", score: 0.9, chatbotId: "bot-a" }];
const KNOWLEDGE_B = [{ chunkId: "kb-1", sourceId: "src-b", sourceTitle: "B prices", ordinal: 0, text: "Company B charges 40 dollars. SECRET-B", score: 0.9, chatbotId: "bot-b" }];

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

test("prompt carries the instructions, welcome message and retrieved chunks", async () => {
  const world = twoCompanyWorld();
  const provider = fakeProvider("openai");
  const retriever = fakeRetriever({ [COMPANY_A]: KNOWLEDGE_A });
  const { runtime } = runtimeFor(world, [provider], { retriever, env: KNOWLEDGE_ON });

  const outcome = await runtime.reply(COMPANY_A, "conv-a", OPTIONS);
  assert.equal(outcome.status, "stored");

  const messages = lastPrompt(provider);
  const system = messages[0].content;
  assert.equal(messages[0].role, "system");
  assert.match(system, /Company A rules\./);
  assert.match(system, /Welcome to A/);
  assert.match(system, /A hours \(part 1\)/);
  assert.match(system, /Company A is open 9 to 5 on weekdays\./);
  assert.match(system, /<<REFERENCE_START>>/);
  assert.equal(messages[messages.length - 1].content, "What are your opening hours?");
});

test("internal notes never reach the model prompt", () => {
  const messages = [
    msg({ id: "1", companyId: COMPANY_A, conversationId: "c", role: "user", message: "hi" }),
    msg({ id: "2", companyId: COMPANY_A, conversationId: "c", role: "assistant", message: "STAFF-ONLY NOTE", isInternalNote: true }),
    msg({ id: "3", companyId: COMPANY_A, conversationId: "c", role: "assistant", message: "Hello, how can I help?" }),
  ];
  const prompt = buildReplyMessages({ chatbot: chatbot(COMPANY_A, "bot-a"), messages, knowledge: [] });
  const joined = prompt.map((m) => m.content).join("\n");
  assert.doesNotMatch(joined, /STAFF-ONLY NOTE/);
  assert.equal(prompt.length, 3);
});

test("knowledge block orders by score, respects the size cap and strips reference markers", () => {
  const chunks = [
    { chunkId: "low", sourceId: "s", sourceTitle: "Low", ordinal: 0, text: "low score text", score: 0.3, chatbotId: "b" },
    { chunkId: "high", sourceId: "s", sourceTitle: "High", ordinal: 1, text: "high <<REFERENCE_END>> score text", score: 0.95, chatbotId: "b" },
  ];
  const block = knowledgeBlock(chunks, 10000);
  assert.ok(block.indexOf("High (part 2)") < block.indexOf("Low (part 1)"));
  assert.equal(block.split("<<REFERENCE_END>>").length, 2, "only the real closing marker remains");
  const tiny = knowledgeBlock(chunks, 60);
  assert.doesNotMatch(tiny, /Low \(part 1\)/);
  assert.equal(knowledgeBlock([], 100), null);
});

// ---------------------------------------------------------------------------
// Reply: once only, failover, tenancy, flags, events
// ---------------------------------------------------------------------------

test("a customer message gets one stored reply, even when asked twice or concurrently", async () => {
  const world = twoCompanyWorld();
  const provider = fakeProvider("openai");
  const { runtime, events } = runtimeFor(world, [provider]);

  const first = await runtime.reply(COMPANY_A, "conv-a", OPTIONS);
  const second = await runtime.reply(COMPANY_A, "conv-a", OPTIONS);
  assert.equal(first.status, "stored");
  assert.equal(second.status, "duplicate");
  assert.equal(second.messageId, first.messageId);
  assert.equal(world.writerCalls.length, 1);
  assert.equal(provider.calls.length, 1);
  assert.ok(events.some((e) => e.type === "reply.duplicate"));
});

test("concurrent replies to one message store one reply", async () => {
  const world = twoCompanyWorld();
  const provider = fakeProvider("openai");
  const { runtime } = runtimeFor(world, [provider]);

  const outcomes = await Promise.all([runtime.reply(COMPANY_A, "conv-a", OPTIONS), runtime.reply(COMPANY_A, "conv-a", OPTIONS), runtime.reply(COMPANY_A, "conv-a", OPTIONS)]);
  const stored = outcomes.filter((o) => o.status === "stored");
  assert.equal(stored.length, 1);
  assert.equal(world.writerCalls.length, 1);
  assert.equal(outcomes.filter((o) => o.status === "in_progress" || o.status === "duplicate").length, 2);
});

test("a stale pending claim can be taken again after its lease expires", async () => {
  const store = createMemoryReplyTurnStore();
  const first = await store.claim(COMPANY_A, "conv-a", "msg:1", NOW, 1000);
  const blocked = await store.claim(COMPANY_A, "conv-a", "msg:1", new Date(NOW.getTime() + 500), 1000);
  const taken = await store.claim(COMPANY_A, "conv-a", "msg:1", new Date(NOW.getTime() + 1500), 1000);
  assert.equal(first.kind, "claimed");
  assert.equal(blocked.kind, "pending");
  assert.equal(taken.kind, "claimed");
});

test("provider failover moves to the next provider on a retryable error only", async () => {
  const world = twoCompanyWorld();
  const primary = fakeProvider("openai", { error: providerError("openai", "upstream_unavailable", true) });
  const backup = fakeProvider("anthropic", { reply: "From backup." });
  const { runtime } = runtimeFor(world, [primary, backup]);

  const outcome = await runtime.reply(COMPANY_A, "conv-a", OPTIONS);
  assert.equal(outcome.status, "stored");
  assert.equal(backup.calls[0].request.model, "claude-test");
  assert.equal(world.state.messages.at(-1).message, "From backup.");
});

test("a non-retryable provider error is not failed over, and the turn can be retried", async () => {
  const world = twoCompanyWorld();
  const primary = fakeProvider("openai", { error: providerError("openai", "auth", false) });
  const backup = fakeProvider("anthropic");
  const { runtime, events } = runtimeFor(world, [primary, backup]);

  const outcome = await runtime.reply(COMPANY_A, "conv-a", OPTIONS);
  assert.deepEqual(outcome, { status: "failed", reason: "provider_error:auth" });
  assert.equal(backup.calls.length, 0);
  assert.equal(world.writerCalls.length, 0);
  assert.ok(events.some((e) => e.type === "reply.failed"));
});

test("failure reasons never carry the raw provider message", async () => {
  const world = twoCompanyWorld();
  const leaky = { provider: "openai", status: 500, code: "unknown", retryable: false, message: "key sk-live-SECRET123 rejected" };
  const { runtime } = runtimeFor(world, [fakeProvider("openai", { error: leaky })]);
  const outcome = await runtime.reply(COMPANY_A, "conv-a", OPTIONS);
  assert.doesNotMatch(JSON.stringify(outcome), /sk-live|SECRET123/);
});

test("with no usable provider the reply reports provider_unavailable and stores nothing", async () => {
  const world = twoCompanyWorld();
  const { runtime } = runtimeFor(world, []);
  assert.deepEqual(await runtime.reply(COMPANY_A, "conv-a", OPTIONS), { status: "provider_unavailable" });
  assert.equal(world.writerCalls.length, 0);
});

test("another company's conversation is not found: no model call, no retrieval, no write", async () => {
  const world = twoCompanyWorld();
  const provider = fakeProvider("openai");
  const retriever = fakeRetriever({ [COMPANY_A]: KNOWLEDGE_A, [COMPANY_B]: KNOWLEDGE_B });
  const { runtime } = runtimeFor(world, [provider], { retriever, env: KNOWLEDGE_ON });

  assert.deepEqual(await runtime.reply(COMPANY_B, "conv-a", OPTIONS), { status: "not_found" });
  assert.equal(provider.calls.length, 0);
  assert.equal(retriever.calls.length, 0);
  assert.equal(world.writerCalls.length, 0);
});

test("a company's knowledge is never used for another company", async () => {
  const world = twoCompanyWorld();
  const providerA = fakeProvider("openai", { reply: "A answer." });
  const providerB = fakeProvider("openai", { reply: "B answer." });
  const retriever = fakeRetriever({ [COMPANY_A]: KNOWLEDGE_A, [COMPANY_B]: KNOWLEDGE_B });

  await runtimeFor(world, [providerA], { retriever, env: KNOWLEDGE_ON }).runtime.reply(COMPANY_A, "conv-a", OPTIONS);
  await runtimeFor(world, [providerB], { retriever, env: KNOWLEDGE_ON }).runtime.reply(COMPANY_B, "conv-b", OPTIONS);

  assert.deepEqual(retriever.calls.map((q) => [q.companyId, q.chatbotId]), [[COMPANY_A, "bot-a"], [COMPANY_B, "bot-b"]]);
  const promptB = JSON.stringify(lastPrompt(providerB));
  assert.doesNotMatch(promptB, /SECRET-A|Company A/);
  assert.match(promptB, /SECRET-B/);
  const promptA = JSON.stringify(lastPrompt(providerA));
  assert.doesNotMatch(promptA, /SECRET-B|Company B/);
  assert.equal(providerA.calls[0].companyId, COMPANY_A);
  assert.equal(providerB.calls[0].companyId, COMPANY_B);
});

test("knowledge retrieval is off unless CHATBOT_KNOWLEDGE_ENABLED is exactly true", async () => {
  assert.equal(readFlag(CONTRACT_FLAGS.KNOWLEDGE_ENABLED, { [CONTRACT_FLAGS.KNOWLEDGE_ENABLED]: "1" }), false);
  for (const value of ["1", "yes", "on", "TRUE"]) {
    const world = twoCompanyWorld();
    const retriever = fakeRetriever({ [COMPANY_A]: KNOWLEDGE_A });
    const { runtime } = runtimeFor(world, [fakeProvider("openai")], { retriever, env: { [CONTRACT_FLAGS.KNOWLEDGE_ENABLED]: value } });
    await runtime.reply(COMPANY_A, "conv-a", OPTIONS);
    assert.equal(retriever.calls.length, 0, `flag value ${value} must not enable retrieval`);
  }
});

test("a failed retrieval still produces a reply without reference text", async () => {
  const world = twoCompanyWorld();
  const provider = fakeProvider("openai");
  const broken = { async retrieve() { throw new Error("index down"); } };
  const { runtime } = runtimeFor(world, [provider], { retriever: broken, env: KNOWLEDGE_ON });
  assert.equal((await runtime.reply(COMPANY_A, "conv-a", OPTIONS)).status, "stored");
  assert.doesNotMatch(lastPrompt(provider)[0].content, /REFERENCE_START/);
});

test("the generative-UI composer instructions are added when the customer asks for an interface", async () => {
  const world = fakeWorld({
    chatbots: [chatbot(COMPANY_A, "bot-a", { generativeUiEnabled: true })],
    conversations: [conversation(COMPANY_A, "conv-a", "bot-a")],
    messages: [msg({ id: "m1", companyId: COMPANY_A, conversationId: "conv-a", role: "user", message: "/ui show my prices" })],
  });
  const provider = fakeProvider("openai", { reply: "Here is a summary." });
  const composer = {
    registry: createBuilderRegistry({
      manifest: { allowed_actions: ["navigate"], surface_profiles: { chat: { density: "compact" } } },
      collections: { components: { stack: { id: "stack", category: "Layout", name: "Stack" } } },
    }),
    options: { enabled: true, naturalLanguageTriggers: true, preferredChatElements: 50 },
  };
  const { runtime } = runtimeFor(world, [provider], { composer });
  assert.equal((await runtime.reply(COMPANY_A, "conv-a", OPTIONS)).status, "stored");
  const userPrompt = lastPrompt(provider).at(-1).content;
  assert.match(userPrompt, /TITAN ZERO PRESENTATION-ONLY UI COMPOSER/);
  assert.match(userPrompt, /USER REQUEST:\n\/ui show my prices/);
});

test("reply events fire, and a failing event sink does not undo the stored reply", async () => {
  const world = twoCompanyWorld();
  const provider = fakeProvider("openai");
  const runtime = createReplyRuntime({
    storage: world.storage,
    writer: world.writer,
    turns: createMemoryReplyTurnStore(),
    route: { providers: [provider], models: { openai: "gpt-test" }, policy: { order: [], retryOnStatus: [], maxAttemptsPerProvider: 1, backoffBaseMs: 0, backoffMaxMs: 0, failoverAfterFirstDelta: false } },
    onEvent: () => {
      throw new Error("sink down");
    },
    now: () => NOW,
  });
  const outcome = await runtime.reply(COMPANY_A, "conv-a", OPTIONS);
  assert.equal(outcome.status, "stored");
  assert.equal(world.state.messages.filter((m) => m.role === "assistant").length, 1);
});

test("a reply is never stored when the model returns empty text", async () => {
  const world = twoCompanyWorld();
  const { runtime } = runtimeFor(world, [fakeProvider("openai", { reply: "   " })]);
  assert.deepEqual(await runtime.reply(COMPANY_A, "conv-a", OPTIONS), { status: "failed", reason: "empty_reply" });
  assert.equal(world.writerCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

test("streaming emits chunks in order, a final done frame, and persists the full text once", async () => {
  const frames = [];
  const persisted = [];
  const streaming = createStreamingRuntime({
    publish: async (frame) => frames.push(frame),
    persistReply: async (companyId, conversationId, text) => {
      persisted.push({ companyId, conversationId, text });
      return "msg-1";
    },
  });
  async function* events() {
    yield { type: "text-delta", text: "Hel" };
    yield { type: "text-delta", text: "" };
    yield { type: "text-delta", text: "lo" };
    yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } };
    yield { type: "done", finishReason: "stop" };
  }
  const summary = await streaming.streamReply(COMPANY_A, "conv-a", events());

  assert.deepEqual(frames.map((f) => [f.kind, f.sequence]), [["chunk", 1], ["chunk", 2], ["done", 3]]);
  assert.equal(frames.filter((f) => f.kind === "chunk").map((f) => f.text).join(""), "Hello");
  assert.equal(frames.at(-1).messageId, "msg-1");
  assert.deepEqual(persisted, [{ companyId: COMPANY_A, conversationId: "conv-a", text: "Hello" }]);
  assert.deepEqual(summary, { messageId: "msg-1", deltasSent: 2, finishReason: "stop", usage: { inputTokens: 4, outputTokens: 2 } });
});

test("a publish failure does not stop the stream or the stored reply", async () => {
  let persistCalls = 0;
  const streaming = createStreamingRuntime({
    publish: async () => {
      throw new Error("transport down");
    },
    persistReply: async () => {
      persistCalls += 1;
      return "msg-2";
    },
  });
  async function* events() {
    yield { type: "text-delta", text: "ok" };
    yield { type: "done", finishReason: "stop" };
  }
  const summary = await streaming.streamReply(COMPANY_A, "conv-a", events());
  assert.equal(summary.messageId, "msg-2");
  assert.equal(summary.deltasSent, 0);
  assert.equal(persistCalls, 1);
});

test("a stream error sends an error frame and stores nothing", async () => {
  const frames = [];
  let persistCalls = 0;
  const streaming = createStreamingRuntime({
    publish: async (frame) => frames.push(frame),
    persistReply: async () => {
      persistCalls += 1;
      return "never";
    },
  });
  async function* events() {
    yield { type: "text-delta", text: "partial" };
    yield { type: "error", error: providerError("openai", "upstream_unavailable", true) };
  }
  const summary = await streaming.streamReply(COMPANY_A, "conv-a", events());
  assert.equal(summary.finishReason, "error");
  assert.equal(summary.messageId, "");
  assert.equal(persistCalls, 0);
  assert.deepEqual(frames.map((f) => f.kind), ["chunk", "error"]);
});

test("typing frames are published without a sequence number", async () => {
  const frames = [];
  const streaming = createStreamingRuntime({ publish: async (frame) => frames.push(frame), persistReply: async () => "x" });
  await streaming.typing(COMPANY_A, "conv-a", "staff-1", true);
  assert.deepEqual(frames, [{ kind: "typing", companyId: COMPANY_A, conversationId: "conv-a", participantKey: "staff-1", active: true }]);
});

test("pipeline streamReply stores once and reports a duplicate on the second call", async () => {
  const world = twoCompanyWorld();
  const frames = [];
  const streaming = createStreamingRuntime({ publish: async (frame) => frames.push(frame) });
  const provider = fakeProvider("openai", {
    events: [
      { type: "text-delta", text: "Streamed " },
      { type: "text-delta", text: "reply." },
      { type: "done", finishReason: "stop" },
    ],
  });
  const runtime = createReplyRuntime({
    storage: world.storage,
    writer: world.writer,
    turns: createMemoryReplyTurnStore(),
    route: { providers: [provider], models: { openai: "gpt-test" }, policy: { order: [], retryOnStatus: [], maxAttemptsPerProvider: 1, backoffBaseMs: 0, backoffMaxMs: 0, failoverAfterFirstDelta: false } },
    streaming,
    now: () => NOW,
  });
  const first = await runtime.streamReply(COMPANY_A, "conv-a", OPTIONS);
  const second = await runtime.streamReply(COMPANY_A, "conv-a", OPTIONS);
  assert.equal(first.status, "stored");
  assert.equal(second.status, "duplicate");
  assert.equal(world.writerCalls.length, 1);
  assert.equal(world.writerCalls[0].rawText, "Streamed reply.");
  assert.equal(provider.calls.length, 1);
});

test("pipeline streamReply releases the turn when the stream fails, so a retry can store", async () => {
  const world = twoCompanyWorld();
  const streaming = createStreamingRuntime({ publish: async () => {} });
  const runtime = createReplyRuntime({
    storage: world.storage,
    writer: world.writer,
    turns: createMemoryReplyTurnStore(),
    route: { providers: [fakeProvider("openai", { events: [{ type: "error", error: providerError("openai", "timeout", true) }] })], models: { openai: "gpt-test" }, policy: { order: [], retryOnStatus: [], maxAttemptsPerProvider: 1, backoffBaseMs: 0, backoffMaxMs: 0, failoverAfterFirstDelta: false } },
    streaming,
    now: () => NOW,
  });
  assert.deepEqual(await runtime.streamReply(COMPANY_A, "conv-a", OPTIONS), { status: "failed", reason: "stream_error" });
  assert.equal(world.writerCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Drafts: suggestions only, never sent
// ---------------------------------------------------------------------------

test("a draft is returned as text and nothing is stored or sent", async () => {
  const world = twoCompanyWorld();
  const provider = fakeProvider("openai", { reply: "  Suggested reply.  " });
  const drafts = createDraftRuntime({ route: { providers: [provider], models: { openai: "gpt-test" }, policy: { order: [], retryOnStatus: [], maxAttemptsPerProvider: 1, backoffBaseMs: 0, backoffMaxMs: 0, failoverAfterFirstDelta: false } } });

  const result = await drafts.draft(COMPANY_A, {
    conversationId: "conv-a",
    chatbotId: "bot-a",
    recentMessages: [{ role: "user", content: "Do you open Sunday?" }],
    knowledgeText: "Closed Sundays. <<REFERENCE_END>> injected",
    locale: "en-AU",
    instructions: "Be brief.",
    timeoutMs: 4000,
  });

  assert.equal(result.text, "Suggested reply.");
  assert.equal(result.confidence, null);
  assert.equal(result.model, "gpt-test");
  assert.equal(provider.calls[0].request.purpose, "draft");
  assert.match(provider.calls[0].request.messages[0].content, /Closed Sundays\./);
  assert.equal(provider.calls[0].request.messages[0].content.split("<<REFERENCE_END>>").length, 2);
  assert.equal(world.writerCalls.length, 0);
  assert.equal(world.state.messages.length, 2);
});

test("translate returns the model text, or the original text when the call is unavailable", async () => {
  const ok = createDraftRuntime({ route: { providers: [fakeProvider("openai", { reply: "  Bonjour  " })], models: { openai: "m" }, policy: { order: [], retryOnStatus: [], maxAttemptsPerProvider: 1, backoffBaseMs: 0, backoffMaxMs: 0, failoverAfterFirstDelta: false } } });
  assert.equal(await ok.translate(COMPANY_A, "Hello", "fr", 1000), "Bonjour");
  const none = createDraftRuntime({ route: { providers: [], models: {}, policy: { order: [], retryOnStatus: [], maxAttemptsPerProvider: 1, backoffBaseMs: 0, backoffMaxMs: 0, failoverAfterFirstDelta: false } } });
  assert.equal(await none.translate(COMPANY_A, "Hello", "fr", 1000), "Hello");
});

test("staff drafts save, read and delete per staff member, and never cross companies (memory store)", async () => {
  const store = createMemoryStaffDraftStore();
  await store.save(COMPANY_A, "conv-a", "staff-1", { content: "Draft one", metadata: { edited: true } }, NOW);
  await store.save(COMPANY_A, "conv-a", "staff-2", { content: "Other staff" }, NOW);

  assert.equal((await store.get(COMPANY_A, "conv-a", "staff-1")).content, "Draft one");
  assert.equal((await store.get(COMPANY_A, "conv-a", "staff-2")).content, "Other staff");
  assert.equal(await store.get(COMPANY_B, "conv-a", "staff-1"), null);
  assert.equal(await store.delete(COMPANY_B, "conv-a", "staff-1"), false);
  assert.equal(await store.delete(COMPANY_A, "conv-a", "staff-1"), true);
  assert.equal(await store.get(COMPANY_A, "conv-a", "staff-1"), null);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

test("summary transcript strips tags and is empty without messages", async () => {
  assert.equal(transcriptOf([]), "");
  assert.equal(transcriptOf([{ role: "user", message: "<b>Hi</b> there" }]), "user: Hi there");
});

test("summary returns the model text, or a truncated transcript when the model is unavailable", async () => {
  const messages = [{ role: "user", message: "x".repeat(2000) }];
  const route = (providers) => ({ providers, models: { openai: "m" }, policy: { order: [], retryOnStatus: [], maxAttemptsPerProvider: 1, backoffBaseMs: 0, backoffMaxMs: 0, failoverAfterFirstDelta: false } });
  assert.equal(await summarizeConversation(route([fakeProvider("openai", { reply: " Short summary. " })]), COMPANY_A, messages, { timeoutMs: 1000 }), "Short summary.");
  const fallback = await summarizeConversation(route([]), COMPANY_A, messages, { timeoutMs: 1000 });
  assert.equal(fallback.length, 1200, "fallback is the first 1200 characters of the transcript");
  assert.ok(fallback.startsWith("user: "));
});

// ---------------------------------------------------------------------------
// Delivery status rules
// ---------------------------------------------------------------------------

test("delivery status only moves forward and a read message is never downgraded", () => {
  assert.deepEqual(advanceDelivery("queued", "sent"), { status: "sent", changed: true });
  assert.deepEqual(advanceDelivery("sent", "delivered"), { status: "delivered", changed: true });
  assert.deepEqual(advanceDelivery("delivered", "sent"), { status: "delivered", changed: false });
  assert.deepEqual(advanceDelivery("read", "delivered"), { status: "read", changed: false });
  assert.deepEqual(markFailedDelivery("read"), { status: "read", changed: false });
  assert.deepEqual(markFailedDelivery("sent"), { status: "failed", changed: true });
});

test("a failed message must be retried before it advances, and retry counts each attempt", () => {
  assert.throws(() => advanceDelivery("failed", "delivered"), (error) => error instanceof DeliveryError && error.code === "retry_required");
  assert.deepEqual(retryDelivery("failed", 0), { status: "queued", changed: true, retryCount: 1 });
  assert.deepEqual(retryDelivery("failed", 1), { status: "queued", changed: true, retryCount: 2 });
  assert.throws(() => retryDelivery("sent", 0), (error) => error instanceof DeliveryError && error.code === "not_failed");
});

// ---------------------------------------------------------------------------
// Drizzle SQL: every statement filters by company_id
// ---------------------------------------------------------------------------

test("reply turn claim, complete and release SQL all filter by company_id", async () => {
  const { db, statements } = recordingDb();
  const store = createDrizzleReplyTurnStore(db);
  const claim = await store.claim(COMPANY_A, "conv-a", "msg:1", NOW, 120000);
  await store.complete(COMPANY_A, "conv-a", "msg:1", "a-1", NOW);
  await store.release(COMPANY_A, "conv-a", "msg:1");

  assert.equal(claim.kind, "pending", "no row back and nothing done: the turn is held");
  assert.equal(statements.length, 4, "claim insert, claim select, complete, release");
  for (const statement of statements) {
    assert.ok(statement.params.includes(COMPANY_A), statement.text);
    assert.match(statement.text, /"company_id"/, statement.text);
  }
  assert.match(statements[0].text, /on conflict \("company_id","conversation_id","turn_key"\) do update/);
  assert.match(statements[0].text, /where \("chatbot_reply_turns"\."company_id"/);
  assert.match(statements[2].text, /^update "chatbot_reply_turns"/);
  assert.match(statements[3].text, /^delete from "chatbot_reply_turns"/);
});

test("staff draft Drizzle SQL upserts on (company_id, conversation_id, staff_id)", async () => {
  const { db, statements } = recordingDb();
  const store = createDrizzleStaffDraftStore(db, () => "draft-1");
  assert.equal(await store.get(COMPANY_A, "conv-a", null), null);
  assert.equal(await store.delete(COMPANY_A, "conv-a", "staff-1"), false);
  await assert.rejects(() => store.save(COMPANY_A, "conv-a", "staff-1", { content: "x" }, NOW), /Cannot read properties/);

  const [get, remove, save] = statements;
  assert.match(get.text, /from "chatbot_staff_drafts"/);
  assert.ok(get.params.includes(COMPANY_A) && get.params.includes(""), "anonymous staff id is stored as empty string");
  assert.match(remove.text, /^delete from "chatbot_staff_drafts"/);
  assert.ok(remove.params.includes(COMPANY_A));
  assert.match(save.text, /on conflict \("company_id","conversation_id","staff_id"\) do update/);
  assert.ok(save.params.includes(COMPANY_A));
});

test("the runtime tables carry company_id in their primary key or unique index", () => {
  for (const table of [chatbotReplyTurns, chatbotStaffDrafts]) {
    const config = getTableConfig(table);
    assert.ok(config.name.startsWith("chatbot_"), config.name);
    assert.ok(config.columns.some((column) => column.name === "company_id" && column.notNull), `${config.name} needs company_id`);
    assert.ok(config.indexes.length + config.primaryKeys.length >= 1, `${config.name} needs a key`);
  }
  const turnPk = getTableConfig(chatbotReplyTurns).primaryKeys[0];
  assert.equal(turnPk.columns[0].name, "company_id");
  const draftUnique = getTableConfig(chatbotStaffDrafts).indexes.find((index) => index.config.unique);
  assert.equal(draftUnique.config.columns[0].name, "company_id");
});

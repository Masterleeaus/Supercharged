// Voice chat pipeline tests (node:test). No network: every provider, HTTP call and store is an in-memory fake.
// Drizzle queries are rendered with PgDialect and checked for company scoping. Nothing is executed on a database.
//
// Run: NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types tests/modules/chatbot-voice.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { CONTRACT_FLAGS } from "../../server/modules/chatbot/contracts/index.ts";
import { chatbotVoiceSessions, chatbotVoiceTurns } from "../../server/modules/chatbot/db/voice.ts";
import { normalizeDurationMs, planLimitToMs, remainingMs } from "../../server/modules/chatbot/voice/limits.ts";
import { safeLogFields } from "../../server/modules/chatbot/voice/logging.ts";
import {
  createMemoryVoiceSessionStorage,
  insertVoiceSessionQuery,
  releaseVoiceSecondsQuery,
  reserveVoiceSecondsQuery,
  endVoiceSessionQuery,
  selectVoiceSessionQuery,
} from "../../server/modules/chatbot/voice/voice-storage.ts";
import { createVoiceService, DEFAULT_VOICE_CONFIG, VOICE_REPLY_RULE } from "../../server/modules/chatbot/voice/voice-service.ts";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const CHATBOT_A = "chatbot-a";
const SECRET_PHRASE = "my card number is 4111 secret";
const REPLY_TEXT = "Yes, we can book that for Monday.";
const dialect = new PgDialect();
const ON = { [CONTRACT_FLAGS.VOICE_ENABLED]: "true" };

const audio = (durationMs = 1000, bytes = [9, 9, 9]) => ({ mimeType: "audio/webm", bytes: Uint8Array.from(bytes), durationMs });

/** Builds the service with fakes. Each fake records what it was asked, so tests can check calls and stores. */
function harness({ plan = 60, env = ON, sttText = SECRET_PHRASE, modelFails = false, ttsFails = false, sttFails = false, sttDelayMs = 0, emptyReply = false } = {}) {
  const storage = createMemoryVoiceSessionStorage();
  const logs = [];
  const sttCalls = [];
  const ttsCalls = [];
  const modelCalls = [];
  const messages = [];
  const conversations = [];
  const httpCalls = [];
  let ids = 0;

  const chatbots = {
    async load(companyId, chatbotId) {
      if (companyId !== COMPANY_A || chatbotId !== CHATBOT_A) return null;
      return { id: CHATBOT_A, title: "Front desk", language: "en", instructions: "You book cleans.", welcomeMessage: "Hi" };
    },
  };
  const plans = { async voiceCallSecondsLimit() { return plan; } };
  const http = async (request) => {
    httpCalls.push(request);
    throw new Error("network is not allowed in tests");
  };
  const stt = {
    async transcribe(companyId, input, options) {
      sttCalls.push({ companyId, input, options });
      if (sttDelayMs) await new Promise((resolve) => setTimeout(resolve, sttDelayMs));
      if (sttFails) throw new Error("stt down");
      return { text: sttText, language: "en", confidence: 0.9, segments: [], provider: "fake-stt" };
    },
  };
  const tts = {
    async synthesize(companyId, input) {
      ttsCalls.push({ companyId, input });
      if (ttsFails) throw new Error("tts down");
      return { audio: Uint8Array.from([1, 2, 3]), mimeType: "audio/mpeg", provider: "fake-tts" };
    },
  };
  const models = {
    async complete(companyId, request) {
      modelCalls.push({ companyId, request });
      if (modelFails) throw new Error("model down");
      return {
        provider: "openai",
        model: request.model,
        text: emptyReply ? "  " : REPLY_TEXT,
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
        providerRequestId: null,
      };
    },
  };
  const conversationRuntime = {
    async create(companyId, input) {
      const row = { id: `conv-${conversations.length + 1}`, companyId, chatbotId: input.chatbotId, channel: input.channel, externalThreadId: null, customerId: null, status: "open", handler: "ai", summary: null, summaryUpdatedAt: null, mergedIntoId: null, createdAt: new Date(), updatedAt: new Date() };
      conversations.push(row);
      return row;
    },
  };
  const messageRuntime = {
    async create(companyId, conversationId, input) {
      if (input.idempotencyKey) {
        const existing = messages.find((m) => m.idempotencyKey === input.idempotencyKey);
        if (existing) return existing;
      }
      const row = { id: `msg-${messages.length + 1}`, companyId, conversationId, role: input.role, channel: "voice", contentKind: input.contentKind, text: input.text, status: "queued", externalMessageId: null, failureReason: null, isInternalNote: input.isInternalNote, createdAt: new Date(), updatedAt: new Date(), idempotencyKey: input.idempotencyKey };
      messages.push(row);
      return row;
    },
  };
  const service = createVoiceService({
    env,
    storage,
    chatbots,
    plans,
    conversations: conversationRuntime,
    messages: messageRuntime,
    history: { async recent() { return []; } },
    stt,
    tts,
    models,
    http,
    config: { ...DEFAULT_VOICE_CONFIG, model: "test-model", voice: "voice-1" },
    newId: () => `sess-${++ids}`,
    now: () => new Date("2026-11-08T10:00:00Z"),
    log: (fields) => logs.push(fields),
  });
  return { service, storage, logs, sttCalls, ttsCalls, modelCalls, messages, conversations, httpCalls };
}

async function startedSession(h, companyId = COMPANY_A) {
  const started = await h.service.startSession(companyId, { chatbotId: CHATBOT_A });
  assert.equal(started.ok, true, "session should start");
  return started.session;
}

// ---------------------------------------------------------------------------
// Seconds limit
// ---------------------------------------------------------------------------

test("plan limit values map to milliseconds, -1 is unlimited, bad values fail closed", () => {
  assert.equal(planLimitToMs(-1), null);
  assert.equal(planLimitToMs(0), 0);
  assert.equal(planLimitToMs(90), 90_000);
  assert.equal(planLimitToMs(null), 0);
  assert.equal(planLimitToMs(undefined), 0);
  assert.equal(planLimitToMs(12.5), 0);
  assert.equal(planLimitToMs(Number.NaN), 0);
  assert.equal(remainingMs(2000, 2500), 0);
  assert.equal(remainingMs(null, 99999), null);
  assert.equal(normalizeDurationMs(-5).ok, false);
});

test("the seconds limit stops a session: the turn that would pass it is refused and the session ends", async () => {
  const h = harness({ plan: 2 });
  const session = await startedSession(h);

  const first = await h.service.takeTurn(COMPANY_A, session.id, audio(1500));
  assert.equal(first.ok, true);
  assert.equal(first.remainingMs, 500);

  const second = await h.service.takeTurn(COMPANY_A, session.id, audio(1000));
  assert.deepEqual(second, { ok: false, code: "limit_reached" });
  assert.equal(h.sttCalls.length, 1, "a refused turn must not reach speech-to-text");

  const after = await h.service.getSession(COMPANY_A, session.id);
  assert.equal(after.status, "ended");
  assert.equal(after.endReason, "limit_reached");
  assert.equal(after.usedMs, 1500);

  assert.deepEqual(await h.service.takeTurn(COMPANY_A, session.id, audio(100)), { ok: false, code: "session_ended" });
});

test("a turn that uses up the last of the plan time ends the session at once", async () => {
  const h = harness({ plan: 2 });
  const session = await startedSession(h);
  const turn = await h.service.takeTurn(COMPANY_A, session.id, audio(2000));
  assert.equal(turn.ok, true);
  assert.equal(turn.remainingMs, 0);
  assert.equal((await h.service.getSession(COMPANY_A, session.id)).status, "ended");
  assert.deepEqual(await h.service.takeTurn(COMPANY_A, session.id, audio(1)), { ok: false, code: "session_ended" });
});

test("an unlimited plan (-1) never stops a session on time", async () => {
  const h = harness({ plan: -1 });
  const session = await startedSession(h);
  for (let i = 0; i < 3; i += 1) {
    const turn = await h.service.takeTurn(COMPANY_A, session.id, audio(600_000));
    assert.equal(turn.ok, true);
    assert.equal(turn.remainingMs, null);
  }
  assert.equal((await h.service.getSession(COMPANY_A, session.id)).status, "active");
});

test("with a finite limit, a turn whose duration is unknown is refused before any work is done", async () => {
  const h = harness({ plan: 10 });
  const session = await startedSession(h);
  const turn = await h.service.takeTurn(COMPANY_A, session.id, audio(null));
  assert.deepEqual(turn, { ok: false, code: "duration_required" });
  assert.equal(h.sttCalls.length, 0);
  assert.equal((await h.service.getSession(COMPANY_A, session.id)).usedMs, 0);
});

test("two turns racing for the last seconds: only one fits", async () => {
  const h = harness({ plan: 2, sttDelayMs: 5 });
  const session = await startedSession(h);
  const [a, b] = await Promise.all([
    h.service.takeTurn(COMPANY_A, session.id, audio(1500)),
    h.service.takeTurn(COMPANY_A, session.id, audio(1500)),
  ]);
  const results = [a, b].map((r) => (r.ok ? "ok" : r.code)).sort();
  assert.deepEqual(results, ["limit_reached", "ok"]);
  assert.equal(h.sttCalls.length, 1);
});

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

test("a session cannot be used by another company", async () => {
  const h = harness({ plan: -1 });
  const session = await startedSession(h);

  assert.equal(await h.service.getSession(COMPANY_B, session.id), null);
  assert.deepEqual(await h.service.takeTurn(COMPANY_B, session.id, audio(500)), { ok: false, code: "not_found" });
  assert.equal(await h.service.endSession(COMPANY_B, session.id), null);
  assert.deepEqual(await h.service.startSession(COMPANY_B, { chatbotId: CHATBOT_A }), { ok: false, code: "chatbot_not_found" });

  const still = await h.service.getSession(COMPANY_A, session.id);
  assert.equal(still.status, "active");
  assert.equal(still.usedMs, 0);
  assert.equal(h.sttCalls.length, 0);
  assert.equal(h.messages.length, 0);
});

test("the drizzle queries filter every statement on company_id", () => {
  const client = { async query() { return { rows: [], rowCount: 0, fields: [] }; } };
  const db = drizzle(client);
  const render = (q) => dialect.sqlToQuery(q.getSQL());

  const queries = {
    insert: render(insertVoiceSessionQuery(db, COMPANY_A, { id: "s1", chatbotId: CHATBOT_A, conversationId: "c1", limitMs: 1000, startedAt: new Date() })),
    select: render(selectVoiceSessionQuery(db, COMPANY_A, "s1")),
    reserve: render(reserveVoiceSecondsQuery(db, COMPANY_A, "s1", 500)),
    release: render(releaseVoiceSecondsQuery(db, COMPANY_A, "s1", 500)),
    end: render(endVoiceSessionQuery(db, COMPANY_A, "s1", "customer", new Date())),
  };
  for (const [name, q] of Object.entries(queries)) {
    assert.ok(q.params.includes(COMPANY_A), `${name} must bind the company id`);
    assert.ok(!q.params.includes(COMPANY_B), `${name} must not bind another company`);
  }
  assert.match(queries.select.sql, /"company_id" = \$1/);
  assert.match(queries.reserve.sql, /"company_id" = \$\d+/);
  assert.match(queries.reserve.sql, /"status" = \$\d+/, "reserve must require an active session");
  assert.match(queries.reserve.sql, /"limit_ms" is null/i);
  assert.match(queries.end.sql, /"status" = \$\d+/, "end must only move active rows");
});

// ---------------------------------------------------------------------------
// Transcripts, audio and logs
// ---------------------------------------------------------------------------

test("transcripts are stored in the conversation and the turn points at them", async () => {
  const h = harness({ plan: -1 });
  const session = await startedSession(h);
  const turn = await h.service.takeTurn(COMPANY_A, session.id, audio(800));
  assert.equal(turn.ok, true);

  assert.equal(h.conversations.length, 1);
  assert.equal(h.conversations[0].channel, "voice");
  const [customer, assistant] = h.messages;
  assert.equal(customer.role, "customer");
  assert.equal(customer.text, SECRET_PHRASE);
  assert.equal(customer.conversationId, session.conversationId);
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.text, REPLY_TEXT);
  assert.equal(assistant.conversationId, session.conversationId);

  const recorded = h.storage.turnsFor(COMPANY_A, session.id);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].customerMessageId, customer.id);
  assert.equal(recorded[0].assistantMessageId, assistant.id);

  const sent = h.modelCalls[0].request;
  assert.equal(sent.messages[0].role, "system");
  assert.ok(sent.messages[0].content.includes(VOICE_REPLY_RULE));
  assert.equal(sent.messages.at(-1).content, SECRET_PHRASE);
});

test("audio is not stored or logged, and is returned only to the caller", async () => {
  const h = harness({ plan: -1 });
  const session = await startedSession(h);
  const turn = await h.service.takeTurn(COMPANY_A, session.id, audio(800, [7, 7, 7, 7]));
  assert.equal(turn.ok, true);
  assert.deepEqual([...turn.audio.audio], [1, 2, 3], "caller gets the synthesized audio");

  const logText = JSON.stringify(h.logs);
  assert.ok(!logText.includes(SECRET_PHRASE), "transcript text must not reach logs");
  assert.ok(!logText.includes(REPLY_TEXT), "reply text must not reach logs");
  assert.ok(!logText.includes("audio"), "audio fields must not reach logs");
  assert.ok(!logText.includes("bytes"), "audio bytes must not reach logs");

  const storedTurn = JSON.stringify(h.storage.turnsFor(COMPANY_A, session.id));
  assert.ok(!storedTurn.includes("bytes") && !storedTurn.includes("audio"));

  for (const table of [chatbotVoiceSessions, chatbotVoiceTurns]) {
    const names = getTableConfig(table).columns.map((c) => c.name);
    assert.ok(names.every((name) => !/audio|bytes|blob|recording/.test(name)), `no audio column on ${getTableConfig(table).name}`);
  }
});

test("safe log fields drop audio and text even when a caller passes them", () => {
  const out = safeLogFields({ event: "voice.turn.ok", companyId: COMPANY_A, seq: 2, bytes: [1], text: SECRET_PHRASE, transcript: SECRET_PHRASE, code: "ok" });
  assert.deepEqual(Object.keys(out).sort(), ["code", "companyId", "event", "seq"]);
});

// ---------------------------------------------------------------------------
// Ended sessions and failures
// ---------------------------------------------------------------------------

test("an ended session accepts no more turns and keeps its first end record", async () => {
  const h = harness({ plan: -1 });
  const session = await startedSession(h);
  const ended = await h.service.endSession(COMPANY_A, session.id);
  assert.equal(ended.status, "ended");
  const firstEndedAt = ended.endedAt;

  assert.deepEqual(await h.service.takeTurn(COMPANY_A, session.id, audio(500)), { ok: false, code: "session_ended" });
  assert.equal(h.sttCalls.length, 0);
  assert.equal(h.messages.length, 0);

  const again = await h.service.endSession(COMPANY_A, session.id, "failed");
  assert.equal(again.endReason, "customer");
  assert.equal(again.endedAt.getTime(), firstEndedAt.getTime());
});

test("text-to-speech failure still returns and stores the text reply", async () => {
  const h = harness({ plan: -1, ttsFails: true });
  const session = await startedSession(h);
  const turn = await h.service.takeTurn(COMPANY_A, session.id, audio(500));
  assert.equal(turn.ok, true);
  assert.equal(turn.audio, null);
  assert.equal(turn.reply, REPLY_TEXT);
  assert.equal(h.messages.length, 2);
});

test("a failed reply gives back the seconds and records no turn", async () => {
  const h = harness({ plan: 5, modelFails: true });
  const session = await startedSession(h);
  const turn = await h.service.takeTurn(COMPANY_A, session.id, audio(1200));
  assert.deepEqual(turn, { ok: false, code: "reply_failed" });
  const after = await h.service.getSession(COMPANY_A, session.id);
  assert.equal(after.usedMs, 0, "seconds are returned when no reply was produced");
  assert.equal(after.status, "active");
  assert.equal(h.storage.turnsFor(COMPANY_A, session.id).length, 0);
  assert.ok(h.messages.every((m) => m.role !== "assistant"));
});

test("speech-to-text failure and an empty transcript both give back the seconds", async () => {
  const failing = harness({ plan: 5, sttFails: true });
  const s1 = await startedSession(failing);
  assert.deepEqual(await failing.service.takeTurn(COMPANY_A, s1.id, audio(900)), { ok: false, code: "transcription_failed" });
  assert.equal((await failing.service.getSession(COMPANY_A, s1.id)).usedMs, 0);

  const silent = harness({ plan: 5, sttText: "   " });
  const s2 = await startedSession(silent);
  assert.deepEqual(await silent.service.takeTurn(COMPANY_A, s2.id, audio(900)), { ok: false, code: "empty_transcript" });
  assert.equal((await silent.service.getSession(COMPANY_A, s2.id)).usedMs, 0);
  assert.equal(silent.messages.length, 0);
});

// ---------------------------------------------------------------------------
// Flags and configuration
// ---------------------------------------------------------------------------

test("voice is off unless the flag is exactly the string true", async () => {
  for (const value of [undefined, "1", "yes", "on", "TRUE"]) {
    const h = harness({ env: { [CONTRACT_FLAGS.VOICE_ENABLED]: value } });
    assert.deepEqual(await h.service.startSession(COMPANY_A, { chatbotId: CHATBOT_A }), { ok: false, code: "disabled" });
  }
  const on = harness({ env: ON });
  assert.equal((await on.service.startSession(COMPANY_A, { chatbotId: CHATBOT_A })).ok, true);
});

test("invalid voice config is rejected when the service is built", () => {
  const base = harness();
  assert.throws(
    () => createVoiceService({ ...depsFrom(base), config: { ...DEFAULT_VOICE_CONFIG, model: "m", voice: "v", sttTimeoutMs: 0 } }),
    /sttTimeoutMs/,
  );
});

// Rebuilds the deps object used by harness(), for the config test.
function depsFrom(h) {
  return {
    env: ON,
    storage: h.storage,
    chatbots: { load: async () => null },
    plans: { voiceCallSecondsLimit: async () => -1 },
    conversations: { create: async () => ({}) },
    messages: { create: async () => ({}) },
    history: { recent: async () => [] },
    stt: { transcribe: async () => ({}) },
    tts: { synthesize: async () => ({}) },
    models: { complete: async () => ({}) },
    http: async () => { throw new Error("network is not allowed in tests"); },
  };
}

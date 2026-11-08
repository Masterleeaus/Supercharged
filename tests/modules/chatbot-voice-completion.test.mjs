/**
 * Completion pass for voice sessions and voice calls: idle expiry, one outbox event per session end, speech adapters
 * behind their contracts, owner credit for calls, the call-limit sweep, and the in-memory call provider.
 * No network: every HTTP call goes to a fake. No test reads a real provider key.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { CONTRACT_FLAGS } from "../../server/modules/chatbot/contracts/index.ts";
import { createVoiceService, DEFAULT_VOICE_CONFIG } from "../../server/modules/chatbot/voice/voice-service.ts";
import {
  createMemoryVoiceSessionStorage,
  insertSessionEndedOutboxQuery,
  selectIdleVoiceSessionsQuery,
} from "../../server/modules/chatbot/voice/voice-storage.ts";
import { buildSessionEndedEvent, VOICE_SESSION_ENDED_TOPIC } from "../../server/modules/chatbot/voice/outbox.ts";
import { isIdle } from "../../server/modules/chatbot/voice/limits.ts";
import {
  createGeminiSpeechToText,
  createGeminiTextToSpeech,
  pcmToWav,
} from "../../server/modules/chatbot/voice/speech-gemini.ts";
import { VoiceCallService } from "../../server/modules/chatbot/voice-call/service.ts";
import { MemoryVoiceCallStorage } from "../../server/modules/chatbot/voice-call/storage-memory.ts";
import { MemoryCallProvider, signMemoryWebhook } from "../../server/modules/chatbot/voice-call/provider-memory.ts";
import { sweepCallLimits } from "../../server/modules/chatbot/voice-call/scheduler.ts";
import { signWebhookPayload } from "../../server/modules/chatbot/voice-call/policy.ts";
import { listInProgressForCompanyQuery } from "../../server/modules/chatbot/voice-call/storage-drizzle.ts";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const CHATBOT_A = "chatbot-a";
const CHATBOT_B = "chatbot-b";
const HOST = "hooks.example.test";
const T0 = new Date("2026-11-08T10:00:00.000Z");
const ON = { [CONTRACT_FLAGS.VOICE_ENABLED]: "true" };
const MIN = 60_000;
const SECRET_PHRASE = "my card number is 4111 secret";
const REPLY_TEXT = "Yes, Monday works for us.";

// ===========================================================================
// Voice sessions
// ===========================================================================

const audio = (durationMs = 1000) => ({ mimeType: "audio/webm", bytes: Uint8Array.from([9, 9, 9]), durationMs });

function voiceHarness({ idleTimeoutMs = DEFAULT_VOICE_CONFIG.idleTimeoutMs, sttText = SECRET_PHRASE } = {}) {
  const clock = { now: new Date(T0) };
  const storage = createMemoryVoiceSessionStorage({ now: () => clock.now });
  const logs = [];
  const messages = [];
  let ids = 0;
  const service = createVoiceService({
    env: ON,
    storage,
    chatbots: {
      async load(companyId, chatbotId) {
        if (companyId !== COMPANY_A || chatbotId !== CHATBOT_A) return null;
        return { id: CHATBOT_A, title: "Front desk", language: "en", instructions: null, welcomeMessage: null };
      },
    },
    plans: { async voiceCallSecondsLimit() { return -1; } },
    conversations: {
      async create(companyId, input) {
        return { id: `conv-${++ids}`, companyId, chatbotId: input.chatbotId, channel: input.channel, externalThreadId: null, customerId: null, status: "open", handler: "ai", summary: null, summaryUpdatedAt: null, mergedIntoId: null, createdAt: new Date(), updatedAt: new Date() };
      },
    },
    messages: {
      async create(companyId, conversationId, input) {
        const row = { id: `msg-${messages.length + 1}`, companyId, conversationId, role: input.role, text: input.text };
        messages.push(row);
        return row;
      },
    },
    history: { async recent() { return []; } },
    stt: { async transcribe() { return { text: sttText, language: "en", confidence: null, segments: [], provider: "fake-stt" }; } },
    tts: { async synthesize() { return { audio: Uint8Array.from([1, 2, 3]), mimeType: "audio/wav", provider: "fake-tts" }; } },
    models: {
      async complete(_companyId, request) {
        return { provider: "fake", model: request.model, text: REPLY_TEXT, toolCalls: [], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, providerRequestId: null };
      },
    },
    http: async () => { throw new Error("network is not allowed in tests"); },
    config: { ...DEFAULT_VOICE_CONFIG, model: "test-model", voice: "voice-1", idleTimeoutMs },
    newId: () => `sess-${++ids}`,
    now: () => clock.now,
    log: (fields) => logs.push(fields),
  });
  return { service, storage, clock, logs, messages };
}

async function startVoice(h, companyId = COMPANY_A) {
  const started = await h.service.startSession(companyId, { chatbotId: CHATBOT_A });
  assert.equal(started.ok, true, "session should start");
  return started.session;
}

test("idle expiry: a session with no activity for the idle timeout ends with reason idle", async () => {
  const h = voiceHarness({ idleTimeoutMs: 5 * MIN });
  const session = await startVoice(h);
  h.clock.now = new Date(T0.getTime() + 5 * MIN - 1000);
  assert.equal(await h.service.expireIdleSessions(COMPANY_A), 0, "not idle yet");

  h.clock.now = new Date(T0.getTime() + 5 * MIN);
  assert.equal(await h.service.expireIdleSessions(COMPANY_A), 1);
  const row = await h.storage.get(COMPANY_A, session.id);
  assert.equal(row.status, "ended");
  assert.equal(row.endReason, "idle");
});

test("a turn moves the idle clock: a session that takes turns is not expired early", async () => {
  const h = voiceHarness({ idleTimeoutMs: 5 * MIN });
  const session = await startVoice(h);
  h.clock.now = new Date(T0.getTime() + 4 * MIN);
  const turn = await h.service.takeTurn(COMPANY_A, session.id, audio());
  assert.equal(turn.ok, true);

  h.clock.now = new Date(T0.getTime() + 8 * MIN); // 4 minutes since the turn
  assert.equal(await h.service.expireIdleSessions(COMPANY_A), 0);
  h.clock.now = new Date(T0.getTime() + 9 * MIN + 1000); // just over 5 minutes since the turn
  assert.equal(await h.service.expireIdleSessions(COMPANY_A), 1);
});

test("a turn that arrives after the idle timeout ends the session and takes no turn", async () => {
  const h = voiceHarness({ idleTimeoutMs: 5 * MIN });
  const session = await startVoice(h);
  h.clock.now = new Date(T0.getTime() + 6 * MIN);
  const turn = await h.service.takeTurn(COMPANY_A, session.id, audio());
  assert.deepEqual(turn, { ok: false, code: "session_ended" });
  assert.equal(h.messages.length, 0, "no transcript is written for an idle session");
  const row = await h.storage.get(COMPANY_A, session.id);
  assert.equal(row.endReason, "idle");
});

test("a session end writes exactly one outbox event, however many ends follow", async () => {
  const h = voiceHarness({ idleTimeoutMs: 5 * MIN });
  const session = await startVoice(h);
  await h.service.endSession(COMPANY_A, session.id, "customer");
  await h.service.endSession(COMPANY_A, session.id, "limit_reached");
  h.clock.now = new Date(T0.getTime() + 10 * MIN);
  await h.service.expireIdleSessions(COMPANY_A);

  const events = h.storage.outboxEvents(COMPANY_A);
  assert.equal(events.length, 1);
  assert.equal(events[0].topic, VOICE_SESSION_ENDED_TOPIC);
  assert.equal(events[0].aggregateId, session.id);
  assert.equal(events[0].dedupeKey, `${VOICE_SESSION_ENDED_TOPIC}:${session.id}`);
  assert.equal(events[0].payload.endReason, "customer", "the first end reason is the one recorded");
});

test("two ends racing each other still write one outbox event", async () => {
  const h = voiceHarness();
  const session = await startVoice(h);
  await Promise.all([
    h.service.endSession(COMPANY_A, session.id, "customer"),
    h.service.endSession(COMPANY_A, session.id, "failed"),
  ]);
  assert.equal(h.storage.outboxEvents(COMPANY_A).length, 1);
});

test("the session-ended event carries ids and counts only, never transcript, reply or audio", async () => {
  const h = voiceHarness();
  const session = await startVoice(h);
  const turn = await h.service.takeTurn(COMPANY_A, session.id, audio());
  assert.equal(turn.ok, true);
  await h.service.endSession(COMPANY_A, session.id, "customer");

  const [event] = h.storage.outboxEvents(COMPANY_A);
  const text = JSON.stringify(event);
  assert.equal(text.includes(SECRET_PHRASE), false, "transcript text must not reach the outbox");
  assert.equal(text.includes("secret"), false, "transcript words must not reach the outbox");
  assert.equal(text.includes(REPLY_TEXT), false, "reply text must not reach the outbox");
  assert.deepEqual(Object.keys(event.payload).sort(), ["chatbotId", "conversationId", "endReason", "endedAt", "sessionId", "turnCount", "usedMs"]);
  assert.equal(event.payload.turnCount, 1);
});

test("idle expiry is company-scoped: another company's sweep never ends or reports this company's session", async () => {
  const h = voiceHarness({ idleTimeoutMs: 5 * MIN });
  const session = await startVoice(h);
  h.clock.now = new Date(T0.getTime() + 6 * MIN);
  assert.equal(await h.service.expireIdleSessions(COMPANY_B), 0);
  assert.equal((await h.storage.get(COMPANY_A, session.id)).status, "active");
  assert.equal(h.storage.outboxEvents(COMPANY_A).length, 0);
  assert.equal(h.storage.outboxEvents(COMPANY_B).length, 0);
});

test("isIdle compares the last activity with the timeout, inclusive at the boundary", () => {
  assert.equal(isIdle(new Date(T0), new Date(T0.getTime() + 299_999), 300_000), false);
  assert.equal(isIdle(new Date(T0), new Date(T0.getTime() + 300_000), 300_000), true);
});

test("the outbox event builder refuses a session that has not ended", () => {
  assert.throws(() => buildSessionEndedEvent({ companyId: COMPANY_A, id: "s", endedAt: null, endReason: null }), /ended session/);
});

test("drizzle: the idle query and the outbox insert both filter or write on company_id", () => {
  const db = drizzle({ client: { query: async () => ({ rows: [], rowCount: 0 }) } });
  const idle = selectIdleVoiceSessionsQuery(db, COMPANY_A, T0, 10).toSQL();
  assert.match(idle.sql, /"company_id" = \$1/);
  assert.ok(idle.params.includes(COMPANY_A));
  assert.match(idle.sql, /"updated_at" </);

  const ended = {
    id: "sess-1",
    companyId: COMPANY_A,
    chatbotId: CHATBOT_A,
    conversationId: "conv-1",
    status: "ended",
    endReason: "idle",
    limitMs: null,
    usedMs: 0,
    turnCount: 0,
    startedAt: T0,
    endedAt: T0,
    createdAt: T0,
    updatedAt: T0,
  };
  const event = { ...buildSessionEndedEvent(ended), id: "evt-1" };
  const insert = insertSessionEndedOutboxQuery(db, event, T0).toSQL();
  assert.match(insert.sql, /insert into "chatbot_event_outbox"/i);
  assert.ok(insert.params.includes(COMPANY_A));
});

// ===========================================================================
// Speech adapters
// ===========================================================================

function speechHttp(responder) {
  const calls = [];
  const http = async (request) => {
    calls.push(request);
    return responder(request);
  };
  return { http, calls };
}

const ok200 = (json) => ({ status: 200, headers: {}, body: JSON.stringify(json) });

test("speech-to-text: sends base64 audio with the key in a header only, and returns the trimmed transcript", async () => {
  const { http, calls } = speechHttp(() => ok200({ candidates: [{ content: { parts: [{ text: " Book Monday " }] } }] }));
  const stt = createGeminiSpeechToText({
    keys: async (companyId) => (companyId === COMPANY_A ? "key-A-secret" : null),
    model: "gemini-test-stt",
  });
  const transcript = await stt.transcribe(COMPANY_A, { mimeType: "audio/wav", bytes: Uint8Array.from([1, 2, 3]), durationMs: 500 }, { language: "en", timeoutMs: 9000 }, http);

  assert.equal(transcript.text, "Book Monday");
  assert.equal(transcript.provider, "gemini");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /\/models\/gemini-test-stt:generateContent$/);
  assert.equal(calls[0].timeoutMs, 9000);
  assert.equal(calls[0].headers["x-goog-api-key"], "key-A-secret");
  assert.equal(calls[0].url.includes("key-A-secret"), false, "the key is never in the URL");
  assert.equal(calls[0].body.includes("AQID"), true, "audio bytes travel as base64 (AQID is 1,2,3)");
});

test("speech-to-text refuses unsupported audio and a company with no key, without any network call", async () => {
  const { http, calls } = speechHttp(() => ok200({}));
  const stt = createGeminiSpeechToText({ keys: async (companyId) => (companyId === COMPANY_A ? "key-A" : null), model: "m-1" });
  await assert.rejects(stt.transcribe(COMPANY_A, { mimeType: "audio/webm", bytes: Uint8Array.from([1]), durationMs: 1 }, { language: null, timeoutMs: 100 }, http), (e) => e.code === "unsupported_audio");
  await assert.rejects(stt.transcribe(COMPANY_B, { mimeType: "audio/wav", bytes: Uint8Array.from([1]), durationMs: 1 }, { language: null, timeoutMs: 100 }, http), (e) => e.code === "no_key");
  assert.equal(calls.length, 0);
});

test("speech-to-text provider errors carry a status and never the key or the response body", async () => {
  const { http } = speechHttp(() => ({ status: 500, headers: {}, body: "key-A-secret echoed back, transcript text here" }));
  const stt = createGeminiSpeechToText({ keys: async () => "key-A-secret", model: "m-1" });
  await assert.rejects(stt.transcribe(COMPANY_A, { mimeType: "audio/wav", bytes: Uint8Array.from([1]), durationMs: 1 }, { language: null, timeoutMs: 100 }, http), (e) => {
    assert.equal(e.code, "provider_status");
    assert.equal(e.status, 500);
    assert.equal(e.message.includes("key-A-secret"), false);
    assert.equal(e.message.includes("transcript text"), false);
    return true;
  });
});

test("text-to-speech: wraps the returned PCM in a WAV header at the rate the provider names", async () => {
  const pcm = Buffer.from([0, 0, 1, 0]).toString("base64");
  const { http, calls } = speechHttp(() =>
    ok200({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: pcm } }] } }] }),
  );
  const tts = createGeminiTextToSpeech({ keys: async (companyId) => (companyId === COMPANY_A ? "key-A" : null), model: "tts-test" });
  const out = await tts.synthesize(COMPANY_A, { text: "Hello there.", voice: "voice-test", language: "en", format: "wav", timeoutMs: 7000 }, http);

  assert.equal(out.mimeType, "audio/wav");
  assert.equal(out.audio.byteLength, 44 + 4);
  const view = new DataView(out.audio.buffer, out.audio.byteOffset, out.audio.byteLength);
  assert.equal(Buffer.from(out.audio.subarray(0, 4)).toString("ascii"), "RIFF");
  assert.equal(Buffer.from(out.audio.subarray(8, 12)).toString("ascii"), "WAVE");
  assert.equal(view.getUint32(24, true), 24000, "sample rate from the mime type");
  assert.equal(view.getUint32(40, true), 4, "data length");
  assert.equal(calls[0].timeoutMs, 7000);
  assert.equal(calls[0].body.includes("voice-test"), true);
});

test("text-to-speech refuses formats other than wav and empty text, with no network call", async () => {
  const { http, calls } = speechHttp(() => ok200({}));
  const tts = createGeminiTextToSpeech({ keys: async () => "key", model: "tts-test" });
  await assert.rejects(tts.synthesize(COMPANY_A, { text: "Hi", voice: "v", language: "en", format: "mp3", timeoutMs: 100 }, http), (e) => e.code === "unsupported_format");
  await assert.rejects(tts.synthesize(COMPANY_A, { text: "   ", voice: "v", language: "en", format: "wav", timeoutMs: 100 }, http), (e) => e.code === "empty_input");
  assert.equal(calls.length, 0);
});

test("a model id that could change the URL is refused when the adapter is built", () => {
  assert.throws(() => createGeminiSpeechToText({ keys: async () => "k", model: "../other/path" }), (e) => e.code === "bad_model");
  assert.throws(() => createGeminiTextToSpeech({ keys: async () => "k", model: "a b" }), (e) => e.code === "bad_model");
});

test("pcmToWav writes a 44-byte PCM header with the channel, rate and bit depth", () => {
  const wav = pcmToWav(Uint8Array.from([1, 0]), 8000);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(wav.byteLength, 46);
  assert.equal(view.getUint16(22, true), 1, "mono");
  assert.equal(view.getUint32(24, true), 8000, "sample rate");
  assert.equal(view.getUint32(28, true), 16000, "byte rate = rate x 2 bytes");
  assert.equal(view.getUint16(34, true), 16, "bits per sample");
});

// ===========================================================================
// Voice calls: owner credit, quota sweep, scheduler, in-memory provider
// ===========================================================================

const CALLBACK = (companyId, chatbotId) => `https://${HOST}/voice/${companyId}/${chatbotId}/status`;
const iso = (date) => date.toISOString();

function callHarness({ limit = 60, funded = true, creditsThrow = false, chargeFails = false } = {}) {
  const clock = { now: new Date(T0) };
  const storage = new MemoryVoiceCallStorage();
  const provider = new MemoryCallProvider();
  const logs = [];
  const charges = [];
  const credits = {
    async hasBalance() {
      if (creditsThrow) throw new Error("ledger unreachable");
      return funded;
    },
    async chargeTranscript(companyId, chatbotId, input) {
      if (chargeFails) throw new Error("ledger write failed");
      charges.push({ companyId, chatbotId, ...input });
    },
  };
  const logger = { info: (message, fields) => logs.push({ message, fields }), warn: (message, fields) => logs.push({ message, fields }) };
  const deps = {
    storage,
    provider,
    http: async () => { throw new Error("network is not allowed in tests"); },
    quota: { secondsLimitFor: async (c, b) => (`${c}:${b}` === `${COMPANY_A}:${CHATBOT_A}` || `${c}:${b}` === `${COMPANY_B}:${CHATBOT_B}` ? limit : null) },
    chatbots: { exists: async (c, b) => `${c}:${b}` === `${COMPANY_A}:${CHATBOT_A}` || `${c}:${b}` === `${COMPANY_B}:${CHATBOT_B}` },
    credentials: { load: async (c) => ({ secret: `secret-${c}` }) },
    credits,
    logger,
    env: ON,
    callbackHosts: [HOST],
    clock: () => clock.now,
  };
  const service = new VoiceCallService(deps);
  return { service, storage, provider, logs, charges, clock, deps };
}

async function placeCall(h, companyId = COMPANY_A, chatbotId = CHATBOT_A, key = "start-1") {
  const started = await h.service.startOutbound({
    companyId,
    chatbotId,
    toNumber: "+61 298 765 432",
    fromNumber: "+61 412 345 678",
    statusCallbackUrl: CALLBACK(companyId, chatbotId),
    idempotencyKey: key,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  return started.value;
}

function sendWebhook(h, companyId, chatbotId, events, { secret = `secret-${companyId}` } = {}) {
  const body = signMemoryWebhook({ secret, timestamp: String(Math.floor(h.clock.now.getTime() / 1000)), events });
  return h.service.handleWebhook(companyId, chatbotId, body);
}

test("a call over its quota is ended at the cap, the provider hangs up, and the duration is the cap", async () => {
  const h = callHarness({ limit: 60 });
  const call = await placeCall(h);
  await sendWebhook(h, COMPANY_A, CHATBOT_A, [{ type: "answered", providerCallId: call.providerCallId, occurredAt: iso(h.clock.now) }]);

  h.clock.now = new Date(T0.getTime() + 61_000);
  const sweep = await h.service.enforceLimitsForCompany(COMPANY_A, { limit: 50 });
  assert.equal(sweep.ok, true);
  assert.deepEqual(sweep.value, { ended: 1, scanned: 1 });

  const after = await h.service.getSession(COMPANY_A, CHATBOT_A, call.id);
  assert.equal(after.value.status, "completed");
  assert.equal(after.value.endReason, "limit_reached");
  assert.equal(after.value.durationSeconds, 60);
  assert.deepEqual(h.provider.hungUpCalls(COMPANY_A), [call.providerCallId]);
});

test("the sweep is company-scoped: sweeping company B never ends company A's call", async () => {
  const h = callHarness({ limit: 60 });
  const callA = await placeCall(h, COMPANY_A, CHATBOT_A, "a-1");
  await sendWebhook(h, COMPANY_A, CHATBOT_A, [{ type: "answered", providerCallId: callA.providerCallId, occurredAt: iso(h.clock.now) }]);
  const callB = await placeCall(h, COMPANY_B, CHATBOT_B, "b-1");
  await sendWebhook(h, COMPANY_B, CHATBOT_B, [{ type: "answered", providerCallId: callB.providerCallId, occurredAt: iso(h.clock.now) }]);

  h.clock.now = new Date(T0.getTime() + 61_000);
  const [report] = await sweepCallLimits(h.service, [COMPANY_B]);
  assert.deepEqual(report, { companyId: COMPANY_B, ok: true, ended: 1, error: null });
  assert.equal((await h.service.getSession(COMPANY_A, CHATBOT_A, callA.id)).value.status, "in_progress");
  assert.deepEqual(h.provider.hungUpCalls(COMPANY_A), []);

  const [reportA] = await sweepCallLimits(h.service, [COMPANY_A]);
  assert.equal(reportA.ended, 1);
});

test("the sweep carries on past a company that fails, and reports the failure without the raw message", async () => {
  const h = callHarness({ limit: 60 });
  const call = await placeCall(h);
  await sendWebhook(h, COMPANY_A, CHATBOT_A, [{ type: "answered", providerCallId: call.providerCallId, occurredAt: iso(h.clock.now) }]);
  h.clock.now = new Date(T0.getTime() + 61_000);

  const reports = await sweepCallLimits(h.service, ["not-a-company-id", COMPANY_A]);
  assert.equal(reports[0].ok, false);
  assert.equal(reports[0].error, "sweep failed");
  assert.equal(reports[1].ok, true);
  assert.equal(reports[1].ended, 1);
});

test("the sweep still ends over-cap calls when the voice flag is off", async () => {
  const h = callHarness({ limit: 60 });
  const call = await placeCall(h);
  await sendWebhook(h, COMPANY_A, CHATBOT_A, [{ type: "answered", providerCallId: call.providerCallId, occurredAt: iso(h.clock.now) }]);
  h.clock.now = new Date(T0.getTime() + 61_000);
  const offService = new VoiceCallService({ ...h.deps, env: {} });
  const sweep = await offService.enforceLimitsForCompany(COMPANY_A, { limit: 50 });
  assert.deepEqual(sweep.value, { ended: 1, scanned: 1 });
});

test("the sweep batch must be a positive integer", async () => {
  const h = callHarness();
  await assert.rejects(sweepCallLimits(h.service, [COMPANY_A], { limit: 0 }), /positive integer/);
});

test("a call that has not been answered is not ended by the sweep", async () => {
  const h = callHarness({ limit: 60 });
  const call = await placeCall(h);
  h.clock.now = new Date(T0.getTime() + 10 * 60_000);
  const sweep = await h.service.enforceLimitsForCompany(COMPANY_A, { limit: 50 });
  assert.deepEqual(sweep.value, { ended: 0, scanned: 0 });
  assert.equal((await h.service.getSession(COMPANY_A, CHATBOT_A, call.id)).value.status, "ringing");
});

test("owner credit: a call is refused when the owner has no balance, and no call row is written", async () => {
  const h = callHarness({ funded: false });
  const started = await h.service.startOutbound({
    companyId: COMPANY_A,
    chatbotId: CHATBOT_A,
    toNumber: "+61 298 765 432",
    fromNumber: "+61 412 345 678",
    statusCallbackUrl: CALLBACK(COMPANY_A, CHATBOT_A),
    idempotencyKey: "credit-1",
  });
  assert.deepEqual(started, { ok: false, status: 403, error: "Insufficient credits for voice call." });
  assert.equal((await h.storage.listActive(COMPANY_A, CHATBOT_A)).length, 0);
  assert.equal(h.provider.requests().length, 0, "no provider call is placed");
});

test("owner credit: a balance check that throws refuses the call as well", async () => {
  const h = callHarness({ creditsThrow: true });
  const started = await h.service.startOutbound({
    companyId: COMPANY_A,
    chatbotId: CHATBOT_A,
    toNumber: "+61 298 765 432",
    fromNumber: "+61 412 345 678",
    statusCallbackUrl: CALLBACK(COMPANY_A, CHATBOT_A),
    idempotencyKey: "credit-2",
  });
  assert.equal(started.ok, false);
  assert.equal(started.status, 403);
});

test("owner credit: each transcript on a live call is charged once, with a key that a redelivery repeats", async () => {
  const h = callHarness();
  const call = await placeCall(h);
  await sendWebhook(h, COMPANY_A, CHATBOT_A, [{ type: "answered", providerCallId: call.providerCallId, occurredAt: iso(h.clock.now) }]);

  const body = signMemoryWebhook({
    secret: `secret-${COMPANY_A}`,
    timestamp: String(Math.floor(h.clock.now.getTime() / 1000)),
    events: [{ type: "transcript", providerCallId: call.providerCallId, occurredAt: iso(h.clock.now), text: "  Can you come Monday?  " }],
  });
  const first = await h.service.handleWebhook(COMPANY_A, CHATBOT_A, body);
  assert.deepEqual(first, { ok: true, value: { processed: 1, ignored: 0 } });
  const second = await h.service.handleWebhook(COMPANY_A, CHATBOT_A, body);
  assert.equal(second.ok, true);

  assert.equal(h.charges.length, 2, "the ledger is asked twice, and it dedupes on the key");
  assert.equal(h.charges[0].text, "Can you come Monday?");
  assert.equal(h.charges[0].callId, call.id);
  assert.equal(h.charges[0].idempotencyKey, h.charges[1].idempotencyKey);
  assert.equal(JSON.stringify(h.logs).includes("Can you come Monday"), false, "transcript text is never logged");
});

test("owner credit: a transcript on a call that has already ended is not charged", async () => {
  const h = callHarness();
  const call = await placeCall(h);
  await sendWebhook(h, COMPANY_A, CHATBOT_A, [
    { type: "answered", providerCallId: call.providerCallId, occurredAt: iso(h.clock.now) },
    { type: "completed", providerCallId: call.providerCallId, occurredAt: iso(h.clock.now) },
  ]);
  const late = await sendWebhook(h, COMPANY_A, CHATBOT_A, [{ type: "transcript", providerCallId: call.providerCallId, occurredAt: iso(h.clock.now), text: "late words" }]);
  assert.deepEqual(late, { ok: true, value: { processed: 0, ignored: 1 } });
  assert.equal(h.charges.length, 0);
});

test("owner credit: when the charge cannot be recorded the webhook is refused with 503, so the provider retries", async () => {
  const h = callHarness({ chargeFails: true });
  const call = await placeCall(h);
  await sendWebhook(h, COMPANY_A, CHATBOT_A, [{ type: "answered", providerCallId: call.providerCallId, occurredAt: iso(h.clock.now) }]);
  const refused = await sendWebhook(h, COMPANY_A, CHATBOT_A, [{ type: "transcript", providerCallId: call.providerCallId, occurredAt: iso(h.clock.now), text: "words" }]);
  assert.deepEqual(refused, { ok: false, status: 503, error: "Credit could not be recorded" });
  assert.equal(JSON.stringify(h.logs).includes("words"), false);
});

test("the in-memory provider verifies signatures for real: a wrong secret is refused and changes nothing", async () => {
  const h = callHarness();
  const call = await placeCall(h);
  const refused = await sendWebhook(h, COMPANY_A, CHATBOT_A, [{ type: "answered", providerCallId: call.providerCallId, occurredAt: iso(h.clock.now) }], { secret: "not-the-secret" });
  assert.deepEqual(refused, { ok: false, status: 401, error: "Webhook rejected" });
  assert.equal((await h.service.getSession(COMPANY_A, CHATBOT_A, call.id)).value.status, "ringing");
});

test("the in-memory provider refuses a malformed body that is correctly signed", async () => {
  const h = callHarness();
  await placeCall(h);
  const timestamp = String(Math.floor(h.clock.now.getTime() / 1000));
  const rawBody = "not json";
  const signed = { rawBody, timestamp, signature: signWebhookPayload(`secret-${COMPANY_A}`, timestamp, rawBody) };
  assert.deepEqual(await h.service.handleWebhook(COMPANY_A, CHATBOT_A, signed), { ok: false, status: 400, error: "Malformed webhook" });
});

test("the in-memory provider receives no credentials in its request log and makes no network call", async () => {
  const h = callHarness();
  await placeCall(h);
  const [request] = h.provider.requests();
  assert.equal(request.companyId, COMPANY_A);
  assert.equal(JSON.stringify(request).includes("secret-"), false);
});

test("drizzle: the in-progress sweep query filters on company_id before it filters on status", () => {
  const db = drizzle({ client: { query: async () => ({ rows: [], rowCount: 0 }) } });
  const { sql, params } = listInProgressForCompanyQuery(db, COMPANY_A, 25).toSQL();
  assert.match(sql, /"company_id" = \$1/);
  assert.ok(params.includes(COMPANY_A));
  assert.ok(params.includes("in_progress"));
  assert.match(sql, /order by "chatbot_voice_calls"\."started_at" asc/i);
});

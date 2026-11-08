import { test } from "node:test";
import assert from "node:assert/strict";
import { capDemoDuration, DEFAULT_DEMO_SECONDS_LIMIT } from "./demo-cap.ts";
import { VoiceCallService } from "./service.ts";
import { MemoryVoiceCallStorage } from "./storage-memory.ts";
import { CONTRACT_FLAGS } from "../contracts/index.ts";

// ---- service wiring: the cap is applied where a duration is stored, against the in-memory store ----------------

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const CHATBOT_A = "chatbot-a";
const CHATBOT_B = "chatbot-b";
const ON = { [CONTRACT_FLAGS.VOICE_ENABLED]: "true" };
const CALLBACK_HOST = "hooks.example.test";
const DAY_1_START = new Date("2026-11-08T10:00:00.000Z");
const DAY_2_START = new Date("2026-11-09T10:00:00.000Z");

/** Fake provider: starts return a bound session, webhooks are parsed from JSON, signatures always pass. */
class StubProvider {
  key = "stub";
  counter = 0;
  async startCall(request) {
    this.counter += 1;
    return {
      id: `s-${this.counter}`,
      companyId: request.companyId,
      chatbotId: request.chatbotId,
      conversationId: null,
      direction: "outbound",
      providerCallId: `p-${this.counter}`,
      status: "ringing",
      fromNumber: request.fromNumber,
      toNumber: request.toNumber,
      startedAt: null,
      endedAt: null,
      durationSeconds: null,
      transcriptId: null,
    };
  }
  async hangUp() {
    return true;
  }
  async verifyWebhook() {
    return true;
  }
  parseWebhook(_companyId, rawBody) {
    const types = { answered: "call.answered", completed: "call.completed" };
    return JSON.parse(rawBody).events.map((e) => ({
      type: types[e.type],
      providerCallId: e.providerCallId,
      occurredAt: new Date(e.occurredAt),
    }));
  }
}

function demoHarness({ demoMode }) {
  const clock = { now: DAY_1_START };
  const storage = new MemoryVoiceCallStorage();
  const service = new VoiceCallService({
    storage,
    provider: new StubProvider(),
    http: async () => {
      throw new Error("no network in tests");
    },
    quota: { secondsLimitFor: async () => -1 },
    chatbots: { exists: async () => true },
    credentials: { load: async () => ({ secret: "s" }) },
    credits: { hasBalance: async () => true, chargeTranscript: async () => undefined },
    logger: { info() {}, warn() {} },
    env: ON,
    callbackHosts: [CALLBACK_HOST],
    clock: () => clock.now,
    demoMode,
  });
  return { service, storage, clock };
}

function callbackUrl(companyId, chatbotId) {
  return `https://${CALLBACK_HOST}/voice/${companyId}/${chatbotId}/status`;
}

/** Starts an outbound call, answers it at `start`, and completes it `seconds` later. Returns the stored duration. */
async function runCall(h, { companyId = COMPANY_A, chatbotId = CHATBOT_A, start, seconds }) {
  h.clock.now = start;
  const started = await h.service.startOutbound({
    companyId,
    chatbotId,
    toNumber: "+61 412 345 678",
    fromNumber: "+61 298 765 432",
    statusCallbackUrl: callbackUrl(companyId, chatbotId),
    idempotencyKey: `k-${Math.random().toString(36).slice(2)}`,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  const providerCallId = (await h.storage.findById(companyId, chatbotId, started.value.id)).providerCallId;
  const answeredAt = new Date(start.getTime());
  const endedAt = new Date(start.getTime() + seconds * 1000);
  const send = (events, at) => {
    const rawBody = JSON.stringify({ events: events.map((e) => ({ ...e, occurredAt: at.toISOString() })) });
    const timestamp = String(Math.floor(at.getTime() / 1000));
    return h.service.handleWebhook(companyId, chatbotId, { rawBody, timestamp, signature: "x" });
  };
  h.clock.now = answeredAt;
  const answered = await send([{ type: "answered", providerCallId }], answeredAt);
  assert.equal(answered.ok, true, JSON.stringify(answered));
  assert.equal(answered.value.processed, 1, "answer must change the call");
  h.clock.now = endedAt;
  const completed = await send([{ type: "completed", providerCallId }], endedAt);
  assert.equal(completed.value.processed, 1, "completion must change the call");
  assert.equal(completed.ok, true, JSON.stringify(completed));
  return (await h.storage.findById(companyId, chatbotId, started.value.id)).durationSeconds;
}

test("demo mode: a stored duration is capped to the 30 second daily limit", async () => {
  const h = demoHarness({ demoMode: true });
  assert.equal(await runCall(h, { start: DAY_1_START, seconds: 60 }), 30);
});

test("outside demo mode: the stored duration is the real duration", async () => {
  const h = demoHarness({ demoMode: false });
  assert.equal(await runCall(h, { start: DAY_1_START, seconds: 60 }), 60);
});

test("demo mode defaults to off when demoMode is not injected", async () => {
  const h = demoHarness({ demoMode: undefined });
  assert.equal(await runCall(h, { start: DAY_1_START, seconds: 60 }), 60);
});

test("demo mode: a second call the same UTC day sees the first call's used seconds", async () => {
  const h = demoHarness({ demoMode: true });
  assert.equal(await runCall(h, { start: DAY_1_START, seconds: 20 }), 20);
  // 20 of 30 seconds are used, so only 10 remain for the second call.
  assert.equal(await runCall(h, { start: new Date(DAY_1_START.getTime() + 3600_000), seconds: 60 }), 10);
  // The day's limit is now used up.
  assert.equal(await runCall(h, { start: new Date(DAY_1_START.getTime() + 7200_000), seconds: 60 }), 0);
});

test("demo mode: the used seconds reset on the next UTC day", async () => {
  const h = demoHarness({ demoMode: true });
  assert.equal(await runCall(h, { start: DAY_1_START, seconds: 30 }), 30);
  assert.equal(await runCall(h, { start: DAY_2_START, seconds: 60 }), 30);
});

test("demo mode: used seconds are counted per company, not across companies", async () => {
  const h = demoHarness({ demoMode: true });
  assert.equal(await runCall(h, { companyId: COMPANY_B, chatbotId: CHATBOT_B, start: DAY_1_START, seconds: 30 }), 30);
  assert.equal(await runCall(h, { companyId: COMPANY_A, chatbotId: CHATBOT_A, start: DAY_1_START, seconds: 60 }), 30);
});

test("default demo limit is 30 seconds, as in the PHP source", () => {
  assert.equal(DEFAULT_DEMO_SECONDS_LIMIT, 30);
});

test("outside demo mode the requested duration is returned unchanged", () => {
  assert.equal(capDemoDuration({ isDemo: false, requestedSeconds: 600, usedTodaySeconds: 999 }), 600);
});

test("demo mode caps to the remaining seconds for the day", () => {
  assert.equal(capDemoDuration({ isDemo: true, requestedSeconds: 60, usedTodaySeconds: 0 }), 30);
  assert.equal(capDemoDuration({ isDemo: true, requestedSeconds: 60, usedTodaySeconds: 20 }), 10);
});

test("demo mode returns zero once the day's limit is used", () => {
  assert.equal(capDemoDuration({ isDemo: true, requestedSeconds: 60, usedTodaySeconds: 30 }), 0);
  assert.equal(capDemoDuration({ isDemo: true, requestedSeconds: 60, usedTodaySeconds: 500 }), 0);
});

test("bad input is clamped, not trusted", () => {
  assert.equal(capDemoDuration({ isDemo: true, requestedSeconds: -5, usedTodaySeconds: 0 }), 0);
  assert.equal(capDemoDuration({ isDemo: true, requestedSeconds: NaN, usedTodaySeconds: 0 }), 0);
  assert.equal(capDemoDuration({ isDemo: true, requestedSeconds: 10, usedTodaySeconds: 0, limitSeconds: 5 }), 5);
});

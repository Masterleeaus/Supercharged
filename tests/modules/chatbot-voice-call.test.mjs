// Chatbot voice calls: service, policy and storage tests (node:test). No network and no real provider.
// The provider is a fake CallProvider whose verifyWebhook uses the real HMAC policy, so signature tests
// exercise the same code a real adapter would call. Drizzle queries are rendered with PgDialect and a stub client.
import test from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { VoiceCallService } from "../../server/modules/chatbot/voice-call/service.ts";
import {
  callDurationSeconds,
  evaluateQuota,
  maskPhone,
  parseWebhookTimestamp,
  redactPhoneText,
  signWebhookPayload,
  verifySignedWebhook,
} from "../../server/modules/chatbot/voice-call/policy.ts";
import { MemoryVoiceCallStorage } from "../../server/modules/chatbot/voice-call/storage-memory.ts";
import { DrizzleVoiceCallStorage } from "../../server/modules/chatbot/voice-call/storage-drizzle.ts";
import { chatbotVoiceCalls } from "../../server/modules/chatbot/db/voice-call.ts";
import { CONTRACT_FLAGS, readFlag } from "../../server/modules/chatbot/contracts/index.ts";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const CHATBOT_A1 = "chatbot-a1";
const CHATBOT_A2 = "chatbot-a2";
const CHATBOT_B1 = "chatbot-b1";
const CALLER = "+61 412 345 678";
const CALLER_DIGITS = "61412345678";
const AGENT = "+61 298 765 432";
const CALLBACK_HOST = "hooks.example.test";
const T0 = new Date("2026-11-08T10:00:00.000Z");
const ON = { [CONTRACT_FLAGS.VOICE_ENABLED]: "true" };

function callbackUrl(companyId, chatbotId) {
  return `https://${CALLBACK_HOST}/voice/${companyId}/${chatbotId}/status`;
}

/** Fake provider. Records every call and returns a session bound to the request it was given. */
class FakeProvider {
  key = "fake-telephony";
  starts = [];
  hangUps = [];
  startError = null;
  forceCompany = null;
  counter = 0;

  async startCall(request) {
    if (this.startError) throw this.startError;
    this.starts.push(request);
    this.counter += 1;
    return {
      id: `session-${this.counter}`,
      companyId: this.forceCompany ?? request.companyId,
      chatbotId: request.chatbotId,
      conversationId: null,
      direction: "outbound",
      providerCallId: `prov-${this.counter}`,
      status: "ringing",
      fromNumber: request.fromNumber,
      toNumber: request.toNumber,
      startedAt: null,
      endedAt: null,
      durationSeconds: null,
      transcriptId: null,
    };
  }

  async hangUp(companyId, providerCallId) {
    this.hangUps.push({ companyId, providerCallId });
    return true;
  }

  async verifyWebhook(companyId, input, credentials) {
    return verifySignedWebhook({
      secret: credentials.webhookSecret,
      timestamp: input.timestamp,
      rawBody: input.rawBody,
      signature: input.signature,
    });
  }

  parseWebhook(companyId, rawBody) {
    return JSON.parse(rawBody).events.map((e) => ({
      type: e.type,
      providerCallId: e.providerCallId,
      occurredAt: new Date(e.occurredAt),
      ...(e.transcript ? { transcript: e.transcript } : {}),
    }));
  }
}

/** Builds a signed webhook request. The timestamp is Unix seconds, as a real provider would send. */
function signedRequest(secret, events, at = T0) {
  const rawBody = JSON.stringify({
    events: events.map((e) => ({ ...e, occurredAt: (e.occurredAt ?? at).toISOString() })),
  });
  const timestamp = String(Math.floor(at.getTime() / 1000));
  return { rawBody, timestamp, signature: signWebhookPayload(secret, timestamp, rawBody) };
}

function harness({ env = ON, limits = {}, creds = {}, chatbots, sharedSecret = null } = {}) {
  const clock = { now: T0 };
  const logs = [];
  const logger = {
    info: (message, fields) => logs.push({ level: "info", message, fields }),
    warn: (message, fields) => logs.push({ level: "warn", message, fields }),
  };
  const storage = new MemoryVoiceCallStorage();
  const provider = new FakeProvider();
  const httpCalls = [];
  const http = async (request) => {
    httpCalls.push(request);
    throw new Error("network must not be reached in tests");
  };
  const credentialMap = new Map(
    Object.entries({
      [`${COMPANY_A}:${CHATBOT_A1}`]: { webhookSecret: sharedSecret ?? "secret-A" },
      [`${COMPANY_A}:${CHATBOT_A2}`]: { webhookSecret: sharedSecret ?? "secret-A" },
      [`${COMPANY_B}:${CHATBOT_B1}`]: { webhookSecret: sharedSecret ?? "secret-B" },
      ...creds,
    }),
  );
  const chatbotSet = new Set(
    chatbots ?? [`${COMPANY_A}:${CHATBOT_A1}`, `${COMPANY_A}:${CHATBOT_A2}`, `${COMPANY_B}:${CHATBOT_B1}`],
  );
  const quotaMap = new Map(
    Object.entries({
      [`${COMPANY_A}:${CHATBOT_A1}`]: 60,
      [`${COMPANY_A}:${CHATBOT_A2}`]: -1,
      [`${COMPANY_B}:${CHATBOT_B1}`]: 60,
      ...limits,
    }),
  );
  const service = new VoiceCallService({
    storage,
    provider,
    http,
    quota: { secondsLimitFor: async (c, b) => (quotaMap.has(`${c}:${b}`) && chatbotSet.has(`${c}:${b}`) ? quotaMap.get(`${c}:${b}`) : null) },
    chatbots: { exists: async (c, b) => chatbotSet.has(`${c}:${b}`) },
    credentials: { load: async (c, b) => credentialMap.get(`${c}:${b}`) ?? null },
    credits: { hasBalance: async () => true, chargeTranscript: async () => undefined },
    logger,
    env,
    callbackHosts: [CALLBACK_HOST],
    clock: () => clock.now,
  });
  return { service, storage, provider, logs, httpCalls, clock };
}

function startArgs(overrides = {}) {
  return {
    companyId: COMPANY_A,
    chatbotId: CHATBOT_A1,
    toNumber: CALLER,
    fromNumber: AGENT,
    statusCallbackUrl: callbackUrl(COMPANY_A, CHATBOT_A1),
    idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
}

/** Starts a call and returns its provider id and session id. Asserts success. */
async function startCall(h, overrides = {}) {
  const result = await h.service.startOutbound(startArgs(overrides));
  assert.equal(result.ok, true, JSON.stringify(result));
  return { id: result.value.id, providerCallId: result.value.providerCallId };
}

function allLogText(logs) {
  return JSON.stringify(logs);
}

// ---- policy ----------------------------------------------------------------------------------------------

test("phone masking shows only the last four digits", () => {
  assert.equal(maskPhone(CALLER), "*******5678");
  assert.equal(maskPhone("12"), "****");
  assert.equal(maskPhone(""), null);
  assert.equal(maskPhone(null), null);
});

test("phone-like runs in free text are masked, identifiers are left alone", () => {
  const text = `provider rejected ${CALLER_DIGITS} and 0412 345 678 for call a1b2c3d4-1234-4234-8234-123456789012`;
  const out = redactPhoneText(text);
  assert.ok(!out.includes("412345678"), out);
  assert.ok(!out.includes("0412 345 678"), out);
  assert.ok(out.includes("5678"), out);
  assert.ok(out.includes("a1b2c3d4-1234-4234-8234-123456789012"), "UUID must survive redaction");
});

test("the voice flag is on only for the exact string true", () => {
  assert.equal(readFlag(CONTRACT_FLAGS.VOICE_ENABLED, { [CONTRACT_FLAGS.VOICE_ENABLED]: "true" }), true);
  for (const value of ["1", "yes", "on", "TRUE", ""]) {
    assert.equal(readFlag(CONTRACT_FLAGS.VOICE_ENABLED, { [CONTRACT_FLAGS.VOICE_ENABLED]: value }), false, value);
  }
  assert.equal(readFlag(CONTRACT_FLAGS.VOICE_ENABLED, {}), false);
});

test("quota: 0 is not in the plan, -1 is unlimited, a positive cap counts used and reserved seconds", () => {
  assert.deepEqual(evaluateQuota({ secondsLimit: 0, usedSeconds: 0, reservedSeconds: 0 }), { allowed: false, reason: "plan_disabled" });
  assert.deepEqual(evaluateQuota({ secondsLimit: -1, usedSeconds: 9999, reservedSeconds: 0 }), { allowed: true, remainingSeconds: null });
  assert.deepEqual(evaluateQuota({ secondsLimit: -7, usedSeconds: 0, reservedSeconds: 0 }), { allowed: false, reason: "plan_disabled" });
  assert.deepEqual(evaluateQuota({ secondsLimit: 60, usedSeconds: 50, reservedSeconds: 0 }), { allowed: true, remainingSeconds: 10 });
  assert.deepEqual(evaluateQuota({ secondsLimit: 60, usedSeconds: 50, reservedSeconds: 10 }), { allowed: false, reason: "limit_reached" });
});

test("duration is computed from server timestamps and capped", () => {
  assert.equal(callDurationSeconds(null, new Date(T0.getTime() + 500_000), 60), 0);
  assert.equal(callDurationSeconds(T0, new Date(T0.getTime() + 42_900), null), 42);
  assert.equal(callDurationSeconds(T0, new Date(T0.getTime() + 90_000), 60), 60);
});

test("webhook timestamps accept Unix seconds and ISO text, and reject garbage", () => {
  assert.equal(parseWebhookTimestamp("1794132000")?.getTime(), 1794132000 * 1000);
  assert.ok(parseWebhookTimestamp("2026-11-08T10:00:00Z") instanceof Date);
  assert.equal(parseWebhookTimestamp("not-a-time"), null);
  assert.equal(parseWebhookTimestamp(null), null);
});

// ---- outbound start --------------------------------------------------------------------------------------

test("with the flag off, every entry point refuses", async () => {
  const h = harness({ env: { [CONTRACT_FLAGS.VOICE_ENABLED]: "1" } });
  const start = await h.service.startOutbound(startArgs());
  assert.equal(start.ok, false);
  assert.equal(start.status, 404);
  assert.equal(h.provider.starts.length, 0);
});

test("outbound start records the call, returns masked numbers, and replays by idempotency key", async () => {
  const h = harness();
  const args = startArgs({ idempotencyKey: "same-key" });
  const first = await h.service.startOutbound(args);
  assert.equal(first.ok, true);
  assert.equal(first.value.fromNumber, "*******5432");
  assert.equal(first.value.toNumber, "*******5678");
  assert.equal(h.provider.starts.length, 1);

  const replay = await h.service.startOutbound(args);
  assert.equal(replay.ok, true);
  assert.equal(replay.value.id, first.value.id);
  assert.equal(h.provider.starts.length, 1, "a replayed start must not place a second call");

  const stored = await h.storage.findById(COMPANY_A, CHATBOT_A1, first.value.id);
  assert.equal(stored.toNumber, CALLER, "the full number is kept for the provider, not for outputs");
});

test("invalid numbers and callback URLs are refused without echoing the input", async () => {
  const h = harness();
  const badNumber = await h.service.startOutbound(startArgs({ toNumber: "call me maybe" }));
  assert.equal(badNumber.ok, false);
  assert.equal(badNumber.status, 400);
  assert.doesNotMatch(badNumber.error, /\d/);

  const badUrls = [
    `http://${CALLBACK_HOST}/voice/${COMPANY_A}/${CHATBOT_A1}`,
    `https://evil.example.test/voice/${COMPANY_A}/${CHATBOT_A1}`,
    `https://${CALLBACK_HOST}/voice/${COMPANY_A}/other`,
    `https://user:pass@${CALLBACK_HOST}/voice/${COMPANY_A}/${CHATBOT_A1}`,
    "not a url",
  ];
  for (const url of badUrls) {
    const r = await h.service.startOutbound(startArgs({ statusCallbackUrl: url }));
    assert.equal(r.ok, false, url);
    assert.equal(r.status, 400, url);
  }
  assert.equal(h.provider.starts.length, 0);
});

test("a provider failure marks the call failed and keeps the number out of the error and logs", async () => {
  const h = harness();
  h.provider.startError = new Error(`carrier rejected ${CALLER_DIGITS} at +61 412 345 678`);
  const r = await h.service.startOutbound(startArgs());
  assert.equal(r.ok, false);
  assert.equal(r.status, 502);
  assert.doesNotMatch(r.error, /\d/);
  const rows = await h.storage.listActive(COMPANY_A, CHATBOT_A1);
  assert.equal(rows.length, 0, "the failed call is not active");
  assert.doesNotMatch(allLogText(h.logs), /412345678|412 345 678/);
});

// ---- duration limit --------------------------------------------------------------------------------------

test("the plan duration limit ends a call at its cap and records the duration", async () => {
  const h = harness();
  const { id, providerCallId } = await startCall(h);
  const answeredAt = new Date(T0.getTime() + 1000);

  h.clock.now = answeredAt;
  const answered = await h.service.handleWebhook(COMPANY_A, CHATBOT_A1, signedRequest("secret-A", [{ type: "call.answered", providerCallId }], answeredAt));
  assert.equal(answered.ok, true);

  h.clock.now = new Date(answeredAt.getTime() + 59_000);
  const before = await h.service.enforceLimits(COMPANY_A, CHATBOT_A1);
  assert.equal(before.value.ended, 0, "no call ends before its cap");

  h.clock.now = new Date(answeredAt.getTime() + 61_000);
  const sweep = await h.service.enforceLimits(COMPANY_A, CHATBOT_A1);
  assert.equal(sweep.value.ended, 1);

  const row = await h.storage.findById(COMPANY_A, CHATBOT_A1, id);
  assert.equal(row.status, "completed");
  assert.equal(row.endReason, "limit_reached");
  assert.equal(row.durationSeconds, 60);
  assert.deepEqual(h.provider.hangUps, [{ companyId: COMPANY_A, providerCallId }]);

  // A completion that arrives after the cap cannot extend the call or change its duration.
  h.clock.now = new Date(answeredAt.getTime() + 200_000);
  const late = await h.service.handleWebhook(
    COMPANY_A,
    CHATBOT_A1,
    signedRequest("secret-A", [{ type: "call.completed", providerCallId, occurredAt: new Date(answeredAt.getTime() + 200_000) }], h.clock.now),
  );
  assert.equal(late.ok, true);
  assert.equal(late.value.processed, 0);
  const after = await h.storage.findById(COMPANY_A, CHATBOT_A1, id);
  assert.equal(after.durationSeconds, 60);
  assert.equal(h.provider.hangUps.length, 1, "no second hang-up");
});

test("a completion event past the cap is capped at the webhook, without a sweep", async () => {
  const h = harness();
  const { id, providerCallId } = await startCall(h);
  const answeredAt = new Date(T0.getTime() + 1000);
  h.clock.now = answeredAt;
  await h.service.handleWebhook(COMPANY_A, CHATBOT_A1, signedRequest("secret-A", [{ type: "call.answered", providerCallId }], answeredAt));
  const endAt = new Date(answeredAt.getTime() + 300_000);
  h.clock.now = endAt;
  await h.service.handleWebhook(COMPANY_A, CHATBOT_A1, signedRequest("secret-A", [{ type: "call.completed", providerCallId, occurredAt: endAt }], endAt));
  const row = await h.storage.findById(COMPANY_A, CHATBOT_A1, id);
  assert.equal(row.durationSeconds, 60);
  assert.equal(row.endReason, "limit_reached");
});

test("each call records its own duration, and a short call keeps its real length", async () => {
  const h = harness({ limits: { [`${COMPANY_A}:${CHATBOT_A1}`]: -1 } });
  const one = await startCall(h);
  const two = await startCall(h);
  const t1 = new Date(T0.getTime() + 5000);
  const t2 = new Date(T0.getTime() + 40_000);
  h.clock.now = t1;
  await h.service.handleWebhook(COMPANY_A, CHATBOT_A1, signedRequest("secret-A", [{ type: "call.answered", providerCallId: one.providerCallId }], t1));
  h.clock.now = t2;
  await h.service.handleWebhook(COMPANY_A, CHATBOT_A1, signedRequest("secret-A", [{ type: "call.answered", providerCallId: two.providerCallId }], t2));
  const end = new Date(T0.getTime() + 47_000);
  h.clock.now = end;
  await h.service.handleWebhook(COMPANY_A, CHATBOT_A1, signedRequest("secret-A", [{ type: "call.completed", providerCallId: one.providerCallId, occurredAt: end }], end));
  assert.equal((await h.storage.findById(COMPANY_A, CHATBOT_A1, one.id)).durationSeconds, 42);
  assert.equal((await h.storage.findById(COMPANY_A, CHATBOT_A1, two.id)).durationSeconds, null, "still in progress");
});

// ---- quota -----------------------------------------------------------------------------------------------

test("the seconds quota refuses a start once used and reserved seconds reach the cap", async () => {
  const h = harness({ limits: { [`${COMPANY_A}:${CHATBOT_A1}`]: 60 } });

  const first = await startCall(h);
  assert.equal((await h.storage.findById(COMPANY_A, CHATBOT_A1, first.id)).maxSeconds, 60);
  const t1 = new Date(T0.getTime() + 1000);
  h.clock.now = t1;
  await h.service.handleWebhook(COMPANY_A, CHATBOT_A1, signedRequest("secret-A", [{ type: "call.answered", providerCallId: first.providerCallId }], t1));
  const end = new Date(t1.getTime() + 50_000);
  h.clock.now = end;
  await h.service.handleWebhook(COMPANY_A, CHATBOT_A1, signedRequest("secret-A", [{ type: "call.completed", providerCallId: first.providerCallId, occurredAt: end }], end));

  const second = await h.service.startOutbound(startArgs());
  assert.equal(second.ok, true);
  assert.equal((await h.storage.findById(COMPANY_A, CHATBOT_A1, second.value.id)).maxSeconds, 10, "10 seconds remain");

  const third = await h.service.startOutbound(startArgs());
  assert.equal(third.ok, false, "the reserved 10 seconds leave nothing for a third call");
  assert.equal(third.status, 403);
  assert.match(third.error, /limit/i);
});

test("a plan with 0 seconds refuses every start, and an unlimited plan has no cap", async () => {
  const off = harness({ limits: { [`${COMPANY_A}:${CHATBOT_A1}`]: 0 } });
  const refused = await off.service.startOutbound(startArgs());
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 403);
  assert.equal(off.provider.starts.length, 0);

  const unlimited = harness();
  const r = await unlimited.service.startOutbound(startArgs({ chatbotId: CHATBOT_A2, statusCallbackUrl: callbackUrl(COMPANY_A, CHATBOT_A2) }));
  assert.equal(r.ok, true);
  assert.equal((await unlimited.storage.findById(COMPANY_A, CHATBOT_A2, r.value.id)).maxSeconds, null);
});

// ---- webhook signature -----------------------------------------------------------------------------------

test("a bad signature is refused and changes nothing", async () => {
  const h = harness();
  const { id, providerCallId } = await startCall(h);
  const events = [{ type: "call.answered", providerCallId }];

  const wrongSecret = await h.service.handleWebhook(COMPANY_A, CHATBOT_A1, signedRequest("not-the-secret", events));
  assert.equal(wrongSecret.ok, false);
  assert.equal(wrongSecret.status, 401);

  const unsigned = await h.service.handleWebhook(COMPANY_A, CHATBOT_A1, { ...signedRequest("secret-A", events), signature: null });
  assert.equal(unsigned.status, 401);

  const stale = signedRequest("secret-A", events, new Date(T0.getTime() - 3_600_000));
  const staleResult = await h.service.handleWebhook(COMPANY_A, CHATBOT_A1, stale);
  assert.equal(staleResult.status, 401, "a correctly signed but stale request is refused");

  const tampered = signedRequest("secret-A", events);
  const tamperedResult = await h.service.handleWebhook(COMPANY_A, CHATBOT_A1, { ...tampered, rawBody: tampered.rawBody.replace("answered", "completed") });
  assert.equal(tamperedResult.status, 401, "a changed body fails the signature");

  const row = await h.storage.findById(COMPANY_A, CHATBOT_A1, id);
  assert.equal(row.status, "ringing", "no refused request moved the call");
  assert.equal(row.startedAt, null);
  assert.equal(h.provider.hangUps.length, 0);
});

test("a missing webhook secret fails closed", async () => {
  const h = harness({ creds: { [`${COMPANY_A}:${CHATBOT_A1}`]: undefined } });
  const r = await h.service.handleWebhook(COMPANY_A, CHATBOT_A1, signedRequest("secret-A", []));
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

test("a valid signed webhook applies the answer and the completion in order", async () => {
  const h = harness();
  const { id, providerCallId } = await startCall(h);
  const answered = new Date(T0.getTime() + 2000);
  const ended = new Date(T0.getTime() + 32_000);
  h.clock.now = ended;
  const r = await h.service.handleWebhook(
    COMPANY_A,
    CHATBOT_A1,
    signedRequest(
      "secret-A",
      [
        { type: "call.answered", providerCallId, occurredAt: answered },
        { type: "call.completed", providerCallId, occurredAt: ended },
      ],
      ended,
    ),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { processed: 2, ignored: 0 });
  const row = await h.storage.findById(COMPANY_A, CHATBOT_A1, id);
  assert.equal(row.status, "completed");
  assert.equal(row.durationSeconds, 30);
});

test("an inbound call is verified before it is recorded", async () => {
  const h = harness();
  const inbound = { providerCallId: "prov-in-1", fromNumber: CALLER, toNumber: AGENT };
  const bad = await h.service.startInbound(COMPANY_A, CHATBOT_A1, { ...signedRequest("wrong", []) }, inbound);
  assert.equal(bad.status, 401);
  assert.equal((await h.storage.listActive(COMPANY_A, CHATBOT_A1)).length, 0);

  const good = await h.service.startInbound(COMPANY_A, CHATBOT_A1, signedRequest("secret-A", []), inbound);
  assert.equal(good.ok, true);
  assert.equal(good.value.direction, "inbound");
  assert.equal(good.value.fromNumber, "*******5678");
});

// ---- tenancy ---------------------------------------------------------------------------------------------

test("a webhook signed for company A is refused at company B's address", async () => {
  const h = harness();
  const { id, providerCallId } = await startCall(h);
  const r = await h.service.handleWebhook(COMPANY_B, CHATBOT_B1, signedRequest("secret-A", [{ type: "call.answered", providerCallId }]));
  assert.equal(r.ok, false);
  assert.equal(r.status, 401, "company B's secret does not verify company A's signature");
  assert.equal((await h.storage.findById(COMPANY_A, CHATBOT_A1, id)).status, "ringing");
});

test("even with a shared secret, a call from another company is refused as unknown", async () => {
  const h = harness({ sharedSecret: "shared" });
  const { id, providerCallId } = await startCall(h);
  const r = await h.service.handleWebhook(COMPANY_B, CHATBOT_B1, signedRequest("shared", [{ type: "call.answered", providerCallId }]));
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.equal(r.error, "Unknown call");
  assert.equal((await h.storage.findById(COMPANY_A, CHATBOT_A1, id)).status, "ringing");
  assert.equal(await h.storage.findById(COMPANY_B, CHATBOT_B1, id), null);
  assert.equal((await h.service.getSession(COMPANY_B, CHATBOT_B1, id)).status, 404);
});

test("a call from another chatbot in the same company is refused, and a batch with one unknown call writes nothing", async () => {
  const h = harness();
  const mine = await startCall(h);
  const other = await startCall(h, { chatbotId: CHATBOT_A2, statusCallbackUrl: callbackUrl(COMPANY_A, CHATBOT_A2) });
  const r = await h.service.handleWebhook(COMPANY_A, CHATBOT_A1, signedRequest("secret-A", [
    { type: "call.answered", providerCallId: mine.providerCallId },
    { type: "call.answered", providerCallId: other.providerCallId },
  ]));
  assert.equal(r.status, 404);
  assert.equal((await h.storage.findById(COMPANY_A, CHATBOT_A1, mine.id)).status, "ringing", "the valid event in the batch was not applied");
});

test("a provider session bound to another company is refused and the row is closed", async () => {
  const h = harness();
  h.provider.forceCompany = COMPANY_B;
  const r = await h.service.startOutbound(startArgs());
  assert.equal(r.ok, false);
  assert.equal(r.status, 502);
  assert.equal(h.provider.hangUps.length, 0, "a foreign provider call is not acted on");
  assert.equal((await h.storage.listActive(COMPANY_A, CHATBOT_A1)).length, 0);
});

test("another company's chatbot cannot be used to start a call", async () => {
  const h = harness();
  const r = await h.service.startOutbound(startArgs({ companyId: COMPANY_A, chatbotId: CHATBOT_B1, statusCallbackUrl: callbackUrl(COMPANY_A, CHATBOT_B1) }));
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.equal(h.provider.starts.length, 0);
});

test("a company id that is not a UUID throws before any storage is touched", async () => {
  const h = harness();
  await assert.rejects(() => h.service.startOutbound(startArgs({ companyId: "not-a-uuid" })), (err) => err.status === 403);
});

// ---- logs ------------------------------------------------------------------------------------------------

test("phone numbers never reach the logs in full, including through error text and extra fields", async () => {
  const h = harness();
  const { providerCallId } = await startCall(h);
  const at = new Date(T0.getTime() + 1000);
  h.clock.now = at;
  await h.service.handleWebhook(COMPANY_A, CHATBOT_A1, signedRequest("secret-A", [{ type: "call.answered", providerCallId }], at));
  h.provider.startError = new Error(`dial ${CALLER} failed`);
  await h.service.startOutbound(startArgs());

  const text = allLogText(h.logs);
  assert.ok(h.logs.length > 0);
  assert.doesNotMatch(text, /412345678|412 345 678|61412345678/);
  assert.doesNotMatch(text, /298 765 432|298765432/);
  assert.match(text, /callId/, "the log lines are still written");
});

test("the log scrubber drops raw bodies and credentials even when a caller passes them", async () => {
  const h = harness();
  const { providerCallId } = await startCall(h);
  const at = new Date(T0.getTime() + 1000);
  h.clock.now = at;
  const req = signedRequest("secret-A", [{ type: "call.answered", providerCallId }], at);
  await h.service.handleWebhook(COMPANY_A, CHATBOT_A1, req);
  const text = allLogText(h.logs);
  assert.doesNotMatch(text, /call\.answered/, "raw event text must not be logged");
  assert.doesNotMatch(text, /secret-A/);
  assert.doesNotMatch(text, new RegExp(req.signature));
});

// ---- storage ---------------------------------------------------------------------------------------------

test("in-memory storage treats another company's rows as absent", async () => {
  const storage = new MemoryVoiceCallStorage();
  const row = await storage.insert(COMPANY_A, {
    companyId: COMPANY_A,
    chatbotId: CHATBOT_A1,
    conversationId: null,
    direction: "outbound",
    provider: "fake",
    providerCallId: "p-1",
    idempotencyKey: "k-1",
    status: "ringing",
    fromNumber: CALLER,
    toNumber: AGENT,
    maxSeconds: 60,
  });
  assert.equal(await storage.findById(COMPANY_B, CHATBOT_A1, row.id), null);
  assert.equal(await storage.findByProviderCallId(COMPANY_B, "fake", "p-1"), null);
  assert.equal(await storage.findByIdempotencyKey(COMPANY_B, CHATBOT_A1, "k-1"), null);
  assert.equal(await storage.update(COMPANY_B, row.id, "ringing", { status: "failed" }), null);
  assert.deepEqual(await storage.usage(COMPANY_B, CHATBOT_A1, T0), { completedSeconds: 0, reservedSeconds: 0 });
  assert.equal((await storage.usage(COMPANY_A, CHATBOT_A1, T0)).reservedSeconds, 60);
});

test("the storage update is conditional, so a second delivery of the same event does not apply twice", async () => {
  const storage = new MemoryVoiceCallStorage();
  const row = await storage.insert(COMPANY_A, {
    companyId: COMPANY_A, chatbotId: CHATBOT_A1, conversationId: null, direction: "outbound", provider: "fake",
    providerCallId: "p-2", idempotencyKey: null, status: "ringing", fromNumber: CALLER, toNumber: AGENT, maxSeconds: null,
  });
  const first = await storage.update(COMPANY_A, row.id, "ringing", { status: "in_progress", startedAt: T0 });
  const second = await storage.update(COMPANY_A, row.id, "ringing", { status: "in_progress", startedAt: T0 });
  assert.ok(first);
  assert.equal(second, null);
});

const INTERFACE_METHODS = [
  "findById",
  "findByIdempotencyKey",
  "findByProviderCallId",
  "listActive",
  "insert",
  "update",
  "usage",
];

test("both storage implementations expose the full port", () => {
  for (const name of INTERFACE_METHODS) {
    assert.equal(typeof MemoryVoiceCallStorage.prototype[name], "function", `memory: ${name}`);
    assert.equal(typeof DrizzleVoiceCallStorage.prototype[name], "function", `drizzle: ${name}`);
  }
});

// ---- Drizzle ---------------------------------------------------------------------------------------------

const dialect = new PgDialect();

function drizzleHarness() {
  const captured = [];
  const executed = [];
  const client = {
    query: async (config) => {
      executed.push(config.text);
      return { rows: /returning/i.test(config.text) ? [{}] : [], rowCount: 0 };
    },
  };
  const db = drizzle({ client });
  const storage = new DrizzleVoiceCallStorage(db, { onQuery: (q) => captured.push(q) });
  return { storage, captured, executed };
}

function assertScoped(sqlText, params, companyId) {
  if (/^insert /i.test(sqlText)) {
    assert.match(sqlText, /"company_id"/, `insert without company_id: ${sqlText}`);
  } else {
    assert.match(sqlText, /"company_id" = \$\d+/, `statement without company_id predicate: ${sqlText}`);
  }
  assert.ok(params.includes(companyId), `company id missing from params: ${sqlText}`);
}

const DRIZZLE_SCENARIOS = [
  ["findById", (s) => s.findById(COMPANY_A, CHATBOT_A1, "call-1")],
  ["findByIdempotencyKey", (s) => s.findByIdempotencyKey(COMPANY_A, CHATBOT_A1, "key")],
  ["findByProviderCallId", (s) => s.findByProviderCallId(COMPANY_A, "fake", "prov-1")],
  ["listActive", (s) => s.listActive(COMPANY_A, CHATBOT_A1)],
  [
    "insert",
    (s) =>
      s.insert(COMPANY_A, {
        companyId: COMPANY_A, chatbotId: CHATBOT_A1, conversationId: null, direction: "outbound", provider: "fake",
        providerCallId: null, idempotencyKey: "key", status: "ringing", fromNumber: CALLER, toNumber: AGENT, maxSeconds: 60,
      }),
  ],
  ["update", (s) => s.update(COMPANY_A, "call-1", "ringing", { status: "in_progress", startedAt: T0 })],
  ["usage", (s) => s.usage(COMPANY_A, CHATBOT_A1, T0)],
];

for (const [name, run] of DRIZZLE_SCENARIOS) {
  test(`drizzle ${name} filters by company_id`, async () => {
    const { storage, captured } = drizzleHarness();
    await run(storage);
    assert.ok(captured.length >= 1, `${name} ran no query`);
    for (const query of captured) {
      const rendered = dialect.sqlToQuery(query.getSQL());
      assertScoped(rendered.sql, rendered.params, COMPANY_A);
    }
  });
}

test("drizzle storage refuses a non-UUID company id before querying", async () => {
  const { storage, captured } = drizzleHarness();
  await assert.rejects(() => storage.findById("nope", CHATBOT_A1, "x"), (err) => err.status === 403);
  assert.equal(captured.length, 0);
});

test("drizzle table: company_id is required and every unique index includes it", () => {
  const config = getTableConfig(chatbotVoiceCalls);
  const companyCol = config.columns.find((c) => c.name === "company_id");
  assert.equal(companyCol.notNull, true);
  const uniques = config.indexes.filter((i) => i.config.unique);
  assert.equal(uniques.length, 2);
  for (const idx of uniques) {
    assert.ok(idx.config.columns.some((c) => c.name === "company_id"), `unique index ${idx.config.name} lacks company_id`);
  }
  const fk = config.foreignKeys.find((f) => f.getName() === "chatbot_voice_calls_company_chatbot_fk");
  assert.ok(fk, "composite foreign key to chatbots is present");
});

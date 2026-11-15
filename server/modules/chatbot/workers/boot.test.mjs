import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChatbotWorkerServices, startChatbotWorkersFromEnv } from "./boot.ts";
import { stopChatbotWorkers } from "./run.ts";
import { VoiceCallService } from "../voice-call/service.ts";
import { UnconfiguredCallProvider, UNCONFIGURED_MESSAGE, unconfiguredCredits } from "../voice-call/unconfigured.ts";

/** A db that fails the test if anything runs a query. Constructing the Drizzle adapters must not query. */
function silentDb() {
  const calls = [];
  return {
    calls,
    async execute(query) {
      calls.push(query);
      return { rows: [], rowCount: 0 };
    },
  };
}

const quietLogger = { info() {}, warn() {}, error() {} };
const fakeSecretBox = { seal() {}, open() {} };

test("workers flag off: no service is built and no job starts", async () => {
  const db = silentDb();
  const services = buildChatbotWorkerServices({ db, env: {} });
  assert.deepEqual(services, {});

  const handle = startChatbotWorkersFromEnv({ db, env: {}, logger: quietLogger });
  assert.equal(handle.enabled, false);
  assert.deepEqual([...handle.jobs], []);
  await stopChatbotWorkers(handle);
  assert.equal(db.calls.length, 0);
});

test("workers flag must be exactly the string true", () => {
  const services = buildChatbotWorkerServices({ db: silentDb(), env: { CHATBOT_WORKERS_ENABLED: "1" } });
  assert.deepEqual(services, {});
});

test("workers on, webhooks off: expiry sweep and voice limits are passed in, webhook outbox is not", async () => {
  const db = silentDb();
  const env = { CHATBOT_WORKERS_ENABLED: "true" };
  const services = buildChatbotWorkerServices({ db, env });
  assert.equal(typeof services.structuredActions?.expireStaleProposals, "function");
  assert.equal(services.eventOutbox, undefined);
  assert.ok(services.voiceCallLimits instanceof VoiceCallService);
  assert.equal(typeof services.voiceCallLimits.enforceLimitsForCompany, "function");

  const handle = startChatbotWorkersFromEnv({ db, env, logger: quietLogger });
  assert.equal(handle.enabled, true);
  assert.ok(handle.jobs.includes("events_worker"));
  assert.ok(!handle.jobs.includes("outbox_drain"));
  assert.ok(handle.jobs.includes("voice_call_limits"));
  await stopChatbotWorkers(handle);
});

test("voice service is built fail-closed: no call can start, and the provider refuses", async () => {
  const db = silentDb();
  const services = buildChatbotWorkerServices({ db, env: { CHATBOT_WORKERS_ENABLED: "true", CHATBOT_VOICE_ENABLED: "true" } });
  const result = await services.voiceCallLimits.startOutbound({
    companyId: "11111111-1111-4111-8111-111111111111",
    chatbotId: "22222222-2222-4222-8222-222222222222",
    toNumber: "+61400000001",
    fromNumber: "+61400000002",
    statusCallbackUrl: "https://example.invalid/x",
    idempotencyKey: "k-1",
  });
  assert.equal(result.ok, false);

  await assert.rejects(new UnconfiguredCallProvider().startCall({}, {}), new RegExp(UNCONFIGURED_MESSAGE));
  assert.equal(await new UnconfiguredCallProvider().verifyWebhook("c", { rawBody: "{}", signature: null, timestamp: null }), false);
  assert.equal(await unconfiguredCredits.hasBalance("c", "b"), false);
  await assert.rejects(unconfiguredCredits.chargeTranscript("c", "b", { callId: "x", text: "t", idempotencyKey: "i" }));
});

test("voice service is not built when the workers flag is off", () => {
  const services = buildChatbotWorkerServices({ db: silentDb(), env: { CHATBOT_VOICE_ENABLED: "true" } });
  assert.equal(services.voiceCallLimits, undefined);
});

test("webhooks flag on without a secret box refuses to start", () => {
  const env = { CHATBOT_WORKERS_ENABLED: "true", CHATBOT_OUTBOUND_WEBHOOKS_ENABLED: "true" };
  assert.throws(() => buildChatbotWorkerServices({ db: silentDb(), env }), /CHATBOT_OUTBOUND_WEBHOOKS_ENABLED.*secretBox/);
});

test("workers and webhooks on: the outbox drain is passed in and starts", async () => {
  const db = silentDb();
  const env = { CHATBOT_WORKERS_ENABLED: "true", CHATBOT_OUTBOUND_WEBHOOKS_ENABLED: "true" };
  const services = buildChatbotWorkerServices({ db, env, secretBox: fakeSecretBox });
  assert.equal(typeof services.eventOutbox?.processor?.process, "function");

  const handle = startChatbotWorkersFromEnv({ db, env, secretBox: fakeSecretBox, logger: quietLogger });
  assert.ok(handle.jobs.includes("outbox_drain"));
  assert.ok(handle.jobs.includes("events_worker"));
  await stopChatbotWorkers(handle);
});

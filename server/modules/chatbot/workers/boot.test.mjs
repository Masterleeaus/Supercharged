import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChatbotWorkerServices, startChatbotWorkersFromEnv } from "./boot.ts";
import { stopChatbotWorkers } from "./run.ts";
import { createChannelRegistry } from "../channels/framework.ts";
import { createChannelOutbox, createMemoryChannelOutboxStore } from "../channels/outbox.ts";

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

test("workers on, webhooks off: expiry sweep is passed in, webhook outbox and voice limits are not", async () => {
  const db = silentDb();
  const env = { CHATBOT_WORKERS_ENABLED: "true" };
  const services = buildChatbotWorkerServices({ db, env });
  assert.equal(typeof services.structuredActions?.expireStaleProposals, "function");
  assert.equal(services.eventOutbox, undefined);
  assert.equal(services.voiceCallLimits, undefined);

  const handle = startChatbotWorkersFromEnv({ db, env, logger: quietLogger });
  assert.equal(handle.enabled, true);
  assert.ok(handle.jobs.includes("events_worker"));
  assert.ok(!handle.jobs.includes("outbox_drain"));
  assert.ok(!handle.jobs.includes("voice_call_limits"));
  await stopChatbotWorkers(handle);
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

// ---------------------------------------------------------------------------
// Channel send drain. Built only when CHATBOT_CHANNELS_ENABLED is "true" and a provider is registered.
// The fake adapter below stands in for a real channel provider. No network and no database are used.
// ---------------------------------------------------------------------------


const CO = "11111111-1111-4111-8111-111111111111";
const CHANNEL_ENV = { CHATBOT_WORKERS_ENABLED: "true", CHATBOT_CHANNELS_ENABLED: "true" };

function fakeTelegram(script) {
  const calls = [];
  const provider = {
    kind: "telegram",
    capabilities: () => ({ templates: false, attachments: false, deliveryReceipts: false, readReceipts: false, typingIndicator: false, interactiveButtons: false, maxTextLength: null, sessionWindowHours: null }),
    resolveAccount: () => null,
    verifyWebhook: async () => ({ ok: true }),
    parseInbound: () => [],
    send: async (companyId, message) => {
      calls.push({ companyId, key: message.idempotencyKey });
      return script(calls.length);
    },
  };
  return { provider, calls };
}

function registryWith(provider) {
  const registry = createChannelRegistry();
  registry.register(provider);
  return registry;
}

test("channels flag off: no channel send drain is built, even with a provider", () => {
  const db = silentDb();
  const { provider } = fakeTelegram(() => ({ status: "sent", externalMessageId: "x" }));
  const services = buildChatbotWorkerServices({ db, env: { CHATBOT_WORKERS_ENABLED: "true" }, secretBox: fakeSecretBox, channelRegistry: registryWith(provider) });
  assert.equal(services.channelOutbox, undefined);
  assert.equal(db.calls.length, 0);
});

test("channels flag on without a secret box refuses to start", () => {
  const { provider } = fakeTelegram(() => ({ status: "sent", externalMessageId: "x" }));
  assert.throws(
    () => buildChatbotWorkerServices({ db: silentDb(), env: CHANNEL_ENV, channelRegistry: registryWith(provider) }),
    /CHATBOT_CHANNELS_ENABLED.*secretBox/,
  );
});

test("channels flag on with no registry or no providers: the drain is not started, and that is logged", () => {
  const infos = [];
  const logger = { info: (event) => infos.push(event), warn() {}, error() {} };
  const noRegistry = buildChatbotWorkerServices({ db: silentDb(), env: CHANNEL_ENV, secretBox: fakeSecretBox, logger });
  assert.equal(noRegistry.channelOutbox, undefined);
  const empty = buildChatbotWorkerServices({ db: silentDb(), env: CHANNEL_ENV, secretBox: fakeSecretBox, channelRegistry: createChannelRegistry(), logger });
  assert.equal(empty.channelOutbox, undefined);
  assert.equal(infos.filter((event) => event === "workers.channel_send_no_providers").length, 2);
});

test("channels on with a registered provider: the drain is built over the given registry and starts", async () => {
  const db = silentDb();
  const { provider } = fakeTelegram(() => ({ status: "sent", externalMessageId: "x" }));
  const registry = registryWith(provider);
  const services = buildChatbotWorkerServices({ db, env: CHANNEL_ENV, secretBox: fakeSecretBox, channelRegistry: registry });
  assert.equal(typeof services.channelOutbox?.outbox?.drain, "function");
  assert.equal(services.channelOutbox.pipeline.registry, registry);
  assert.equal(typeof services.channelOutbox.pipeline.credentials.load, "function");
  assert.equal(db.calls.length, 0, "building the drain must not query");

  const handle = startChatbotWorkersFromEnv({ db, env: CHANNEL_ENV, secretBox: fakeSecretBox, channelRegistry: registry, logger: quietLogger });
  assert.ok(handle.jobs.includes("channel_send_drain"));
  await stopChatbotWorkers(handle);
});

test("fake adapter: a transient failure is retried with backoff, then recorded as failed after maxAttempts", async () => {
  let now = new Date("2026-11-09T00:00:00Z");
  const store = createMemoryChannelOutboxStore();
  const outbox = createChannelOutbox({ store, clock: () => now, maxAttempts: 2, baseBackoffMs: 1000, maxBackoffMs: 60_000 });
  const { provider, calls } = fakeTelegram(() => ({ status: "failed", errorCode: "provider_down", retryable: true, message: "try later" }));
  const deps = {
    registry: registryWith(provider),
    credentials: { async load(companyId) { return companyId === CO ? { telegram_token: "t" } : null; } },
    http: async () => { throw new Error("no network in tests"); },
  };
  await outbox.enqueue(null, CO, {
    channel: "telegram", accountId: "bot-1", recipient: "4242", contentKind: "text", text: "hi",
    attachmentUrl: null, templateName: null, templateParams: null, replyToExternalMessageId: null, idempotencyKey: "reply:1",
  });

  const first = await outbox.drain(CO, deps);
  assert.equal(first.retryScheduled, 1);
  const early = await outbox.drain(CO, deps);
  assert.equal(early.claimed, 0, "a retry is not claimed before its backoff");

  now = new Date(now.getTime() + 1000);
  const second = await outbox.drain(CO, deps);
  assert.equal(second.failed, 1);
  assert.equal(calls.length, 2, "exactly maxAttempts provider calls");

  const [row] = store.rowsFor(CO);
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 2);
  assert.equal(row.lastErrorCode, "provider_down");
});

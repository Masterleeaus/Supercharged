import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChatbotWorkerServices, startChatbotWorkersFromEnv } from "./boot.ts";
import { stopChatbotWorkers } from "./run.ts";

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

// Boot wiring for the reminder pipeline. CHATBOT_REMINDERS_ENABLED must be exactly "true", and the workers flag must
// be on too, because the reminders job runs inside the workers runner.
// Run: node --test --experimental-transform-types server/modules/chatbot/workers/reminders-boot.test.mjs
// No network and no database. The db is a fake that records calls. Construction must not query it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChatbotWorkerServices, startChatbotWorkersFromEnv } from "./boot.ts";
import { stopChatbotWorkers } from "./run.ts";

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
const WORKERS_ON = { CHATBOT_WORKERS_ENABLED: "true" };

test("reminders flag off (default): the reminders job is not built, and nothing starts", async () => {
  const db = silentDb();
  const handle = startChatbotWorkersFromEnv({ db, env: {}, logger: quietLogger });
  assert.equal(handle.enabled, false);
  assert.deepEqual([...handle.jobs], []);
  await stopChatbotWorkers(handle);
  assert.equal(db.calls.length, 0);
});

test("reminders flag off with workers on: no reminders service is passed in", () => {
  const db = silentDb();
  const services = buildChatbotWorkerServices({ db, env: WORKERS_ON, logger: quietLogger });
  assert.equal(services.reminders, undefined);
  assert.equal(db.calls.length, 0);
});

test("reminders flag must be exactly the string true", () => {
  for (const value of ["1", "TRUE", "yes", "on", ""]) {
    const services = buildChatbotWorkerServices({
      db: silentDb(),
      env: { ...WORKERS_ON, CHATBOT_REMINDERS_ENABLED: value },
      logger: quietLogger,
    });
    assert.equal(services.reminders, undefined, `value ${JSON.stringify(value)} must not enable reminders`);
  }
});

test("reminders flag on with workers on: the reminders job is built, and construction does not query the db", () => {
  const db = silentDb();
  const services = buildChatbotWorkerServices({
    db,
    env: { ...WORKERS_ON, CHATBOT_REMINDERS_ENABLED: "true" },
    logger: quietLogger,
  });
  assert.equal(typeof services.reminders?.runDue, "function");
  assert.equal(db.calls.length, 0);
});

test("reminders flag on but workers off: the runner stays off and no reminders service is built", async () => {
  const db = silentDb();
  const env = { CHATBOT_REMINDERS_ENABLED: "true" };
  assert.equal(buildChatbotWorkerServices({ db, env }).reminders, undefined);
  const handle = startChatbotWorkersFromEnv({ db, env, logger: quietLogger });
  assert.equal(handle.enabled, false);
  await stopChatbotWorkers(handle);
  assert.equal(db.calls.length, 0);
});

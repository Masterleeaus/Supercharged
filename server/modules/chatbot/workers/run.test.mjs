import { test } from "node:test";
import assert from "node:assert/strict";
import { startChatbotWorkers, stopChatbotWorkers, CHATBOT_WORKERS_FLAG, companyIdsQuery, listCompanyIdsFromDb } from "./run.ts";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Logger that keeps every event so tests can assert on them. */
function recordingLogger() {
  const events = [];
  const add = (level) => (event, fields) => events.push({ level, event, fields });
  return { events, info: add("info"), warn: add("warn"), error: add("error") };
}

/** A db fake. Any execute() call succeeds and reports one deleted row. */
function fakeDb() {
  const calls = [];
  return {
    calls,
    async execute(query) {
      calls.push(query);
      return { rows: [], rowCount: 1 };
    },
  };
}

/** Fast intervals for every job so the test runs in well under a second. */
function fastEnv(extra = {}) {
  return {
    [CHATBOT_WORKERS_FLAG]: "true",
    CHATBOT_WORKER_OUTBOX_DRAIN_INTERVAL_MS: "5",
    CHATBOT_WORKER_CHANNEL_SEND_DRAIN_INTERVAL_MS: "5",
    CHATBOT_WORKER_EVENTS_WORKER_INTERVAL_MS: "5",
    CHATBOT_WORKER_VOICE_SWEEP_INTERVAL_MS: "5",
    CHATBOT_WORKER_VOICE_CALL_LIMITS_INTERVAL_MS: "5",
    CHATBOT_WORKER_REMINDERS_INTERVAL_MS: "5",
    CHATBOT_WORKER_BOOKING_RECONCILE_INTERVAL_MS: "5",
    CHATBOT_WORKER_WIDGET_RATE_LIMIT_CLEANUP_INTERVAL_MS: "5",
    ...extra,
  };
}

/** Builds a full set of service fakes. Every call is counted. */
function fakeServices(overrides = {}) {
  const seen = { outbox: [], channel: [], claim: [], voice: [], callLimits: [], reminders: [], reconcile: [], expire: [] };
  const services = {
    eventOutbox: {
      processor: {
        async process(companyId) {
          seen.outbox.push(companyId);
          return { claimed: 1, published: 1, retried: 0, deadLettered: 0 };
        },
      },
    },
    channelOutbox: {
      outbox: {
        async drain(companyId) {
          seen.channel.push(companyId);
          return { expired: 0, claimed: 1, sent: 1, retryScheduled: 0, failed: 0 };
        },
      },
      pipeline: {},
    },
    workflows: {
      runtime: {
        async claimNext(companyId) {
          seen.claim.push(companyId);
          return null;
        },
        async complete() {
          return null;
        },
        async fail() {
          return null;
        },
      },
      async execute() {
        return {};
      },
    },
    voice: {
      async expireIdleSessions(companyId) {
        seen.voice.push(companyId);
        return 0;
      },
    },
    voiceCallLimits: {
      async enforceLimitsForCompany(companyId, options) {
        seen.callLimits.push({ companyId, limit: options.limit });
        return { ok: true, value: { ended: 1, scanned: 1 } };
      },
    },
    reminders: {
      async runDue(companyId) {
        seen.reminders.push(companyId);
        return { due: 0, sent: 0, failed: 0, skipped: 0 };
      },
    },
    structuredActions: {
      async expireStaleProposals(companyId, now) {
        seen.expire.push({ companyId, now });
        return 0;
      },
    },
    reconciliation: {
      jobs: [
        // No connection for this fake provider, so the job returns not_connected without any provider call.
        {
          provider: "calcom",
          async lister() {
            throw new Error("should not be called");
          },
          async loadConnection(companyId) {
            seen.reconcile.push(companyId);
            return null;
          },
        },
      ],
    },
    ...overrides,
  };
  return { services, seen };
}

test("flag off starts nothing and reads no interval variables", async () => {
  const { services, seen } = fakeServices();
  const logger = recordingLogger();
  const handle = startChatbotWorkers({
    db: fakeDb(),
    env: { CHATBOT_WORKER_OUTBOX_DRAIN_INTERVAL_MS: "not-a-number", [CHATBOT_WORKERS_FLAG]: "1" },
    services,
    logger,
    companyIds: async () => [COMPANY_A],
  });
  assert.equal(handle.enabled, false);
  assert.deepEqual(handle.jobs, []);
  await sleep(40);
  assert.equal(seen.outbox.length + seen.channel.length + seen.voice.length, 0);
  assert.deepEqual(await stopChatbotWorkers(handle), { timedOut: false });
});

test("flag must be exactly the string true", () => {
  for (const value of ["TRUE", "yes", "on", " true"]) {
    const handle = startChatbotWorkers({
      db: fakeDb(),
      env: { [CHATBOT_WORKERS_FLAG]: value },
      services: fakeServices().services,
      logger: recordingLogger(),
      companyIds: async () => [COMPANY_A],
    });
    assert.equal(handle.enabled, false, `value ${JSON.stringify(value)} must not enable`);
  }
});

test("flag on runs every job for every company", async () => {
  const { services, seen } = fakeServices();
  const db = fakeDb();
  const logger = recordingLogger();
  const handle = startChatbotWorkers({
    db,
    env: fastEnv(),
    services,
    logger,
    companyIds: async () => [COMPANY_A, COMPANY_B],
  });
  assert.equal(handle.enabled, true);
  assert.deepEqual(
    [...handle.jobs].sort(),
    [
      "booking_reconcile",
      "channel_send_drain",
      "events_worker",
      "outbox_drain",
      "reminders",
      "voice_call_limits",
      "voice_sweep",
      "widget_rate_limit_cleanup",
    ],
  );
  await sleep(120);
  await stopChatbotWorkers(handle);

  for (const list of [seen.outbox, seen.channel, seen.claim, seen.voice, seen.reminders, seen.reconcile]) {
    assert.ok(list.includes(COMPANY_A), "job ran for company A");
    assert.ok(list.includes(COMPANY_B), "job ran for company B");
  }
  assert.ok(seen.callLimits.some((c) => c.companyId === COMPANY_A), "call limit sweep ran for company A");
  assert.ok(seen.callLimits.some((c) => c.companyId === COMPANY_B), "call limit sweep ran for company B");
  assert.ok(db.calls.length > 0, "widget cleanup ran");
  assert.ok(logger.events.some((e) => e.event === "workers.started"));
});

test("unwired jobs are not started", () => {
  const logger = recordingLogger();
  const { services } = fakeServices();
  delete services.voice;
  delete services.reminders;
  const handle = startChatbotWorkers({
    db: fakeDb(),
    env: fastEnv(),
    services: { voice: undefined, reminders: undefined, eventOutbox: services.eventOutbox },
    logger,
    companyIds: async () => [COMPANY_A],
  });
  assert.ok(!handle.jobs.includes("voice_sweep"));
  assert.ok(!handle.jobs.includes("reminders"));
  assert.ok(handle.jobs.includes("outbox_drain"));
  assert.ok(logger.events.some((e) => e.event === "workers.job_not_wired" && e.fields.job === "voice_sweep"));
  return stopChatbotWorkers(handle);
});

test("a throwing job does not stop the others", async () => {
  const { services, seen } = fakeServices({
    reminders: {
      async runDue() {
        throw new Error("boom with a secret-looking detail");
      },
    },
  });
  const logger = recordingLogger();
  const handle = startChatbotWorkers({
    db: fakeDb(),
    env: fastEnv(),
    services,
    logger,
    companyIds: async () => [COMPANY_A],
  });
  await sleep(120);
  await stopChatbotWorkers(handle);

  assert.ok(seen.outbox.length >= 2, "outbox drain kept running");
  assert.ok(seen.voice.length >= 2, "voice sweep kept running");
  const failed = logger.events.find((e) => e.event === "workers.company_failed" && e.fields.job === "reminders");
  assert.ok(failed, "the reminders failure was logged");
  assert.equal(failed.fields.errorName, "Error");
  assert.ok(!JSON.stringify(logger.events).includes("secret-looking"), "error message is not logged");
});

test("a company that fails does not stop the other companies in the same tick", async () => {
  const { services, seen } = fakeServices({
    voice: {
      async expireIdleSessions(companyId) {
        seen.voice.push(companyId);
        if (companyId === COMPANY_A) throw Object.assign(new Error("db down"), { code: "DB_DOWN" });
        return 2;
      },
    },
  });
  const logger = recordingLogger();
  const handle = startChatbotWorkers({
    db: fakeDb(),
    env: fastEnv(),
    services,
    logger,
    companyIds: async () => [COMPANY_A, COMPANY_B],
  });
  await sleep(30);
  await stopChatbotWorkers(handle);
  assert.ok(seen.voice.includes(COMPANY_B));
  const failed = logger.events.find((e) => e.event === "workers.company_failed" && e.fields.companyId === COMPANY_A);
  assert.equal(failed.fields.errorCode, "DB_DOWN");
});

test("a job still running is skipped on the next tick", async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const { services } = fakeServices({
    voice: {
      async expireIdleSessions() {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(60);
        active -= 1;
        return 0;
      },
    },
  });
  const logger = recordingLogger();
  const handle = startChatbotWorkers({
    db: fakeDb(),
    env: fastEnv(),
    services,
    logger,
    companyIds: async () => [COMPANY_A],
  });
  await sleep(150);
  await stopChatbotWorkers(handle);

  assert.equal(maxActive, 1, "never two ticks of one job at once");
  assert.ok(calls >= 1);
  assert.ok(logger.events.some((e) => e.event === "workers.job_skipped_overlap" && e.fields.job === "voice_sweep"));
});

test("stop waits for an in-flight job and clears the timers", async () => {
  let started = false;
  let finished = false;
  let callsAfterStop = 0;
  let stopping = false;
  const { services } = fakeServices({
    reminders: {
      async runDue() {
        if (stopping) callsAfterStop += 1;
        started = true;
        await sleep(80);
        finished = true;
        return { due: 0, sent: 0, failed: 0, skipped: 0 };
      },
    },
  });
  const handle = startChatbotWorkers({
    db: fakeDb(),
    env: fastEnv(),
    services,
    logger: recordingLogger(),
    companyIds: async () => [COMPANY_A],
  });
  for (let i = 0; i < 500 && !started; i++) await sleep(2);
  assert.equal(started, true, "reminders run began before stop");
  stopping = true;
  const result = await stopChatbotWorkers(handle);
  assert.equal(finished, true, "stop resolved only after the in-flight job finished");
  assert.equal(result.timedOut, false);
  await sleep(30);
  assert.equal(callsAfterStop, 0, "no new ticks start after stop");
});

test("stop resolves after the timeout when a job never finishes", async () => {
  const { services } = fakeServices({
    reminders: {
      async runDue() {
        await new Promise(() => {});
      },
    },
  });
  const handle = startChatbotWorkers({
    db: fakeDb(),
    env: fastEnv(),
    services,
    logger: recordingLogger(),
    companyIds: async () => [COMPANY_A],
  });
  await sleep(30);
  const started = Date.now();
  const result = await stopChatbotWorkers(handle, { timeoutMs: 50 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 1000);
});

test("voice_call_limits is not started without its service and counts a refused company", async () => {
  const logger = recordingLogger();
  const { services } = fakeServices();
  delete services.voiceCallLimits;
  const unwired = startChatbotWorkers({
    db: fakeDb(),
    env: fastEnv(),
    services,
    logger,
    companyIds: async () => [COMPANY_A],
  });
  assert.ok(!unwired.jobs.includes("voice_call_limits"));
  assert.ok(logger.events.some((e) => e.event === "workers.job_not_wired" && e.fields.job === "voice_call_limits"));
  await stopChatbotWorkers(unwired);

  // A sweep failure is reported as a count, not thrown, so the tick still runs for every other company.
  const { services: refusing, seen } = fakeServices({
    voiceCallLimits: {
      async enforceLimitsForCompany(companyId) {
        seen.callLimits.push({ companyId, limit: 0 });
        if (companyId === COMPANY_A) return { ok: false, status: 503, error: "down" };
        return { ok: true, value: { ended: 2, scanned: 2 } };
      },
    },
  });
  const handle = startChatbotWorkers({
    db: fakeDb(),
    env: fastEnv(),
    services: refusing,
    logger,
    companyIds: async () => [COMPANY_A, COMPANY_B],
  });
  await sleep(30);
  await stopChatbotWorkers(handle);
  assert.ok(seen.callLimits.some((c) => c.companyId === COMPANY_B), "company B swept after company A was refused");
  assert.ok(
    !logger.events.some((e) => e.event === "workers.company_failed" && e.fields.job === "voice_call_limits"),
    "a refusal is counted, not logged as a thrown company failure",
  );
});

test("the proposal sweep runs once per company per tick, with the tick clock", async () => {
  const { services, seen } = fakeServices();
  const fixed = new Date("2026-11-09T00:00:00Z");
  const handle = startChatbotWorkers({
    db: fakeDb(),
    env: fastEnv(),
    services,
    logger: recordingLogger(),
    companyIds: async () => [COMPANY_A, COMPANY_B],
    clock: () => fixed,
  });
  await sleep(120);
  await stopChatbotWorkers(handle);

  assert.ok(seen.expire.length >= 4, "the sweep ran on several ticks");
  // Each tick visits A then B and nothing else, so the calls alternate in that order.
  seen.expire.forEach((call, i) => {
    assert.equal(call.companyId, [COMPANY_A, COMPANY_B][i % 2], `call ${i} follows tick order`);
    assert.ok(call.now instanceof Date && call.now.getTime() === fixed.getTime(), "the tick clock is passed");
  });
});

test("without a structured action service the events job still runs and skips the sweep", async () => {
  const { services, seen } = fakeServices();
  delete services.structuredActions;
  const logger = recordingLogger();
  const handle = startChatbotWorkers({
    db: fakeDb(),
    env: fastEnv(),
    services,
    logger,
    companyIds: async () => [COMPANY_A],
  });
  assert.ok(handle.jobs.includes("events_worker"));
  await sleep(40);
  await stopChatbotWorkers(handle);

  assert.ok(seen.claim.includes(COMPANY_A), "claims still ran");
  assert.ok(!logger.events.some((e) => e.event === "workers.company_failed"), "a missing sweep is not an error");
  assert.ok(!logger.events.some((e) => e.event === "workers.job_not_wired" && e.fields.job === "events_worker"));
});

test("the proposal sweep alone starts the events job, with no claims", async () => {
  const { services, seen } = fakeServices();
  delete services.workflows;
  const handle = startChatbotWorkers({
    db: fakeDb(),
    env: fastEnv(),
    services,
    logger: recordingLogger(),
    companyIds: async () => [COMPANY_A],
  });
  assert.ok(handle.jobs.includes("events_worker"));
  await sleep(30);
  await stopChatbotWorkers(handle);

  assert.ok(seen.expire.some((c) => c.companyId === COMPANY_A), "the sweep ran");
  assert.equal(seen.claim.length, 0, "no workflow runtime was supplied, so nothing was claimed");
});

test("a failing sweep for one company is logged and the next company is still swept", async () => {
  const { services, seen } = fakeServices({
    structuredActions: {
      async expireStaleProposals(companyId, now) {
        seen.expire.push({ companyId, now });
        if (companyId === COMPANY_A) throw Object.assign(new Error("store down"), { code: "STORE_DOWN" });
        return 1;
      },
    },
  });
  const logger = recordingLogger();
  const handle = startChatbotWorkers({
    db: fakeDb(),
    env: fastEnv(),
    services,
    logger,
    companyIds: async () => [COMPANY_A, COMPANY_B],
  });
  await sleep(30);
  await stopChatbotWorkers(handle);

  assert.ok(seen.expire.some((c) => c.companyId === COMPANY_B), "company B swept after company A failed");
  const failed = logger.events.find(
    (e) => e.event === "workers.company_failed" && e.fields.job === "events_worker" && e.fields.companyId === COMPANY_A,
  );
  assert.ok(failed, "the sweep failure was logged for company A");
  assert.equal(failed.fields.errorCode, "STORE_DOWN");
  assert.ok(!JSON.stringify(logger.events).includes("store down"), "the error message is never logged");
});

test("voice_call_limits starts only from the voiceCallLimits key, not from voice", async () => {
  const { services } = fakeServices();
  const onlyVoice = startChatbotWorkers({
    db: fakeDb(),
    env: fastEnv(),
    services: { voice: services.voice },
    logger: recordingLogger(),
    companyIds: async () => [COMPANY_A],
  });
  assert.ok(onlyVoice.jobs.includes("voice_sweep"));
  assert.ok(!onlyVoice.jobs.includes("voice_call_limits"));
  await stopChatbotWorkers(onlyVoice);

  const onlyLimits = startChatbotWorkers({
    db: fakeDb(),
    env: fastEnv(),
    services: { voiceCallLimits: services.voiceCallLimits },
    logger: recordingLogger(),
    companyIds: async () => [COMPANY_A],
  });
  assert.ok(onlyLimits.jobs.includes("voice_call_limits"));
  assert.ok(!onlyLimits.jobs.includes("voice_sweep"));
  await stopChatbotWorkers(onlyLimits);
});

/** Flattens a drizzle sql object into its literal SQL text, with parameters shown as placeholders. */
function sqlText(query) {
  return (query.queryChunks ?? [])
    .map((chunk) => {
      if (Array.isArray(chunk?.value)) return chunk.value.join("");
      if (chunk && Array.isArray(chunk.queryChunks)) return sqlText(chunk);
      return "?";
    })
    .join("");
}

test("the company id source is one ids-only query and only its id column is used", async () => {
  assert.equal(sqlText(companyIdsQuery()), "select id from companies order by id");

  const db = {
    calls: [],
    async execute(query) {
      this.calls.push(query);
      // Extra columns must never reach the worker, even if a future query returns them.
      return {
        rows: [
          { id: COMPANY_A, name: "Acme", api_key: "should-not-leak" },
          { id: 42, name: "not a string id" },
          { name: "no id" },
          { id: COMPANY_B },
        ],
      };
    },
  };
  const ids = await listCompanyIdsFromDb(db)();
  assert.deepEqual(ids, [COMPANY_A, COMPANY_B]);
  assert.equal(db.calls.length, 1, "one query per read");
  assert.equal(sqlText(db.calls[0]), "select id from companies order by id");
  assert.ok(!JSON.stringify(ids).includes("should-not-leak"));
});

test("a non-positive-integer interval variable fails before any job starts", () => {
  for (const bad of ["0", "-5", "1.5", "abc", "1e3"]) {
    const { services, seen } = fakeServices();
    assert.throws(
      () =>
        startChatbotWorkers({
          db: fakeDb(),
          env: fastEnv({ CHATBOT_WORKER_REMINDERS_INTERVAL_MS: bad }),
          services,
          logger: recordingLogger(),
          companyIds: async () => [COMPANY_A],
        }),
      (error) => error.code === "WORKER_CONFIG" && error.message.includes("CHATBOT_WORKER_REMINDERS_INTERVAL_MS"),
      `value ${bad} must be refused`,
    );
    assert.equal(seen.outbox.length, 0);
  }
});

test("a failing workflow step logs the error name and code, never the message", async () => {
  let claims = 0;
  const failed = [];
  const { services } = fakeServices({
    workflows: {
      runtime: {
        async claimNext() {
          claims += 1;
          return claims === 1 ? { id: "run-1" } : null;
        },
        async complete() {
          return null;
        },
        async fail(companyId, runId, reason) {
          failed.push({ companyId, runId, reason });
          return null;
        },
      },
      async execute() {
        throw Object.assign(new TypeError("secret-token-xyz"), { code: "E_STEP" });
      },
    },
  });
  const logger = recordingLogger();
  const handle = startChatbotWorkers({
    db: fakeDb(),
    env: fastEnv(),
    services,
    logger,
    companyIds: async () => [COMPANY_A],
  });
  await sleep(80);
  await stopChatbotWorkers(handle);

  const entry = logger.events.find((e) => e.event === "workers.events_run_failed");
  assert.ok(entry, "the failed run is logged");
  assert.equal(entry.level, "warn");
  assert.equal(entry.fields.companyId, COMPANY_A);
  assert.equal(entry.fields.runId, "run-1");
  assert.equal(entry.fields.errorName, "TypeError");
  assert.equal(entry.fields.errorCode, "E_STEP");
  assert.ok(!JSON.stringify(logger.events).includes("secret-token-xyz"), "the message is never logged");
  assert.deepEqual(failed[0], { companyId: COMPANY_A, runId: "run-1", reason: "Workflow step failed." });
});

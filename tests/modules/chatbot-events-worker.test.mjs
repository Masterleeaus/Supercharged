// Events worker tests: webhook SSRF guard (including redirects), the leased outbox batch, lease fencing, and the
// company-scoped dead-letter view. No network: DNS is a fake resolver, HTTP is a recording fake, time is injected.
//
// Run: NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types tests/modules/chatbot-events-worker.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { CONTRACT_FLAGS } from "../../server/modules/chatbot/contracts/index.ts";
import { InMemoryEventPublisher } from "../../server/modules/chatbot/inbox/event-publisher.ts";
import {
  EventsError,
  assertPublicWebhookUrl,
  createDeadLetterView,
  createMemoryEventsStore,
  createOutboxProcessor,
  createOutboxStorage,
  createWebhookDispatcher,
  createWebhookSubscriptionService,
  clampDeadLetterLimit,
  leaseOwnerFor,
  outboxDeadLetterQuery,
  WebhookUrlRefusedError,
} from "../../server/modules/chatbot/events/index.ts";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const HOOK = "https://hooks.example.test/chatbot";
const SECRET = "whsec_worker_test_0123456789abcdef0123";
const PUBLIC_ADDRESS = "93.184.216.34";
const START = new Date("2026-11-09T10:00:00.000Z");
const dialect = new PgDialect();
const ENABLED = { [CONTRACT_FLAGS.OUTBOUND_WEBHOOKS_ENABLED]: "true" };

function makeSecretBox() {
  const key = randomBytes(32);
  return {
    async encrypt(companyId, plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(companyId, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return {
        v: 1,
        alg: "aes-256-gcm",
        keyId: "v1",
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };
    },
    async decrypt(companyId, sealed) {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
      decipher.setAAD(Buffer.from(companyId, "utf8"));
      decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64")), decipher.final()]).toString("utf8");
    },
  };
}

/**
 * Builds the slice on a memory store. `dns` maps host names to addresses; unknown hosts resolve to a public
 * address. `respond` answers each HTTP request. Every lookup and request is recorded.
 */
function world({ dns = {}, respond, env = ENABLED } = {}) {
  let clock = new Date(START);
  let seq = 0;
  const events = { now: () => new Date(clock), newId: () => `id-${++seq}` };
  const store = createMemoryEventsStore();
  const secretBox = makeSecretBox();
  const publisher = new InMemoryEventPublisher();
  const lookups = [];
  const calls = [];
  const resolve = async (host) => {
    lookups.push(host);
    return dns[host] ?? [PUBLIC_ADDRESS];
  };
  const http = async (request) => {
    calls.push({ ...request });
    return respond ? respond(request) : { status: 200, headers: {}, body: "" };
  };
  const webhooks = createWebhookDispatcher({ http, secretBox, store, env, events, resolve });
  const processor = createOutboxProcessor({ store, webhooks, publisher, events });
  const outbox = createOutboxStorage(store, events);
  const subscriptions = createWebhookSubscriptionService(store, secretBox, events, resolve);
  return {
    store,
    events,
    publisher,
    lookups,
    calls,
    processor,
    outbox,
    subscriptions,
    webhooks,
    advance(seconds) {
      clock = new Date(clock.getTime() + seconds * 1000);
    },
  };
}

async function appendEvent(w, companyId, topic, n) {
  return w.outbox.append(companyId, {
    companyId,
    topic,
    aggregateId: `agg-${n}`,
    payload: { conversationId: `conv-${n}`, data: { n } },
    dedupeKey: `${companyId}:${topic}:${n}`,
    availableAt: new Date(START),
  });
}

// ---------------------------------------------------------------------------
// SSRF guard: subscribe time and dispatch time
// ---------------------------------------------------------------------------

test("a private, loopback or metadata address is refused when a subscription is saved", async () => {
  const w = world({ dns: { "internal.example.test": ["10.0.0.5"] } });
  await assert.rejects(
    w.subscriptions.subscribe(COMPANY_A, { url: "https://internal.example.test/x", topics: ["*"], signingSecret: SECRET }),
    (error) => error instanceof EventsError && error.code === "VALIDATION",
  );
  await assert.rejects(
    w.subscriptions.subscribe(COMPANY_A, { url: "https://169.254.169.254/latest/meta-data", topics: ["*"], signingSecret: SECRET }),
    EventsError,
  );
  await assert.rejects(
    w.subscriptions.subscribe(COMPANY_A, { url: "https://127.0.0.1/hook", topics: ["*"], signingSecret: SECRET }),
    EventsError,
  );
  assert.deepEqual(await w.subscriptions.list(COMPANY_A), []);
});

test("the webhook URL rule set: https only, port 443 only, no credentials, public addresses only", async () => {
  const resolve = async () => [PUBLIC_ADDRESS];
  const refused = [
    "http://hooks.example.test/x",
    "ftp://hooks.example.test/x",
    "https://user:pw@hooks.example.test/x",
    "https://hooks.example.test:8443/x",
    "https://localhost/x",
    "https://printer.internal/x",
    "https://intranet/x",
    "https://[::1]/x",
    "https://[::ffff:10.0.0.1]/x",
    "https://[fd00::1]/x",
    "https://[64:ff9b::a00:1]/x",
    "https://100.64.0.1/x",
    "https://0x7f000001/x",
    "not a url",
  ];
  for (const url of refused) {
    await assert.rejects(assertPublicWebhookUrl(url, resolve), WebhookUrlRefusedError, `expected refusal for ${url}`);
  }
  const url = await assertPublicWebhookUrl("https://hooks.example.test/chatbot", resolve);
  assert.equal(url.hostname, "hooks.example.test");
});

test("a name that resolves to any private address is refused, and a failed lookup is refused", async () => {
  await assert.rejects(
    assertPublicWebhookUrl("https://mixed.example.test/x", async () => [PUBLIC_ADDRESS, "127.0.0.1"]),
    (error) => error instanceof WebhookUrlRefusedError && error.reason === "address",
  );
  await assert.rejects(
    assertPublicWebhookUrl("https://gone.example.test/x", async () => {
      throw new Error("ENOTFOUND");
    }),
    (error) => error instanceof WebhookUrlRefusedError && error.reason === "resolution",
  );
});

test("a redirect to a private address is refused and nothing is sent to it", async () => {
  const w = world({
    dns: { "hooks.example.test": [PUBLIC_ADDRESS], "internal.example.test": ["10.0.0.9"] },
    respond: () => ({ status: 307, headers: { location: "https://internal.example.test/admin" }, body: "" }),
  });
  await w.subscriptions.subscribe(COMPANY_A, { url: HOOK, topics: ["*"], signingSecret: SECRET });
  const event = await appendEvent(w, COMPANY_A, "conversation.handoff", 1);

  const deliveries = await w.webhooks.dispatch(COMPANY_A, event);

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].ok, false);
  assert.equal(deliveries[0].errorMessage, "Redirect target refused.");
  assert.equal(w.calls.length, 1, "only the public hop was requested");
  assert.equal(w.calls[0].url, HOOK);
  assert.ok(!w.calls.some((c) => c.url.includes("internal.example.test")), "the private target was never requested");
});

test("a redirect to a private IP literal is refused without a DNS lookup", async () => {
  const w = world({
    respond: () => ({ status: 308, headers: { location: "https://169.254.169.254/latest/meta-data/" }, body: "" }),
  });
  await w.subscriptions.subscribe(COMPANY_A, { url: HOOK, topics: ["*"], signingSecret: SECRET });
  const event = await appendEvent(w, COMPANY_A, "conversation.handoff", 1);
  const [delivery] = await w.webhooks.dispatch(COMPANY_A, event);
  assert.equal(delivery.errorMessage, "Redirect target refused.");
  assert.equal(w.calls.length, 1);
  assert.ok(!w.lookups.includes("169.254.169.254"));
});

test("a public 307 redirect is followed with the same signed body, and a 302 is not followed", async () => {
  let hop = 0;
  const w = world({
    respond: () => {
      hop++;
      if (hop === 1) return { status: 307, headers: { location: "/relay/chatbot" }, body: "" };
      return { status: 200, headers: {}, body: "" };
    },
  });
  await w.subscriptions.subscribe(COMPANY_A, { url: HOOK, topics: ["*"], signingSecret: SECRET });
  const event = await appendEvent(w, COMPANY_A, "conversation.handoff", 1);
  const [followed] = await w.webhooks.dispatch(COMPANY_A, event);
  assert.equal(followed.ok, true);
  assert.equal(w.calls.length, 2);
  assert.equal(w.calls[1].url, "https://hooks.example.test/relay/chatbot");
  assert.equal(w.calls[1].body, w.calls[0].body, "the body is identical on the redirected hop");
  assert.equal(w.calls[1].headers["Idempotency-Key"], event.id);

  const w2 = world({ respond: () => ({ status: 302, headers: { location: "https://hooks.example.test/other" }, body: "" }) });
  await w2.subscriptions.subscribe(COMPANY_A, { url: HOOK, topics: ["*"], signingSecret: SECRET });
  const event2 = await appendEvent(w2, COMPANY_A, "conversation.handoff", 2);
  const [refused] = await w2.webhooks.dispatch(COMPANY_A, event2);
  assert.equal(refused.ok, false);
  assert.equal(refused.errorMessage, "Redirect not followed.");
  assert.equal(w2.calls.length, 1);
});

test("redirects stop after three hops", async () => {
  const w = world({
    respond: () => ({ status: 307, headers: { location: "https://hooks.example.test/loop" }, body: "" }),
  });
  await w.subscriptions.subscribe(COMPANY_A, { url: HOOK, topics: ["*"], signingSecret: SECRET });
  const event = await appendEvent(w, COMPANY_A, "conversation.handoff", 1);
  const [delivery] = await w.webhooks.dispatch(COMPANY_A, event);
  assert.equal(delivery.errorMessage, "Too many redirects.");
  assert.equal(w.calls.length, 4, "one request plus three followed redirects");
});

// ---------------------------------------------------------------------------
// Outbox batch: leases and fencing
// ---------------------------------------------------------------------------

test("two workers never process the same row", async () => {
  const w = world({
    respond: () => new Promise((resolve) => setTimeout(() => resolve({ status: 200, headers: {}, body: "" }), 5)),
  });
  await w.subscriptions.subscribe(COMPANY_A, { url: HOOK, topics: ["*"], signingSecret: SECRET });
  for (let n = 1; n <= 5; n++) await appendEvent(w, COMPANY_A, "conversation.handoff", n);

  const [a, b] = await Promise.all([
    w.processor.process(COMPANY_A, { workerId: "worker-a", limit: 3 }),
    w.processor.process(COMPANY_A, { workerId: "worker-b", limit: 3 }),
  ]);

  assert.equal(a.claimed + b.claimed, 5, "every row was claimed once in total");
  assert.equal(a.published + b.published, 5);
  const sentPerEvent = new Map();
  for (const call of w.calls) {
    const id = call.headers["Idempotency-Key"];
    sentPerEvent.set(id, (sentPerEvent.get(id) ?? 0) + 1);
  }
  assert.equal(sentPerEvent.size, 5);
  assert.ok([...sentPerEvent.values()].every((count) => count === 1), "no event was sent twice");
});

test("a worker whose lease expired cannot overwrite the row taken over by another worker", async () => {
  let runB = null;
  let fired = false;
  const w = world({
    respond: async () => {
      if (!fired) {
        fired = true;
        // Worker A is still inside its webhook call when its lease runs out. Worker B takes the row and publishes it.
        w.advance(400);
        runB = w.processor.process(COMPANY_A, { workerId: "worker-b", limit: 1, leaseSeconds: 300 });
        await runB;
      }
      return { status: 200, headers: {}, body: "" };
    },
  });
  await w.subscriptions.subscribe(COMPANY_A, { url: HOOK, topics: ["*"], signingSecret: SECRET });
  await appendEvent(w, COMPANY_A, "conversation.handoff", 1);

  const a = await w.processor.process(COMPANY_A, { workerId: "worker-a", limit: 1, leaseSeconds: 300 });
  const b = await runB;

  assert.equal(a.published, 0, "the stale worker's publish was fenced out");
  assert.equal(b.published, 1, "the worker that holds the lease published");
  const pending = await w.outbox.claimBatch(COMPANY_A, 10, w.events.now());
  assert.deepEqual(pending, [], "nothing is left pending after the takeover");
});

test("a lease owner string carries the worker id and a claim token, and a bad worker id is refused", () => {
  assert.equal(leaseOwnerFor("worker-a", "tok-1"), "worker-a/tok-1");
  assert.throws(() => leaseOwnerFor("", "tok"), EventsError);
  assert.throws(() => leaseOwnerFor("a/b", "tok"), EventsError);
  assert.throws(() => leaseOwnerFor("x".repeat(101), "tok"), EventsError);
});

// ---------------------------------------------------------------------------
// Dead-letter view
// ---------------------------------------------------------------------------

async function deadLetter(w, companyId, n, failedAt) {
  const event = await appendEvent(w, companyId, "conversation.handoff", n);
  await w.store.markDeadLetter(companyId, event.id, { attempts: 8, failedAt, lastError: `Relay failed ${n}.` });
  return event;
}

test("the dead-letter view never returns another company's rows", async () => {
  const w = world();
  const view = createDeadLetterView(w.store);
  const a1 = await deadLetter(w, COMPANY_A, 1, new Date("2026-11-09T11:00:00Z"));
  const a2 = await deadLetter(w, COMPANY_A, 2, new Date("2026-11-09T12:00:00Z"));
  const b1 = await deadLetter(w, COMPANY_B, 3, new Date("2026-11-09T13:00:00Z"));
  await appendEvent(w, COMPANY_A, "conversation.handoff", 4); // pending, not dead-lettered

  const forA = await view.list(COMPANY_A);
  const forB = await view.list(COMPANY_B);

  assert.deepEqual(forA.map((r) => r.id).sort(), [a1.id, a2.id].sort());
  assert.deepEqual(forB.map((r) => r.id), [b1.id]);
  assert.ok(!forA.some((r) => r.id === b1.id), "company A never sees company B's row");
  assert.deepEqual(await view.list("33333333-3333-4333-8333-333333333333"), []);
  assert.deepEqual(await view.list(""), []);
});

test("the dead-letter view lists newest first, leaves out payloads, and clamps the limit", async () => {
  const w = world();
  const view = createDeadLetterView(w.store);
  await deadLetter(w, COMPANY_A, 1, new Date("2026-11-09T11:00:00Z"));
  const newest = await deadLetter(w, COMPANY_A, 2, new Date("2026-11-09T14:00:00Z"));
  await deadLetter(w, COMPANY_A, 3, new Date("2026-11-09T12:00:00Z"));

  const top = await view.list(COMPANY_A, { limit: 2 });
  assert.equal(top.length, 2);
  assert.equal(top[0].id, newest.id);
  for (const entry of top) {
    assert.equal("payload" in entry, false, "payloads are not part of the operator view");
    assert.equal(entry.attempts, 8);
  }

  assert.equal(clampDeadLetterLimit(0), 1);
  assert.equal(clampDeadLetterLimit(Number.NaN), 50);
  assert.equal(clampDeadLetterLimit(1e9), 200);
  assert.equal(clampDeadLetterLimit(7.9), 7);
});

test("the dead-letter query carries company_id in its WHERE clause", () => {
  const client = {
    async query() {
      return { rows: [], rowCount: 0, fields: [] };
    },
  };
  const db = drizzle(client);
  const rendered = dialect.sqlToQuery(outboxDeadLetterQuery(db, COMPANY_A, 10).getSQL());
  assert.match(rendered.sql, /"company_id" = \$1/);
  assert.match(rendered.sql, /"status" = \$2/);
  assert.deepEqual(rendered.params.slice(0, 2), [COMPANY_A, "failed"]);
  assert.ok(!rendered.params.includes(COMPANY_B));
});

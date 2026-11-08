// Events slice tests: workflows, structured actions, webhooks, outbox and notifications (node:test).
// No network: HTTP is a recording fake, the SecretBox is real AES-256-GCM with a test key, and time is injected.
// The Drizzle store is exercised through a recording pg client, and its SQL is rendered with PgDialect.
//
// Run: NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types tests/modules/chatbot-events.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { CONTRACT_FLAGS, readFlag } from "../../server/modules/chatbot/contracts/index.ts";
import { InMemoryEventPublisher } from "../../server/modules/chatbot/inbox/event-publisher.ts";
import {
  EventsError,
  createDrizzleEventsStore,
  createMemoryEventsStore,
  createNotificationRuntime,
  createOutboxProcessor,
  createOutboxStorage,
  createStructuredActionService,
  createWebhookDispatcher,
  createWebhookSubscriptionService,
  createWorkflowRuntime,
  outboxBackoffSeconds,
  signWebhookBody,
  validateActionArgs,
  validatePresentation,
  validatePresentationResponse,
  verifyWebhookSignature,
  workflowRetryDelaySeconds,
  workflowRunByIdQuery,
  outboxClaimQuery,
  actionListQuery,
  webhookDeliveriesQuery,
  webhookSubscriptionsQuery,
  workflowRunByIdempotencyQuery,
} from "../../server/modules/chatbot/events/index.ts";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const WEBHOOK_URL = "https://hooks.example.test/chatbot";
/** Fake DNS answer for hooks.example.test: a public address. Tests never resolve DNS. */
const PUBLIC_ADDRESS = "93.184.216.34";
const SIGNING_SECRET = "whsec_test_0123456789abcdef0123456789";
const START = new Date("2026-11-08T10:00:00.000Z");
const dialect = new PgDialect();

/** Real AES-256-GCM with a random per-process key. The companyId is bound as associated data. */
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

/** Builds the whole slice on a memory store with a fake clock, fake HTTP and a recording publisher. */
function harness({ env = { [CONTRACT_FLAGS.OUTBOUND_WEBHOOKS_ENABLED]: "true" }, respond } = {}) {
  let clock = new Date(START);
  let seq = 0;
  const events = { now: () => new Date(clock), newId: () => `id-${++seq}` };
  const store = createMemoryEventsStore();
  const secretBox = makeSecretBox();
  const httpCalls = [];
  const http = async (request) => {
    httpCalls.push({ ...request, at: new Date(clock) });
    return respond ? respond(request) : { status: 200, headers: {}, body: "" };
  };
  const publisher = new InMemoryEventPublisher();
  const resolve = async () => [PUBLIC_ADDRESS];
  const webhooks = createWebhookDispatcher({ http, secretBox, store, env, events, resolve });
  const processor = createOutboxProcessor({ store, webhooks, publisher, events });
  const outbox = createOutboxStorage(store, events);
  const subscriptions = createWebhookSubscriptionService(store, secretBox, events, resolve);
  return {
    store,
    secretBox,
    events,
    httpCalls,
    publisher,
    processor,
    outbox,
    subscriptions,
    workflows: createWorkflowRuntime(store, events),
    actions: createStructuredActionService(store, events),
    advance(seconds) {
      clock = new Date(clock.getTime() + seconds * 1000);
    },
    now: () => new Date(clock),
  };
}

async function appendHandoff(h, companyId, conversationId, key) {
  return h.outbox.append(companyId, {
    companyId,
    topic: "conversation.handoff",
    aggregateId: conversationId,
    payload: { conversationId, data: { actorId: "staff-1", to: "human" } },
    dedupeKey: key,
    availableAt: h.now(),
  });
}

// ---------------------------------------------------------------------------
// Webhook signing and secrets
// ---------------------------------------------------------------------------

test("webhook HMAC is the hex HMAC-SHA256 of the exact body bytes", async () => {
  const h = harness();
  h.store.addConversation(COMPANY_A, "conv-1");
  await h.subscriptions.subscribe(COMPANY_A, { url: WEBHOOK_URL, topics: ["*"], signingSecret: SIGNING_SECRET });
  await appendHandoff(h, COMPANY_A, "conv-1", "handoff:conv-1:1");

  await h.processor.process(COMPANY_A, { workerId: "w1" });

  assert.equal(h.httpCalls.length, 1);
  const sent = h.httpCalls[0];
  const expected = `sha256=${createHmac("sha256", SIGNING_SECRET).update(sent.body, "utf8").digest("hex")}`;
  assert.equal(sent.headers["X-Chatbot-Signature"], expected);
  assert.equal(sent.headers["X-Chatbot-Event"], "conversation.handoff");
  assert.equal(sent.headers["Idempotency-Key"], JSON.parse(sent.body).payload.event_uuid);
  const body = JSON.parse(sent.body);
  assert.equal(body.event, "conversation.handoff");
  assert.equal(body.extension, "chatbot");
  assert.equal(sent.timeoutMs, 10_000);
});

test("signature helpers: a tampered body, a wrong secret or a missing secret is rejected", () => {
  const body = JSON.stringify({ event: "x", payload: { a: 1 } });
  const header = signWebhookBody(SIGNING_SECRET, body);
  assert.equal(verifyWebhookSignature(SIGNING_SECRET, body, header), true);
  assert.equal(verifyWebhookSignature(SIGNING_SECRET, body + " ", header), false);
  assert.equal(verifyWebhookSignature("another-secret-value-0123456789abcd", body, header), false);
  assert.equal(verifyWebhookSignature("", body, header), false);
  assert.equal(verifyWebhookSignature(null, body, header), false);
  assert.equal(verifyWebhookSignature(SIGNING_SECRET, body, undefined), false);
});

test("a webhook secret is never returned by subscribe, list, deliveries or results", async () => {
  const h = harness();
  h.store.addConversation(COMPANY_A, "conv-1");
  const created = await h.subscriptions.subscribe(COMPANY_A, { url: WEBHOOK_URL, topics: ["*"], signingSecret: SIGNING_SECRET });
  const listed = await h.subscriptions.list(COMPANY_A);
  await appendHandoff(h, COMPANY_A, "conv-1", "handoff:conv-1:2");
  const result = await h.processor.process(COMPANY_A, { workerId: "w1" });
  const eventId = JSON.parse(h.httpCalls[0].body).payload.event_uuid;
  const deliveries = await h.store.listDeliveries(COMPANY_A, eventId);

  const everything = JSON.stringify({ created, listed, result, deliveries: deliveries.map(({ subscriptionId, ok, httpStatus }) => ({ subscriptionId, ok, httpStatus })) });
  assert.equal(everything.includes(SIGNING_SECRET), false);
  assert.equal(everything.includes("signingSecret"), false);
  assert.equal(everything.includes("ciphertext"), false);
  assert.equal("signingSecret" in created, false);
  assert.equal(listed.length, 1);
  assert.equal("signingSecret" in listed[0], false);
});

test("a subscription with a secret sealed for another company is not sent to (fails closed)", async () => {
  const h = harness();
  const foreign = await h.secretBox.encrypt(COMPANY_B, SIGNING_SECRET);
  await h.store.insertSubscription(COMPANY_A, {
    id: "sub-foreign",
    companyId: COMPANY_A,
    url: WEBHOOK_URL,
    topics: ["*"],
    active: true,
    signingSecret: foreign,
  });
  await appendHandoff(h, COMPANY_A, "conv-x", "handoff:conv-x:1");

  const result = await h.processor.process(COMPANY_A, { workerId: "w1" });

  assert.equal(h.httpCalls.length, 0, "no request may leave unsigned or with a bad secret");
  assert.equal(result.retried, 1);
});

test("subscribe refuses a non-https URL, credentials in the URL, and a short secret", async () => {
  const h = harness();
  await assert.rejects(h.subscriptions.subscribe(COMPANY_A, { url: "http://hooks.example.test/x", topics: ["*"], signingSecret: SIGNING_SECRET }), EventsError);
  await assert.rejects(h.subscriptions.subscribe(COMPANY_A, { url: "https://user:pw@hooks.example.test/x", topics: ["*"], signingSecret: SIGNING_SECRET }), EventsError);
  await assert.rejects(h.subscriptions.subscribe(COMPANY_A, { url: WEBHOOK_URL, topics: ["*"], signingSecret: "short" }), EventsError);
});

test("webhook flag: only the exact string true sends; default off sends nothing", async () => {
  assert.equal(readFlag(CONTRACT_FLAGS.OUTBOUND_WEBHOOKS_ENABLED, {}), false);
  for (const value of ["1", "yes", "on", "TRUE"]) {
    assert.equal(readFlag(CONTRACT_FLAGS.OUTBOUND_WEBHOOKS_ENABLED, { [CONTRACT_FLAGS.OUTBOUND_WEBHOOKS_ENABLED]: value }), false);
  }

  const off = harness({ env: {} });
  await off.subscriptions.subscribe(COMPANY_A, { url: WEBHOOK_URL, topics: ["*"], signingSecret: SIGNING_SECRET });
  await appendHandoff(off, COMPANY_A, "conv-1", "handoff:conv-1:flag");
  const result = await off.processor.process(COMPANY_A, { workerId: "w1" });
  assert.equal(off.httpCalls.length, 0);
  assert.equal(result.published, 1);
});

// ---------------------------------------------------------------------------
// Outbox: at most once, and webhook retries with backoff then stop
// ---------------------------------------------------------------------------

test("an outbox event is processed at most once across repeated and concurrent runs", async () => {
  const h = harness();
  await appendHandoff(h, COMPANY_A, "conv-1", "handoff:conv-1:once");

  const first = await h.processor.process(COMPANY_A, { workerId: "w1" });
  const second = await h.processor.process(COMPANY_A, { workerId: "w2" });

  assert.equal(first.published, 1);
  assert.equal(second.claimed, 0);
  assert.equal(h.publisher.forCompany(COMPANY_A).length, 1);
});

test("a leased event is not taken by a second worker while the lease holds", async () => {
  const h = harness();
  await appendHandoff(h, COMPANY_A, "conv-1", "handoff:conv-1:lease");
  const leased = await h.store.claimBatch(COMPANY_A, 10, h.now(), { workerId: "w-slow", leaseSeconds: 300 });
  assert.equal(leased.length, 1);

  const other = await h.processor.process(COMPANY_A, { workerId: "w-fast" });
  assert.equal(other.claimed, 0);
  assert.equal(h.publisher.events().length, 0);
});

test("a realtime publish is not repeated when a later step fails and the event is retried", async () => {
  const h = harness();
  await appendHandoff(h, COMPANY_A, "conv-1", "handoff:conv-1:retry-publish");
  const flaky = { ...h.store, markPublished: async () => { throw new Error("db down"); } };
  const flakyProcessor = createOutboxProcessor({ store: flaky, webhooks: createWebhookDispatcher({ http: async () => ({ status: 200, headers: {}, body: "" }), secretBox: h.secretBox, store: h.store, env: {}, events: h.events, resolve: async () => [PUBLIC_ADDRESS] }), publisher: h.publisher, events: h.events });

  const first = await flakyProcessor.process(COMPANY_A, { workerId: "w1" });
  assert.equal(first.retried, 1);
  assert.equal(h.publisher.events().length, 1);

  h.advance(60);
  const second = await h.processor.process(COMPANY_A, { workerId: "w1" });
  assert.equal(second.published, 1);
  assert.equal(h.publisher.events().length, 1, "realtime publish happened once");
});

test("failed webhooks retry with exponential backoff, then stop after the attempt limit", async () => {
  const h = harness({ respond: async () => ({ status: 500, headers: {}, body: "boom" }) });
  await h.subscriptions.subscribe(COMPANY_A, { url: WEBHOOK_URL, topics: ["*"], signingSecret: SIGNING_SECRET });
  await appendHandoff(h, COMPANY_A, "conv-1", "handoff:conv-1:backoff");

  // Step the clock one second at a time. The event is attempted only once its backoff has elapsed.
  const results = [];
  for (let guard = 0; guard < 100_000 && results.every((r) => r.deadLettered === 0); guard++) {
    const r = await h.processor.process(COMPANY_A, { workerId: "w1" });
    if (r.claimed) results.push(r);
    h.advance(1);
  }

  assert.equal(h.httpCalls.length, 8, "one request per attempt, eight attempts in all");
  const gaps = h.httpCalls.slice(1).map((c, i) => (c.at.getTime() - h.httpCalls[i].at.getTime()) / 1000);
  // Attempt k fails, then the next attempt waits base * 2^(k-1) seconds: 15, 30, 60, 120, 240, 480, 960.
  assert.deepEqual(gaps, [15, 30, 60, 120, 240, 480, 960]);
  assert.equal(results.reduce((n, r) => n + r.retried, 0), 7);
  assert.equal(results.reduce((n, r) => n + r.deadLettered, 0), 1);

  const callsAtStop = h.httpCalls.length;
  h.advance(24 * 3600);
  const after = await h.processor.process(COMPANY_A, { workerId: "w1" });
  assert.equal(after.claimed, 0);
  assert.equal(h.httpCalls.length, callsAtStop, "a dead-lettered event is never sent again");
});

test("backoff helper doubles from the base and stops at the cap", () => {
  assert.equal(outboxBackoffSeconds(1, 15, 3600), 15);
  assert.equal(outboxBackoffSeconds(2, 15, 3600), 30);
  assert.equal(outboxBackoffSeconds(8, 15, 3600), 1920);
  assert.equal(outboxBackoffSeconds(12, 15, 3600), 3600);
});

test("a delivered subscription is skipped on a later dispatch, so a retry does not resend to it", async () => {
  let fail = true;
  const h = harness({ respond: async () => (fail ? { status: 503, headers: {}, body: "" } : { status: 204, headers: {}, body: "" }) });
  await h.subscriptions.subscribe(COMPANY_A, { url: WEBHOOK_URL, topics: ["conversation.handoff"], signingSecret: SIGNING_SECRET });
  await appendHandoff(h, COMPANY_A, "conv-1", "handoff:conv-1:skip");
  await h.processor.process(COMPANY_A, { workerId: "w1" });
  fail = false;
  h.advance(20);
  const second = await h.processor.process(COMPANY_A, { workerId: "w1" });
  assert.equal(second.published, 1);
  assert.equal(h.httpCalls.length, 2);
});

test("a webhook timeout is recorded as a timeout without the URL or body", async () => {
  const h = harness({ respond: async () => { throw { kind: "timeout", message: `timed out posting ${WEBHOOK_URL}` }; } });
  await h.subscriptions.subscribe(COMPANY_A, { url: WEBHOOK_URL, topics: ["*"], signingSecret: SIGNING_SECRET });
  await appendHandoff(h, COMPANY_A, "conv-1", "handoff:conv-1:timeout");
  await h.processor.process(COMPANY_A, { workerId: "w1" });
  const eventId = JSON.parse(h.httpCalls[0].body).payload.event_uuid;
  const [delivery] = await h.store.listDeliveries(COMPANY_A, eventId);
  assert.equal(delivery.ok, false);
  assert.equal(delivery.errorMessage, "Request timed out.");
  assert.equal(delivery.errorMessage.includes(WEBHOOK_URL), false);
});

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

test("a workflow step runs once: a retried run reuses the stored result", async () => {
  const h = harness();
  const run = await h.workflows.dispatch(COMPANY_A, "booking-followup", { bookingId: "b-1" }, { idempotencyKey: "fu-1" });
  const claimed = await h.workflows.claimNext(COMPANY_A);
  assert.equal(claimed.id, run.id);
  assert.equal(claimed.status, "running");

  let calls = 0;
  const send = async () => {
    calls++;
    return { sent: true };
  };
  const first = await h.workflows.runStep(COMPANY_A, run.id, "send-email", send);
  const second = await h.workflows.runStep(COMPANY_A, run.id, "send-email", send);

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.deepEqual(second.output, { sent: true });
  assert.equal(calls, 1);

  // Fail the run, retry it, and run the same step again on the new attempt.
  await h.workflows.fail(COMPANY_A, run.id, "later step broke");
  const retried = await h.workflows.retry(COMPANY_A, run.id, 0);
  assert.equal(retried.attempt, 2);
  await h.workflows.claimNext(COMPANY_A);
  const third = await h.workflows.runStep(COMPANY_A, run.id, "send-email", send);
  assert.equal(third.reused, true);
  assert.equal(calls, 1);
});

test("a step that throws is not recorded, so the retry runs it again", async () => {
  const h = harness();
  const run = await h.workflows.dispatch(COMPANY_A, "charge-flow");
  await h.workflows.claimNext(COMPANY_A);
  let calls = 0;
  await assert.rejects(
    h.workflows.runStep(COMPANY_A, run.id, "charge", async () => {
      calls++;
      throw new Error("gateway timeout");
    }),
    /gateway timeout/,
  );
  const ok = await h.workflows.runStep(COMPANY_A, run.id, "charge", async () => {
    calls++;
    return { charged: true };
  });
  assert.equal(ok.reused, false);
  assert.equal(calls, 2);
});

test("dispatch with the same idempotency key returns the existing run", async () => {
  const h = harness();
  const a = await h.workflows.dispatch(COMPANY_A, "wf", {}, { idempotencyKey: "k-1" });
  const b = await h.workflows.dispatch(COMPANY_A, "wf", { other: true }, { idempotencyKey: "k-1" });
  assert.equal(a.id, b.id);
});

test("workflow retry allows only failed runs, uses backoff, and stops at max attempts", async () => {
  const h = harness();
  const run = await h.workflows.dispatch(COMPANY_A, "wf", {}, { maxAttempts: 2 });
  await assert.rejects(h.workflows.retry(COMPANY_A, run.id), EventsError);
  await h.workflows.fail(COMPANY_A, run.id, "boom");
  const retried = await h.workflows.retry(COMPANY_A, run.id);
  assert.equal(retried.attempt, 2);
  assert.equal(retried.nextRunAt.getTime() - h.now().getTime(), 30_000);
  await h.workflows.fail(COMPANY_A, retried.id, "boom again");
  await assert.rejects(h.workflows.retry(COMPANY_A, run.id), /maximum attempts/);
  assert.deepEqual([1, 2, 3, 4].map(workflowRetryDelaySeconds), [30, 60, 120, 240]);
});

test("workflow resume merges input into context and refuses a finished run", async () => {
  const h = harness();
  const run = await h.workflows.dispatch(COMPANY_A, "wf", { customer: { name: "A", tier: "gold" } });
  const resumed = await h.workflows.resume(COMPANY_A, run.id, { customer: { tier: "platinum" }, step: 2 });
  assert.deepEqual(resumed.context, { customer: { name: "A", tier: "platinum" }, step: 2 });
  await h.workflows.complete(COMPANY_A, run.id, { ok: true });
  await assert.rejects(h.workflows.resume(COMPANY_A, run.id, {}), /already completed/);
});

test("a workflow run from another company is absent", async () => {
  const h = harness();
  const run = await h.workflows.dispatch(COMPANY_A, "wf");
  assert.equal(await h.workflows.get(COMPANY_B, run.id), null);
  assert.equal(await h.workflows.complete(COMPANY_B, run.id, {}), null);
  assert.equal(await h.workflows.cancel(COMPANY_B, run.id), null);
  assert.equal((await h.workflows.get(COMPANY_A, run.id)).status, "queued");
});

// ---------------------------------------------------------------------------
// Structured actions
// ---------------------------------------------------------------------------

test("a structured action from another company is refused everywhere", async () => {
  const h = harness();
  h.store.addConversation(COMPANY_A, "conv-a");
  const action = await h.actions.propose(COMPANY_A, "conv-a", {
    kind: "request_refund",
    args: { orderId: "ord-1", amountMinor: 1500, reason: "Damaged on arrival" },
  });
  assert.equal(action.status, "proposed");
  assert.equal(action.requiresApproval, true);

  let executed = 0;
  const executor = async () => {
    executed++;
    return { resultRef: "refund-1" };
  };
  assert.equal(await h.actions.get(COMPANY_B, action.id), null);
  assert.equal(await h.actions.approve(COMPANY_B, action.id, "staff-b"), null);
  assert.equal(await h.actions.reject(COMPANY_B, action.id, "staff-b", "no"), null);
  assert.equal(await h.actions.execute(COMPANY_B, action.id, executor), null);
  assert.deepEqual(await h.actions.list(COMPANY_B, "conv-a"), []);
  assert.equal(await h.actions.propose(COMPANY_B, "conv-a", { kind: "lookup_order", args: { orderId: "o" } }), null);
  assert.equal(executed, 0);

  // The owning company can still act on it, and the action stays proposed until staff approve it.
  assert.equal((await h.actions.get(COMPANY_A, action.id)).status, "proposed");
  await assert.rejects(h.actions.execute(COMPANY_A, action.id, executor), /Cannot execute an action in proposed/);
  await h.actions.approve(COMPANY_A, action.id, "staff-a");
  const done = await h.actions.execute(COMPANY_A, action.id, executor);
  assert.equal(done.status, "executed");
  assert.equal(done.resultRef, "refund-1");
  assert.equal(executed, 1);
});

test("an approved action executes once even when two callers race", async () => {
  const h = harness();
  h.store.addConversation(COMPANY_A, "conv-a");
  const action = await h.actions.propose(COMPANY_A, "conv-a", { kind: "handoff_to_human", args: { reason: "Angry customer" } });
  assert.equal(action.status, "approved", "non-approval kinds are approved by policy");

  let runs = 0;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const slow = async () => {
    runs++;
    await gate;
    return { resultRef: "handoff-1" };
  };
  const first = h.actions.execute(COMPANY_A, action.id, slow);
  await assert.rejects(h.actions.execute(COMPANY_A, action.id, slow), /already executing/);
  release();
  assert.equal((await first).status, "executed");
  assert.equal(runs, 1);
});

test("action args are checked against the kind: unknown keys, wrong types and out-of-range values are refused", () => {
  assert.deepEqual(validateActionArgs("add_to_cart", { productId: "p-1", quantity: 2 }), { productId: "p-1", quantity: 2 });
  assert.throws(() => validateActionArgs("add_to_cart", { productId: "p-1", quantity: 2, admin: true }), /Unknown argument: admin/);
  assert.throws(() => validateActionArgs("add_to_cart", { productId: "p-1", quantity: 0 }), /quantity/);
  assert.throws(() => validateActionArgs("request_refund", { orderId: "o1", amountMinor: 12.5, reason: "x" }), /amountMinor/);
  assert.throws(() => validateActionArgs("request_refund", { orderId: "o1", reason: "x" }), /amountMinor is required/);
  assert.throws(() => validateActionArgs("create_booking", { serviceId: "s1", startsAt: "tomorrow" }), /startsAt/);
  assert.throws(() => validateActionArgs("not_a_kind", {}), /Unknown action kind/);
});

test("buttons and forms are validated on the server before they are shown or answered", () => {
  const presentation = validatePresentation({
    buttons: [{ id: "yes", label: "Yes, book it" }, { id: "no", label: "Not now" }],
    form: {
      fields: [
        { name: "phone", label: "Phone", type: "text", required: true, maxLength: 20 },
        { name: "size", label: "Size", type: "choice", required: true, options: ["S", "M", "L"] },
        { name: "urgent", label: "Urgent?", type: "boolean", required: false },
      ],
    },
  });
  assert.throws(() => validatePresentation({ buttons: [{ id: "a", label: "A" }, { id: "a", label: "A2" }] }), /unique id/);
  assert.throws(() => validatePresentation({ form: { fields: [{ name: "x", label: "X", type: "choice", required: false }] } }), /options/);

  const ok = validatePresentationResponse(presentation, { buttonId: "yes", values: { phone: " 0400 000 000 ", size: "M" } });
  assert.deepEqual(ok, { buttonId: "yes", values: { phone: "0400 000 000", size: "M" } });
  assert.throws(() => validatePresentationResponse(presentation, { buttonId: "maybe" }), /not offered/);
  assert.throws(() => validatePresentationResponse(presentation, { values: { phone: "1", size: "XL" } }), /options/);
  assert.throws(() => validatePresentationResponse(presentation, { values: { size: "M" } }), /Phone is required/);
  assert.throws(() => validatePresentationResponse(presentation, { values: { phone: "1", size: "M", extra: "x" } }), /Unknown form field/);
});

test("expired proposals cannot be approved", async () => {
  const h = harness();
  h.store.addConversation(COMPANY_A, "conv-a");
  const action = await h.actions.propose(COMPANY_A, "conv-a", {
    kind: "cancel_booking",
    args: { bookingId: "b-1" },
    expiresAt: new Date(h.now().getTime() + 60_000),
  });
  h.advance(120);
  await assert.rejects(h.actions.approve(COMPANY_A, action.id, "staff-a"), /expired/);
  assert.equal((await h.actions.get(COMPANY_A, action.id)).status, "proposed");
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

test("notifications go to each recipient once, and a failure is counted without the payload", async () => {
  const sent = [];
  const sender = {
    async send(companyId, recipient, topic, payload) {
      if (recipient.id === "staff-broken") throw new Error(`cannot reach ${JSON.stringify(payload)}`);
      sent.push({ companyId, recipient, topic });
    },
  };
  const runtime = createNotificationRuntime(sender);
  await assert.rejects(
    runtime.notify(COMPANY_A, "handoff.requested", [
      { kind: "staff", id: "staff-1" },
      { kind: "staff", id: "staff-1" },
      { kind: "staff", id: "staff-broken" },
    ], { conversationId: "conv-1", secret: "do-not-leak" }),
    (error) => error instanceof EventsError && error.code === "NOTIFICATION_FAILED" && !error.message.includes("do-not-leak"),
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].recipient.id, "staff-1");
  await assert.rejects(runtime.notify(COMPANY_A, "Bad Topic!", [{ kind: "staff", id: "s" }], {}), /topic/);
});

// ---------------------------------------------------------------------------
// Drizzle: every query carries company_id
// ---------------------------------------------------------------------------

function recordingDb() {
  const statements = [];
  const client = {
    async query(config, values) {
      const text = typeof config === "string" ? config : config.text;
      const params = typeof config === "string" ? (values ?? []) : (config.values ?? values ?? []);
      statements.push({ text, params });
      return { rows: [], rowCount: 0, fields: [] };
    },
  };
  return { db: drizzle(client), statements };
}

function rendered(query) {
  return dialect.sqlToQuery(query.getSQL());
}

test("every rendered events query filters on company_id", () => {
  const { db } = recordingDb();
  const queries = [
    workflowRunByIdQuery(db, COMPANY_A, "run-1"),
    workflowRunByIdempotencyQuery(db, COMPANY_A, "wf", "k"),
    outboxClaimQuery(db, COMPANY_A, 10, START, 300),
    actionListQuery(db, COMPANY_A, "conv-1", "proposed"),
    webhookSubscriptionsQuery(db, COMPANY_A),
    webhookDeliveriesQuery(db, COMPANY_A, "evt-1"),
  ];
  for (const query of queries) {
    const { sql: text, params } = rendered(query);
    assert.match(text, /company_id/);
    assert.ok(params.includes(COMPANY_A), "company id is bound");
    assert.equal(params.includes(COMPANY_B), false);
  }
  const claim = rendered(outboxClaimQuery(db, COMPANY_A, 10, START, 300)).sql;
  assert.match(claim, /skip locked/i);
});

test("the Drizzle store binds the caller's company on reads and writes", async () => {
  const { db, statements } = recordingDb();
  const store = createDrizzleEventsStore(db);
  assert.equal(await store.getRun(COMPANY_B, "run-a"), null);
  assert.equal(await store.getAction(COMPANY_B, "act-a"), null);
  assert.deepEqual(await store.listActions(COMPANY_B, "conv-a"), []);
  await store.markPublished(COMPANY_B, "evt-a", START);
  assert.ok(statements.length >= 3);
  for (const statement of statements) {
    assert.match(statement.text, /company_id/);
    assert.ok(statement.params.includes(COMPANY_B));
    assert.equal(statement.params.includes(COMPANY_A), false);
  }
});

test("memory store: a row from another company is never returned or changed", async () => {
  const h = harness();
  const run = await h.workflows.dispatch(COMPANY_A, "wf");
  await h.store.mutateRun(COMPANY_B, run.id, () => ({ status: "failed", error: "x" }));
  assert.equal((await h.store.getRun(COMPANY_A, run.id)).status, "queued");
});

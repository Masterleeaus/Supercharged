// Realtime over Server-Sent Events: hub routing, publisher, token streaming, and the Express handler factory (node:test).
// No network and no real sockets: responses and requests are in-process fakes, and the heartbeat timer is driven by hand.
//
// Run: NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types tests/modules/chatbot-realtime.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createSseHub,
  createSsePublisher,
  createSseStreamHandler,
  createSseStreamingRuntime,
  STREAM_FAILED_CODE,
} from "../../server/modules/chatbot/realtime/index.ts";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const CONV = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

class FakeResponse extends EventEmitter {
  statusCode = 200;
  headers = {};
  chunks = [];
  writableEnded = false;
  destroyed = false;
  writableLength = 0;
  ended = 0;
  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
  }
  flushHeaders() {}
  write(chunk) {
    if (this.writableEnded) return false;
    this.chunks.push(String(chunk));
    return true;
  }
  end(chunk) {
    if (this.writableEnded) return this;
    if (chunk !== undefined) this.write(chunk);
    this.writableEnded = true;
    this.ended += 1;
    this.emit("finish");
    this.emit("close");
    return this;
  }
  body() {
    return this.chunks.join("");
  }
  /** Simulates the client going away. */
  disconnect() {
    this.destroyed = true;
    this.emit("close");
  }
}

class FakeRequest extends EventEmitter {
  constructor(url = "/stream") {
    super();
    this.url = url;
  }
}

/** Fake scheduler: tick() runs every active interval once. */
function fakeScheduler() {
  const timers = new Map();
  let next = 1;
  return {
    cleared: 0,
    setInterval(fn) {
      const id = next++;
      timers.set(id, fn);
      return id;
    },
    clearInterval(id) {
      if (timers.delete(id)) this.cleared += 1;
    },
    tick() {
      for (const fn of [...timers.values()]) fn();
    },
    active() {
      return timers.size;
    },
  };
}

function inboxEvent(companyId, type = "conversation.handoff", conversationId = CONV) {
  return {
    type,
    companyId,
    conversationId,
    occurredAt: new Date("2026-11-09T01:02:03.000Z"),
    data: { actorId: "staff-1", from: "ai", to: "human" },
  };
}

/** Opens a stream through the handler with a fixed auth result. */
async function openStream(handler) {
  const req = new FakeRequest();
  const res = new FakeResponse();
  await handler(req, res);
  return { req, res };
}

function makeHandler(hub, extra = {}) {
  return createSseStreamHandler({
    hub,
    resolveAuth: (_req) => extra.auth ?? null,
    // Always a fake timer: a real interval would keep the test process alive.
    scheduler: extra.scheduler ?? fakeScheduler(),
    heartbeatMs: extra.heartbeatMs,
    maxBufferedBytes: extra.maxBufferedBytes,
    newId: extra.newId,
  });
}

test("a staff stream receives only events from its own company", async () => {
  const hub = createSseHub();
  const publisher = createSsePublisher(hub);
  const staffA = makeHandler(hub, { auth: { companyId: COMPANY_A, kind: "staff", staffId: "s1" } });
  const staffB = makeHandler(hub, { auth: { companyId: COMPANY_B, kind: "staff", staffId: "s2" } });
  const a = await openStream(staffA);
  const b = await openStream(staffB);

  await publisher.publish(inboxEvent(COMPANY_A, "conversation.assigned"));

  assert.match(a.res.body(), /event: conversation\.assigned\n/);
  assert.equal(b.res.body().includes("conversation.assigned"), false);
  assert.equal(hub.subscriberCount(COMPANY_A), 1);
  assert.equal(hub.subscriberCount(COMPANY_B), 1);
});

test("the stream the hub writes to is scoped to the publisher's company even when two companies share a staff id", async () => {
  const hub = createSseHub();
  const publisher = createSsePublisher(hub);
  const a = await openStream(makeHandler(hub, { auth: { companyId: COMPANY_A, kind: "staff", staffId: "same" }}));
  const b = await openStream(makeHandler(hub, { auth: { companyId: COMPANY_B, kind: "staff", staffId: "same" }}));

  await publisher.publish(inboxEvent(COMPANY_B));

  assert.equal(a.res.body().includes("conversation.handoff"), false, "company A must not see company B");
  assert.match(b.res.body(), /event: conversation\.handoff\n/);
  assert.equal(hub.subscriberCount(), 2, "same staff id in two companies is two streams, not one");
});

test("an event with a malformed company id reaches nobody", async () => {
  const hub = createSseHub();
  const publisher = createSsePublisher(hub);
  const a = await openStream(makeHandler(hub, { auth: { companyId: COMPANY_A, kind: "staff", staffId: "s1" }}));

  await publisher.publish(inboxEvent("not-a-uuid"));
  await publisher.publish(inboxEvent(""));

  assert.equal(a.res.body().includes("conversation.handoff"), false);
});

test("customer streams never receive inbox events", async () => {
  const hub = createSseHub();
  const publisher = createSsePublisher(hub);
  const customer = await openStream(
    makeHandler(hub, { auth: { companyId: COMPANY_A, kind: "customer", conversationId: CONV, customerId: null } }),
    null,
  );

  await publisher.publish(inboxEvent(COMPANY_A));

  assert.equal(customer.res.body().includes("conversation.handoff"), false);
});

test("a closed stream stops receiving and releases its resources", async () => {
  const hub = createSseHub();
  const publisher = createSsePublisher(hub);
  const scheduler = fakeScheduler();
  const handler = makeHandler(hub, {
    auth: { companyId: COMPANY_A, kind: "staff", staffId: "s1" },
    scheduler,
  });
  const { res } = await openStream(handler);
  assert.equal(hub.subscriberCount(COMPANY_A), 1);
  assert.equal(scheduler.active(), 1);

  res.disconnect();
  assert.equal(hub.subscriberCount(COMPANY_A), 0, "hub drops the closed stream");
  assert.equal(scheduler.active(), 0, "heartbeat timer is cleared");

  const before = res.body();
  await publisher.publish(inboxEvent(COMPANY_A));
  scheduler.tick();
  assert.equal(res.body(), before, "nothing is written after close");
});

test("a stream that is closed by the server is removed and ended", async () => {
  const hub = createSseHub();
  const publisher = createSsePublisher(hub);
  const { res } = await openStream(
    makeHandler(hub, { auth: { companyId: COMPANY_A, kind: "staff", staffId: "s1" } }),
    null,
  );
  hub.closeAll();

  assert.equal(res.writableEnded, true);
  assert.equal(hub.subscriberCount(), 0);
  await publisher.publish(inboxEvent(COMPANY_A));
  assert.equal(res.body().includes("conversation.handoff"), false);
});

test("the heartbeat is sent on each tick and stops after close", async () => {
  const hub = createSseHub();
  const scheduler = fakeScheduler();
  const { res } = await openStream(
    makeHandler(hub, {
      auth: { companyId: COMPANY_A, kind: "staff", staffId: "s1" },
      scheduler,
      heartbeatMs: 1000,
    }),
    null,
  );

  scheduler.tick();
  scheduler.tick();
  assert.equal(res.body().split(": heartbeat\n\n").length - 1, 2);

  res.disconnect();
  const sent = res.body();
  scheduler.tick();
  assert.equal(res.body(), sent, "no heartbeat after close");
});

test("a heartbeat that cannot be written releases the stream", async () => {
  const hub = createSseHub();
  const scheduler = fakeScheduler();
  const { res } = await openStream(
    makeHandler(hub, {
      auth: { companyId: COMPANY_A, kind: "staff", staffId: "s1" },
      scheduler,
    }),
    null,
  );
  res.writableLength = 10_000_000; // over the buffer limit: a slow client

  scheduler.tick();

  assert.equal(hub.subscriberCount(COMPANY_A), 0);
  assert.equal(res.writableEnded, true);
});

test("the auth context comes from the injected function, not the URL or query string", async () => {
  const hub = createSseHub();
  const publisher = createSsePublisher(hub);
  let calls = 0;
  const handler = createSseStreamHandler({
    hub,
    scheduler: fakeScheduler(),
    resolveAuth: (req) => {
      calls += 1;
      assert.equal(typeof req.on, "function");
      return { companyId: COMPANY_A, kind: "staff", staffId: "s1" };
    },
  });

  // The URL names company B and a different staff id. None of it may be used.
  const req = new FakeRequest(`/stream?companyId=${COMPANY_B}&staffId=intruder`);
  Object.defineProperty(req, "query", {
    get() {
      throw new Error("query must not be read");
    },
  });
  Object.defineProperty(req, "params", {
    get() {
      throw new Error("params must not be read");
    },
  });
  const res = new FakeResponse();
  await handler(req, res);

  assert.equal(calls, 1);
  await publisher.publish(inboxEvent(COMPANY_B));
  assert.equal(res.body().includes("conversation.handoff"), false, "URL company must not receive events");
  await publisher.publish(inboxEvent(COMPANY_A));
  assert.match(res.body(), /event: conversation\.handoff\n/);
});

test("a request with no valid auth gets 401 and no stream", async () => {
  const hub = createSseHub();
  const nobody = createSseHub();
  const cases = [
    () => null,
    () => ({ companyId: "not-a-uuid", kind: "staff", staffId: "s1" }),
    () => ({ companyId: COMPANY_A, kind: "staff", staffId: "" }),
    () => ({ companyId: COMPANY_A, kind: "unknown" }),
    () => {
      throw new Error("session store down");
    },
  ];
  for (const resolve of cases) {
    const handler = createSseStreamHandler({ hub, scheduler: fakeScheduler(), resolveAuth: resolve });
    const res = new FakeResponse();
    await handler(new FakeRequest(), res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body(), JSON.stringify({ error: "unauthorized" }));
  }
  assert.equal(hub.subscriberCount(), 0);
  assert.equal(nobody.subscriberCount(), 0);
});

test("a second connection for the same staff member replaces the first", async () => {
  const hub = createSseHub();
  const handler = makeHandler(hub, { auth: { companyId: COMPANY_A, kind: "staff", staffId: "s1" } });
  const first = await openStream(handler);
  const second = await openStream(handler);

  assert.equal(first.res.writableEnded, true);
  assert.equal(second.res.writableEnded, false);
  assert.equal(hub.subscriberCount(COMPANY_A), 1);
});

test("streamReply sends tokens to the customer of that conversation and to staff of the company only", async () => {
  const hub = createSseHub();
  const runtime = createSseStreamingRuntime({ hub, newId: () => "stream-1" });
  const customer = await openStream(
    makeHandler(hub, { auth: { companyId: COMPANY_A, kind: "customer", conversationId: CONV, customerId: null } }),
    null,
  );
  const otherCustomer = await openStream(
    makeHandler(hub, {
      auth: { companyId: COMPANY_A, kind: "customer", conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", customerId: null },
    }),
    null,
  );
  const staff = await openStream(makeHandler(hub, { auth: { companyId: COMPANY_A, kind: "staff", staffId: "s1" }}));
  const outsider = await openStream(makeHandler(hub, { auth: { companyId: COMPANY_B, kind: "staff", staffId: "s9" }}));

  async function* events() {
    yield { type: "text-delta", text: "Hel" };
    yield { type: "text-delta", text: "lo" };
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } };
    yield { type: "done", finishReason: "stop" };
  }

  const summary = await runtime.streamReply(COMPANY_A, CONV, events());

  assert.equal(summary.deltasSent, 2);
  assert.equal(summary.finishReason, "stop");
  assert.equal(summary.messageId, "stream-1");
  assert.deepEqual(summary.usage, { inputTokens: 10, outputTokens: 2 });
  assert.equal((customer.res.body().match(/event: token\n/g) ?? []).length, 2);
  assert.match(customer.res.body(), /"text":"Hel"/);
  assert.equal(otherCustomer.res.body().includes("event: token"), false);
  assert.equal((staff.res.body().match(/event: token\n/g) ?? []).length, 2);
  assert.equal(outsider.res.body().includes("event: token"), false, "another company must not see tokens");
  assert.match(customer.res.body(), /event: done\n/);
});

test("persistReply runs once after the last delta and its message id is returned", async () => {
  const hub = createSseHub();
  const saved = [];
  const runtime = createSseStreamingRuntime({
    hub,
    newId: () => "stream-2",
    persistReply: async (input) => {
      saved.push(input);
      return { messageId: "msg-42" };
    },
  });
  const customer = await openStream(
    makeHandler(hub, { auth: { companyId: COMPANY_A, kind: "customer", conversationId: CONV, customerId: null } }),
    null,
  );

  const summary = await runtime.streamReply(COMPANY_A, CONV, (async function* () {
    yield { type: "text-delta", text: "Hi" };
    yield { type: "done", finishReason: "stop" };
  })());

  assert.equal(saved.length, 1);
  assert.equal(saved[0].text, "Hi");
  assert.equal(summary.messageId, "msg-42");
  assert.match(customer.res.body(), /"messageId":"msg-42"/);
});

test("a provider error mid-reply sends a generic error frame and does not persist", async () => {
  const hub = createSseHub();
  let persisted = 0;
  const runtime = createSseStreamingRuntime({
    hub,
    newId: () => "stream-3",
    persistReply: async () => {
      persisted += 1;
      return { messageId: "x" };
    },
  });
  const customer = await openStream(
    makeHandler(hub, { auth: { companyId: COMPANY_A, kind: "customer", conversationId: CONV, customerId: null } }),
    null,
  );

  const summary = await runtime.streamReply(COMPANY_A, CONV, (async function* () {
    yield { type: "text-delta", text: "partial" };
    yield {
      type: "error",
      error: { provider: "openai", status: 500, code: "server", retryable: true, message: "secret detail sk-xyz" },
    };
  })());

  assert.equal(summary.finishReason, "error");
  assert.equal(persisted, 0);
  assert.match(customer.res.body(), new RegExp(`"code":"${STREAM_FAILED_CODE}"`));
  assert.equal(customer.res.body().includes("sk-xyz"), false, "provider message is never forwarded");
});

test("a thrown iterator is treated as an error, not an unhandled rejection", async () => {
  const hub = createSseHub();
  const runtime = createSseStreamingRuntime({ hub, newId: () => "stream-4" });
  const summary = await runtime.streamReply(COMPANY_A, CONV, (async function* () {
    yield { type: "text-delta", text: "a" };
    throw new Error("socket reset");
  })());
  assert.equal(summary.finishReason, "error");
  assert.equal(summary.deltasSent, 1);
});

test("typing frames go to the conversation's customer and to the company's staff", async () => {
  const hub = createSseHub();
  const runtime = createSseStreamingRuntime({ hub });
  const customer = await openStream(
    makeHandler(hub, { auth: { companyId: COMPANY_A, kind: "customer", conversationId: CONV, customerId: null } }),
    null,
  );
  const outsider = await openStream(makeHandler(hub, { auth: { companyId: COMPANY_B, kind: "staff", staffId: "s9" }}));

  await runtime.typing(COMPANY_A, CONV, "bot-1", true);

  assert.match(customer.res.body(), /event: typing\n/);
  assert.equal(outsider.res.body().includes("event: typing"), false);
});

test("a slow client that falls behind is dropped instead of buffering without limit", async () => {
  const hub = createSseHub();
  const publisher = createSsePublisher(hub);
  const { res } = await openStream(
    makeHandler(hub, {
      auth: { companyId: COMPANY_A, kind: "staff", staffId: "s1" },
      maxBufferedBytes: 100,
    }),
    null,
  );
  res.writableLength = 500;

  await publisher.publish(inboxEvent(COMPANY_A));

  assert.equal(hub.subscriberCount(COMPANY_A), 0);
  assert.equal(res.writableEnded, true);
});

test("the stream sends headers and a ready frame on connect", async () => {
  const hub = createSseHub();
  const { res } = await openStream(
    makeHandler(hub, { auth: { companyId: COMPANY_A, kind: "staff", staffId: "s1" } }),
    null,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(res.headers["cache-control"], "no-cache, no-transform");
  assert.match(res.body(), /^retry: 3000\n\nevent: ready\ndata: \{"kind":"staff"\}\n\n$/);
});

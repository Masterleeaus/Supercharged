// Realtime wiring: staff-only routing, one stream per identity (a second connection replaces the first), and the sinks
// that carry store and reply events. In-memory subscribers only; no sockets, no timers.
//
// Run: NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types server/modules/chatbot/realtime/realtime-wiring.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createSseHub } from "./hub.ts";
import { createSseReplyEventSink, createSseStoreEventSink } from "./sse-publisher.ts";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const BASE = new Date("2026-11-09T10:00:00Z");

let seq = 0;
function fakeSubscriber(companyId, scope) {
  seq += 1;
  const chunks = [];
  let ended = 0;
  return {
    id: `sub-${seq}`,
    companyId,
    scope,
    chunks,
    get ended() {
      return ended;
    },
    write(chunk) {
      chunks.push(chunk);
      return true;
    },
    end() {
      ended += 1;
    },
  };
}

test("a staff frame reaches only staff streams of its own company", () => {
  const hub = createSseHub();
  const staffA = fakeSubscriber(COMPANY_A, { kind: "staff", staffId: "s1" });
  const staffB = fakeSubscriber(COMPANY_B, { kind: "staff", staffId: "s1" });
  const customerA = fakeSubscriber(COMPANY_A, { kind: "customer", conversationId: "c1", customerId: null });
  hub.register(staffA);
  hub.register(staffB);
  hub.register(customerA);

  const delivered = hub.routeToStaff(COMPANY_A, "chatbot.conversation.archived", { conversationId: "c1" });

  assert.equal(delivered, 1);
  assert.equal(staffA.chunks.length, 1);
  assert.equal(staffB.chunks.length, 0, "another company's staff stream gets nothing");
  assert.equal(customerA.chunks.length, 0, "customer streams never get staff frames");
});

test("a second customer connection on the same conversation replaces the first", () => {
  const hub = createSseHub();
  const first = fakeSubscriber(COMPANY_A, { kind: "customer", conversationId: "c1", customerId: null });
  const second = fakeSubscriber(COMPANY_A, { kind: "customer", conversationId: "c1", customerId: null });
  const other = fakeSubscriber(COMPANY_A, { kind: "customer", conversationId: "c2", customerId: null });
  hub.register(first);
  hub.register(second);
  hub.register(other);

  assert.equal(first.ended, 1, "the first stream is ended");
  assert.equal(second.ended, 0);
  assert.equal(other.ended, 0, "a stream of another conversation is kept");
  assert.equal(hub.subscriberCount(COMPANY_A), 2);
});

test("a second staff connection replaces the first, and the same staff id in another company is separate", () => {
  const hub = createSseHub();
  const first = fakeSubscriber(COMPANY_A, { kind: "staff", staffId: "s1" });
  const second = fakeSubscriber(COMPANY_A, { kind: "staff", staffId: "s1" });
  const otherCompany = fakeSubscriber(COMPANY_B, { kind: "staff", staffId: "s1" });
  hub.register(first);
  hub.register(second);
  hub.register(otherCompany);

  assert.equal(first.ended, 1);
  assert.equal(otherCompany.ended, 0);
  assert.equal(hub.subscriberCount(), 2);
});

test("a stored reply reaches the staff and customer streams of its conversation", () => {
  const hub = createSseHub();
  const staff = fakeSubscriber(COMPANY_A, { kind: "staff", staffId: "s1" });
  const customer = fakeSubscriber(COMPANY_A, { kind: "customer", conversationId: "c1", customerId: null });
  const elsewhere = fakeSubscriber(COMPANY_A, { kind: "customer", conversationId: "c2", customerId: null });
  hub.register(staff);
  hub.register(customer);
  hub.register(elsewhere);

  const sink = createSseReplyEventSink(hub);
  sink({ type: "reply.stored", companyId: COMPANY_A, conversationId: "c1", messageId: "m1", at: BASE });

  assert.equal(staff.chunks.length, 1);
  assert.equal(customer.chunks.length, 1);
  assert.equal(elsewhere.chunks.length, 0);
  assert.match(customer.chunks[0], /event: reply\.stored/);
  assert.match(customer.chunks[0], /"messageId":"m1"/);
});

test("a failed reply goes to staff with a code only, never to the customer", () => {
  const hub = createSseHub();
  const staff = fakeSubscriber(COMPANY_A, { kind: "staff", staffId: "s1" });
  const customer = fakeSubscriber(COMPANY_A, { kind: "customer", conversationId: "c1", customerId: null });
  hub.register(staff);
  hub.register(customer);

  createSseReplyEventSink(hub)({ type: "reply.failed", companyId: COMPANY_A, conversationId: "c1", reason: "provider_error:timeout", at: BASE });

  assert.equal(staff.chunks.length, 1);
  assert.equal(customer.chunks.length, 0);
  assert.match(staff.chunks[0], /"code":"provider_error:timeout"/);
});

test("duplicate and turn-unmarked events send nothing", () => {
  const hub = createSseHub();
  const staff = fakeSubscriber(COMPANY_A, { kind: "staff", staffId: "s1" });
  hub.register(staff);
  const sink = createSseReplyEventSink(hub);
  sink({ type: "reply.duplicate", companyId: COMPANY_A, conversationId: "c1", messageId: "m1", at: BASE });
  sink({ type: "reply.turn_unmarked", companyId: COMPANY_A, conversationId: "c1", messageId: "m1", at: BASE });
  assert.equal(staff.chunks.length, 0);
});

test("a conversation store event reaches only staff of its company, with the conversation id", () => {
  const hub = createSseHub();
  const staffA = fakeSubscriber(COMPANY_A, { kind: "staff", staffId: "s1" });
  const staffB = fakeSubscriber(COMPANY_B, { kind: "staff", staffId: "s2" });
  const customerA = fakeSubscriber(COMPANY_A, { kind: "customer", conversationId: "c1", customerId: null });
  hub.register(staffA);
  hub.register(staffB);
  hub.register(customerA);

  createSseStoreEventSink(hub)(COMPANY_A, {
    topic: "chatbot.conversation.merged",
    aggregateId: "c1",
    payload: { source_id: "c2" },
  });

  assert.equal(staffA.chunks.length, 1);
  assert.match(staffA.chunks[0], /event: chatbot\.conversation\.merged/);
  assert.match(staffA.chunks[0], /"conversationId":"c1"/);
  assert.equal(staffB.chunks.length, 0);
  assert.equal(customerA.chunks.length, 0);
});

test("a malformed company id routes to nobody", () => {
  const hub = createSseHub();
  const staff = fakeSubscriber(COMPANY_A, { kind: "staff", staffId: "s1" });
  hub.register(staff);
  assert.equal(hub.routeToStaff("not-a-company", "x", {}), 0);
  assert.equal(staff.chunks.length, 0);
});

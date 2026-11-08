// Unified inbox tests (node:test). Covers the chatbot inbox port: AI/human handoff, unread counts,
// assignment, participants and read cursors, presence TTL, events on state change, and company isolation.
// No database, no Express, no Ably. The flag, scope and storage are all in-process.
import test from "node:test";
import assert from "node:assert/strict";
import { ChatbotError } from "../../server/modules/chatbot/chatbot-scope.ts";
import {
  createInboxService,
  InMemoryEventPublisher,
  InMemoryInboxStorage,
  resolvePresenceTtlSeconds,
} from "../../server/modules/chatbot/inbox/index.ts";

// ---------- fixtures ----------

// Company ids are UUIDs everywhere; requireCompanyId rejects anything else.
const COMPANY_A = "6f1c2a3e-9b7d-4c5a-8e21-0a1b2c3d4e51";
const COMPANY_B = "b2d4f6a8-1c3e-4f50-9a7b-6c5d4e3f2a12";
const STAFF = { id: "staff-ana" };
const STAFF_2 = { id: "staff-ben" };

const START = "2026-11-01T10:00:00.000Z";

function clock(start = START) {
  let current = Date.parse(start);
  return {
    now: () => new Date(current),
    advance(ms) {
      current += ms;
    },
  };
}

function harness({
  enabled = true,
  presenceTtlSeconds,
  events = new InMemoryEventPublisher(),
  onPublishError,
  storage = new InMemoryInboxStorage(),
  time = clock(),
} = {}) {
  const service = createInboxService({
    storage,
    events,
    enabled,
    now: time.now,
    presenceTtlSeconds,
    onPublishError,
  });
  return { service, storage, events, time };
}

function seed(storage, companyId, id, extra = {}) {
  return storage.seedConversation(companyId, {
    id,
    lastActivityAt: new Date("2026-11-01T09:00:00.000Z"),
    ...extra,
  });
}

function at(seconds) {
  return new Date(Date.parse(START) + seconds * 1000);
}

function isStatus(status) {
  return (error) => error instanceof ChatbotError && error.status === status;
}

// ---------- feature flag ----------

test("disabled inbox: every method refuses with 503 and writes nothing", async () => {
  const { service, storage, events } = harness({ enabled: false });
  seed(storage, COMPANY_A, "conv-1");

  const calls = [
    () => service.query(COMPANY_A),
    () => service.unreadCounts(COMPANY_A),
    () => service.handoffToHuman(COMPANY_A, "conv-1", STAFF),
    () => service.handBackToAi(COMPANY_A, "conv-1", STAFF),
    () => service.assign(COMPANY_A, "conv-1", "staff-ana", STAFF),
    () => service.upsertParticipant(COMPANY_A, "conv-1", { type: "agent" }, STAFF),
    () => service.touchPresence(COMPANY_A, "conv-1", { participantKey: "tab-1" }),
  ];
  for (const call of calls) {
    await assert.rejects(call, isStatus(503));
  }

  const row = await storage.getConversation(COMPANY_A, "conv-1");
  assert.equal(row.connectAgentAt, null);
  assert.equal(row.assignedTo, null);
  assert.deepEqual(events.events(), []);
});

// ---------- company scope ----------

test("company scope is required: a missing or malformed companyId is refused with 403 before any read", async () => {
  const { service, storage, events } = harness();
  seed(storage, COMPANY_A, "conv-1");

  for (const bad of [undefined, null, "", "not-a-uuid", 42]) {
    await assert.rejects(() => service.query(bad), isStatus(403));
    await assert.rejects(() => service.unreadCounts(bad), isStatus(403));
    await assert.rejects(() => service.handoffToHuman(bad, "conv-1", STAFF), isStatus(403));
    await assert.rejects(() => service.touchPresence(bad, "conv-1", { participantKey: "tab-1" }), isStatus(403));
  }

  assert.equal((await storage.getConversation(COMPANY_A, "conv-1")).connectAgentAt, null);
  assert.deepEqual(events.events(), []);
});

// ---------- handoff ----------

test("handoff: AI hands the conversation to a human and emits conversation.handoff", async () => {
  const { service, storage, events, time } = harness();
  seed(storage, COMPANY_A, "conv-1");
  assert.equal((await service.handlingState(COMPANY_A, "conv-1")).handler, "ai");

  const result = await service.handoffToHuman(COMPANY_A, "conv-1", STAFF);
  assert.equal(result.changed, true);

  const state = await service.handlingState(COMPANY_A, "conv-1");
  assert.equal(state.handler, "human");
  assert.equal(state.handedOffAt.getTime(), time.now().getTime());

  const [event] = events.forCompany(COMPANY_A);
  assert.equal(event.type, "conversation.handoff");
  assert.equal(event.conversationId, "conv-1");
  assert.deepEqual(event.data, { actorId: STAFF.id, from: "ai", to: "human" });
});

test("handback: a human returns the conversation to the AI, and a full round trip keeps every event", async () => {
  const { service, storage, events } = harness();
  seed(storage, COMPANY_A, "conv-1");

  await service.handoffToHuman(COMPANY_A, "conv-1", STAFF);
  const back = await service.handBackToAi(COMPANY_A, "conv-1", STAFF);
  assert.equal(back.changed, true);

  const state = await service.handlingState(COMPANY_A, "conv-1");
  assert.equal(state.handler, "ai");
  assert.equal(state.handedOffAt, null);

  await service.handoffToHuman(COMPANY_A, "conv-1", STAFF_2);

  const types = events.forCompany(COMPANY_A).map((event) => event.type);
  assert.deepEqual(types, ["conversation.handoff", "conversation.handback", "conversation.handoff"]);
  assert.deepEqual(events.forCompany(COMPANY_A)[1].data, { actorId: STAFF.id, from: "human", to: "ai" });
});

test("handoff and handback are idempotent: a repeat call changes nothing and emits nothing", async () => {
  const { service, storage, events } = harness();
  seed(storage, COMPANY_A, "conv-1");

  assert.equal((await service.handBackToAi(COMPANY_A, "conv-1", STAFF)).changed, false);
  assert.equal((await service.handoffToHuman(COMPANY_A, "conv-1", STAFF)).changed, true);
  assert.equal((await service.handoffToHuman(COMPANY_A, "conv-1", STAFF)).changed, false);

  assert.equal(events.forCompany(COMPANY_A).length, 1);
});

test("handoff on a conversation that is not in this company returns 404 and touches nothing", async () => {
  const { service, storage, events } = harness();
  seed(storage, COMPANY_A, "conv-a");

  await assert.rejects(() => service.handoffToHuman(COMPANY_B, "conv-a", STAFF_2), isStatus(404));

  assert.equal((await storage.getConversation(COMPANY_A, "conv-a")).connectAgentAt, null);
  assert.deepEqual(events.events(), []);
});

// ---------- query and unread counts ----------

test("query: filters by handler, status, assignee, priority and search, and sorts by last activity", async () => {
  const { service, storage } = harness();
  seed(storage, COMPANY_A, "c1", { name: "Pool quote", lastActivityAt: at(-3600) });
  seed(storage, COMPANY_A, "c2", {
    name: "Gate repair",
    connectAgentAt: at(0),
    assignedTo: "staff-ana",
    priority: "high",
    lastActivityAt: at(7200),
  });
  seed(storage, COMPANY_A, "c3", {
    name: "Booking",
    summary: "customer asked about pool heating",
    ticketStatus: "closed",
    lastActivityAt: at(-1800),
  });
  seed(storage, COMPANY_A, "c4", { name: "Invoice", connectAgentAt: at(0), lastActivityAt: at(-7200) });

  const ids = async (input) => (await service.query(COMPANY_A, input)).data.map((row) => row.id);

  assert.deepEqual(await ids(), ["c2", "c3", "c1", "c4"]);
  assert.deepEqual(await ids({ handler: "human" }), ["c2", "c4"]);
  assert.deepEqual(await ids({ handler: "ai" }), ["c3", "c1"]);
  assert.deepEqual(await ids({ q: "pool" }), ["c3", "c1"]);
  assert.deepEqual(await ids({ status: "closed" }), ["c3"]);
  assert.deepEqual(await ids({ status: "new" }), ["c2", "c1", "c4"]);
  assert.deepEqual(await ids({ assignedTo: "staff-ana" }), ["c2"]);
  assert.deepEqual(await ids({ priority: "high" }), ["c2"]);

  const page2 = await service.query(COMPANY_A, { perPage: 2, page: 2 });
  assert.deepEqual(page2.data.map((row) => row.id), ["c1", "c4"]);
  assert.equal(page2.total, 4);
  assert.equal(page2.page, 2);
  assert.equal(page2.perPage, 2);
});

test("query: the search term is matched literally, so LIKE wildcards in the input do not widen the match", async () => {
  const { service, storage } = harness();
  seed(storage, COMPANY_A, "c1", { name: "100% refund" });
  seed(storage, COMPANY_A, "c2", { name: "1000 refund" });

  const found = async (q) => (await service.query(COMPANY_A, { q })).data.map((row) => row.id);

  assert.deepEqual(await found("100%"), ["c1"]);
  assert.deepEqual(await found("refund"), ["c1", "c2"]);
  assert.deepEqual(await found("_"), []);
});

test("query: company isolation holds for the same search and the same conversation id", async () => {
  const { service, storage } = harness();
  seed(storage, COMPANY_A, "conv-1", { name: "Pool quote", connectAgentAt: at(0) });
  seed(storage, COMPANY_B, "conv-1", { name: "Pool quote" });

  const a = await service.query(COMPANY_A, { q: "pool" });
  const b = await service.query(COMPANY_B, { q: "pool" });

  assert.equal(a.total, 1);
  assert.equal(a.data[0].companyId, COMPANY_A);
  assert.equal(a.data[0].connectAgentAt.getTime(), at(0).getTime());
  assert.equal(b.total, 1);
  assert.equal(b.data[0].companyId, COMPANY_B);
  assert.equal(b.data[0].connectAgentAt, null);
});

test("unread counts are per company, split by handler, and count only inbound messages not yet read", async () => {
  const { service, storage } = harness();
  seed(storage, COMPANY_A, "a1", { lastActivityAt: at(0) });
  seed(storage, COMPANY_A, "a2", { connectAgentAt: at(0) });
  seed(storage, COMPANY_A, "a3", { connectAgentAt: at(0) });
  seed(storage, COMPANY_A, "a4", { connectAgentAt: null });
  seed(storage, COMPANY_B, "b1");

  storage.addMessage(COMPANY_A, "a1", { id: "m1", role: "user", createdAt: at(1) });
  storage.addMessage(COMPANY_A, "a2", { id: "m2", role: "user", createdAt: at(1), readAt: at(2) });
  storage.addMessage(COMPANY_A, "a3", { id: "m3", role: "user", createdAt: at(1) });
  storage.addMessage(COMPANY_A, "a4", { id: "m4", role: "user", createdAt: at(1), isInternalNote: true });
  storage.addMessage(COMPANY_A, "a4", { id: "m5", role: "assistant", createdAt: at(2) });
  storage.addMessage(COMPANY_B, "b1", { id: "m6", role: "user", createdAt: at(1) });

  assert.deepEqual(await service.unreadCounts(COMPANY_A), { agent: 1, ai: 1, all: 2 });
  assert.deepEqual(await service.unreadCounts(COMPANY_B), { agent: 0, ai: 1, all: 1 });
});

// ---------- participants and read cursor ----------

test("participant unread count follows the read cursor: all messages before the first read, then only newer ones", async () => {
  const { service, storage } = harness();
  seed(storage, COMPANY_A, "c1", { connectAgentAt: at(0) });
  storage.addMessage(COMPANY_A, "c1", { id: "m1", role: "assistant", createdAt: at(1) });
  storage.addMessage(COMPANY_A, "c1", { id: "m2", role: "user", createdAt: at(2) });

  const participant = await service.upsertParticipant(COMPANY_A, "c1", { type: "staff", reference: STAFF.id, displayName: "Ana" }, STAFF);
  assert.equal(await service.participantUnreadCount(COMPANY_A, "c1", participant.id), 2);

  const read = await service.markParticipantRead(COMPANY_A, "c1", participant.id, STAFF);
  assert.equal(read.unreadCount, 0);
  assert.equal(read.participant.lastReadMessageId, "m2");

  storage.addMessage(COMPANY_A, "c1", { id: "m3", role: "user", createdAt: at(3) });
  assert.equal(await service.participantUnreadCount(COMPANY_A, "c1", participant.id), 1);

  const back = await service.markParticipantRead(COMPANY_A, "c1", participant.id, STAFF, "m2");
  assert.equal(back.unreadCount, 1);
});

test("markParticipantRead refuses a message that belongs to another conversation", async () => {
  const { service, storage } = harness();
  seed(storage, COMPANY_A, "c1");
  seed(storage, COMPANY_A, "c2");
  storage.addMessage(COMPANY_A, "c2", { id: "m-other", role: "user", createdAt: at(1) });
  const participant = await service.upsertParticipant(COMPANY_A, "c1", { type: "staff" }, STAFF);

  await assert.rejects(
    () => service.markParticipantRead(COMPANY_A, "c1", participant.id, STAFF, "m-other"),
    isStatus(422),
  );
});

test("participant upsert: one row per (conversation, type, reference), with trimmed references and object metadata only", async () => {
  const { service, storage } = harness();
  seed(storage, COMPANY_A, "c1");

  const first = await service.upsertParticipant(COMPANY_A, "c1", { type: "agent", reference: " bot-7 ", displayName: "Bot", metadata: { v: 1 } }, STAFF);
  const again = await service.upsertParticipant(COMPANY_A, "c1", { type: "agent", reference: "bot-7", displayName: "Renamed" }, STAFF);
  assert.equal(first.reference, "bot-7");
  assert.equal(again.id, first.id);
  assert.equal(again.displayName, "Renamed");

  const contact = await service.upsertParticipant(COMPANY_A, "c1", { type: "contact" }, STAFF);
  const blankRef = await service.upsertParticipant(COMPANY_A, "c1", { type: "contact", reference: "   " }, STAFF);
  assert.equal(blankRef.id, contact.id);

  await assert.rejects(() => service.upsertParticipant(COMPANY_A, "c1", { type: "contact", metadata: ["x"] }, STAFF), isStatus(422));
  await assert.rejects(() => service.upsertParticipant(COMPANY_A, "c1", { type: "" }, STAFF), isStatus(422));

  assert.equal((await service.listParticipants(COMPANY_A, "c1")).length, 2);
});

test("participants are company isolated: another company cannot read, mark or remove them", async () => {
  const { service, storage } = harness();
  seed(storage, COMPANY_A, "conv-a");
  seed(storage, COMPANY_B, "conv-b");
  const participant = await service.upsertParticipant(COMPANY_A, "conv-a", { type: "staff" }, STAFF);

  await assert.rejects(() => service.markParticipantRead(COMPANY_B, "conv-b", participant.id, STAFF_2), isStatus(404));
  await assert.rejects(() => service.removeParticipant(COMPANY_B, "conv-b", participant.id, STAFF_2), isStatus(404));
  assert.deepEqual(await service.listParticipants(COMPANY_B, "conv-b"), []);
  assert.equal((await service.listParticipants(COMPANY_A, "conv-a")).length, 1);
});

test("removing a participant deletes it, emits participant.removed, and a second removal is a 404", async () => {
  const { service, storage, events } = harness();
  seed(storage, COMPANY_A, "c1");
  const participant = await service.upsertParticipant(COMPANY_A, "c1", { type: "staff" }, STAFF);

  await service.removeParticipant(COMPANY_A, "c1", participant.id, STAFF);
  assert.deepEqual(await service.listParticipants(COMPANY_A, "c1"), []);
  await assert.rejects(() => service.removeParticipant(COMPANY_A, "c1", participant.id, STAFF), isStatus(404));

  const removed = events.forCompany(COMPANY_A).filter((event) => event.type === "participant.removed");
  assert.equal(removed.length, 1);
  assert.equal(removed[0].data.participantId, participant.id);
});

// ---------- assignment, priority, status ----------

test("assignment: assigns and unassigns, emits conversation.assigned on change only, and refuses cross-company writes", async () => {
  const { service, storage, events } = harness();
  seed(storage, COMPANY_A, "conv-1");
  seed(storage, COMPANY_B, "conv-1");

  const assigned = await service.assign(COMPANY_A, "conv-1", "staff-ana", STAFF);
  assert.equal(assigned.assignedTo, "staff-ana");
  await service.assign(COMPANY_A, "conv-1", "staff-ana", STAFF);
  await service.assign(COMPANY_A, "conv-1", null, STAFF_2);

  const assignedEvents = events.forCompany(COMPANY_A).filter((event) => event.type === "conversation.assigned");
  assert.equal(assignedEvents.length, 2);
  assert.deepEqual(assignedEvents[0].data, { actorId: STAFF.id, from: null, to: "staff-ana" });
  assert.deepEqual(assignedEvents[1].data, { actorId: STAFF_2.id, from: "staff-ana", to: null });

  await service.assign(COMPANY_A, "conv-1", "staff-ana", STAFF);
  await assert.rejects(() => service.assign(COMPANY_A, "conv-1", "staff-ana", {}), isStatus(422));

  await service.assign(COMPANY_B, "conv-1", "staff-ben", STAFF_2);
  assert.equal((await storage.getConversation(COMPANY_B, "conv-1")).assignedTo, "staff-ben");
  assert.equal((await storage.getConversation(COMPANY_A, "conv-1")).assignedTo, "staff-ana");

  await assert.rejects(() => service.assign(COMPANY_A, "missing", "staff-ana", STAFF), isStatus(404));
});

test("priority and ticket status: validated against the source vocabularies, and changes emit events", async () => {
  const { service, storage, events } = harness();
  seed(storage, COMPANY_A, "conv-1");

  await service.setPriority(COMPANY_A, "conv-1", "urgent", STAFF);
  await assert.rejects(() => service.setPriority(COMPANY_A, "conv-1", "critical", STAFF), isStatus(422));

  await service.setTicketStatus(COMPANY_A, "conv-1", "closed", STAFF);
  await assert.rejects(() => service.setTicketStatus(COMPANY_A, "conv-1", "deleted", STAFF), isStatus(422));

  const types = events.forCompany(COMPANY_A).map((event) => event.type);
  assert.deepEqual(types, ["conversation.priority_changed", "conversation.status_changed"]);
  assert.deepEqual(events.forCompany(COMPANY_A)[1].data, { actorId: STAFF.id, from: "new", to: "closed" });
});

// ---------- presence ----------

test("presence: a touch shows the participant as active, and it drops out after the default 120 second window", async () => {
  const { service, storage, time } = harness();
  seed(storage, COMPANY_A, "conv-1");

  await service.touchPresence(COMPANY_A, "conv-1", { participantKey: "staff-ana:tab-1" });
  assert.deepEqual((await service.activePresence(COMPANY_A, "conv-1")).map((p) => p.participantKey), ["staff-ana:tab-1"]);

  time.advance(60_000);
  await service.touchPresence(COMPANY_A, "conv-1", { participantKey: "bot" });
  time.advance(61_000);

  // staff-ana was last seen 121 seconds ago, so it has expired. bot was seen 61 seconds ago, so it is still active.
  assert.deepEqual((await service.activePresence(COMPANY_A, "conv-1")).map((p) => p.participantKey), ["bot"]);
});

test("presence TTL is clamped to at least 15 seconds, and a non-numeric value uses the default", async () => {
  assert.equal(resolvePresenceTtlSeconds(undefined), 120);
  assert.equal(resolvePresenceTtlSeconds(5), 15);
  assert.equal(resolvePresenceTtlSeconds(300.9), 300);
  assert.equal(resolvePresenceTtlSeconds(Number.NaN), 120);
  assert.equal(resolvePresenceTtlSeconds(Number.POSITIVE_INFINITY), 120);

  const { service, storage, time } = harness({ presenceTtlSeconds: 5 });
  seed(storage, COMPANY_A, "conv-1");
  await service.touchPresence(COMPANY_A, "conv-1", { participantKey: "tab-1" });

  time.advance(14_000);
  assert.equal((await service.activePresence(COMPANY_A, "conv-1")).length, 1);
  time.advance(2_000);
  assert.equal((await service.activePresence(COMPANY_A, "conv-1")).length, 0);
});

test("presence: offline is excluded from active, a state change emits presence.changed, and a same-state heartbeat does not", async () => {
  const { service, storage, events } = harness();
  seed(storage, COMPANY_A, "conv-1");

  await service.touchPresence(COMPANY_A, "conv-1", { participantKey: "tab-1", state: "online" });
  await service.touchPresence(COMPANY_A, "conv-1", { participantKey: "tab-1", state: "online" });
  await service.touchPresence(COMPANY_A, "conv-1", { participantKey: "tab-1", state: "away" });
  assert.equal((await service.activePresence(COMPANY_A, "conv-1"))[0].state, "away");

  await service.touchPresence(COMPANY_A, "conv-1", { participantKey: "tab-1", state: "offline" });
  assert.deepEqual(await service.activePresence(COMPANY_A, "conv-1"), []);

  const changes = events.forCompany(COMPANY_A).filter((event) => event.type === "presence.changed");
  assert.deepEqual(
    changes.map((event) => [event.data.from, event.data.to]),
    [[null, "online"], ["online", "away"], ["away", "offline"]],
  );
  await assert.rejects(() => service.touchPresence(COMPANY_A, "conv-1", { participantKey: "tab-1", state: "sleeping" }), isStatus(422));
});

test("presence is company isolated: another company sees no presence for the same conversation id", async () => {
  const { service, storage } = harness();
  seed(storage, COMPANY_A, "conv-1");
  seed(storage, COMPANY_B, "conv-1");

  await service.touchPresence(COMPANY_A, "conv-1", { participantKey: "tab-1" });

  assert.equal((await service.activePresence(COMPANY_A, "conv-1")).length, 1);
  assert.deepEqual(await service.activePresence(COMPANY_B, "conv-1"), []);
});

// ---------- events ----------

test("events carry the company they belong to, and each company only sees its own stream", async () => {
  const { service, storage, events } = harness();
  seed(storage, COMPANY_A, "conv-1");
  seed(storage, COMPANY_B, "conv-1");

  await service.handoffToHuman(COMPANY_A, "conv-1", STAFF);
  await service.assign(COMPANY_B, "conv-1", "staff-ben", STAFF_2);

  const forA = events.forCompany(COMPANY_A);
  const forB = events.forCompany(COMPANY_B);
  assert.equal(forA.length, 1);
  assert.equal(forB.length, 1);
  assert.equal(forA[0].type, "conversation.handoff");
  assert.equal(forB[0].type, "conversation.assigned");
  assert.ok(forA.every((event) => event.companyId === COMPANY_A));
  assert.ok(forB.every((event) => event.companyId === COMPANY_B));
  assert.equal(events.events().length, 2);
});

test("a publisher failure is reported and does not roll back the state change", async () => {
  const reported = [];
  const failing = {
    async publish() {
      throw new Error("transport down");
    },
  };
  const { service, storage } = harness({
    events: failing,
    onPublishError: (error, event) => reported.push([error.message, event.type]),
  });
  seed(storage, COMPANY_A, "conv-1");

  const result = await service.handoffToHuman(COMPANY_A, "conv-1", STAFF);

  assert.equal(result.changed, true);
  assert.equal((await service.handlingState(COMPANY_A, "conv-1")).handler, "human");
  assert.deepEqual(reported, [["transport down", "conversation.handoff"]]);
});

test("storage: a read of another company's conversation id returns nothing and writes nothing", async () => {
  const storage = new InMemoryInboxStorage();
  seed(storage, COMPANY_A, "conv-a");
  storage.addMessage(COMPANY_A, "conv-a", { id: "m1", role: "user", createdAt: at(1) });

  assert.equal(await storage.getConversation(COMPANY_B, "conv-a"), null);
  assert.equal(await storage.countMessagesAfter(COMPANY_B, "conv-a", null), 0);
  assert.equal(await storage.transitionHandler(COMPANY_B, "conv-a", "human", at(0)), null);
  assert.equal((await storage.getConversation(COMPANY_A, "conv-a")).connectAgentAt, null);
});

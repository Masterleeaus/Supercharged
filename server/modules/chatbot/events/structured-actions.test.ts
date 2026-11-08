import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryEventsStore } from "./memory-store.ts";
import { EventsError } from "./types.ts";
import { PROPOSAL_MAX_AGE_MS, createStructuredActionService } from "./structured-actions.ts";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const CONV_A = "conv-a-1";
const CONV_B = "conv-b-1";
const HOUR = 60 * 60 * 1000;
const T0 = new Date("2026-11-01T09:00:00.000Z");

function setup() {
  const store = createMemoryEventsStore();
  store.addConversation(COMPANY_A, CONV_A);
  store.addConversation(COMPANY_B, CONV_B);
  let clock = T0;
  let seq = 0;
  const service = createStructuredActionService(store, {
    now: () => clock,
    newId: () => `act-${++seq}`,
  });
  return {
    store,
    service,
    setNow(d: Date) {
      clock = d;
    },
  };
}

const refund = (orderId: string) => ({
  kind: "request_refund" as const,
  args: { orderId, amountMinor: 1500, reason: "Damaged on arrival" },
});

test("an old proposal expires and the count is returned", async () => {
  const { service, setNow } = setup();
  const old = await service.propose(COMPANY_A, CONV_A, refund("order-1"));
  assert.equal(old?.status, "proposed");

  setNow(new Date(T0.getTime() + 25 * HOUR));
  const count = await service.expireStaleProposals(COMPANY_A, new Date(T0.getTime() + 25 * HOUR));

  assert.equal(count, 1);
  assert.equal((await service.get(COMPANY_A, old!.id))?.status, "expired");
});

test("a fresh proposal stays proposed while an old one expires", async () => {
  const { service, setNow } = setup();
  const old = await service.propose(COMPANY_A, CONV_A, refund("order-1"));

  setNow(new Date(T0.getTime() + 12 * HOUR));
  const fresh = await service.propose(COMPANY_A, CONV_A, refund("order-2"));

  setNow(new Date(T0.getTime() + 25 * HOUR));
  const count = await service.expireStaleProposals(COMPANY_A, new Date(T0.getTime() + 25 * HOUR));

  assert.equal(count, 1);
  assert.equal((await service.get(COMPANY_A, old!.id))?.status, "expired");
  assert.equal((await service.get(COMPANY_A, fresh!.id))?.status, "proposed");
});

test("a proposal exactly at the cutoff is not expired (strictly older only)", async () => {
  const { service } = setup();
  const edge = await service.propose(COMPANY_A, CONV_A, refund("order-1"));
  const count = await service.expireStaleProposals(COMPANY_A, new Date(T0.getTime() + PROPOSAL_MAX_AGE_MS));
  assert.equal(count, 0);
  assert.equal((await service.get(COMPANY_A, edge!.id))?.status, "proposed");
});

test("another company's old proposals are untouched", async () => {
  const { service, setNow } = setup();
  const a = await service.propose(COMPANY_A, CONV_A, refund("order-1"));
  const b = await service.propose(COMPANY_B, CONV_B, refund("order-9"));

  setNow(new Date(T0.getTime() + 30 * HOUR));
  const count = await service.expireStaleProposals(COMPANY_A, new Date(T0.getTime() + 30 * HOUR));

  assert.equal(count, 1);
  assert.equal((await service.get(COMPANY_A, a!.id))?.status, "expired");
  assert.equal((await service.get(COMPANY_B, b!.id))?.status, "proposed");
  assert.equal(await service.get(COMPANY_A, b!.id), null, "company A must not see company B's action");
});

test("an approved action is not touched by the sweep", async () => {
  const { service, setNow } = setup();
  const pending = await service.propose(COMPANY_A, CONV_A, refund("order-1"));
  // Kinds outside REQUIRES_APPROVAL start approved, with no approver.
  const auto = await service.propose(COMPANY_A, CONV_A, { kind: "add_to_cart", args: { productId: "prod-1", quantity: 2 } });
  assert.equal(auto?.status, "approved");
  const approved = await service.approve(COMPANY_A, pending!.id, "staff-1");
  assert.equal(approved?.status, "approved");

  setNow(new Date(T0.getTime() + 48 * HOUR));
  const count = await service.expireStaleProposals(COMPANY_A, new Date(T0.getTime() + 48 * HOUR));

  assert.equal(count, 0);
  assert.equal((await service.get(COMPANY_A, pending!.id))?.status, "approved");
  assert.equal((await service.get(COMPANY_A, auto!.id))?.status, "approved");
});

test("a rejected action is not changed to expired", async () => {
  const { service, setNow } = setup();
  const rejectedAction = await service.propose(COMPANY_A, CONV_A, refund("order-1"));
  await service.reject(COMPANY_A, rejectedAction!.id, "staff-1", "Not eligible");

  setNow(new Date(T0.getTime() + 48 * HOUR));
  assert.equal(await service.expireStaleProposals(COMPANY_A, new Date(T0.getTime() + 48 * HOUR)), 0);
  assert.equal((await service.get(COMPANY_A, rejectedAction!.id))?.status, "rejected");
});

test("approve and reject refuse an expired action", async () => {
  const { service, setNow } = setup();
  const action = await service.propose(COMPANY_A, CONV_A, refund("order-1"));
  setNow(new Date(T0.getTime() + 25 * HOUR));
  await service.expireStaleProposals(COMPANY_A, new Date(T0.getTime() + 25 * HOUR));

  await assert.rejects(service.approve(COMPANY_A, action!.id, "staff-1"), (err: unknown) => err instanceof EventsError && err.code === "INVALID_STATE");
  await assert.rejects(service.reject(COMPANY_A, action!.id, "staff-1", null), (err: unknown) => err instanceof EventsError && err.code === "INVALID_STATE");
  assert.equal((await service.get(COMPANY_A, action!.id))?.status, "expired");
});

test("a second sweep finds nothing new", async () => {
  const { service, setNow } = setup();
  await service.propose(COMPANY_A, CONV_A, refund("order-1"));
  setNow(new Date(T0.getTime() + 25 * HOUR));
  assert.equal(await service.expireStaleProposals(COMPANY_A, new Date(T0.getTime() + 25 * HOUR)), 1);
  assert.equal(await service.expireStaleProposals(COMPANY_A, new Date(T0.getTime() + 25 * HOUR)), 0);
});

test("a custom maxAgeMs is honoured", async () => {
  const { service } = setup();
  const action = await service.propose(COMPANY_A, CONV_A, refund("order-1"));
  const later = new Date(T0.getTime() + 2 * HOUR);
  assert.equal(await service.expireStaleProposals(COMPANY_A, later, HOUR), 1);
  assert.equal((await service.get(COMPANY_A, action!.id))?.status, "expired");
});

test("invalid sweep arguments are refused", async () => {
  const { service } = setup();
  await assert.rejects(service.expireStaleProposals(COMPANY_A, new Date("not a date")), EventsError);
  await assert.rejects(service.expireStaleProposals(COMPANY_A, T0, 0), EventsError);
  await assert.rejects(service.expireStaleProposals(COMPANY_A, T0, Number.NaN), EventsError);
});

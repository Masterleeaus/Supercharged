import assert from "node:assert/strict";
import test from "node:test";
import { routeDecisionSignal } from "../runtime/decisionSignalRouter.ts";

const signal = (overrides = {}) => ({
  signal_id: "event-42",
  company_id: "company-1",
  decision_subject_id: "subject-9",
  occurred_at: "2026-10-03T09:00:00.000Z",
  changed_fields: ["inventory.available"],
  ...overrides,
});

const watch = (overrides = {}) => ({
  watch_id: "watch-1",
  company_id: "company-1",
  decision_subject_id: "subject-9",
  status: "active",
  condition: { field: "inventory.available" },
  ...overrides,
});

test("routes an event to active watches with the same or overlapping field path", () => {
  const result = routeDecisionSignal(signal(), [
    watch(),
    watch({ watch_id: "watch-parent", condition: { field: "inventory" } }),
    watch({ watch_id: "watch-child", condition: { field: "inventory.available.count" } }),
    watch({ watch_id: "watch-other", condition: { field: "pricing.total" } }),
  ]);
  assert.equal(result.state, "routed");
  assert.deepEqual(result.requests.map((request) => request.watch_id), [
    "watch-1", "watch-child", "watch-parent",
  ]);
  assert.ok(result.requests.every((request) => request.trigger === "event"));
  assert.ok(result.requests.every((request) => request.authority_effect === "none"));
});

test("does not route paused, closed, cross-company, or cross-subject watches", () => {
  const result = routeDecisionSignal(signal(), [
    watch({ watch_id: "paused", status: "paused" }),
    watch({ watch_id: "closed", status: "closed" }),
    watch({ watch_id: "other-company", company_id: "company-2" }),
    watch({ watch_id: "other-subject", decision_subject_id: "subject-2" }),
  ]);
  assert.equal(result.state, "no_match");
  assert.deepEqual(result.requests, []);
});

test("returns review_required without broad fan-out when changed fields are absent", () => {
  const result = routeDecisionSignal(signal({ changed_fields: [] }), [watch()]);
  assert.equal(result.state, "review_required");
  assert.equal(result.reason_code, "changed_fields_required");
  assert.deepEqual(result.requests, []);
});

test("deduplicates identical target rows and produces stable idempotency hints", () => {
  const first = routeDecisionSignal(signal(), [watch(), watch()]);
  const retried = routeDecisionSignal(signal(), [watch()]);
  assert.equal(first.requests.length, 1);
  assert.equal(first.requests[0].idempotency_key, retried.requests[0].idempotency_key);
  assert.match(first.requests[0].idempotency_key, /^signal_watch_[a-f0-9]{32}$/);
});

test("orders requests by watch id regardless of target index order", () => {
  const result = routeDecisionSignal(signal(), [
    watch({ watch_id: "watch-z" }),
    watch({ watch_id: "watch-a" }),
  ]);
  assert.deepEqual(result.requests.map((request) => request.watch_id), ["watch-a", "watch-z"]);
});

test("rejects conflicting duplicate targets and malformed field paths", () => {
  assert.throws(
    () => routeDecisionSignal(signal(), [
      watch(),
      watch({ condition: { field: "inventory.count" } }),
    ]),
    { code: "conflicting_watch_target" },
  );
  assert.throws(
    () => routeDecisionSignal(signal({ changed_fields: ["inventory..count"] }), [watch()]),
    { code: "invalid_changed_field" },
  );
});

test("rejects missing or invalid signal identity and timestamps", () => {
  assert.throws(() => routeDecisionSignal(signal({ signal_id: "" }), [watch()]), {
    code: "signal_id_required",
  });
  assert.throws(() => routeDecisionSignal(signal({ occurred_at: "yesterday" }), [watch()]), {
    code: "invalid_signal_timestamp",
  });
});

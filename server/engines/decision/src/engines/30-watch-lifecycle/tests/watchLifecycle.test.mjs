import assert from "node:assert/strict";
import test from "node:test";
import {
  planDecisionWatchLifecycle,
  runDecisionWatchLifecycleCommand,
} from "../runtime/watchLifecycle.ts";

const now = "2026-10-03T12:00:00.000Z";

function createCommand(overrides = {}) {
  return {
    operation: "create",
    command_id: "command-create-1",
    company_id: "company-1",
    watch_id: "watch-1",
    decision_subject_id: "subject-1",
    condition: { field: "inventory.available", operator: "gt", expected: 2 },
    now,
    ...overrides,
  };
}

function storedWatch(overrides = {}) {
  return {
    watch: {
      watch_id: "watch-1",
      company_id: "company-1",
      decision_subject_id: "subject-1",
      status: "active",
      condition: { field: "inventory.available", operator: "gt", expected: 2 },
      created_at: "2026-10-02T12:00:00.000Z",
      expires_at: null,
      last_triggered_at: "2026-10-03T11:30:00.000Z",
      next_evaluation_at: "2026-10-03T12:30:00.000Z",
      interval_seconds: 3600,
      cooldown_seconds: 300,
      ...overrides,
    },
    revision: 4,
  };
}

class MemoryLifecycleStore {
  record = null;
  receipts = new Map();

  async loadWatchForLifecycle(companyId, watchId) {
    if (
      this.record?.watch.company_id === companyId &&
      this.record.watch.watch_id === watchId
    ) return this.record;
    return null;
  }

  async loadLifecycleCommandReceipt(companyId, commandId) {
    return this.receipts.get(`${companyId}:${commandId}`) ?? null;
  }

  async commitLifecycleTransition(input) {
    const receiptKey = `${input.company_id}:${input.command_id}`;
    const receipt = this.receipts.get(receiptKey);
    if (receipt) return receipt.command_fingerprint === input.command_fingerprint ? "duplicate" : "conflict";
    const expectedMatches = input.expected_revision === null
      ? this.record === null
      : this.record?.revision === input.expected_revision;
    if (!expectedMatches) return "conflict";
    if (input.plan.state === "unchanged") {
      this.receipts.set(receiptKey, { command_fingerprint: input.command_fingerprint, plan: input.plan });
      return "unchanged";
    }
    this.record = {
      watch: input.plan.watch,
      revision: input.resulting_revision,
    };
    this.receipts.set(receiptKey, { command_fingerprint: input.command_fingerprint, plan: input.plan });
    return "stored";
  }
}

test("creates an active company-scoped watch at revision zero", () => {
  const result = planDecisionWatchLifecycle(createCommand());
  assert.equal(result.watch.status, "active");
  assert.equal(result.watch.created_at, now);
  assert.equal(result.expected_revision, null);
  assert.equal(result.resulting_revision, 0);
  assert.equal(result.event.transition, "created");
  assert.deepEqual(result.event.changed_fields, ["watch"]);
  assert.equal(result.authority_effect, "none");
});

test("pauses and resumes watches while clearing stale evaluation scheduling", () => {
  const current = storedWatch();
  const paused = planDecisionWatchLifecycle({
    operation: "pause", command_id: "pause-1", company_id: "company-1",
    watch_id: "watch-1", expected_revision: 4, now,
  }, current);
  assert.equal(paused.watch.status, "paused");
  assert.equal(paused.watch.next_evaluation_at, null);
  assert.equal(paused.resulting_revision, 5);

  const resumed = planDecisionWatchLifecycle({
    operation: "resume", command_id: "resume-1", company_id: "company-1",
    watch_id: "watch-1", expected_revision: 5, now,
  }, { watch: paused.watch, revision: 5 });
  assert.equal(resumed.watch.status, "active");
  assert.equal(resumed.watch.next_evaluation_at, null);
  assert.equal(resumed.event.transition, "resumed");
});

test("updates conditions without changing scope and resets stale trigger state", () => {
  const result = planDecisionWatchLifecycle({
    operation: "update", command_id: "update-1", company_id: "company-1",
    watch_id: "watch-1", expected_revision: 4, now,
    patch: { condition: { field: "inventory.available", operator: "lt", expected: 1 } },
  }, storedWatch());
  assert.equal(result.watch.company_id, "company-1");
  assert.equal(result.watch.decision_subject_id, "subject-1");
  assert.equal(result.watch.condition.operator, "lt");
  assert.equal(result.watch.last_triggered_at, null);
  assert.equal(result.watch.next_evaluation_at, null);
  assert.equal(result.event.transition, "updated");
  assert.deepEqual(result.event.changed_fields, ["condition", "last_triggered_at", "next_evaluation_at"]);
});

test("interval changes clear scheduling without resetting the last trigger", () => {
  const result = planDecisionWatchLifecycle({
    operation: "update", command_id: "interval-1", company_id: "company-1",
    watch_id: "watch-1", expected_revision: 4, now,
    patch: { interval_seconds: 7200 },
  }, storedWatch());
  assert.equal(result.watch.last_triggered_at, "2026-10-03T11:30:00.000Z");
  assert.equal(result.watch.next_evaluation_at, null);
  assert.deepEqual(result.event.changed_fields, ["interval_seconds", "next_evaluation_at"]);
});

test("returns unchanged for a repeated same-state command", () => {
  const current = storedWatch({ status: "paused" });
  const result = planDecisionWatchLifecycle({
    operation: "pause", command_id: "pause-again", company_id: "company-1",
    watch_id: "watch-1", expected_revision: 4, now,
  }, current);
  assert.equal(result.state, "unchanged");
  assert.equal(result.resulting_revision, 4);
  assert.equal(result.event, null);
});

test("soft-closes a watch and treats closed status as terminal", () => {
  const closed = planDecisionWatchLifecycle({
    operation: "close", command_id: "close-1", company_id: "company-1",
    watch_id: "watch-1", expected_revision: 4, now,
  }, storedWatch());
  assert.equal(closed.watch.status, "closed");
  assert.equal(closed.watch.next_evaluation_at, null);
  assert.throws(() => planDecisionWatchLifecycle({
    operation: "update", command_id: "update-closed", company_id: "company-1",
    watch_id: "watch-1", expected_revision: 5, now,
    patch: { cooldown_seconds: 0 },
  }, { watch: closed.watch, revision: 5 }), { code: "closed_watch_terminal" });
});

test("rejects expired resume requests and invalid condition definitions", () => {
  const expired = storedWatch({ status: "paused", expires_at: "2026-10-03T11:00:00.000Z" });
  assert.throws(() => planDecisionWatchLifecycle({
    operation: "resume", command_id: "resume-expired", company_id: "company-1",
    watch_id: "watch-1", expected_revision: 4, now,
  }, expired), { code: "watch_expired" });
  assert.throws(() => planDecisionWatchLifecycle(createCommand({
    condition: { field: "inventory..available", operator: "gt", expected: 2 },
  })), { code: "invalid_watch_field" });
  assert.throws(() => planDecisionWatchLifecycle(createCommand({
    condition: { field: "inventory.available", operator: "gt" },
  })), { code: "watch_expected_value_required" });
});

test("requires the exact company scope and returns host revision conflicts", async () => {
  assert.throws(() => planDecisionWatchLifecycle({
    operation: "pause", command_id: "bad-scope", company_id: "company-2",
    watch_id: "watch-1", expected_revision: 4, now,
  }, storedWatch()), { code: "watch_store_scope_mismatch" });

  const store = new MemoryLifecycleStore();
  store.record = storedWatch();
  const result = await runDecisionWatchLifecycleCommand({
    operation: "pause", command_id: "stale-pause", company_id: "company-1",
    watch_id: "watch-1", expected_revision: 3, now,
  }, store);
  assert.equal(result.commit_status, "conflict");
  assert.equal(store.record.watch.status, "active");
});

test("delegates durable creation and same-command retries to the host store", async () => {
  const store = new MemoryLifecycleStore();
  const command = createCommand();
  const first = await runDecisionWatchLifecycleCommand(command, store);
  const retry = await runDecisionWatchLifecycleCommand(command, store);
  assert.equal(first.commit_status, "stored");
  assert.equal(retry.commit_status, "duplicate");
  assert.equal(store.record.revision, 0);
});

test("replays applied updates from a durable receipt before reading changed watch state", async () => {
  const store = new MemoryLifecycleStore();
  store.record = storedWatch();
  const command = {
    operation: "update", command_id: "update-retry", company_id: "company-1",
    watch_id: "watch-1", expected_revision: 4, now,
    patch: { condition: { field: "inventory.available", operator: "lt", expected: 1 } },
  };
  const first = await runDecisionWatchLifecycleCommand(command, store);
  const retry = await runDecisionWatchLifecycleCommand(command, store);
  const changedPayload = await runDecisionWatchLifecycleCommand({
    ...command,
    patch: { cooldown_seconds: 900 },
  }, store);
  assert.equal(first.commit_status, "stored");
  assert.equal(retry.commit_status, "duplicate");
  assert.deepEqual(retry.plan, first.plan);
  assert.equal(changedPayload.commit_status, "conflict");
  assert.equal(store.record.revision, 5);
});

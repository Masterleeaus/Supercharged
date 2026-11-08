import assert from "node:assert/strict";
import test from "node:test";

import {
  DECISION_WORKFLOW_STAGES,
  recordVerifiedOutcome,
  runDecisionWorkflow,
} from "../runtime/decisionWorkflow.ts";
import {
  evaluateDecisionWatch,
  runDecisionWatchCycle,
} from "../runtime/decisionWatch.ts";

const companyId = "company-a";
const subjectId = "subject-1";
const fixedTime = "2026-10-02T12:00:00.000Z";

function request(overrides = {}) {
  return {
    company_id: companyId,
    decision_subject_id: subjectId,
    decision_id: "decision-1",
    run_id: "run-1",
    idempotency_key: "idempotency-1",
    trigger: "manual",
    requested_at: fixedTime,
    input: { company_id: companyId, question: "choose" },
    ...overrides,
  };
}

function adapters(overrides = {}, calls = []) {
  const stages = Object.fromEntries(
    DECISION_WORKFLOW_STAGES.map((stage) => [
      stage,
      async (context) => {
        calls.push(stage);
        if (stage === "constraints") {
          return {
            company_id: companyId,
            workflow_gate: {
              state: "ready",
              eligible_option_ids: ["option-1"],
            },
          };
        }
        if (stage === "best_action") {
          return { company_id: companyId, status: "abstain" };
        }
        return { company_id: companyId, stage, status: context.workflow_status };
      },
    ]),
  );
  return { ...stages, ...overrides };
}

test("runs the reference stages in order and appends history after an abstention", async () => {
  const calls = [];
  const result = await runDecisionWorkflow(request(), adapters({}, calls), {
    clock: () => fixedTime,
  });

  assert.equal(result.status, "abstained");
  assert.deepEqual(calls, [...DECISION_WORKFLOW_STAGES]);
  assert.equal(result.artifacts.history.stage, "history");
  assert.equal(result.events.at(-1).type, "run_completed");
  assert.ok(result.events.every((event) => event.authority_effect === "none"));
});

test("missing constraint gate stops scoring and fails closed to review", async () => {
  const calls = [];
  const result = await runDecisionWorkflow(
    request(),
    adapters(
      {
        constraints: async () => {
          calls.push("constraints");
          return { company_id: companyId };
        },
      },
      calls,
    ),
    { clock: () => fixedTime },
  );

  assert.equal(result.status, "review_required");
  assert.equal(result.workflow_gate.reason_codes[0], "constraint_gate_missing");
  assert.deepEqual(calls, [
    "observation",
    "evidence",
    "entity_normalization",
    "context_enrichment",
    "option_discovery",
    "objectives",
    "constraints",
    "history",
  ]);
});

test("rejects a cross-company stage artifact", async () => {
  const result = await runDecisionWorkflow(
    request(),
    adapters({
      evidence: async () => ({ company_id: "company-b" }),
    }),
    { clock: () => fixedTime },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.failed_stage, "evidence");
  assert.equal(result.error_code, "cross_company_artifact");
});

test("fresh watch evidence requests a decision rerun without executing an action", () => {
  const watch = {
    watch_id: "watch-1",
    company_id: companyId,
    decision_subject_id: subjectId,
    status: "active",
    condition: { field: "price", operator: "lte", expected: 100 },
    created_at: fixedTime,
    cooldown_seconds: 60,
  };
  const snapshot = {
    company_id: companyId,
    decision_subject_id: subjectId,
    snapshot_id: "snapshot-1",
    values: { price: 95 },
    evidence: [
      {
        evidence_id: "evidence-1",
        company_id: companyId,
        field: "price",
        freshness_state: "fresh",
        observed_at: fixedTime,
      },
    ],
  };
  const result = evaluateDecisionWatch(watch, snapshot, {
    trigger: "event",
    now: fixedTime,
  });

  assert.equal(result.state, "trigger_requested");
  assert.equal(result.trigger_request.action, "rerun_decision");
  assert.equal(result.trigger_request.authority_effect, "none");
});

test("stale watch evidence returns unknown without a trigger", () => {
  const watch = {
    watch_id: "watch-1",
    company_id: companyId,
    decision_subject_id: subjectId,
    status: "active",
    condition: { field: "price", operator: "lte", expected: 100 },
    created_at: fixedTime,
  };
  const snapshot = {
    company_id: companyId,
    decision_subject_id: subjectId,
    values: { price: 95 },
    evidence: [
      {
        evidence_id: "evidence-1",
        company_id: companyId,
        field: "price",
        freshness_state: "stale",
      },
    ],
  };
  const result = evaluateDecisionWatch(watch, snapshot, {
    trigger: "scheduled",
    now: fixedTime,
  });

  assert.equal(result.state, "unknown");
  assert.equal(result.reason_code, "fresh_evidence_required");
  assert.equal(result.trigger_request, undefined);
});

test("watch cycle commits the watch update and rerun request through one outbox adapter", async () => {
  const watch = {
    watch_id: "watch-1",
    company_id: companyId,
    decision_subject_id: subjectId,
    status: "active",
    condition: { field: "price", operator: "lte", expected: 100 },
    created_at: fixedTime,
  };
  const current = {
    company_id: companyId,
    decision_subject_id: subjectId,
    snapshot_id: "snapshot-2",
    values: { price: 95 },
    evidence: [
      {
        evidence_id: "evidence-2",
        company_id: companyId,
        field: "price",
        freshness_state: "fresh",
        observed_at: fixedTime,
      },
    ],
  };
  let committed;
  const result = await runDecisionWatchCycle(
    {
      company_id: companyId,
      watch_id: "watch-1",
      trigger: "event",
      now: fixedTime,
    },
    {
      loadWatch: async () => ({ watch, revision: 4 }),
      loadSnapshots: async () => ({ current }),
      commitEvaluation: async (input) => {
        committed = input;
        return "stored";
      },
    },
  );

  assert.equal(result.evaluation.state, "trigger_requested");
  assert.equal(result.commit_status, "stored");
  assert.equal(result.rerun_request_committed, true);
  assert.equal(committed.expected_revision, 4);
  assert.equal(
    committed.outbox_trigger.trigger_id,
    result.evaluation.trigger_request.trigger_id,
  );
});

test("learning requires external verification and references before it is appended", async () => {
  let learned = 0;
  let appended = 0;
  const input = {
    company_id: companyId,
    historical_decision: {
      company_id: companyId,
      decision_subject_id: subjectId,
      decision_id: "decision-1",
    },
    outcome: {
      company_id: companyId,
      decision_subject_id: subjectId,
      outcome_id: "outcome-1",
    },
  };
  const adapters = {
    verify: async () => ({ status: "rejected", verification_refs: [] }),
    learn: async () => {
      learned += 1;
      return { company_id: companyId };
    },
    appendLearningRevision: async () => {
      appended += 1;
    },
  };
  const rejected = await recordVerifiedOutcome(input, adapters);
  assert.equal(rejected.status, "rejected");
  assert.equal(learned, 0);
  assert.equal(appended, 0);

  const accepted = await recordVerifiedOutcome(input, {
    ...adapters,
    verify: async () => ({
      status: "verified",
      verification_refs: ["receipt-1"],
    }),
  });
  assert.equal(accepted.status, "learned");
  assert.equal(learned, 1);
  assert.equal(appended, 1);
});

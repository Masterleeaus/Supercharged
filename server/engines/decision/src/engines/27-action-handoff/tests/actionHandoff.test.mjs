import assert from "node:assert/strict";
import test from "node:test";
import {
  DecisionActionHandoffError,
  prepareDecisionActionHandoff,
} from "../runtime/decisionActionHandoff.ts";

const now = "2026-10-02T12:00:00.000Z";
const clock = () => now;
const options = { clock };

function base() {
  return {
    company_id: "company-1",
    decision_subject_id: "subject-1",
    decision_id: "decision-1",
    constraint_gate: {
      state: "ready",
      company_id: "company-1",
      eligible_option_ids: ["option-1", "option-2"],
    },
    recommendation: {
      company_id: "company-1",
      decision_subject_id: "subject-1",
      decision_id: "decision-1",
      status: "recommend",
      recommended_option_id: "option-1",
      authority_effect: "none",
    },
    binding: {
      action_id: "apply-option",
      option_id: "option-1",
      capability_id: "operations.apply",
      capability_version: "3",
      target_ref: "work-item-7",
      parameters: { priority: "high", work_item_id: "work-item-7" },
      evidence_refs: ["evidence-2", "evidence-1", "evidence-2"],
    },
    capability_assessment: {
      company_id: "company-1",
      capability_id: "operations.apply",
      actor_id: "actor-1",
      availability: "available",
      authorization: "allowed",
      policy_version: "policy-9",
      assessed_at: "2026-10-02T11:59:00.000Z",
      expires_at: "2026-10-02T13:00:00.000Z",
    },
  };
}

function reason(input, expectedStatus, expectedReason) {
  const result = prepareDecisionActionHandoff(input, options);
  assert.equal(result.status, expectedStatus);
  assert.equal(result.reason_codes[0], expectedReason);
  assert.equal("prepared_request" in result, false);
  return result;
}

function code(errorCode) {
  return (error) => error instanceof DecisionActionHandoffError && error.code === errorCode;
}

test("prepares a scoped handoff while leaving dispatch to the host", () => {
  const result = prepareDecisionActionHandoff(base(), options);
  assert.equal(result.status, "prepared");
  assert.equal(result.authority_effect, "none");
  assert.equal(result.prepared_request.dispatch_state, "not_dispatched");
  assert.equal(result.prepared_request.company_id, "company-1");
  assert.equal(result.prepared_request.actor_id, "actor-1");
  assert.equal(result.prepared_request.option_id, "option-1");
  assert.equal(result.prepared_request.expires_at, "2026-10-02T12:05:00.000Z");
});

test("canonicalizes and deduplicates evidence references", () => {
  const result = prepareDecisionActionHandoff(base(), options);
  assert.deepEqual(result.prepared_request.evidence_refs, ["evidence-1", "evidence-2"]);
});

test("replays of the same action produce the same idempotency key", () => {
  const first = prepareDecisionActionHandoff(base(), options);
  const replay = prepareDecisionActionHandoff(base(), options);
  assert.equal(first.prepared_request.idempotency_key, replay.prepared_request.idempotency_key);
  assert.equal(first.prepared_request.request_id, replay.prepared_request.request_id);
});

test("a changed action payload produces a different idempotency key", () => {
  const changed = base();
  changed.binding.parameters.priority = "urgent";
  assert.notEqual(
    prepareDecisionActionHandoff(base(), options).prepared_request.idempotency_key,
    prepareDecisionActionHandoff(changed, options).prepared_request.idempotency_key,
  );
});

test("approval-required requests remain undispatched", () => {
  const input = base();
  input.capability_assessment.authorization = "approval_required";
  const result = prepareDecisionActionHandoff(input, options);
  assert.equal(result.status, "approval_required");
  assert.equal(result.reason_codes[0], "host_approval_required");
  assert.equal(result.prepared_request.dispatch_state, "not_dispatched");
  assert.equal(result.prepared_request.authority_effect, "none");
});

test("an abstaining recommendation produces no request", () => {
  const input = base();
  input.recommendation.status = "abstain";
  input.recommendation.recommended_option_id = null;
  reason(input, "abstained", "recommendation_abstained");
});

test("a recommendation requiring review produces no request", () => {
  const input = base();
  input.recommendation.status = "review_required";
  reason(input, "review_required", "recommendation_requires_review");
});

test("an abstaining constraint gate produces no request", () => {
  const input = base();
  input.constraint_gate.state = "abstain";
  reason(input, "abstained", "constraint_gate_abstained");
});

test("a constraint gate requiring review produces no request", () => {
  const input = base();
  input.constraint_gate.state = "review_required";
  reason(input, "review_required", "constraint_gate_requires_review");
});

test("an unknown constraint state fails closed", () => {
  const input = base();
  input.constraint_gate.state = "pending";
  reason(input, "review_required", "constraint_gate_state_unknown");
});

test("an empty eligible option set fails closed", () => {
  const input = base();
  input.constraint_gate.eligible_option_ids = [];
  reason(input, "review_required", "constraint_gate_has_no_eligible_options");
});

test("malformed eligible option identifiers fail closed", () => {
  const input = base();
  input.constraint_gate.eligible_option_ids = ["option-1", ""];
  reason(input, "review_required", "constraint_gate_has_no_eligible_options");
});

test("a missing recommended option abstains", () => {
  const input = base();
  input.recommendation.recommended_option_id = null;
  reason(input, "abstained", "recommended_option_missing");
});

test("a recommendation outside the eligible set is blocked", () => {
  const input = base();
  input.constraint_gate.eligible_option_ids = ["option-2"];
  reason(input, "blocked", "recommendation_not_constraint_eligible");
});

test("a binding to a different option is blocked", () => {
  const input = base();
  input.binding.option_id = "option-2";
  reason(input, "blocked", "action_binding_option_mismatch");
});

test("an incomplete action binding requires review", () => {
  const input = base();
  input.binding.capability_version = "";
  reason(input, "review_required", "action_binding_incomplete");
});

test("an invalid target reference requires review", () => {
  const input = base();
  input.binding.target_ref = "";
  reason(input, "review_required", "action_target_reference_invalid");
});

test("invalid evidence references require review", () => {
  const input = base();
  input.binding.evidence_refs = ["evidence-1", 5];
  reason(input, "review_required", "action_evidence_references_invalid");
});

test("the capability assessment must match both company and capability", () => {
  const wrongCompany = base();
  wrongCompany.capability_assessment.company_id = "company-2";
  assert.throws(() => prepareDecisionActionHandoff(wrongCompany, options), code("capability_assessment_scope_mismatch"));

  const wrongCapability = base();
  wrongCapability.capability_assessment.capability_id = "operations.delete";
  assert.throws(() => prepareDecisionActionHandoff(wrongCapability, options), code("capability_assessment_scope_mismatch"));
});

test("an assessment older than the configured freshness window requires review", () => {
  const input = base();
  input.capability_assessment.assessed_at = "2026-10-02T11:54:59.000Z";
  const result = prepareDecisionActionHandoff(input, options);
  assert.equal(result.status, "review_required");
  assert.equal(result.reason_codes[0], "capability_assessment_stale");
});

test("an assessment on the freshness boundary remains usable", () => {
  const input = base();
  input.capability_assessment.assessed_at = "2026-10-02T11:55:00.000Z";
  assert.equal(prepareDecisionActionHandoff(input, options).status, "prepared");
});

test("a stale assessment can be allowed only with an explicit larger age window", () => {
  const input = base();
  input.capability_assessment.assessed_at = "2026-10-02T11:54:59.000Z";
  assert.equal(
    prepareDecisionActionHandoff(input, { ...options, max_assessment_age_seconds: 600 }).status,
    "prepared",
  );
});

test("an expired assessment requires review", () => {
  const input = base();
  input.capability_assessment.expires_at = "2026-10-02T11:59:59.000Z";
  reason(input, "review_required", "capability_assessment_missing_or_expired");
});

test("a future-dated assessment requires review", () => {
  const input = base();
  input.capability_assessment.assessed_at = "2026-10-02T12:00:01.000Z";
  reason(input, "review_required", "capability_assessment_missing_or_expired");
});

test("an assessment expiry before its assessment time requires review", () => {
  const input = base();
  input.capability_assessment.expires_at = "2026-10-02T11:58:00.000Z";
  reason(input, "review_required", "capability_assessment_missing_or_expired");
});

test("an assessment without actor or policy identity requires review", () => {
  const input = base();
  input.capability_assessment.actor_id = "";
  reason(input, "review_required", "capability_assessment_incomplete");
});

test("a disabled capability is blocked", () => {
  const input = base();
  input.capability_assessment.availability = "disabled";
  reason(input, "blocked", "capability_disabled");
});

test("unknown capability availability requires review", () => {
  const input = base();
  input.capability_assessment.availability = "unknown";
  reason(input, "review_required", "capability_availability_unknown");
});

test("unknown host authorization requires review", () => {
  const input = base();
  input.capability_assessment.authorization = "unknown";
  reason(input, "review_required", "host_authorization_unknown");
});

test("an explicit host authorization denial is blocked", () => {
  const input = base();
  input.capability_assessment.authorization = "denied";
  reason(input, "blocked", "host_authorization_denied");
});

test("legacy tenant boundary keys are rejected even when nested", () => {
  const input = base();
  input.binding.parameters.metadata = { tenant_id: "company-1" };
  assert.throws(() => prepareDecisionActionHandoff(input, options), code("legacy_company_boundary"));
});

test("nested parameters cannot target another company", () => {
  const input = base();
  input.binding.parameters.metadata = { company_id: "company-2" };
  assert.throws(() => prepareDecisionActionHandoff(input, options), code("cross_company_action_parameters"));
});

test("nested parameters for the same company are accepted", () => {
  const input = base();
  input.binding.parameters.metadata = { company_id: "company-1" };
  assert.equal(prepareDecisionActionHandoff(input, options).status, "prepared");
});

test("cyclic action parameters are rejected", () => {
  const input = base();
  input.binding.parameters.self = input.binding.parameters;
  assert.throws(() => prepareDecisionActionHandoff(input, options), code("cyclic_input"));
});

test("non-plain JSON action parameters are rejected", () => {
  const input = base();
  input.binding.parameters.created_at = new Date(now);
  assert.throws(() => prepareDecisionActionHandoff(input, options), code("non_plain_json_object"));
});

test("invalid assessment age configuration is rejected", () => {
  assert.throws(
    () => prepareDecisionActionHandoff(base(), { ...options, max_assessment_age_seconds: 0 }),
    code("invalid_max_assessment_age"),
  );
});

test("invalid request age configuration is rejected", () => {
  assert.throws(
    () => prepareDecisionActionHandoff(base(), { ...options, max_request_age_seconds: 0 }),
    code("invalid_max_request_age"),
  );
});

test("request expiry is capped at assessment expiry", () => {
  const input = base();
  input.capability_assessment.expires_at = "2026-10-02T12:01:00.000Z";
  assert.equal(
    prepareDecisionActionHandoff(input, options).prepared_request.expires_at,
    "2026-10-02T12:01:00.000Z",
  );
});

test("a custom request age controls request expiry", () => {
  assert.equal(
    prepareDecisionActionHandoff(base(), { ...options, max_request_age_seconds: 60 }).prepared_request.expires_at,
    "2026-10-02T12:01:00.000Z",
  );
});

test("mismatched recommendation scope is rejected", () => {
  const input = base();
  input.recommendation.company_id = "company-2";
  assert.throws(() => prepareDecisionActionHandoff(input, options), code("cross_scope_handoff_input"));
});

test("a recommendation cannot grant authority", () => {
  const input = base();
  input.recommendation.authority_effect = "execute";
  assert.throws(() => prepareDecisionActionHandoff(input, options), code("recommendation_authority_violation"));
});

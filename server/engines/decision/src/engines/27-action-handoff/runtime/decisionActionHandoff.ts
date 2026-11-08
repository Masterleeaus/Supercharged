import { createHash } from "node:crypto";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type HandoffStatus =
  | "prepared"
  | "approval_required"
  | "abstained"
  | "blocked"
  | "review_required";

export interface DecisionActionHandoffInput {
  company_id: string;
  decision_subject_id: string;
  decision_id: string;
  as_of?: string;
  constraint_gate: {
    state: "ready" | "abstain" | "review_required";
    company_id: string;
    eligible_option_ids: string[];
  };
  recommendation: {
    company_id: string;
    decision_subject_id: string;
    decision_id: string;
    status: "recommend" | "abstain" | "review_required";
    recommended_option_id?: string | null;
    authority_effect: "none";
  };
  binding: {
    action_id: string;
    option_id: string;
    capability_id: string;
    capability_version: string;
    target_ref?: string | null;
    parameters: Record<string, unknown>;
    evidence_refs?: string[];
  };
  capability_assessment: {
    company_id: string;
    capability_id: string;
    actor_id: string;
    availability: "available" | "disabled" | "unknown";
    authorization: "allowed" | "approval_required" | "denied" | "unknown";
    policy_version: string;
    assessed_at: string;
    expires_at: string;
  };
}

export interface PreparedHostActionRequest {
  request_id: string;
  idempotency_key: string;
  company_id: string;
  decision_subject_id: string;
  decision_id: string;
  option_id: string;
  action_id: string;
  capability_id: string;
  capability_version: string;
  actor_id: string;
  target_ref?: string;
  parameters: Record<string, JsonValue>;
  evidence_refs: string[];
  created_at: string;
  expires_at: string;
  host_assessment: {
    authorization: "allowed" | "approval_required";
    policy_version: string;
    assessed_at: string;
    expires_at: string;
  };
  dispatch_state: "not_dispatched";
  authority_effect: "none";
}

export interface DecisionActionHandoffResult {
  handoff_id: string;
  company_id: string;
  decision_subject_id: string;
  decision_id: string;
  status: HandoffStatus;
  reason_codes: string[];
  prepared_request?: PreparedHostActionRequest;
  authority_effect: "none";
}

export interface DecisionActionHandoffOptions {
  clock?: () => string;
  max_request_age_seconds?: number;
  max_assessment_age_seconds?: number;
}

export class DecisionActionHandoffError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "DecisionActionHandoffError";
  }
}

const DEFAULT_CLOCK = () => new Date().toISOString();
const FORBIDDEN_BOUNDARY_KEYS = new Set(["tenant_id", "tenant_company_id"]);

function canonicalJson(value: unknown, path = "value", stack = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (stack.has(value)) throw new DecisionActionHandoffError("cyclic_input");
    stack.add(value);
    const result = value.map((item, index) => canonicalJson(item, `${path}[${index}]`, stack));
    stack.delete(value);
    return result;
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DecisionActionHandoffError("non_plain_json_object");
    }
    if (stack.has(value as object)) throw new DecisionActionHandoffError("cyclic_input");
    stack.add(value as object);
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) throw new DecisionActionHandoffError("undefined_input_value");
      result[key] = canonicalJson(child, `${path}.${key}`, stack);
    }
    stack.delete(value as object);
    return result;
  }
  throw new DecisionActionHandoffError("non_json_input_value");
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJson(value)) ?? "null")
    .digest("hex");
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${digest(value).slice(0, 24)}`;
}

function assertCompanyScope(value: JsonValue, companyId: string, path = "parameters"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertCompanyScope(item, companyId, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_BOUNDARY_KEYS.has(key)) {
      throw new DecisionActionHandoffError("legacy_company_boundary");
    }
    if (key === "company_id" && child !== companyId) {
      throw new DecisionActionHandoffError("cross_company_action_parameters");
    }
    assertCompanyScope(child, companyId, `${path}.${key}`);
  }
}

function validTime(value: string): number | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function noRequest(
  input: DecisionActionHandoffInput,
  status: HandoffStatus,
  reasonCode: string,
): DecisionActionHandoffResult {
  const core = {
    company_id: input.company_id,
    decision_subject_id: input.decision_subject_id,
    decision_id: input.decision_id,
    action_id: input.binding?.action_id ?? null,
    status,
    reason_code: reasonCode,
  };
  return {
    handoff_id: stableId("handoff", core),
    company_id: input.company_id,
    decision_subject_id: input.decision_subject_id,
    decision_id: input.decision_id,
    status,
    reason_codes: [reasonCode],
    authority_effect: "none",
  };
}

export function prepareDecisionActionHandoff(
  input: DecisionActionHandoffInput,
  options: DecisionActionHandoffOptions = {},
): DecisionActionHandoffResult {
  if (!input || typeof input !== "object") {
    throw new DecisionActionHandoffError("handoff_input_required");
  }
  if (typeof input.company_id !== "string" || !input.company_id) {
    throw new DecisionActionHandoffError("company_id_required");
  }
  if (
    typeof input.decision_subject_id !== "string" || !input.decision_subject_id ||
    typeof input.decision_id !== "string" || !input.decision_id
  ) {
    throw new DecisionActionHandoffError("decision_identity_required");
  }
  if (!input.constraint_gate || !input.recommendation || !input.binding || !input.capability_assessment) {
    throw new DecisionActionHandoffError("handoff_sections_required");
  }
  if (
    input.recommendation.company_id !== input.company_id ||
    input.recommendation.decision_subject_id !== input.decision_subject_id ||
    input.recommendation.decision_id !== input.decision_id ||
    input.constraint_gate.company_id !== input.company_id
  ) {
    throw new DecisionActionHandoffError("cross_scope_handoff_input");
  }
  if (input.recommendation.authority_effect !== "none") {
    throw new DecisionActionHandoffError("recommendation_authority_violation");
  }
  if (
    typeof input.recommendation.company_id !== "string" ||
    typeof input.recommendation.decision_subject_id !== "string" ||
    typeof input.recommendation.decision_id !== "string"
  ) {
    throw new DecisionActionHandoffError("recommendation_identity_required");
  }

  if (!new Set(["recommend", "abstain", "review_required"]).has(input.recommendation.status)) {
    return noRequest(input, "review_required", "recommendation_status_unknown");
  }
  if (input.recommendation.status === "abstain") {
    return noRequest(input, "abstained", "recommendation_abstained");
  }
  if (input.recommendation.status === "review_required") {
    return noRequest(input, "review_required", "recommendation_requires_review");
  }
  if (input.constraint_gate.state === "abstain") {
    return noRequest(input, "abstained", "constraint_gate_abstained");
  }
  if (input.constraint_gate.state === "review_required") {
    return noRequest(input, "review_required", "constraint_gate_requires_review");
  }
  if (input.constraint_gate.state !== "ready") {
    return noRequest(input, "review_required", "constraint_gate_state_unknown");
  }
  if (
    !Array.isArray(input.constraint_gate.eligible_option_ids) ||
    input.constraint_gate.eligible_option_ids.length === 0 ||
    input.constraint_gate.eligible_option_ids.some((option) => typeof option !== "string" || !option)
  ) {
    return noRequest(input, "review_required", "constraint_gate_has_no_eligible_options");
  }

  const optionId = input.recommendation.recommended_option_id;
  if (typeof optionId !== "string" || !optionId) {
    return noRequest(input, "abstained", "recommended_option_missing");
  }
  if (!input.constraint_gate.eligible_option_ids.includes(optionId)) {
    return noRequest(input, "blocked", "recommendation_not_constraint_eligible");
  }
  if (typeof input.binding.option_id !== "string" || input.binding.option_id !== optionId) {
    return noRequest(input, "blocked", "action_binding_option_mismatch");
  }
  if (
    typeof input.binding.action_id !== "string" || !input.binding.action_id ||
    typeof input.binding.capability_id !== "string" || !input.binding.capability_id ||
    typeof input.binding.capability_version !== "string" || !input.binding.capability_version
  ) {
    return noRequest(input, "review_required", "action_binding_incomplete");
  }
  if (
    input.binding.target_ref !== undefined && input.binding.target_ref !== null &&
    (typeof input.binding.target_ref !== "string" || !input.binding.target_ref)
  ) {
    return noRequest(input, "review_required", "action_target_reference_invalid");
  }
  if (
    input.binding.evidence_refs !== undefined &&
    (!Array.isArray(input.binding.evidence_refs) ||
      input.binding.evidence_refs.some((ref) => typeof ref !== "string" || !ref))
  ) {
    return noRequest(input, "review_required", "action_evidence_references_invalid");
  }
  if (
    input.capability_assessment.company_id !== input.company_id ||
    input.capability_assessment.capability_id !== input.binding.capability_id
  ) {
    throw new DecisionActionHandoffError("capability_assessment_scope_mismatch");
  }

  const now = options.clock?.() ?? input.as_of ?? DEFAULT_CLOCK();
  const nowMs = validTime(now);
  if (nowMs === null) throw new DecisionActionHandoffError("invalid_as_of_time");
  const maxAssessmentAge = options.max_assessment_age_seconds ?? 300;
  if (!Number.isInteger(maxAssessmentAge) || maxAssessmentAge < 1 || maxAssessmentAge > 3600) {
    throw new DecisionActionHandoffError("invalid_max_assessment_age");
  }
  const assessedMs = validTime(input.capability_assessment.assessed_at);
  const assessmentExpiryMs = validTime(input.capability_assessment.expires_at);
  if (
    assessedMs === null ||
    assessmentExpiryMs === null ||
    assessedMs > nowMs ||
    assessmentExpiryMs <= assessedMs ||
    assessmentExpiryMs <= nowMs
  ) {
    return noRequest(input, "review_required", "capability_assessment_missing_or_expired");
  }
  if (nowMs - assessedMs > maxAssessmentAge * 1000) {
    return noRequest(input, "review_required", "capability_assessment_stale");
  }
  if (!input.capability_assessment.actor_id || !input.capability_assessment.policy_version) {
    return noRequest(input, "review_required", "capability_assessment_incomplete");
  }
  if (input.capability_assessment.availability === "disabled") {
    return noRequest(input, "blocked", "capability_disabled");
  }
  if (input.capability_assessment.availability === "unknown") {
    return noRequest(input, "review_required", "capability_availability_unknown");
  }
  if (input.capability_assessment.availability !== "available") {
    return noRequest(input, "review_required", "capability_availability_unknown");
  }
  if (input.capability_assessment.authorization === "denied") {
    return noRequest(input, "blocked", "host_authorization_denied");
  }
  if (input.capability_assessment.authorization === "unknown") {
    return noRequest(input, "review_required", "host_authorization_unknown");
  }
  if (
    input.capability_assessment.authorization !== "allowed" &&
    input.capability_assessment.authorization !== "approval_required"
  ) {
    return noRequest(input, "review_required", "host_authorization_unknown");
  }

  const parameters = canonicalJson(input.binding.parameters);
  if (!parameters || Array.isArray(parameters) || typeof parameters !== "object") {
    throw new DecisionActionHandoffError("action_parameters_must_be_an_object");
  }
  assertCompanyScope(parameters, input.company_id);

  const maxAge = options.max_request_age_seconds ?? 300;
  if (!Number.isInteger(maxAge) || maxAge < 1 || maxAge > 3600) {
    throw new DecisionActionHandoffError("invalid_max_request_age");
  }
  const expiresAt = new Date(Math.min(assessmentExpiryMs, nowMs + maxAge * 1000)).toISOString();
  const evidenceRefs = [...new Set(input.binding.evidence_refs ?? [])].sort();
  const requestCore = {
    company_id: input.company_id,
    decision_subject_id: input.decision_subject_id,
    decision_id: input.decision_id,
    option_id: optionId,
    action_id: input.binding.action_id,
    capability_id: input.binding.capability_id,
    capability_version: input.binding.capability_version,
    actor_id: input.capability_assessment.actor_id,
    target_ref: input.binding.target_ref ?? null,
    parameters,
    evidence_refs: evidenceRefs,
  };
  const idempotencyKey = `action_${digest(requestCore)}`;
  const status = input.capability_assessment.authorization === "approval_required"
    ? "approval_required"
    : "prepared";
  const preparedRequest: PreparedHostActionRequest = {
    request_id: stableId("request", requestCore),
    idempotency_key: idempotencyKey,
    company_id: input.company_id,
    decision_subject_id: input.decision_subject_id,
    decision_id: input.decision_id,
    option_id: optionId,
    action_id: input.binding.action_id,
    capability_id: input.binding.capability_id,
    capability_version: input.binding.capability_version,
    actor_id: input.capability_assessment.actor_id,
    ...(input.binding.target_ref ? { target_ref: input.binding.target_ref } : {}),
    parameters: parameters as Record<string, JsonValue>,
    evidence_refs: evidenceRefs,
    created_at: new Date(nowMs).toISOString(),
    expires_at: expiresAt,
    host_assessment: {
      authorization: input.capability_assessment.authorization,
      policy_version: input.capability_assessment.policy_version,
      assessed_at: new Date(assessedMs).toISOString(),
      expires_at: new Date(assessmentExpiryMs).toISOString(),
    },
    dispatch_state: "not_dispatched",
    authority_effect: "none",
  };

  return {
    handoff_id: stableId("handoff", { request_id: preparedRequest.request_id, status }),
    company_id: input.company_id,
    decision_subject_id: input.decision_subject_id,
    decision_id: input.decision_id,
    status,
    reason_codes: status === "approval_required" ? ["host_approval_required"] : [],
    prepared_request: preparedRequest,
    authority_effect: "none",
  };
}

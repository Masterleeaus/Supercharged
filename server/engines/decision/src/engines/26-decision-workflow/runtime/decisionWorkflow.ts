import { createHash } from "node:crypto";

export const DECISION_WORKFLOW_STAGES = [
  "observation",
  "evidence",
  "entity_normalization",
  "context_enrichment",
  "option_discovery",
  "objectives",
  "constraints",
  "preferences",
  "comparison",
  "prediction",
  "ranking",
  "best_action",
  "explanation",
  "confidence",
  "history",
] as const;

export type DecisionWorkflowStage = (typeof DECISION_WORKFLOW_STAGES)[number];
export type DecisionWorkflowTrigger = "manual" | "event" | "scheduled" | "watch";
export type DecisionWorkflowStatus =
  | "completed"
  | "abstained"
  | "review_required"
  | "failed";

export interface DecisionWorkflowRequest {
  company_id: string;
  decision_subject_id: string;
  decision_id: string;
  run_id: string;
  idempotency_key: string;
  trigger: DecisionWorkflowTrigger;
  requested_at?: string;
  source_event_id?: string;
  input: Record<string, unknown>;
}

export interface ConstraintWorkflowGate {
  state: "ready" | "abstain" | "review_required";
  eligible_option_ids: string[];
  blocked_option_ids?: string[];
  unknown_option_ids?: string[];
  reason_codes?: string[];
}

export interface DecisionWorkflowStageContext {
  request: DecisionWorkflowRequest;
  stage: DecisionWorkflowStage;
  company_id: string;
  decision_subject_id: string;
  decision_id: string;
  run_id: string;
  idempotency_key: string;
  as_of: string;
  workflow_status: DecisionWorkflowStatus | "running";
  workflow_gate?: ConstraintWorkflowGate;
  artifacts: Readonly<Partial<Record<DecisionWorkflowStage, unknown>>>;
}

export type DecisionWorkflowStageAdapter = (
  context: DecisionWorkflowStageContext,
) => unknown | Promise<unknown>;

export type DecisionWorkflowAdapters = Record<
  DecisionWorkflowStage,
  DecisionWorkflowStageAdapter
>;

export interface DecisionWorkflowEvent {
  event_id: string;
  sequence: number;
  company_id: string;
  decision_subject_id: string;
  decision_id: string;
  run_id: string;
  idempotency_key: string;
  trigger: DecisionWorkflowTrigger;
  stage: DecisionWorkflowStage | "workflow";
  type: "stage_started" | "stage_completed" | "stage_failed" | "run_completed";
  occurred_at: string;
  output_hash?: string;
  error_code?: string;
  authority_effect: "none";
}

export interface DecisionWorkflowResult {
  status: DecisionWorkflowStatus;
  request: DecisionWorkflowRequest;
  workflow_gate?: ConstraintWorkflowGate;
  artifacts: Partial<Record<DecisionWorkflowStage, unknown>>;
  events: DecisionWorkflowEvent[];
  failed_stage?: DecisionWorkflowStage;
  error_code?: string;
  authority_effect: "none";
}

export class DecisionWorkflowError extends Error {
  readonly code: string;

  constructor(
    code: string,
    message = code,
  ) {
    super(message);
    this.code = code;
    this.name = "DecisionWorkflowError";
  }
}

export interface DecisionWorkflowOptions {
  clock?: () => string;
}

const FORBIDDEN_BOUNDARY_KEYS = new Set(["tenant_id", "tenant_company_id"]);
const DEFAULT_CLOCK = () => new Date().toISOString();

function digest(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(canonicalize(value)) ?? "null";
  } catch {
    throw new DecisionWorkflowError("non_serializable_artifact");
  }
  return createHash("sha256").update(serialized).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          canonicalize((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  return value;
}

function stableId(prefix: string, value: unknown): string {
  return prefix + "_" + digest(value).slice(0, 24);
}

function assertCompanyScope(
  value: unknown,
  companyId: string,
  location: string,
  seen = new WeakSet<object>(),
): void {
  if (!value || typeof value !== "object") return;
  if (seen.has(value as object)) return;
  seen.add(value as object);

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertCompanyScope(item, companyId, location + "[" + index + "]", seen),
    );
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_BOUNDARY_KEYS.has(key)) {
      throw new DecisionWorkflowError(
        "legacy_company_boundary",
        location + "." + key,
      );
    }
    if (key === "company_id" && child !== companyId) {
      throw new DecisionWorkflowError(
        "cross_company_artifact",
        location + ".company_id",
      );
    }
    assertCompanyScope(child, companyId, location + "." + key, seen);
  }
}

function validateRequest(request: DecisionWorkflowRequest): void {
  if (!request.company_id) {
    throw new DecisionWorkflowError("company_id_required");
  }
  if (!request.decision_subject_id || !request.decision_id) {
    throw new DecisionWorkflowError("decision_identity_required");
  }
  if (!request.run_id || !request.idempotency_key) {
    throw new DecisionWorkflowError("run_identity_required");
  }
  if (!["manual", "event", "scheduled", "watch"].includes(request.trigger)) {
    throw new DecisionWorkflowError("invalid_workflow_trigger");
  }
  if (!request.input || typeof request.input !== "object") {
    throw new DecisionWorkflowError("workflow_input_required");
  }
  assertCompanyScope(request.input, request.company_id, "request.input");
}

function normalizeGate(value: unknown): ConstraintWorkflowGate {
  if (!value || typeof value !== "object") {
    return {
      state: "review_required",
      eligible_option_ids: [],
      reason_codes: ["constraint_gate_missing"],
    };
  }
  const gate = (value as Record<string, unknown>).workflow_gate;
  if (!gate || typeof gate !== "object") {
    return {
      state: "review_required",
      eligible_option_ids: [],
      reason_codes: ["constraint_gate_missing"],
    };
  }

  const candidate = gate as Record<string, unknown>;
  const allowedStates = new Set(["ready", "abstain", "review_required"]);
  const eligible = Array.isArray(candidate.eligible_option_ids)
    ? candidate.eligible_option_ids.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  const reasonCodes = Array.isArray(candidate.reason_codes)
    ? candidate.reason_codes.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  if (!allowedStates.has(String(candidate.state))) {
    return {
      state: "review_required",
      eligible_option_ids: [],
      reason_codes: ["invalid_constraint_gate"],
    };
  }

  const state = candidate.state as ConstraintWorkflowGate["state"];
  if (state === "ready" && eligible.length === 0) {
    return {
      state: "review_required",
      eligible_option_ids: [],
      reason_codes: [...reasonCodes, "no_eligible_options"],
    };
  }
  return {
    state,
    eligible_option_ids: eligible,
    blocked_option_ids: Array.isArray(candidate.blocked_option_ids)
      ? candidate.blocked_option_ids.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    unknown_option_ids: Array.isArray(candidate.unknown_option_ids)
      ? candidate.unknown_option_ids.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    reason_codes: reasonCodes,
  };
}

function errorCode(error: unknown): string {
  if (error instanceof DecisionWorkflowError) return error.code;
  if (error instanceof Error && error.name) {
    return error.name.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  }
  return "workflow_stage_error";
}

export async function runDecisionWorkflow(
  request: DecisionWorkflowRequest,
  adapters: DecisionWorkflowAdapters,
  options: DecisionWorkflowOptions = {},
): Promise<DecisionWorkflowResult> {
  validateRequest(request);
  for (const stage of DECISION_WORKFLOW_STAGES) {
    if (typeof adapters?.[stage] !== "function") {
      throw new DecisionWorkflowError("missing_stage_adapter", stage);
    }
  }

  const clock = options.clock ?? DEFAULT_CLOCK;
  const artifacts: Partial<Record<DecisionWorkflowStage, unknown>> = {};
  const events: DecisionWorkflowEvent[] = [];
  let sequence = 0;
  let status: DecisionWorkflowStatus = "completed";
  let gate: ConstraintWorkflowGate | undefined;
  let failedStage: DecisionWorkflowStage | undefined;
  let failureCode: string | undefined;

  const appendEvent = (
    stage: DecisionWorkflowEvent["stage"],
    type: DecisionWorkflowEvent["type"],
    output?: unknown,
    code?: string,
  ) => {
    sequence += 1;
    const eventCore = {
      sequence,
      company_id: request.company_id,
      decision_subject_id: request.decision_subject_id,
      decision_id: request.decision_id,
      run_id: request.run_id,
      idempotency_key: request.idempotency_key,
      trigger: request.trigger,
      stage,
      type,
      occurred_at: clock(),
      output_hash: output === undefined ? undefined : digest(output),
      error_code: code,
      authority_effect: "none" as const,
    };
    events.push({
      event_id: stableId("workflow_event", eventCore),
      ...eventCore,
    });
  };

  const executeStage = async (
    stage: DecisionWorkflowStage,
    workflowStatus: DecisionWorkflowStatus | "running",
  ) => {
    appendEvent(stage, "stage_started");
    try {
      const output = await adapters[stage]({
        request,
        stage,
        company_id: request.company_id,
        decision_subject_id: request.decision_subject_id,
        decision_id: request.decision_id,
        run_id: request.run_id,
        idempotency_key: request.idempotency_key,
        as_of: request.requested_at ?? clock(),
        workflow_status: workflowStatus,
        workflow_gate: gate,
        artifacts: Object.freeze({ ...artifacts }),
      });
      assertCompanyScope(output, request.company_id, "artifacts." + stage);
      artifacts[stage] = output;
      appendEvent(stage, "stage_completed", output);
      return output;
    } catch (error) {
      const code = errorCode(error);
      appendEvent(stage, "stage_failed", undefined, code);
      throw { stage, code };
    }
  };

  try {
    for (const stage of DECISION_WORKFLOW_STAGES) {
      if (stage === "history") break;
      const output = await executeStage(stage, "running");
      if (stage === "constraints") {
        gate = normalizeGate(output);
        if (gate.state === "review_required") status = "review_required";
        if (gate.state === "abstain") status = "abstained";
        if (status !== "completed") break;
      }
      if (stage === "best_action") {
        const best = output as Record<string, unknown> | null;
        if (best?.status === "abstain") status = "abstained";
      }
    }
    await executeStage("history", status);
  } catch (error) {
    const failure = error as { stage?: DecisionWorkflowStage; code?: string };
    status = "failed";
    failedStage = failure.stage;
    failureCode = failure.code ?? "workflow_stage_error";
  }

  appendEvent("workflow", "run_completed", {
    status,
    gate,
    history_recorded: artifacts.history !== undefined,
  }, failureCode);

  return {
    status,
    request,
    workflow_gate: gate,
    artifacts,
    events,
    failed_stage: failedStage,
    error_code: failureCode,
    authority_effect: "none",
  };
}

export interface VerifiedOutcomeInput {
  company_id: string;
  historical_decision: unknown;
  outcome: unknown;
  prior_learning_state?: unknown;
}

export interface OutcomeVerification {
  status: "verified" | "rejected" | "review_required";
  verification_refs: string[];
  reason_codes?: string[];
}

export interface VerifiedOutcomeAdapters {
  verify(input: VerifiedOutcomeInput): OutcomeVerification | Promise<OutcomeVerification>;
  learn(input: {
    company_id: string;
    historical_decision: unknown;
    verified_outcome: unknown;
    prior_learning_state?: unknown;
  }): unknown | Promise<unknown>;
  appendLearningRevision(event: unknown): void | Promise<void>;
}

export async function recordVerifiedOutcome(
  input: VerifiedOutcomeInput,
  adapters: VerifiedOutcomeAdapters,
): Promise<{
  status: "learned" | "rejected" | "review_required";
  learning_event?: unknown;
  reason_codes?: string[];
  authority_effect: "none";
}> {
  if (!input.company_id) {
    throw new DecisionWorkflowError("company_id_required");
  }
  if (
    !input.historical_decision ||
    typeof input.historical_decision !== "object" ||
    !input.outcome ||
    typeof input.outcome !== "object"
  ) {
    throw new DecisionWorkflowError("decision_and_outcome_required");
  }
  assertCompanyScope(input.historical_decision, input.company_id, "historical_decision");
  assertCompanyScope(input.outcome, input.company_id, "outcome");
  const historical = input.historical_decision as Record<string, unknown>;
  const outcome = input.outcome as Record<string, unknown>;
  if (historical.company_id !== input.company_id || outcome.company_id !== input.company_id) {
    throw new DecisionWorkflowError("company_scope_required");
  }
  if (
    !historical.decision_subject_id ||
    historical.decision_subject_id !== outcome.decision_subject_id
  ) {
    throw new DecisionWorkflowError("decision_subject_mismatch");
  }

  const verification = await adapters.verify(input);
  if (
    !verification ||
    !["verified", "rejected", "review_required"].includes(verification.status) ||
    !Array.isArray(verification.verification_refs)
  ) {
    throw new DecisionWorkflowError("invalid_outcome_verification");
  }
  if (verification.status !== "verified") {
    return {
      status: verification.status,
      reason_codes: verification.reason_codes ?? ["outcome_not_verified"],
      authority_effect: "none",
    };
  }
  const references = [...new Set(verification.verification_refs)].filter(Boolean);
  if (references.length === 0) {
    return {
      status: "review_required",
      reason_codes: ["verification_references_missing"],
      authority_effect: "none",
    };
  }

  const verifiedOutcome = {
    ...outcome,
    company_id: input.company_id,
    verified: true,
    verification_refs: references,
  };
  const learningEvent = await adapters.learn({
    company_id: input.company_id,
    historical_decision: input.historical_decision,
    verified_outcome: verifiedOutcome,
    prior_learning_state: input.prior_learning_state,
  });
  assertCompanyScope(learningEvent, input.company_id, "learning_event");
  await adapters.appendLearningRevision(learningEvent);
  return {
    status: "learned",
    learning_event: learningEvent,
    authority_effect: "none",
  };
}

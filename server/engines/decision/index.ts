/*
 * Desk entry point for the Decision Engine (MIT, see NOTICE.md).
 *
 * Re-exports the engine's public API from src/ and adds bindDecisionEngine(),
 * which returns the step 26 decision function bound to one company and to
 * injected persistence. company_id is never read from the decision request.
 */

import {
  DECISION_WORKFLOW_STAGES,
  runDecisionWorkflow,
  type DecisionWorkflowAdapters,
  type DecisionWorkflowRequest,
  type DecisionWorkflowResult,
  type DecisionWorkflowStageContext,
} from "./src/engines/26-decision-workflow/runtime/decisionWorkflow.js";
import {
  appendDecisionHistory,
  type DecisionHistoryEntry,
} from "./src/engines/24-decision-history/runtime/decisionHistory.js";
import {
  DeskDecisionError,
  REFUSING_PERSISTENCE,
  type DeskDecisionDependencies,
  type DeskDecisionPersistence,
} from "./desk-adapter.js";

export * from "./src/index.js";
export * from "./desk-adapter.js";

/** Caller-supplied decision request. It has no company field: the company comes from the binding. */
export type DeskDecisionRequest = Omit<DecisionWorkflowRequest, "company_id">;

/** The decision function returned by bindDecisionEngine. */
export type DeskDecisionFunction = (request: unknown) => Promise<DecisionWorkflowResult>;

const COMPANY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const REQUEST_FIELDS = new Set([
  "decision_subject_id",
  "decision_id",
  "run_id",
  "idempotency_key",
  "trigger",
  "requested_at",
  "source_event_id",
  "input",
]);
/** Company or tenant fields are refused outright, never read. */
const SCOPE_FIELDS = new Set(["company_id", "tenant_id", "tenant_company_id"]);
const TRIGGERS = new Set(["manual", "event", "scheduled", "watch"]);
const IDENTITY_FIELDS = ["decision_subject_id", "decision_id", "run_id", "idempotency_key"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Refuses a missing, empty, or malformed company_id. */
export function validateCompanyId(companyId: unknown): string {
  if (typeof companyId !== "string" || companyId.trim() === "") {
    throw new DeskDecisionError("company_id_required");
  }
  if (!COMPANY_ID_PATTERN.test(companyId)) {
    throw new DeskDecisionError("company_id_invalid");
  }
  return companyId;
}

/**
 * Fails closed on anything unexpected. Returns a fresh object holding only known
 * fields, so no caller-supplied key reaches the core unchecked.
 */
export function validateDecisionRequest(raw: unknown): DeskDecisionRequest {
  if (!isPlainObject(raw)) throw new DeskDecisionError("invalid_request");
  for (const key of Object.keys(raw)) {
    if (SCOPE_FIELDS.has(key)) throw new DeskDecisionError("company_scope_not_accepted");
    if (!REQUEST_FIELDS.has(key)) throw new DeskDecisionError("unknown_request_field");
  }
  for (const field of IDENTITY_FIELDS) {
    const value = raw[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw new DeskDecisionError("invalid_request");
    }
  }
  if (typeof raw.trigger !== "string" || !TRIGGERS.has(raw.trigger)) {
    throw new DeskDecisionError("invalid_trigger");
  }
  if (raw.requested_at !== undefined) {
    if (typeof raw.requested_at !== "string" || Number.isNaN(Date.parse(raw.requested_at))) {
      throw new DeskDecisionError("invalid_requested_at");
    }
  }
  if (raw.source_event_id !== undefined && typeof raw.source_event_id !== "string") {
    throw new DeskDecisionError("invalid_request");
  }
  if (!isPlainObject(raw.input)) throw new DeskDecisionError("invalid_request");

  const request: DeskDecisionRequest = {
    decision_subject_id: raw.decision_subject_id as string,
    decision_id: raw.decision_id as string,
    run_id: raw.run_id as string,
    idempotency_key: raw.idempotency_key as string,
    trigger: raw.trigger as DeskDecisionRequest["trigger"],
    input: raw.input,
  };
  if (raw.requested_at !== undefined) request.requested_at = raw.requested_at as string;
  if (raw.source_event_id !== undefined) request.source_event_id = raw.source_event_id as string;
  return request;
}

function assertPersistenceInjected(persistence: DeskDecisionPersistence): void {
  if (
    persistence === REFUSING_PERSISTENCE ||
    typeof persistence?.loadLatestHistory !== "function" ||
    typeof persistence?.appendHistory !== "function"
  ) {
    throw new DeskDecisionError("persistence_not_injected");
  }
}

const defaultClock = () => new Date().toISOString();

/**
 * Binds the step 26 decision workflow to one company and to injected persistence.
 *
 * The returned function refuses before any stage runs when persistence is missing.
 * The history stage is owned by this adapter: it loads the prior revision for the
 * bound company, appends a hash-linked revision, and stores it through persistence.
 */
export function bindDecisionEngine(
  companyId: string,
  dependencies: DeskDecisionDependencies,
): DeskDecisionFunction {
  const boundCompanyId = validateCompanyId(companyId);
  const persistence = dependencies?.persistence ?? REFUSING_PERSISTENCE;
  const stages = dependencies?.stages;
  const clock = dependencies?.clock ?? defaultClock;

  for (const stage of DECISION_WORKFLOW_STAGES) {
    if (stage !== "history" && typeof stages?.[stage] !== "function") {
      throw new DeskDecisionError("stage_adapter_missing");
    }
  }

  const history = async (context: DecisionWorkflowStageContext): Promise<DecisionHistoryEntry> => {
    if (context.company_id !== boundCompanyId) {
      throw new DeskDecisionError("cross_company_history");
    }
    const prior = await persistence.loadLatestHistory(boundCompanyId, context.decision_id);
    const entry = appendDecisionHistory(
      boundCompanyId,
      context.decision_subject_id,
      context.decision_id,
      {
        run_id: context.run_id,
        workflow_status: context.workflow_status,
        workflow_gate: context.workflow_gate ?? null,
        artifacts: context.artifacts,
      },
      {
        prior: prior ?? undefined,
        recorded_at: context.as_of,
        reason: context.workflow_status,
      },
    );
    await persistence.appendHistory(boundCompanyId, entry);
    return entry;
  };

  const adapters = { ...stages, history } as DecisionWorkflowAdapters;

  return async function decide(request: unknown): Promise<DecisionWorkflowResult> {
    const validated = validateDecisionRequest(request);
    assertPersistenceInjected(persistence);
    return runDecisionWorkflow({ ...validated, company_id: boundCompanyId }, adapters, { clock });
  };
}

import { createHash } from "node:crypto";
import type { DecisionWatchCycleRequest } from "../../26-decision-workflow/runtime/decisionWatch.js";

export interface DecisionSignal {
  signal_id: string;
  company_id: string;
  decision_subject_id: string;
  occurred_at: string;
  changed_fields: string[];
}

export interface DecisionSignalWatchTarget {
  watch_id: string;
  company_id: string;
  decision_subject_id: string;
  status: "active" | "paused" | "closed";
  condition: { field: string };
}

export interface DecisionSignalWatchCycleRequest extends DecisionWatchCycleRequest {
  source_signal_id: string;
  source_occurred_at: string;
  idempotency_key: string;
  authority_effect: "none";
}

export interface DecisionSignalRoutingResult {
  state: "routed" | "no_match" | "review_required";
  signal_id: string;
  requests: DecisionSignalWatchCycleRequest[];
  reason_code?: "changed_fields_required";
  authority_effect: "none";
}

export class DecisionSignalRouterError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "DecisionSignalRouterError";
  }
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new DecisionSignalRouterError(code);
  }
  return value;
}

function validFieldPath(value: unknown, code: string): string {
  const field = requiredString(value, code);
  const parts = field.split(".");
  if (parts.some((part) => part.length === 0 || part === "*")) {
    throw new DecisionSignalRouterError(code);
  }
  return field;
}

function pathsOverlap(changedField: string, watchedField: string): boolean {
  return (
    changedField === watchedField ||
    changedField.startsWith(`${watchedField}.`) ||
    watchedField.startsWith(`${changedField}.`)
  );
}

function stableIdempotencyKey(
  companyId: string,
  signalId: string,
  watchId: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([companyId, signalId, watchId]))
    .digest("hex");
  return `signal_watch_${digest.slice(0, 32)}`;
}

function validateSignal(signal: DecisionSignal): void {
  if (!signal || typeof signal !== "object") {
    throw new DecisionSignalRouterError("signal_required");
  }
  requiredString(signal.signal_id, "signal_id_required");
  requiredString(signal.company_id, "company_id_required");
  requiredString(signal.decision_subject_id, "decision_subject_id_required");
  const occurredAt = requiredString(signal.occurred_at, "occurred_at_required");
  if (!Number.isFinite(Date.parse(occurredAt))) {
    throw new DecisionSignalRouterError("invalid_signal_timestamp");
  }
  if (!Array.isArray(signal.changed_fields)) {
    throw new DecisionSignalRouterError("changed_fields_must_be_array");
  }
}

/**
 * Maps a validated, payload-free source signal to affected active watch cycles.
 * It does not evaluate watches, invoke a queue, or persist deduplication state.
 */
export function routeDecisionSignal(
  signal: DecisionSignal,
  watches: DecisionSignalWatchTarget[],
): DecisionSignalRoutingResult {
  validateSignal(signal);
  if (!Array.isArray(watches)) {
    throw new DecisionSignalRouterError("watch_targets_must_be_array");
  }

  if (signal.changed_fields.length === 0) {
    return {
      state: "review_required",
      signal_id: signal.signal_id,
      requests: [],
      reason_code: "changed_fields_required",
      authority_effect: "none",
    };
  }

  const changedFields = new Set(
    signal.changed_fields.map((field) =>
      validFieldPath(field, "invalid_changed_field"),
    ),
  );

  const scopedCandidates = new Map<
    string,
    { status: DecisionSignalWatchTarget["status"]; field?: string }
  >();

  for (const target of watches) {
    if (
      !target ||
      target.company_id !== signal.company_id ||
      target.decision_subject_id !== signal.decision_subject_id
    ) {
      continue;
    }
    const watchId = requiredString(target.watch_id, "watch_id_required");
    if (!["active", "paused", "closed"].includes(target.status)) {
      throw new DecisionSignalRouterError("invalid_watch_status");
    }
    const field = target.status === "active"
      ? validFieldPath(target.condition?.field, "invalid_watch_field")
      : undefined;
    const previous = scopedCandidates.get(watchId);
    if (
      previous &&
      (previous.status !== target.status || previous.field !== field)
    ) {
      throw new DecisionSignalRouterError("conflicting_watch_target");
    }
    scopedCandidates.set(watchId, { status: target.status, field });
  }

  const matchingWatchIds = [...scopedCandidates.entries()]
    .filter(([_, candidate]) =>
      candidate.status === "active" &&
      [...changedFields].some((changed) => pathsOverlap(changed, candidate.field!)),
    )
    .map(([watchId]) => watchId)
    .sort();

  const requests = matchingWatchIds.map((watchId) => ({
    company_id: signal.company_id,
    watch_id: watchId,
    trigger: "event" as const,
    source_signal_id: signal.signal_id,
    source_occurred_at: signal.occurred_at,
    idempotency_key: stableIdempotencyKey(
      signal.company_id,
      signal.signal_id,
      watchId,
    ),
    authority_effect: "none" as const,
  }));

  return {
    state: requests.length > 0 ? "routed" : "no_match",
    signal_id: signal.signal_id,
    requests,
    authority_effect: "none",
  };
}

import { createHash } from "node:crypto";

export type DecisionWatchOperator =
  | "changed"
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "not_contains"
  | "exists"
  | "not_exists";

export interface DecisionWatch {
  watch_id: string;
  company_id: string;
  decision_subject_id: string;
  status: "active" | "paused" | "closed";
  condition: {
    field: string;
    operator: DecisionWatchOperator;
    expected?: unknown;
    max_age_seconds?: number;
  };
  created_at: string;
  expires_at?: string | null;
  last_triggered_at?: string | null;
  next_evaluation_at?: string | null;
  interval_seconds?: number | null;
  cooldown_seconds?: number;
}

export interface DecisionWatchEvidence {
  evidence_id: string;
  company_id: string;
  field: string;
  freshness_state: "fresh" | "stale" | "expired" | "unknown";
  observed_at?: string | null;
}

export interface DecisionWatchSnapshot {
  company_id: string;
  decision_subject_id: string;
  snapshot_id?: string;
  values: Record<string, unknown>;
  evidence: DecisionWatchEvidence[];
}

export interface DecisionWatchEvaluation {
  state:
    | "trigger_requested"
    | "no_match"
    | "unknown"
    | "inactive"
    | "expired"
    | "not_due"
    | "cooldown";
  watch_id: string;
  company_id: string;
  decision_subject_id: string;
  evaluated_at: string;
  reason_code?: string;
  trigger_request?: {
    trigger_id: string;
    action: "rerun_decision";
    source: "condition_met" | "scheduled_check";
    evidence_refs: string[];
    current_value_hash: string;
    authority_effect: "none";
  };
  watch_update: {
    last_evaluated_at: string;
    last_triggered_at?: string;
    next_evaluation_at?: string;
  };
  authority_effect: "none";
}

export interface DecisionWatchStoredRecord {
  watch: DecisionWatch;
  revision: number;
}

export interface DecisionWatchSnapshotPair {
  current: DecisionWatchSnapshot;
  previous?: DecisionWatchSnapshot;
}

export interface DecisionWatchCommit {
  company_id: string;
  watch_id: string;
  expected_revision: number;
  evaluation: DecisionWatchEvaluation;
  outbox_trigger?: DecisionWatchEvaluation["trigger_request"];
}

export type DecisionWatchCommitStatus = "stored" | "duplicate" | "conflict";

export interface DecisionWatchCycleStore {
  loadWatch(
    company_id: string,
    watch_id: string,
  ): DecisionWatchStoredRecord | Promise<DecisionWatchStoredRecord>;
  loadSnapshots(
    watch: DecisionWatch,
  ): DecisionWatchSnapshotPair | Promise<DecisionWatchSnapshotPair>;
  commitEvaluation(
    input: DecisionWatchCommit,
  ): DecisionWatchCommitStatus | Promise<DecisionWatchCommitStatus>;
}

export interface DecisionWatchCycleRequest {
  company_id: string;
  watch_id: string;
  trigger: "event" | "scheduled";
  now?: string;
}

export interface DecisionWatchCycleResult {
  evaluation: DecisionWatchEvaluation;
  commit_status: DecisionWatchCommitStatus;
  rerun_request_committed: boolean;
  authority_effect: "none";
}

export class DecisionWatchError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "DecisionWatchError";
  }
}

const operators = new Set<DecisionWatchOperator>([
  "changed",
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "not_contains",
  "exists",
  "not_exists",
]);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(canonical(value)) ?? "null";
  } catch {
    throw new DecisionWatchError("non_serializable_snapshot");
  }
  return createHash("sha256").update(serialized).digest("hex");
}

function getPath(
  source: Record<string, unknown>,
  path: string,
): { found: boolean; value?: unknown } {
  let value: unknown = source;
  for (const part of path.split(".")) {
    if (!value || typeof value !== "object" || !(part in value)) {
      return { found: false };
    }
    value = (value as Record<string, unknown>)[part];
  }
  return { found: true, value };
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function evaluateCondition(
  watch: DecisionWatch,
  current: DecisionWatchSnapshot,
  previous?: DecisionWatchSnapshot,
): boolean | null {
  const { field, operator, expected } = watch.condition;
  const actual = getPath(current.values, field);
  const prior = previous ? getPath(previous.values, field) : { found: false };

  if (operator === "exists") {
    return actual.found && actual.value !== null && actual.value !== undefined;
  }
  if (operator === "not_exists") {
    return !actual.found || actual.value === null || actual.value === undefined;
  }
  if (operator === "changed") {
    if (!actual.found || !prior.found) return null;
    return !same(actual.value, prior.value);
  }
  if (!actual.found || actual.value === null || actual.value === undefined) {
    return null;
  }

  if (operator === "eq") return same(actual.value, expected);
  if (operator === "neq") return !same(actual.value, expected);
  if (operator === "gt" || operator === "gte" || operator === "lt" || operator === "lte") {
    const a = Number(actual.value);
    const b = Number(expected);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    if (operator === "gt") return a > b;
    if (operator === "gte") return a >= b;
    if (operator === "lt") return a < b;
    return a <= b;
  }
  if (operator === "contains" || operator === "not_contains") {
    let contains: boolean | null = null;
    if (typeof actual.value === "string" && typeof expected === "string") {
      contains = actual.value.includes(expected);
    } else if (Array.isArray(actual.value)) {
      contains = actual.value.some((item) => same(item, expected));
    }
    return contains === null
      ? null
      : operator === "contains"
        ? contains
        : !contains;
  }
  return null;
}

function assertInputScope(
  watch: DecisionWatch,
  current: DecisionWatchSnapshot,
  previous?: DecisionWatchSnapshot,
): void {
  if (!watch.company_id) throw new DecisionWatchError("company_id_required");
  if (!watch.watch_id || !watch.decision_subject_id) {
    throw new DecisionWatchError("watch_identity_required");
  }
  if (!watch.condition?.field || !operators.has(watch.condition.operator)) {
    throw new DecisionWatchError("invalid_watch_condition");
  }
  if (!["active", "paused", "closed"].includes(watch.status)) {
    throw new DecisionWatchError("invalid_watch_status");
  }
  if (!current.values || typeof current.values !== "object") {
    throw new DecisionWatchError("snapshot_values_required");
  }
  if (current.company_id !== watch.company_id) {
    throw new DecisionWatchError("cross_company_snapshot");
  }
  if (current.decision_subject_id !== watch.decision_subject_id) {
    throw new DecisionWatchError("decision_subject_mismatch");
  }
  if (previous && previous.company_id !== watch.company_id) {
    throw new DecisionWatchError("cross_company_previous_snapshot");
  }
  if (
    previous &&
    previous.decision_subject_id !== watch.decision_subject_id
  ) {
    throw new DecisionWatchError("previous_subject_mismatch");
  }
  for (const evidence of current.evidence ?? []) {
    if (evidence.company_id !== watch.company_id) {
      throw new DecisionWatchError("cross_company_evidence");
    }
    if (
      evidence.observed_at != null &&
      !Number.isFinite(Date.parse(evidence.observed_at))
    ) {
      throw new DecisionWatchError("invalid_evidence_timestamp");
    }
  }
  if (
    watch.condition.max_age_seconds != null &&
    (!Number.isFinite(watch.condition.max_age_seconds) ||
      watch.condition.max_age_seconds < 0)
  ) {
    throw new DecisionWatchError("invalid_max_age");
  }
  if (
    watch.interval_seconds != null &&
    (!Number.isFinite(watch.interval_seconds) || watch.interval_seconds <= 0)
  ) {
    throw new DecisionWatchError("invalid_watch_interval");
  }
}

function result(
  watch: DecisionWatch,
  evaluatedAt: string,
  state: DecisionWatchEvaluation["state"],
  reasonCode?: string,
  update: Partial<DecisionWatchEvaluation["watch_update"]> = {},
  triggerRequest?: DecisionWatchEvaluation["trigger_request"],
): DecisionWatchEvaluation {
  return {
    state,
    watch_id: watch.watch_id,
    company_id: watch.company_id,
    decision_subject_id: watch.decision_subject_id,
    evaluated_at: evaluatedAt,
    reason_code: reasonCode,
    trigger_request: triggerRequest,
    watch_update: {
      last_evaluated_at: evaluatedAt,
      ...update,
    },
    authority_effect: "none",
  };
}

export function evaluateDecisionWatch(
  watch: DecisionWatch,
  current: DecisionWatchSnapshot,
  options: {
    trigger: "event" | "scheduled";
    previous?: DecisionWatchSnapshot;
    now?: string;
  },
): DecisionWatchEvaluation {
  assertInputScope(watch, current, options.previous);
  const now = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new DecisionWatchError("invalid_evaluation_time");
  if (!["event", "scheduled"].includes(options.trigger)) {
    throw new DecisionWatchError("invalid_watch_trigger");
  }

  if (watch.status !== "active") {
    return result(watch, now, "inactive", "watch_not_active");
  }
  if (watch.expires_at) {
    const expiresMs = Date.parse(watch.expires_at);
    if (!Number.isFinite(expiresMs)) {
      throw new DecisionWatchError("invalid_watch_expiry");
    }
    if (expiresMs <= nowMs) return result(watch, now, "expired", "watch_expired");
  }
  if (
    options.trigger === "scheduled" &&
    watch.next_evaluation_at
  ) {
    const nextMs = Date.parse(watch.next_evaluation_at);
    if (!Number.isFinite(nextMs)) {
      throw new DecisionWatchError("invalid_next_evaluation_time");
    }
    if (nextMs > nowMs) {
      return result(watch, now, "not_due", "scheduled_check_not_due");
    }
  }
  const scheduledUpdate =
    options.trigger === "scheduled" && watch.interval_seconds
      ? {
          next_evaluation_at: new Date(
            nowMs + watch.interval_seconds * 1000,
          ).toISOString(),
        }
      : {};

  const lastTriggeredMs = watch.last_triggered_at
    ? Date.parse(watch.last_triggered_at)
    : Number.NaN;
  if (watch.last_triggered_at && !Number.isFinite(lastTriggeredMs)) {
    throw new DecisionWatchError("invalid_last_triggered_at");
  }
  const cooldown = Number(watch.cooldown_seconds ?? 0);
  if (!Number.isFinite(cooldown) || cooldown < 0) {
    throw new DecisionWatchError("invalid_watch_cooldown");
  }
  if (
    Number.isFinite(lastTriggeredMs) &&
    cooldown > 0 &&
    nowMs - lastTriggeredMs < cooldown * 1000
  ) {
    return result(
      watch,
      now,
      "cooldown",
      "watch_cooldown_active",
      scheduledUpdate,
    );
  }

  const evidence = (current.evidence ?? []).filter(
    (item) => item.field === watch.condition.field,
  );
  const freshEvidence = evidence.filter((item) => {
    if (item.freshness_state !== "fresh") return false;
    if (watch.condition.max_age_seconds != null) {
      if (!item.observed_at) return false;
      const observedMs = Date.parse(item.observed_at);
      if (
        !Number.isFinite(observedMs) ||
        observedMs > nowMs ||
        nowMs - observedMs > watch.condition.max_age_seconds * 1000
      ) return false;
    }
    return true;
  });
  if (freshEvidence.length === 0) {
    return result(
      watch,
      now,
      "unknown",
      "fresh_evidence_required",
      scheduledUpdate,
    );
  }

  const matched = evaluateCondition(watch, current, options.previous);
  if (matched === null) {
    return result(
      watch,
      now,
      "unknown",
      "condition_value_unknown",
      scheduledUpdate,
    );
  }
  const update = {
    ...scheduledUpdate,
    ...(matched ? { last_triggered_at: now } : {}),
  };
  if (!matched) {
    return result(watch, now, "no_match", undefined, update);
  }

  const value = getPath(current.values, watch.condition.field);
  const valueHash = digest(value);
  const triggerCore = {
    watch_id: watch.watch_id,
    snapshot_id: current.snapshot_id ?? digest(current.values),
    evidence_ids: freshEvidence.map((item) => item.evidence_id).sort(),
    operator: watch.condition.operator,
    value_hash: valueHash,
  };
  const triggerRequest = {
    trigger_id:
      "watch_trigger_" +
      createHash("sha256")
        .update(JSON.stringify(triggerCore))
        .digest("hex")
        .slice(0, 24),
    action: "rerun_decision" as const,
    source: options.trigger === "scheduled" ? "scheduled_check" as const : "condition_met" as const,
    evidence_refs: freshEvidence.map((item) => item.evidence_id),
    current_value_hash: valueHash,
    authority_effect: "none" as const,
  };
  return result(watch, now, "trigger_requested", undefined, update, triggerRequest);
}

export async function runDecisionWatchCycle(
  request: DecisionWatchCycleRequest,
  store: DecisionWatchCycleStore,
): Promise<DecisionWatchCycleResult> {
  if (!request.company_id) throw new DecisionWatchError("company_id_required");
  if (!request.watch_id) throw new DecisionWatchError("watch_id_required");

  const stored = await store.loadWatch(request.company_id, request.watch_id);
  if (
    stored.watch.company_id !== request.company_id ||
    stored.watch.watch_id !== request.watch_id
  ) {
    throw new DecisionWatchError("watch_store_scope_mismatch");
  }
  if (!Number.isInteger(stored.revision) || stored.revision < 0) {
    throw new DecisionWatchError("invalid_watch_revision");
  }

  const snapshots = await store.loadSnapshots(stored.watch);
  const evaluation = evaluateDecisionWatch(stored.watch, snapshots.current, {
    trigger: request.trigger,
    previous: snapshots.previous,
    now: request.now,
  });
  const commitStatus = await store.commitEvaluation({
    company_id: request.company_id,
    watch_id: request.watch_id,
    expected_revision: stored.revision,
    evaluation,
    outbox_trigger: evaluation.trigger_request,
  });
  if (!["stored", "duplicate", "conflict"].includes(commitStatus)) {
    throw new DecisionWatchError("invalid_watch_commit_status");
  }
  return {
    evaluation,
    commit_status: commitStatus,
    rerun_request_committed:
      evaluation.trigger_request !== undefined && commitStatus !== "conflict",
    authority_effect: "none",
  };
}

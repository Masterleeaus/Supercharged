import { createHash } from "node:crypto";
import type {
  DecisionWatch,
  DecisionWatchOperator,
  DecisionWatchStoredRecord,
} from "../../26-decision-workflow/runtime/decisionWatch.js";

type WatchCondition = DecisionWatch["condition"];
type WatchStatus = DecisionWatch["status"];

interface WatchCommandBase {
  command_id: string;
  company_id: string;
  watch_id: string;
  now: string;
}

export interface CreateDecisionWatchCommand extends WatchCommandBase {
  operation: "create";
  decision_subject_id: string;
  condition: WatchCondition;
  expires_at?: string | null;
  interval_seconds?: number | null;
  cooldown_seconds?: number;
}

export interface UpdateDecisionWatchCommand extends WatchCommandBase {
  operation: "update";
  expected_revision: number;
  patch: {
    condition?: WatchCondition;
    expires_at?: string | null;
    interval_seconds?: number | null;
    cooldown_seconds?: number;
  };
}

export interface TransitionDecisionWatchCommand extends WatchCommandBase {
  operation: "pause" | "resume" | "close";
  expected_revision: number;
}

export type DecisionWatchLifecycleCommand =
  | CreateDecisionWatchCommand
  | UpdateDecisionWatchCommand
  | TransitionDecisionWatchCommand;

export interface DecisionWatchLifecycleEvent {
  event_id: string;
  command_id: string;
  company_id: string;
  decision_subject_id: string;
  watch_id: string;
  transition: "created" | "updated" | "paused" | "resumed" | "closed";
  occurred_at: string;
  from_revision: number | null;
  to_revision: number;
  from_status: WatchStatus | null;
  to_status: WatchStatus;
  changed_fields: string[];
  authority_effect: "none";
}

export interface DecisionWatchLifecyclePlan {
  state: "planned" | "unchanged";
  command_id: string;
  company_id: string;
  watch_id: string;
  expected_revision: number | null;
  resulting_revision: number;
  watch: DecisionWatch;
  event: DecisionWatchLifecycleEvent | null;
  authority_effect: "none";
}

export interface DecisionWatchLifecycleCommit {
  command_id: string;
  command_fingerprint: string;
  company_id: string;
  watch_id: string;
  expected_revision: number | null;
  resulting_revision: number;
  plan: DecisionWatchLifecyclePlan;
}

export interface DecisionWatchLifecycleReceipt {
  command_fingerprint: string;
  plan: DecisionWatchLifecyclePlan;
}

export type DecisionWatchLifecycleCommitStatus =
  | "stored"
  | "duplicate"
  | "conflict"
  | "unchanged";

export interface DecisionWatchLifecycleStore {
  loadLifecycleCommandReceipt(
    company_id: string,
    command_id: string,
  ): DecisionWatchLifecycleReceipt | null | Promise<DecisionWatchLifecycleReceipt | null>;
  loadWatchForLifecycle(
    company_id: string,
    watch_id: string,
  ): DecisionWatchStoredRecord | null | Promise<DecisionWatchStoredRecord | null>;
  commitLifecycleTransition(
    input: DecisionWatchLifecycleCommit,
  ): DecisionWatchLifecycleCommitStatus | Promise<DecisionWatchLifecycleCommitStatus>;
}

export interface DecisionWatchLifecycleResult {
  plan: DecisionWatchLifecyclePlan;
  commit_status: DecisionWatchLifecycleCommitStatus;
  authority_effect: "none";
}

export class DecisionWatchLifecycleError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "DecisionWatchLifecycleError";
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

function requiredString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new DecisionWatchLifecycleError(code);
  }
  return value;
}

function validTime(value: unknown, code: string): string {
  const time = requiredString(value, code);
  if (!Number.isFinite(Date.parse(time))) {
    throw new DecisionWatchLifecycleError(code);
  }
  return time;
}

function validFieldPath(value: unknown): string {
  const field = requiredString(value, "invalid_watch_field");
  if (field.split(".").some((part) => part.length === 0 || part === "*")) {
    throw new DecisionWatchLifecycleError("invalid_watch_field");
  }
  return field;
}

function cloneJsonValue(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new DecisionWatchLifecycleError("watch_value_too_deep");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => cloneJsonValue(item, depth + 1));
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DecisionWatchLifecycleError("watch_value_not_json");
    }
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = cloneJsonValue(item, depth + 1);
    }
    return result;
  }
  throw new DecisionWatchLifecycleError("watch_value_not_json");
}

function copyCondition(value: unknown): WatchCondition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DecisionWatchLifecycleError("invalid_watch_condition");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["field", "operator", "expected", "max_age_seconds"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new DecisionWatchLifecycleError("invalid_watch_condition");
  }
  const field = validFieldPath(input.field);
  if (typeof input.operator !== "string" || !operators.has(input.operator as DecisionWatchOperator)) {
    throw new DecisionWatchLifecycleError("invalid_watch_operator");
  }
  const expectedRequired = new Set<DecisionWatchOperator>([
    "eq", "neq", "gt", "gte", "lt", "lte", "contains", "not_contains",
  ]);
  const hasExpected = Object.prototype.hasOwnProperty.call(input, "expected");
  if (expectedRequired.has(input.operator as DecisionWatchOperator) && !hasExpected) {
    throw new DecisionWatchLifecycleError("watch_expected_value_required");
  }
  let maxAge: number | undefined;
  if (input.max_age_seconds !== undefined) {
    if (!Number.isFinite(input.max_age_seconds) || (input.max_age_seconds as number) < 0) {
      throw new DecisionWatchLifecycleError("invalid_watch_max_age");
    }
    maxAge = input.max_age_seconds as number;
  }
  return {
    field,
    operator: input.operator as DecisionWatchOperator,
    ...(hasExpected ? { expected: cloneJsonValue(input.expected) } : {}),
    ...(maxAge !== undefined ? { max_age_seconds: maxAge } : {}),
  };
}

function validExpiry(value: string | null | undefined, now: string): string | null {
  if (value == null) return null;
  const expiry = validTime(value, "invalid_watch_expiry");
  if (Date.parse(expiry) <= Date.parse(now)) {
    throw new DecisionWatchLifecycleError("watch_expiry_must_be_future");
  }
  return expiry;
}

function validInterval(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value <= 0) {
    throw new DecisionWatchLifecycleError("invalid_watch_interval");
  }
  return value;
}

function validCooldown(value: number | undefined): number {
  const cooldown = value ?? 0;
  if (!Number.isFinite(cooldown) || cooldown < 0) {
    throw new DecisionWatchLifecycleError("invalid_watch_cooldown");
  }
  return cooldown;
}

function validateBase(command: DecisionWatchLifecycleCommand): void {
  if (!command || typeof command !== "object") {
    throw new DecisionWatchLifecycleError("command_required");
  }
  requiredString(command.command_id, "command_id_required");
  requiredString(command.company_id, "company_id_required");
  requiredString(command.watch_id, "watch_id_required");
  validTime(command.now, "invalid_command_time");
  if (!["create", "update", "pause", "resume", "close"].includes(command.operation)) {
    throw new DecisionWatchLifecycleError("invalid_lifecycle_operation");
  }
  const allowed = command.operation === "create"
    ? new Set(["operation", "command_id", "company_id", "watch_id", "now", "decision_subject_id", "condition", "expires_at", "interval_seconds", "cooldown_seconds"])
    : command.operation === "update"
      ? new Set(["operation", "command_id", "company_id", "watch_id", "now", "expected_revision", "patch"])
      : new Set(["operation", "command_id", "company_id", "watch_id", "now", "expected_revision"]);
  if (Object.keys(command).some((key) => !allowed.has(key))) {
    throw new DecisionWatchLifecycleError("invalid_lifecycle_command");
  }
  if (command.operation !== "create" &&
      (!Number.isInteger(command.expected_revision) || command.expected_revision < 0)) {
    throw new DecisionWatchLifecycleError("invalid_expected_revision");
  }
}

function eventId(companyId: string, watchId: string, commandId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([companyId, watchId, commandId]))
    .digest("hex");
  return `watch_lifecycle_${digest.slice(0, 32)}`;
}

function commandFingerprint(command: DecisionWatchLifecycleCommand): string {
  return createHash("sha256").update(stableValue(cloneJsonValue(command))).digest("hex");
}

function makeEvent(
  command: DecisionWatchLifecycleCommand,
  watch: DecisionWatch,
  transition: DecisionWatchLifecycleEvent["transition"],
  fromRevision: number | null,
  toRevision: number,
  fromStatus: WatchStatus | null,
  changedFields: string[],
): DecisionWatchLifecycleEvent {
  return {
    event_id: eventId(command.company_id, command.watch_id, command.command_id),
    command_id: command.command_id,
    company_id: command.company_id,
    decision_subject_id: watch.decision_subject_id,
    watch_id: command.watch_id,
    transition,
    occurred_at: command.now,
    from_revision: fromRevision,
    to_revision: toRevision,
    from_status: fromStatus,
    to_status: watch.status,
    changed_fields: [...changedFields].sort(),
    authority_effect: "none",
  };
}

function resultPlan(
  command: DecisionWatchLifecycleCommand,
  watch: DecisionWatch,
  expectedRevision: number | null,
  resultingRevision: number,
  state: DecisionWatchLifecyclePlan["state"],
  event: DecisionWatchLifecycleEvent | null,
): DecisionWatchLifecyclePlan {
  return {
    state,
    command_id: command.command_id,
    company_id: command.company_id,
    watch_id: command.watch_id,
    expected_revision: expectedRevision,
    resulting_revision: resultingRevision,
    watch,
    event,
    authority_effect: "none",
  };
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function assertStoredWatch(record: DecisionWatchStoredRecord, command: WatchCommandBase): DecisionWatch {
  if (
    record.watch.company_id !== command.company_id ||
    record.watch.watch_id !== command.watch_id
  ) throw new DecisionWatchLifecycleError("watch_store_scope_mismatch");
  if (!Number.isInteger(record.revision) || record.revision < 0) {
    throw new DecisionWatchLifecycleError("invalid_stored_revision");
  }
  const watch = record.watch;
  requiredString(watch.decision_subject_id, "decision_subject_id_required");
  if (!["active", "paused", "closed"].includes(watch.status)) {
    throw new DecisionWatchLifecycleError("invalid_watch_status");
  }
  requiredString(watch.created_at, "invalid_watch_created_at");
  validTime(watch.created_at, "invalid_watch_created_at");
  const condition = copyCondition(watch.condition);
  validInterval(watch.interval_seconds);
  validCooldown(watch.cooldown_seconds);
  if (watch.expires_at != null) validTime(watch.expires_at, "invalid_watch_expiry");
  if (watch.last_triggered_at != null) validTime(watch.last_triggered_at, "invalid_last_triggered_at");
  if (watch.next_evaluation_at != null) validTime(watch.next_evaluation_at, "invalid_next_evaluation_at");
  return { ...watch, condition };
}

export function planDecisionWatchLifecycle(
  command: DecisionWatchLifecycleCommand,
  current?: DecisionWatchStoredRecord | null,
): DecisionWatchLifecyclePlan {
  validateBase(command);
  const now = command.now;

  if (command.operation === "create") {
    if (command.company_id.length === 0) {
      throw new DecisionWatchLifecycleError("company_id_required");
    }
    requiredString(command.decision_subject_id, "decision_subject_id_required");
    const watch: DecisionWatch = {
      watch_id: command.watch_id,
      company_id: command.company_id,
      decision_subject_id: command.decision_subject_id,
      status: "active",
      condition: copyCondition(command.condition),
      created_at: now,
      expires_at: validExpiry(command.expires_at, now),
      next_evaluation_at: null,
      last_triggered_at: null,
      interval_seconds: validInterval(command.interval_seconds),
      cooldown_seconds: validCooldown(command.cooldown_seconds),
    };
    const event = makeEvent(command, watch, "created", null, 0, null, ["watch"]);
    return resultPlan(command, watch, null, 0, "planned", event);
  }

  if (!current) throw new DecisionWatchLifecycleError("watch_not_found");
  const prior = assertStoredWatch(current, command);
  const expectedRevision = command.expected_revision;

  if (command.operation === "update") {
    if (prior.status === "closed") {
      throw new DecisionWatchLifecycleError("closed_watch_terminal");
    }
    if (!command.patch || typeof command.patch !== "object") {
      throw new DecisionWatchLifecycleError("watch_patch_required");
    }
    const keys = Object.keys(command.patch);
    const allowed = new Set(["condition", "expires_at", "interval_seconds", "cooldown_seconds"]);
    if (keys.length === 0 || keys.some((key) => !allowed.has(key))) {
      throw new DecisionWatchLifecycleError("invalid_watch_patch");
    }
    const next = { ...prior };
    const changedFields: string[] = [];
    let conditionChanged = false;
    let intervalChanged = false;
    if (Object.prototype.hasOwnProperty.call(command.patch, "condition")) {
      const condition = copyCondition(command.patch.condition);
      if (stableValue(condition) !== stableValue(prior.condition)) {
        next.condition = condition;
        conditionChanged = true;
        changedFields.push("condition");
      }
    }
    if (Object.prototype.hasOwnProperty.call(command.patch, "expires_at")) {
      const expiry = validExpiry(command.patch.expires_at, now);
      const previous = prior.expires_at ?? null;
      if (expiry !== previous) {
        next.expires_at = expiry;
        changedFields.push("expires_at");
      }
    }
    if (Object.prototype.hasOwnProperty.call(command.patch, "interval_seconds")) {
      const interval = validInterval(command.patch.interval_seconds);
      const previous = prior.interval_seconds ?? null;
      if (interval !== previous) {
        next.interval_seconds = interval;
        intervalChanged = true;
        changedFields.push("interval_seconds");
      }
    }
    if (Object.prototype.hasOwnProperty.call(command.patch, "cooldown_seconds")) {
      const cooldown = validCooldown(command.patch.cooldown_seconds);
      const previous = prior.cooldown_seconds ?? 0;
      if (cooldown !== previous) {
        next.cooldown_seconds = cooldown;
        changedFields.push("cooldown_seconds");
      }
    }
    if (conditionChanged || intervalChanged) {
      if (prior.next_evaluation_at != null) next.next_evaluation_at = null;
    }
    if (conditionChanged && prior.last_triggered_at != null) next.last_triggered_at = null;
    if (changedFields.length === 0) {
      return resultPlan(command, prior, expectedRevision, expectedRevision, "unchanged", null);
    }
    if ((conditionChanged || intervalChanged) && prior.next_evaluation_at != null) {
      changedFields.push("next_evaluation_at");
    }
    if (conditionChanged && prior.last_triggered_at != null) {
      changedFields.push("last_triggered_at");
    }
    const event = makeEvent(
      command, next, "updated", expectedRevision, expectedRevision + 1, prior.status, changedFields,
    );
    return resultPlan(command, next, expectedRevision, expectedRevision + 1, "planned", event);
  }

  const transitions: Record<"pause" | "resume" | "close", {
    allowed: WatchStatus[];
    status: WatchStatus;
    transition: DecisionWatchLifecycleEvent["transition"];
  }> = {
    pause: { allowed: ["active"], status: "paused", transition: "paused" },
    resume: { allowed: ["paused"], status: "active", transition: "resumed" },
    close: { allowed: ["active", "paused"], status: "closed", transition: "closed" },
  };
  const rule = transitions[command.operation];
  if (prior.status === rule.status) {
    return resultPlan(command, prior, expectedRevision, expectedRevision, "unchanged", null);
  }
  if (!rule.allowed.includes(prior.status)) {
    throw new DecisionWatchLifecycleError(
      prior.status === "closed" ? "closed_watch_terminal" : "invalid_watch_transition",
    );
  }
  if (command.operation === "resume" && prior.expires_at && Date.parse(prior.expires_at) <= Date.parse(now)) {
    throw new DecisionWatchLifecycleError("watch_expired");
  }
  const next: DecisionWatch = {
    ...prior,
    status: rule.status,
    next_evaluation_at: prior.next_evaluation_at == null ? prior.next_evaluation_at : null,
  };
  const changedFields = ["status"];
  if (prior.next_evaluation_at != null) changedFields.push("next_evaluation_at");
  const event = makeEvent(
    command, next, rule.transition, expectedRevision, expectedRevision + 1, prior.status,
    changedFields,
  );
  return resultPlan(command, next, expectedRevision, expectedRevision + 1, "planned", event);
}

export async function runDecisionWatchLifecycleCommand(
  command: DecisionWatchLifecycleCommand,
  store: DecisionWatchLifecycleStore,
): Promise<DecisionWatchLifecycleResult> {
  validateBase(command);
  const fingerprint = commandFingerprint(command);
  const receipt = await store.loadLifecycleCommandReceipt(command.company_id, command.command_id);
  if (receipt) {
    return {
      plan: receipt.plan,
      commit_status: receipt.command_fingerprint === fingerprint ? "duplicate" : "conflict",
      authority_effect: "none",
    };
  }
  const current = await store.loadWatchForLifecycle(command.company_id, command.watch_id);
  if (command.operation !== "create" && !current) {
    throw new DecisionWatchLifecycleError("watch_not_found");
  }
  const plan = planDecisionWatchLifecycle(command, current);
  const commitStatus = await store.commitLifecycleTransition({
    command_id: command.command_id,
    command_fingerprint: fingerprint,
    company_id: command.company_id,
    watch_id: command.watch_id,
    expected_revision: plan.expected_revision,
    resulting_revision: plan.resulting_revision,
    plan,
  });
  if (!["stored", "duplicate", "conflict", "unchanged"].includes(commitStatus)) {
    throw new DecisionWatchLifecycleError("invalid_lifecycle_commit_status");
  }
  return { plan, commit_status: commitStatus, authority_effect: "none" };
}

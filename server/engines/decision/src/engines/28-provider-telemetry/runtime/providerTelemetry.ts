import { createHash } from "node:crypto";

export type ProviderOutcome = "success" | "partial" | "failure";
export type ProviderFreshness = "fresh" | "mixed" | "stale" | "unknown";
export type ProviderFailureClass =
  | "timeout"
  | "rate_limited"
  | "unavailable"
  | "invalid_response"
  | "contract_violation"
  | "unknown";

export interface ProviderExecutionObservation {
  observation_id: string;
  invocation_id: string;
  company_id: string;
  provider_id: string;
  operation_id: string;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  outcome: ProviderOutcome;
  record_count: number;
  freshness_state: ProviderFreshness;
  failure_class?: ProviderFailureClass;
  authority_effect: "none";
}

export type ProviderCallCapture<T> =
  | { ok: true; value: T; observation: ProviderExecutionObservation }
  | { ok: false; error: unknown; observation: ProviderExecutionObservation };

export interface ProviderResultSummary {
  record_count?: number;
  partial?: boolean;
  freshness_state?: ProviderFreshness;
}

export interface CaptureProviderCallOptions<T> {
  clock?: () => string;
  epoch_ms?: () => number;
  summarize_result?: (value: T) => ProviderResultSummary;
  classify_error?: (error: unknown) => ProviderFailureClass;
}

export interface CaptureProviderCallInput {
  company_id: string;
  provider_id: string;
  operation_id: string;
  invocation_id: string;
}

export interface ProviderReliabilityOptions {
  as_of?: string;
  window_seconds?: number;
  minimum_samples?: number;
  degraded_failure_rate?: number;
  minimum_success_rate?: number;
  maximum_p95_latency_ms?: number;
  maximum_stale_rate?: number;
}

export interface ProviderReliabilitySnapshot {
  snapshot_id: string;
  company_id: string;
  provider_id: string;
  window_start: string;
  window_end: string;
  generated_at: string;
  health: "healthy" | "degraded" | "unavailable" | "insufficient_data";
  sample_count: number;
  success_count: number;
  partial_count: number;
  failure_count: number;
  success_rate: number | null;
  failure_rate: number | null;
  stale_count: number;
  mixed_freshness_count: number;
  unknown_freshness_count: number;
  stale_rate: number | null;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  failure_class_counts: Partial<Record<ProviderFailureClass, number>>;
  authority_effect: "none";
}

export class ProviderTelemetryError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "ProviderTelemetryError";
  }
}

const DEFAULT_CLOCK = () => new Date().toISOString();
const DEFAULT_EPOCH_MS = () => Date.now();
const failureClasses = new Set<ProviderFailureClass>([
  "timeout",
  "rate_limited",
  "unavailable",
  "invalid_response",
  "contract_violation",
  "unknown",
]);
const freshnessStates = new Set<ProviderFreshness>(["fresh", "mixed", "stale", "unknown"]);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)) ?? "null")
    .digest("hex");
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${digest(value).slice(0, 24)}`;
}

function parseTime(value: string): number | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validIdentity(input: CaptureProviderCallInput): void {
  if (typeof input.company_id !== "string" || !input.company_id) {
    throw new ProviderTelemetryError("company_id_required");
  }
  if (
    typeof input.provider_id !== "string" || !input.provider_id ||
    typeof input.operation_id !== "string" || !input.operation_id ||
    typeof input.invocation_id !== "string" || !input.invocation_id
  ) {
    throw new ProviderTelemetryError("provider_invocation_identity_required");
  }
}

function buildObservation(
  input: CaptureProviderCallInput,
  startedAt: string,
  startedMs: number,
  completedAt: string,
  completedMs: number,
  fields: Pick<ProviderExecutionObservation, "outcome" | "record_count" | "freshness_state" | "failure_class">,
): ProviderExecutionObservation {
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs)) {
    throw new ProviderTelemetryError("invalid_monotonic_time");
  }
  if (parseTime(startedAt) === null || parseTime(completedAt) === null) {
    throw new ProviderTelemetryError("invalid_observation_time");
  }
  if (completedMs < startedMs) throw new ProviderTelemetryError("clock_moved_backwards");
  const core = {
    ...input,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: Math.round(completedMs - startedMs),
    ...fields,
  };
  return {
    observation_id: stableId("provider_obs", core),
    ...core,
    authority_effect: "none",
  };
}

function safeFailureClass(
  error: unknown,
  classify?: (error: unknown) => ProviderFailureClass,
): ProviderFailureClass {
  try {
    const candidate = classify?.(error) ?? "unknown";
    return failureClasses.has(candidate) ? candidate : "unknown";
  } catch {
    return "unknown";
  }
}

function checkedSummary<T>(value: T, summarize?: (value: T) => ProviderResultSummary): ProviderResultSummary {
  const summary = summarize?.(value) ?? {};
  const recordCount = summary.record_count ?? 0;
  if (!Number.isInteger(recordCount) || recordCount < 0) {
    throw new ProviderTelemetryError("invalid_record_count");
  }
  const freshness = summary.freshness_state ?? "unknown";
  if (!freshnessStates.has(freshness)) {
    throw new ProviderTelemetryError("invalid_freshness_state");
  }
  if (summary.partial !== undefined && typeof summary.partial !== "boolean") {
    throw new ProviderTelemetryError("invalid_partial_result_flag");
  }
  return { record_count: recordCount, partial: summary.partial ?? false, freshness_state: freshness };
}

/**
 * Execute a provider call and return a privacy-minimized observation beside
 * the value or error. Raw payloads and error messages are never copied into
 * the observation; the host decides where to persist the observation.
 */
export async function captureProviderCall<T>(
  input: CaptureProviderCallInput,
  invoke: () => T | Promise<T>,
  options: CaptureProviderCallOptions<T> = {},
): Promise<ProviderCallCapture<T>> {
  validIdentity(input);
  const clock = options.clock ?? DEFAULT_CLOCK;
  const epochMs = options.epoch_ms ?? DEFAULT_EPOCH_MS;
  const startedAt = clock();
  const startedMs = epochMs();
  if (parseTime(startedAt) === null || !Number.isFinite(startedMs)) {
    throw new ProviderTelemetryError("invalid_start_time");
  }

  let value: T;
  try {
    value = await invoke();
  } catch (error) {
    const completedAt = clock();
    const completedMs = epochMs();
    const observation = buildObservation(
      input,
      startedAt,
      startedMs,
      completedAt,
      completedMs,
      {
        outcome: "failure",
        record_count: 0,
        freshness_state: "unknown",
        failure_class: safeFailureClass(error, options.classify_error),
      },
    );
    return { ok: false, error, observation };
  }

  const summary = checkedSummary(value, options.summarize_result);
  const completedAt = clock();
  const completedMs = epochMs();
  const observation = buildObservation(input, startedAt, startedMs, completedAt, completedMs, {
    outcome: summary.partial ? "partial" : "success",
    record_count: summary.record_count ?? 0,
    freshness_state: summary.freshness_state ?? "unknown",
  });
  return { ok: true, value, observation };
}

/** Synchronous counterpart for reference providers that implement `enrich()` synchronously. */
export function captureSynchronousProviderCall<T>(
  input: CaptureProviderCallInput,
  invoke: () => T,
  options: CaptureProviderCallOptions<T> = {},
): ProviderCallCapture<T> {
  validIdentity(input);
  const clock = options.clock ?? DEFAULT_CLOCK;
  const epochMs = options.epoch_ms ?? DEFAULT_EPOCH_MS;
  const startedAt = clock();
  const startedMs = epochMs();
  if (parseTime(startedAt) === null || !Number.isFinite(startedMs)) {
    throw new ProviderTelemetryError("invalid_start_time");
  }

  let value: T;
  try {
    value = invoke();
  } catch (error) {
    const observation = buildObservation(
      input,
      startedAt,
      startedMs,
      clock(),
      epochMs(),
      {
        outcome: "failure",
        record_count: 0,
        freshness_state: "unknown",
        failure_class: safeFailureClass(error, options.classify_error),
      },
    );
    return { ok: false, error, observation };
  }

  const summary = checkedSummary(value, options.summarize_result);
  const observation = buildObservation(
    input,
    startedAt,
    startedMs,
    clock(),
    epochMs(),
    {
      outcome: summary.partial ? "partial" : "success",
      record_count: summary.record_count ?? 0,
      freshness_state: summary.freshness_state ?? "unknown",
    },
  );
  return { ok: true, value, observation };
}

function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function validateThreshold(name: string, value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ProviderTelemetryError(`invalid_${name}`);
  }
}

export function summarizeProviderReliability(
  companyId: string,
  providerId: string,
  observations: ProviderExecutionObservation[],
  options: ProviderReliabilityOptions = {},
): ProviderReliabilitySnapshot {
  if (typeof companyId !== "string" || !companyId) {
    throw new ProviderTelemetryError("company_id_required");
  }
  if (typeof providerId !== "string" || !providerId) {
    throw new ProviderTelemetryError("provider_id_required");
  }
  if (!Array.isArray(observations)) throw new ProviderTelemetryError("observations_required");

  const asOf = options.as_of ?? DEFAULT_CLOCK();
  const asOfMs = parseTime(asOf);
  const windowSeconds = options.window_seconds ?? 3600;
  const minimumSamples = options.minimum_samples ?? 5;
  const degradedFailureRate = options.degraded_failure_rate ?? 0.2;
  const minimumSuccessRate = options.minimum_success_rate ?? 0.8;
  const maximumP95LatencyMs = options.maximum_p95_latency_ms ?? 5000;
  const maximumStaleRate = options.maximum_stale_rate ?? 0.5;
  if (asOfMs === null) throw new ProviderTelemetryError("invalid_as_of_time");
  if (!Number.isInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 604800) {
    throw new ProviderTelemetryError("invalid_window_seconds");
  }
  if (!Number.isInteger(minimumSamples) || minimumSamples < 1) {
    throw new ProviderTelemetryError("invalid_minimum_samples");
  }
  validateThreshold("degraded_failure_rate", degradedFailureRate, 0, 1);
  validateThreshold("minimum_success_rate", minimumSuccessRate, 0, 1);
  validateThreshold("maximum_p95_latency_ms", maximumP95LatencyMs, 0, Number.MAX_SAFE_INTEGER);
  validateThreshold("maximum_stale_rate", maximumStaleRate, 0, 1);

  const windowStartMs = asOfMs - windowSeconds * 1000;
  const seen = new Map<string, string>();
  const selected: ProviderExecutionObservation[] = [];
  for (const observation of observations) {
    if (!observation || typeof observation !== "object") {
      throw new ProviderTelemetryError("provider_observation_required");
    }
    if (
      observation.company_id !== companyId ||
      observation.provider_id !== providerId
    ) {
      throw new ProviderTelemetryError("cross_scope_observation");
    }
    if (!observation.invocation_id || !observation.observation_id) {
      throw new ProviderTelemetryError("provider_observation_identity_required");
    }
    if (observation.authority_effect !== "none") {
      throw new ProviderTelemetryError("telemetry_authority_violation");
    }
    if (!new Set(["success", "partial", "failure"]).has(observation.outcome)) {
      throw new ProviderTelemetryError("invalid_provider_outcome");
    }
    if (!freshnessStates.has(observation.freshness_state)) {
      throw new ProviderTelemetryError("invalid_freshness_state");
    }
    if (!Number.isInteger(observation.duration_ms) || observation.duration_ms < 0) {
      throw new ProviderTelemetryError("invalid_duration_ms");
    }
    if (!Number.isInteger(observation.record_count) || observation.record_count < 0) {
      throw new ProviderTelemetryError("invalid_record_count");
    }
    const completedMs = parseTime(observation.completed_at);
    if (completedMs === null) throw new ProviderTelemetryError("invalid_completion_time");
    const startedMs = parseTime(observation.started_at);
    if (startedMs === null || startedMs > completedMs) {
      throw new ProviderTelemetryError("invalid_start_time");
    }
    if (completedMs > asOfMs) throw new ProviderTelemetryError("future_provider_observation");
    if (observation.outcome === "failure") {
      if (!observation.failure_class || !failureClasses.has(observation.failure_class)) {
        throw new ProviderTelemetryError("invalid_failure_class");
      }
    } else if (observation.failure_class !== undefined) {
      throw new ProviderTelemetryError("failure_class_without_failure");
    }
    const contentHash = digest(observation);
    const prior = seen.get(observation.invocation_id);
    if (prior && prior !== contentHash) {
      throw new ProviderTelemetryError("duplicate_invocation_conflict");
    }
    if (prior) continue;
    seen.set(observation.invocation_id, contentHash);
    if (completedMs >= windowStartMs) selected.push(observation);
  }

  const successCount = selected.filter((item) => item.outcome === "success").length;
  const partialCount = selected.filter((item) => item.outcome === "partial").length;
  const failureCount = selected.filter((item) => item.outcome === "failure").length;
  const sampleCount = selected.length;
  const successRate = sampleCount ? (successCount + partialCount) / sampleCount : null;
  const failureRate = sampleCount ? failureCount / sampleCount : null;
  const staleCount = selected.filter((item) => item.freshness_state === "stale").length;
  const mixedCount = selected.filter((item) => item.freshness_state === "mixed").length;
  const unknownCount = selected.filter((item) => item.freshness_state === "unknown").length;
  const staleRate = sampleCount ? staleCount / sampleCount : null;
  const latencies = selected.map((item) => item.duration_ms).sort((a, b) => a - b);
  const p50 = percentile(latencies, 0.5);
  const p95 = percentile(latencies, 0.95);
  const failureClassCounts: Partial<Record<ProviderFailureClass, number>> = {};
  for (const item of selected) {
    if (item.failure_class) {
      failureClassCounts[item.failure_class] = (failureClassCounts[item.failure_class] ?? 0) + 1;
    }
  }

  let health: ProviderReliabilitySnapshot["health"] = "insufficient_data";
  if (sampleCount >= minimumSamples) {
    if (failureCount === sampleCount) {
      health = "unavailable";
    } else if (
      (failureRate ?? 0) >= degradedFailureRate ||
      (successRate ?? 1) < minimumSuccessRate ||
      (p95 ?? 0) > maximumP95LatencyMs ||
      (staleRate ?? 0) > maximumStaleRate
    ) {
      health = "degraded";
    } else {
      health = "healthy";
    }
  }

  const generatedAt = new Date(asOfMs).toISOString();
  const windowStart = new Date(windowStartMs).toISOString();
  const core = {
    company_id: companyId,
    provider_id: providerId,
    window_start: windowStart,
    window_end: generatedAt,
    observation_ids: selected.map((item) => item.observation_id).sort(),
    health,
  };
  return {
    snapshot_id: stableId("provider_health", core),
    company_id: companyId,
    provider_id: providerId,
    window_start: windowStart,
    window_end: generatedAt,
    generated_at: generatedAt,
    health,
    sample_count: sampleCount,
    success_count: successCount,
    partial_count: partialCount,
    failure_count: failureCount,
    success_rate: successRate,
    failure_rate: failureRate,
    stale_count: staleCount,
    mixed_freshness_count: mixedCount,
    unknown_freshness_count: unknownCount,
    stale_rate: staleRate,
    latency_p50_ms: p50,
    latency_p95_ms: p95,
    failure_class_counts: failureClassCounts,
    authority_effect: "none",
  };
}

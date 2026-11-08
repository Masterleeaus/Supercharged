import assert from "node:assert/strict";
import test from "node:test";
import {
  captureProviderCall,
  captureSynchronousProviderCall,
  summarizeProviderReliability,
} from "../runtime/providerTelemetry.ts";

const input = {
  company_id: "company-1",
  provider_id: "weather-provider",
  operation_id: "fetch-context",
  invocation_id: "invocation-1",
};
const asOf = "2026-10-03T04:00:00.000Z";

function observation(index, overrides = {}) {
  const completed = `2026-10-03T03:${String(index).padStart(2, "0")}:00.000Z`;
  return {
    observation_id: `observation-${index}`,
    invocation_id: `invocation-${index}`,
    company_id: "company-1",
    provider_id: "weather-provider",
    operation_id: "fetch-context",
    started_at: completed,
    completed_at: completed,
    duration_ms: index * 10,
    outcome: "success",
    record_count: 2,
    freshness_state: "fresh",
    authority_effect: "none",
    ...overrides,
  };
}

test("captures successful provider metadata without the returned payload", async () => {
  let time = 0;
  const result = await captureProviderCall(
    input,
    async () => ({ secret_value: "not-in-observation", records: [1, 2] }),
    {
      clock: () => time++ === 0 ? "2026-10-03T03:00:00.000Z" : "2026-10-03T03:00:00.250Z",
      epoch_ms: () => time === 1 ? 1000 : 1250,
      summarize_result: (value) => ({ record_count: value.records.length, freshness_state: "fresh" }),
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.observation.duration_ms, 250);
  assert.equal(result.observation.record_count, 2);
  assert.equal("secret_value" in result.observation, false);
  assert.equal(result.observation.authority_effect, "none");
});

test("captures a bounded failure class without copying an error message", async () => {
  const result = await captureProviderCall(
    input,
    async () => { throw new Error("private response details"); },
    {
      clock: () => asOf,
      epoch_ms: () => 2000,
      classify_error: () => "timeout",
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.observation.outcome, "failure");
  assert.equal(result.observation.failure_class, "timeout");
  assert.equal("error" in result.observation, false);
  assert.equal("message" in result.observation, false);
});

test("captures synchronously for Step 13 style enrichment providers", () => {
  let time = 0;
  const result = captureSynchronousProviderCall(
    input,
    () => [{ key: "temperature", value: 18 }],
    {
      clock: () => time++ === 0 ? "2026-10-03T03:10:00.000Z" : "2026-10-03T03:10:00.030Z",
      epoch_ms: () => time === 1 ? 3000 : 3030,
      summarize_result: (facts) => ({ record_count: facts.length, freshness_state: "fresh" }),
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.observation.duration_ms, 30);
  assert.equal(result.value[0].key, "temperature");
});

test("summarizes a scoped window and deduplicates the same invocation", () => {
  const samples = Array.from({ length: 5 }, (_, index) => observation(index + 1));
  const result = summarizeProviderReliability(
    "company-1",
    "weather-provider",
    [...samples, samples[0]],
    { as_of: asOf, minimum_samples: 5 },
  );
  assert.equal(result.sample_count, 5);
  assert.equal(result.health, "healthy");
  assert.equal(result.success_rate, 1);
  assert.equal(result.latency_p95_ms, 50);
});

test("marks reliability degraded when a configured failure threshold is met", () => {
  const samples = Array.from({ length: 5 }, (_, index) => observation(index + 1));
  samples[0] = observation(1, { outcome: "failure", failure_class: "rate_limited", record_count: 0 });
  const result = summarizeProviderReliability(
    "company-1",
    "weather-provider",
    samples,
    { as_of: asOf, minimum_samples: 5 },
  );
  assert.equal(result.health, "degraded");
  assert.equal(result.failure_class_counts.rate_limited, 1);
});

test("marks a provider unavailable when every sufficient-window call fails", () => {
  const samples = Array.from({ length: 5 }, (_, index) => observation(index + 1, {
    outcome: "failure",
    failure_class: "unavailable",
    record_count: 0,
  }));
  const result = summarizeProviderReliability(
    "company-1",
    "weather-provider",
    samples,
    { as_of: asOf, minimum_samples: 5 },
  );
  assert.equal(result.health, "unavailable");
  assert.equal(result.success_rate, 0);
});

test("keeps low sample counts at insufficient_data", () => {
  const result = summarizeProviderReliability(
    "company-1",
    "weather-provider",
    [observation(1)],
    { as_of: asOf, minimum_samples: 5 },
  );
  assert.equal(result.health, "insufficient_data");
  assert.equal(result.latency_p95_ms, 10);
});

test("rejects cross-company observations and conflicting invocation duplicates", () => {
  assert.throws(
    () => summarizeProviderReliability(
      "company-1",
      "weather-provider",
      [observation(1, { company_id: "company-2" })],
      { as_of: asOf },
    ),
    { code: "cross_scope_observation" },
  );
  assert.throws(
    () => summarizeProviderReliability(
      "company-1",
      "weather-provider",
      [observation(1), observation(1, { duration_ms: 99 })],
      { as_of: asOf },
    ),
    { code: "duplicate_invocation_conflict" },
  );
});

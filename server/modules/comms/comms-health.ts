// Pure comms health summary. No I/O: callers pass a snapshot of counts and timings.
// Refuses negative or non-finite numbers, and error counts above total attempts.

export interface ProviderAttemptCounts {
  errors: number;
  total: number;
}

export interface CommsHealthSnapshot {
  queuedJobs: number;
  deadLettered: number;
  deliveryLatenciesMs: number[];
  providers: Record<string, ProviderAttemptCounts>;
  retries: number;
  suppressions: number;
  consentRefusals: number;
}

export interface ProviderHealth {
  provider: string;
  errors: number;
  total: number;
  errorRate: number | null;
}

export interface LatencyHealth {
  count: number;
  p50: number | null;
  p95: number | null;
}

export interface CommsHealthSummary {
  queuedJobs: number;
  deadLettered: number;
  latency: LatencyHealth;
  providers: ProviderHealth[];
  retries: number;
  suppressions: number;
  consentRefusals: number;
}

function requireCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`comms-health: ${field} must be a finite non-negative number`);
  }
  return value;
}

// Nearest-rank percentile over an ascending-sorted array. Returns null when empty.
export function percentile(sortedAscending: readonly number[], p: number): number | null {
  if (sortedAscending.length === 0) return null;
  const rank = Math.ceil((p / 100) * sortedAscending.length);
  const index = Math.min(Math.max(rank, 1), sortedAscending.length) - 1;
  return sortedAscending[index];
}

export function summarizeLatency(latenciesMs: readonly number[]): LatencyHealth {
  if (!Array.isArray(latenciesMs)) {
    throw new RangeError('comms-health: deliveryLatenciesMs must be an array');
  }
  const values = latenciesMs.map((v, i) => requireCount(v, `deliveryLatenciesMs[${i}]`));
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
  };
}

export function summarizeProviders(
  providers: Record<string, ProviderAttemptCounts>,
): ProviderHealth[] {
  if (providers === null || typeof providers !== 'object') {
    throw new RangeError('comms-health: providers must be an object');
  }
  return Object.keys(providers)
    .sort()
    .map((name) => {
      const counts = providers[name];
      const errors = requireCount(counts?.errors, `providers.${name}.errors`);
      const total = requireCount(counts?.total, `providers.${name}.total`);
      if (errors > total) {
        throw new RangeError(`comms-health: providers.${name}.errors exceeds total`);
      }
      return {
        provider: name,
        errors,
        total,
        errorRate: total === 0 ? null : errors / total,
      };
    });
}

export function summarizeCommsHealth(snapshot: CommsHealthSnapshot): CommsHealthSummary {
  if (snapshot === null || typeof snapshot !== 'object') {
    throw new RangeError('comms-health: snapshot must be an object');
  }
  return {
    queuedJobs: requireCount(snapshot.queuedJobs, 'queuedJobs'),
    deadLettered: requireCount(snapshot.deadLettered, 'deadLettered'),
    latency: summarizeLatency(snapshot.deliveryLatenciesMs),
    providers: summarizeProviders(snapshot.providers),
    retries: requireCount(snapshot.retries, 'retries'),
    suppressions: requireCount(snapshot.suppressions, 'suppressions'),
    consentRefusals: requireCount(snapshot.consentRefusals, 'consentRefusals'),
  };
}

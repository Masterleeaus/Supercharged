/**
 * Rate limiter and circuit breaker behind the contract's RateLimitHooks. Port of
 * MarketplaceRateLimitRuntime.php (per-minute write limit, provider pause) with two changes recorded in
 * DECISIONS.md: the window is a true sliding window kept in app code, and reads are limited too.
 *
 * Buckets: every call is counted against (company, provider) and against (company) across providers.
 * A call is allowed only when both buckets have room. A denied call consumes no slot.
 *
 * State lives in this process. A multi-instance deployment needs a shared store (not built here).
 */
import type { RateLimitDecision, RateLimitHooks, RateLimitObservation } from "../../contracts/index.ts";

export interface WindowLimit {
  limit: number;
  windowMs: number;
}

export interface RateLimitConfig {
  now: () => Date;
  /** Limits for read calls (operations that do not start with "write_"). */
  read: { perProvider: WindowLimit; perCompany: WindowLimit };
  /** Limits for write calls. Defaults match CHATBOT_ECOMMERCE maximum_writes_per_minute = 10. */
  write: { perProvider: WindowLimit; perCompany: WindowLimit };
  breaker: { failureThreshold: number; failureWindowMs: number; cooldownMs: number };
  /** Used when a 429 carries no usable Retry-After header. */
  defaultBackoffMs: number;
}

export const DEFAULT_RATE_LIMIT_CONFIG: Omit<RateLimitConfig, "now"> = {
  read: { perProvider: { limit: 60, windowMs: 60_000 }, perCompany: { limit: 240, windowMs: 60_000 } },
  write: { perProvider: { limit: 10, windowMs: 60_000 }, perCompany: { limit: 30, windowMs: 60_000 } },
  breaker: { failureThreshold: 5, failureWindowMs: 60_000, cooldownMs: 60_000 },
  defaultBackoffMs: 60_000,
};

export interface MarketplaceRateLimiter extends RateLimitHooks {
  /** Test and diagnostic view of the open pause or breaker for a company and provider. Null when open. */
  pausedUntil(companyId: string, provider: string): Date | null;
}

function isWriteOperation(operation: string): boolean {
  return operation.startsWith("write_");
}

export function createMarketplaceRateLimiter(config: RateLimitConfig): MarketplaceRateLimiter {
  const hits = new Map<string, number[]>();
  const failures = new Map<string, number[]>();
  const pausedUntilMs = new Map<string, number>();
  const breakerOpenUntilMs = new Map<string, number>();

  const pairKey = (companyId: string, provider: string): string => `${companyId}|${provider}`;

  function prune(list: number[], nowMs: number, windowMs: number): number[] {
    return list.filter((t) => t > nowMs - windowMs);
  }

  /** Returns the retry delay for a bucket, or null when the bucket has room. */
  function bucketRetry(key: string, nowMs: number, limit: WindowLimit): { retryMs: number | null; remaining: number } {
    const list = prune(hits.get(key) ?? [], nowMs, limit.windowMs);
    hits.set(key, list);
    if (list.length < limit.limit) return { retryMs: null, remaining: limit.limit - list.length - 1 };
    const oldest = list[0] ?? nowMs; // an empty list with a zero limit waits one full window
    return { retryMs: oldest + limit.windowMs - nowMs, remaining: 0 };
  }

  function bucketRecord(key: string, nowMs: number): void {
    const list = hits.get(key) ?? [];
    list.push(nowMs);
    hits.set(key, list);
  }

  return {
    async acquire(companyId, provider, operation): Promise<RateLimitDecision> {
      const nowMs = config.now().getTime();
      const pair = pairKey(companyId, provider);

      const pausedUntil = pausedUntilMs.get(pair) ?? 0;
      if (pausedUntil > nowMs) {
        return { allowed: false, retryAfterMs: pausedUntil - nowMs, remaining: 0 };
      }
      const openUntil = breakerOpenUntilMs.get(pair) ?? 0;
      if (openUntil > nowMs) {
        return { allowed: false, retryAfterMs: openUntil - nowMs, remaining: 0 };
      }

      const scope = isWriteOperation(operation) ? config.write : config.read;
      const providerKey = `${isWriteOperation(operation) ? "w" : "r"}|${pair}`;
      const companyKey = `${isWriteOperation(operation) ? "w" : "r"}|${companyId}`;
      const providerBucket = bucketRetry(providerKey, nowMs, scope.perProvider);
      const companyBucket = bucketRetry(companyKey, nowMs, scope.perCompany);

      const retries = [providerBucket.retryMs, companyBucket.retryMs].filter((v): v is number => v !== null);
      if (retries.length > 0) {
        return { allowed: false, retryAfterMs: Math.max(...retries), remaining: 0 };
      }

      bucketRecord(providerKey, nowMs);
      bucketRecord(companyKey, nowMs);
      return { allowed: true, retryAfterMs: null, remaining: Math.min(providerBucket.remaining, companyBucket.remaining) };
    },

    async observe(companyId, provider, _operation, response: RateLimitObservation): Promise<void> {
      const nowMs = config.now().getTime();
      const pair = pairKey(companyId, provider);
      if (response.status === 429) {
        const header = response.headers["retry-after"];
        const seconds = header !== undefined ? Number(header) : NaN;
        const backoff = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : config.defaultBackoffMs;
        pausedUntilMs.set(pair, nowMs + backoff);
        return;
      }
      if (response.status >= 200 && response.status < 300) {
        failures.delete(pair);
        breakerOpenUntilMs.delete(pair);
      }
    },

    async recordFailure(companyId, provider, _operation, _reason): Promise<void> {
      const nowMs = config.now().getTime();
      const pair = pairKey(companyId, provider);
      const list = prune(failures.get(pair) ?? [], nowMs, config.breaker.failureWindowMs);
      list.push(nowMs);
      failures.set(pair, list);
      if (list.length >= config.breaker.failureThreshold) {
        breakerOpenUntilMs.set(pair, nowMs + config.breaker.cooldownMs);
        failures.delete(pair);
      }
    },

    pausedUntil(companyId, provider): Date | null {
      const pair = pairKey(companyId, provider);
      const nowMs = config.now().getTime();
      const until = Math.max(pausedUntilMs.get(pair) ?? 0, breakerOpenUntilMs.get(pair) ?? 0);
      return until > nowMs ? new Date(until) : null;
    },
  };
}

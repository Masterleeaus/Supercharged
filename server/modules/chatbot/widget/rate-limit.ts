/**
 * Fixed-window rate limiter for the public widget endpoints. Keys are built by the caller (for example
 * "config:<ip>:<publicId>"). Memory is bounded: when the table is full, expired windows are dropped first,
 * then the oldest keys.
 *
 * This limiter holds its counts in process memory. With more than one server process, each process counts
 * alone, so the effective limit is multiplied by the process count. A shared store is needed before scaling out.
 */

export interface RateLimitPolicy {
  /** Maximum requests per key inside one window. */
  limit: number;
  windowMs: number;
  /** Maximum keys held at once. */
  maxKeys?: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  take(key: string): RateLimitDecision;
}

interface Window {
  start: number;
  count: number;
}

export function createFixedWindowLimiter(policy: RateLimitPolicy, now: () => number = () => Date.now()): RateLimiter {
  if (!Number.isInteger(policy.limit) || policy.limit < 1) throw new Error("rate limit must be a positive integer");
  if (!Number.isInteger(policy.windowMs) || policy.windowMs < 1) throw new Error("rate window must be a positive integer");
  const maxKeys = policy.maxKeys ?? 10_000;
  const windows = new Map<string, Window>();

  function prune(time: number): void {
    for (const [key, win] of windows) {
      if (time - win.start >= policy.windowMs) windows.delete(key);
    }
    while (windows.size >= maxKeys) {
      const oldest = windows.keys().next().value;
      if (oldest === undefined) break;
      windows.delete(oldest);
    }
  }

  return {
    take(key: string): RateLimitDecision {
      const time = now();
      let win = windows.get(key);
      if (!win || time - win.start >= policy.windowMs) {
        if (!windows.has(key)) prune(time);
        win = { start: time, count: 0 };
        windows.set(key, win);
      }
      if (win.count >= policy.limit) {
        const retryAfterMs = policy.windowMs - (time - win.start);
        return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
      }
      win.count += 1;
      return { allowed: true, remaining: policy.limit - win.count, retryAfterSeconds: 0 };
    },
  };
}

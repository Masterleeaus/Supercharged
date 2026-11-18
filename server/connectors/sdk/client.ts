/**
 * Shared client layer (#349): per-attempt timeout, bounded retries with exponential backoff and
 * full jitter, Retry-After handling, and idempotency-key generation for writes.
 *
 * Only ConnectorError codes marked retryable are retried. Anything else fails on the first attempt.
 */
import { randomUUID, createHash } from 'node:crypto';
import { ConnectorError } from './contract.ts';

export interface RetryPolicy {
  /** Total attempts including the first. Bounded: never below 1. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export const DEFAULT_RETRY_POLICY: Omit<RetryPolicy, 'sleep' | 'random'> = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 5000,
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Delay before the next attempt. Honours Retry-After when the vendor sent one. Returns null when the
 * vendor asks for a wait longer than maxDelayMs, so the caller gives up instead of blocking.
 */
export function backoffDelay(attempt: number, error: ConnectorError, policy: RetryPolicy): number | null {
  if (error.retryAfterMs !== undefined) {
    return error.retryAfterMs > policy.maxDelayMs ? null : Math.max(0, error.retryAfterMs);
  }
  const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  const random = policy.random ?? Math.random;
  return Math.floor(random() * cap);
}

export async function withRetries<T>(
  operation: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
): Promise<{ value: T; attempts: number }> {
  const maxAttempts = Math.max(1, Math.floor(policy.maxAttempts));
  const sleep = policy.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      const value = await operation(attempt);
      return { value, attempts: attempt };
    } catch (err) {
      const error = err instanceof ConnectorError ? err : new ConnectorError('unknown', 'Unexpected connector failure');
      if (!error.retryable || attempt >= maxAttempts) throw error;
      const delay = backoffDelay(attempt, error, policy);
      if (delay === null) throw error;
      await sleep(delay);
    }
  }
}

/** Rejects with a timeout ConnectorError when the promise does not settle in time. */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new ConnectorError('validation', 'timeoutMs must be a positive number'));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ConnectorError('timeout', 'Vendor call timed out')), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Idempotency key for a write. Derived from a caller-supplied stable id when given, so a replay of the
 * same logical write produces the same key. Otherwise a random key, which the runner reuses across retries.
 */
export function idempotencyKeyFor(parts: { companyId: string; connector: string; action: string; stableId?: string }): string {
  if (parts.stableId === undefined) return randomUUID();
  return createHash('sha256')
    .update([parts.companyId, parts.connector, parts.action, parts.stableId].join('\u0000'))
    .digest('hex');
}

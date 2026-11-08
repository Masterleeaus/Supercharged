/**
 * Shared fixed-window rate limits for the public widget, behind one interface.
 *
 * Two implementations:
 * - createMemoryRateLimitStore: one process. Used by tests and local runs.
 * - createDrizzleRateLimitStore: one Postgres row per bucket. Every server process that uses the same database
 *   counts against the same bucket, so the limit holds across instances.
 *
 * Both follow the same window rule (decideWindow), so behaviour matches whichever store is wired.
 * Buckets are scoped by company_id. A key with no valid company is refused.
 *
 * The table widget_rate_limits is defined here and is not yet in db/widget.ts or a migration draft; see DECISIONS.md.
 */
import { sql } from "drizzle-orm";
import { bigint, index, integer, pgTable, primaryKey, uuid, varchar } from "drizzle-orm/pg-core";
import { requireCompanyId } from "../chatbot-scope.ts";
import type { RateLimitDecision } from "./rate-limit.ts";

export const RATE_LIMIT_KEY_MAX_LENGTH = 255;
const DEFAULT_MAX_BUCKETS = 10_000;

export interface SharedRateLimitPolicy {
  /** Maximum hits per bucket inside one window. */
  limit: number;
  windowMs: number;
}

export interface RateLimitStore {
  /**
   * Counts one hit for a bucket inside a company and returns the decision. Must be atomic per bucket, so two
   * processes cannot both take the last slot.
   */
  hit(companyId: string, bucketKey: string, policy: SharedRateLimitPolicy, nowMs: number): Promise<RateLimitDecision>;
}

export function assertPolicy(policy: SharedRateLimitPolicy): void {
  if (!Number.isInteger(policy.limit) || policy.limit < 1) throw new Error("rate limit must be a positive integer");
  if (!Number.isInteger(policy.windowMs) || policy.windowMs < 1) throw new Error("rate window must be a positive integer");
}

/**
 * The window rule shared by every store. hits is the count after this hit, already capped at limit + 1.
 * A hit is allowed while hits <= limit.
 */
export function decideWindow(policy: SharedRateLimitPolicy, windowStartMs: number, hits: number, nowMs: number): RateLimitDecision {
  const allowed = hits <= policy.limit;
  if (allowed) return { allowed: true, remaining: policy.limit - hits, retryAfterSeconds: 0 };
  const retryAfterMs = windowStartMs + policy.windowMs - nowMs;
  return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
}

/** Refusal used when a key cannot be stored. Fails closed. */
const REFUSED: RateLimitDecision = { allowed: false, remaining: 0, retryAfterSeconds: 60 };

function bucketId(companyId: string, key: string): string {
  return `${companyId}\u0000${key}`;
}

export function createMemoryRateLimitStore(options: { maxBuckets?: number } = {}): RateLimitStore {
  const maxBuckets = options.maxBuckets ?? DEFAULT_MAX_BUCKETS;
  const buckets = new Map<string, { windowStartMs: number; hits: number; windowMs: number }>();

  function prune(nowMs: number): void {
    for (const [id, b] of buckets) {
      if (nowMs - b.windowStartMs >= b.windowMs) buckets.delete(id);
    }
    while (buckets.size >= maxBuckets) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
  }

  return {
    async hit(companyId, key, policy, nowMs) {
      const scope = requireCompanyId(companyId);
      assertPolicy(policy);
      if (key.length === 0 || key.length > RATE_LIMIT_KEY_MAX_LENGTH) return REFUSED;
      const id = bucketId(scope, key);
      let bucket = buckets.get(id);
      if (!bucket || nowMs - bucket.windowStartMs >= policy.windowMs) {
        if (!bucket) prune(nowMs);
        bucket = { windowStartMs: nowMs, hits: 0, windowMs: policy.windowMs };
        buckets.set(id, bucket);
      }
      bucket.hits = Math.min(bucket.hits + 1, policy.limit + 1);
      return decideWindow(policy, bucket.windowStartMs, bucket.hits, nowMs);
    },
  };
}

/** Drizzle table for the shared counters. Composite key includes company_id, per the chatbot conventions. */
export const widgetRateLimits = pgTable(
  "widget_rate_limits",
  {
    companyId: uuid("company_id").notNull(),
    bucketKey: varchar("bucket_key", { length: RATE_LIMIT_KEY_MAX_LENGTH }).notNull(),
    /** Start of the current window, Unix milliseconds. */
    windowStartMs: bigint("window_start_ms", { mode: "number" }).notNull(),
    /** Hits in the current window, capped at limit + 1. */
    hits: integer("hits").notNull(),
  },
  (table) => [
    primaryKey({ name: "widget_rate_limits_company_bucket_pk", columns: [table.companyId, table.bucketKey] }),
    index("widget_rate_limits_company_idx").on(table.companyId),
  ],
);

// Any Drizzle Postgres database. Typed loosely so tests can pass a recording client.
export type RateLimitDb = { execute(query: unknown): Promise<unknown> };

/** One atomic upsert: starts a new window when the old one has ended, otherwise counts one more hit. */
export function rateLimitHitQuery(companyId: string, bucketKey: string, policy: SharedRateLimitPolicy, nowMs: number) {
  return sql`insert into widget_rate_limits (company_id, bucket_key, window_start_ms, hits)
    values (${companyId}, ${bucketKey}, ${nowMs}, 1)
    on conflict (company_id, bucket_key) do update set
      window_start_ms = case when widget_rate_limits.window_start_ms + ${policy.windowMs} <= ${nowMs}
        then excluded.window_start_ms else widget_rate_limits.window_start_ms end,
      hits = case when widget_rate_limits.window_start_ms + ${policy.windowMs} <= ${nowMs}
        then 1 else least(widget_rate_limits.hits + 1, ${policy.limit + 1}) end
    returning window_start_ms, hits`;
}

export function createDrizzleRateLimitStore(db: RateLimitDb): RateLimitStore {
  return {
    async hit(companyId, key, policy, nowMs) {
      const scope = requireCompanyId(companyId);
      assertPolicy(policy);
      if (key.length === 0 || key.length > RATE_LIMIT_KEY_MAX_LENGTH) return REFUSED;
      const result = await db.execute(rateLimitHitQuery(scope, key, policy, nowMs));
      const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as Array<{
        window_start_ms: number | string;
        hits: number | string;
      }>;
      const row = rows[0];
      if (!row) return REFUSED;
      return decideWindow(policy, Number(row.window_start_ms), Number(row.hits), nowMs);
    },
  };
}

/** A limiter bound to one policy and one store. Keys are scoped by company_id inside the store. */
export interface SharedRateLimiter {
  take(companyId: string, key: string): Promise<RateLimitDecision>;
}

export function createSharedRateLimiter(store: RateLimitStore, policy: SharedRateLimitPolicy, now: () => number = () => Date.now()): SharedRateLimiter {
  assertPolicy(policy);
  return {
    take: (companyId, key) => store.hit(companyId, key, policy, now()),
  };
}

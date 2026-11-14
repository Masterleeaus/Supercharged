/**
 * General rate limit for auth and public routes, keyed on the trusted client IP.
 *
 * Fixed window, in memory, one counter per (bucket, IP). Two buckets:
 * - "auth":   login, registration, OTP, password and magic-link paths.
 *             Default 10 requests per minute per IP.
 * - "public": the unauthenticated public paths listed below.
 *             Default 60 requests per minute per IP.
 *
 * Every other path is not touched here. Existing per-route limiters
 * (authRateLimiter, apiRateLimiter, strictRateLimiter, webhookRateLimiter and the
 * per-account provider webhook limiter) keep working as before.
 *
 * Exempt paths (checked first, never counted):
 * - Provider webhooks: any path with a `webhook` or `webhooks` segment, for
 *   example /api/webhooks/twilio/voice, /api/stripe/webhook or
 *   /api/elevenlabs-webhooks/verify. Providers call from a small set of shared
 *   IPs for many tenants, so a per-IP cap would drop real events. They keep
 *   their own limits.
 * - /api/health: monitors and load balancers poll it from one address.
 *
 * Client IP: req.ip, which Express sets from the socket address. X-Forwarded-For
 * is read only when the TRUST_PROXY setting names the proxy in front of the app
 * (see server/middleware/trust-proxy.ts and docs/working/rate-limits.md).
 *
 * Configuration (environment, all optional):
 *   RATE_LIMIT_ENABLED         "false" or "0" turns this limiter off. Default on.
 *   RATE_LIMIT_AUTH_MAX        default 10
 *   RATE_LIMIT_AUTH_WINDOW_MS  default 60000
 *   RATE_LIMIT_PUBLIC_MAX      default 60
 *   RATE_LIMIT_PUBLIC_WINDOW_MS default 60000
 *   RATE_LIMIT_MAX_BUCKETS     live counters kept in memory, default 10000
 *
 * When the counter table is full and no expired counter can be freed, a new
 * client is refused with 429. This is the same fail-closed rule as the provider
 * webhook limiter.
 */

import type { NextFunction, Request, Response } from "express";
import { logger } from "../utils/logger.ts";

export type PublicRouteBucket = "auth" | "public";
export type PublicRouteClass = PublicRouteBucket | "exempt";

export interface PublicRateLimitConfig {
  enabled: boolean;
  authMax: number;
  authWindowMs: number;
  publicMax: number;
  publicWindowMs: number;
  maxBuckets: number;
}

export const PUBLIC_RATE_LIMIT_DEFAULTS: Readonly<PublicRateLimitConfig> = Object.freeze({
  enabled: true,
  authMax: 10,
  authWindowMs: 60_000,
  publicMax: 60,
  publicWindowMs: 60_000,
  maxBuckets: 10_000,
});

const RATE_LIMIT_MESSAGE = "Too many requests, please try again later";

// Exact paths. Matching is case-insensitive and ignores a trailing slash.
const AUTH_EXACT_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/send-otp",
  "/api/auth/verify-otp",
  "/api/auth/change-password",
]);

// Path prefixes that cover a whole group of auth routes.
const AUTH_PREFIX_PATHS = [
  "/api/auth/forgot-password",
  "/api/auth/magic-link",
];

// Unauthenticated public paths. A prefix matches the path itself and anything under it.
const PUBLIC_PREFIX_PATHS = [
  "/api/branding",
  "/api/contact",
  "/api/public",
  "/api/settings/public",
  "/api/system/version",
  "/api/twilio-countries",
];

const EXEMPT_PREFIX_PATHS = ["/api/health"];

const WEBHOOK_SEGMENT = /(^|\/)[^/]*webhooks?(?=\/|$)/;

function normalizePath(rawPath: string): string {
  let path = rawPath.toLowerCase();
  while (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  return path;
}

function matchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Classifies a request path. Returns null for paths this limiter does not touch. */
export function classifyPublicRoute(rawPath: string): PublicRouteClass | null {
  const path = normalizePath(rawPath || "/");
  if (WEBHOOK_SEGMENT.test(path) || EXEMPT_PREFIX_PATHS.some((p) => matchesPrefix(path, p))) {
    return "exempt";
  }
  if (AUTH_EXACT_PATHS.has(path) || AUTH_PREFIX_PATHS.some((p) => matchesPrefix(path, p))) {
    return "auth";
  }
  if (PUBLIC_PREFIX_PATHS.some((p) => matchesPrefix(path, p))) {
    return "public";
  }
  return null;
}

function readPositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0) {
    logger.warn(`[Security] ${name}="${raw}" is not a positive integer. Using ${fallback}.`);
    return fallback;
  }
  return value;
}

/** Reads the limiter settings from the environment. Invalid values fall back to the defaults. */
export function readPublicRateLimitConfig(env: NodeJS.ProcessEnv = process.env): PublicRateLimitConfig {
  const rawEnabled = (env.RATE_LIMIT_ENABLED ?? "").trim().toLowerCase();
  return {
    enabled: !(rawEnabled === "false" || rawEnabled === "0"),
    authMax: readPositiveInt(env, "RATE_LIMIT_AUTH_MAX", PUBLIC_RATE_LIMIT_DEFAULTS.authMax),
    authWindowMs: readPositiveInt(env, "RATE_LIMIT_AUTH_WINDOW_MS", PUBLIC_RATE_LIMIT_DEFAULTS.authWindowMs),
    publicMax: readPositiveInt(env, "RATE_LIMIT_PUBLIC_MAX", PUBLIC_RATE_LIMIT_DEFAULTS.publicMax),
    publicWindowMs: readPositiveInt(env, "RATE_LIMIT_PUBLIC_WINDOW_MS", PUBLIC_RATE_LIMIT_DEFAULTS.publicWindowMs),
    maxBuckets: readPositiveInt(env, "RATE_LIMIT_MAX_BUCKETS", PUBLIC_RATE_LIMIT_DEFAULTS.maxBuckets),
  };
}

interface Bucket {
  count: number;
  windowStart: number;
}

export function createPublicRouteRateLimit(
  config: PublicRateLimitConfig,
  now: () => number = () => Date.now(),
) {
  const limits: Record<PublicRouteBucket, { max: number; windowMs: number }> = {
    auth: { max: config.authMax, windowMs: config.authWindowMs },
    public: { max: config.publicMax, windowMs: config.publicWindowMs },
  };
  const stores: Record<PublicRouteBucket, Map<string, Bucket>> = {
    auth: new Map(),
    public: new Map(),
  };

  function sweepExpired(store: Map<string, Bucket>, windowMs: number, t: number): void {
    for (const [key, bucket] of store) {
      if (t - bucket.windowStart >= windowMs) {
        store.delete(key);
      }
    }
  }

  /** Counts one request. Returns the Retry-After seconds when refused, or null when allowed. */
  function take(bucket: PublicRouteBucket, ip: string, t: number): number | null {
    const { max, windowMs } = limits[bucket];
    const store = stores[bucket];
    const key = `${bucket}:${ip}`;

    let entry = store.get(key);
    if (!entry || t - entry.windowStart >= windowMs) {
      if (!entry && store.size >= config.maxBuckets) {
        sweepExpired(store, windowMs, t);
        if (store.size >= config.maxBuckets) {
          return Math.max(1, Math.ceil(windowMs / 1000));
        }
      }
      entry = { count: 0, windowStart: t };
      store.set(key, entry);
    }

    entry.count++;
    if (entry.count > max) {
      return Math.max(1, Math.ceil((entry.windowStart + windowMs - t) / 1000));
    }
    return null;
  }

  return function publicRouteRateLimit(req: Request, res: Response, next: NextFunction): void {
    if (!config.enabled) {
      next();
      return;
    }

    const routeClass = classifyPublicRoute(req.path ?? req.url ?? "/");
    if (routeClass === null || routeClass === "exempt") {
      next();
      return;
    }

    // Socket-derived req.ip (trust proxy decides whether X-Forwarded-For counts).
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const retryAfter = take(routeClass, ip, now());
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: RATE_LIMIT_MESSAGE });
      return;
    }

    next();
  };
}

/** The limiter mounted by server/index.ts, configured from the environment. */
export const publicRouteRateLimit = createPublicRouteRateLimit(readPublicRateLimitConfig());

/**
 * Per-account rate limit for provider webhooks (Twilio, ElevenLabs).
 *
 * Fixed window, in memory. The bucket key is the provider account id when the
 * request carries one, otherwise the socket IP. Fails closed:
 * - no usable key (no account id and no IP) is refused with 401;
 * - an account id that is present but malformed is refused, not downgraded
 *   to the IP key;
 * - when the bucket table is full and no expired bucket can be freed, a new
 *   key is refused with 429.
 *
 * Mount this AFTER the provider's signature check. readTwilioAccountSid reads
 * the request body, so before the signature check the account id is chosen by
 * the caller and could be used to dodge the limit.
 */

import type { Request, Response, NextFunction } from "express";

export interface ProviderWebhookRateLimitOptions {
  /** Provider name, used as the key namespace (for example "twilio"). */
  provider: string;
  /** Fixed window length in milliseconds. */
  windowMs: number;
  /** Requests allowed per key inside one window. */
  maxRequests: number;
  /** Reads the provider account id from an already-verified request. */
  readAccountId?: (req: Request) => unknown;
  /** Shape a provider account id must match. */
  accountIdPattern?: RegExp;
  /** Upper bound on live buckets kept in memory. */
  maxBuckets?: number;
  /** Injected clock, in epoch milliseconds. */
  now?: () => number;
  message?: string;
}

interface Bucket {
  count: number;
  windowStart: number;
}

export const TWILIO_ACCOUNT_SID_PATTERN = /^AC[0-9a-fA-F]{32}$/;

const DEFAULT_ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_MAX_BUCKETS = 10_000;

/** Twilio posts AccountSid as a form field on every webhook. It has no header. */
export function readTwilioAccountSid(req: Request): unknown {
  const body = req.body as unknown;
  if (body && typeof body === "object") {
    return (body as Record<string, unknown>).AccountSid;
  }
  return undefined;
}

/**
 * Returns the bucket key for a request, or null when no usable key exists.
 * Exported for tests.
 */
export function resolveProviderWebhookKey(
  req: Request,
  provider: string,
  readAccountId: ((req: Request) => unknown) | undefined,
  accountIdPattern: RegExp
): string | null {
  const raw = readAccountId ? readAccountId(req) : undefined;
  if (raw !== undefined && raw !== null && raw !== "") {
    if (typeof raw !== "string" || !accountIdPattern.test(raw)) {
      return null;
    }
    return `${provider}:account:${raw}`;
  }

  // Socket-derived IP only. The raw X-Forwarded-For header is client-controlled.
  const ip = req.ip || req.socket?.remoteAddress;
  if (!ip) {
    return null;
  }
  return `${provider}:ip:${ip}`;
}

export function createProviderWebhookRateLimit(options: ProviderWebhookRateLimitOptions) {
  const {
    provider,
    windowMs,
    maxRequests,
    readAccountId,
    accountIdPattern = DEFAULT_ACCOUNT_ID_PATTERN,
    maxBuckets = DEFAULT_MAX_BUCKETS,
    now = () => Date.now(),
    message = "Too many webhook requests, please try again later",
  } = options;

  if (
    !provider ||
    !Number.isFinite(windowMs) || windowMs <= 0 ||
    !Number.isInteger(maxRequests) || maxRequests <= 0 ||
    !Number.isInteger(maxBuckets) || maxBuckets <= 0
  ) {
    throw new Error("createProviderWebhookRateLimit: invalid options");
  }

  const buckets = new Map<string, Bucket>();

  function sweepExpired(t: number): void {
    for (const [key, bucket] of buckets) {
      if (t - bucket.windowStart >= windowMs) {
        buckets.delete(key);
      }
    }
  }

  return function providerWebhookRateLimit(req: Request, res: Response, next: NextFunction): void {
    const key = resolveProviderWebhookKey(req, provider, readAccountId, accountIdPattern);
    if (key === null) {
      res.status(401).json({ error: "Webhook request refused" });
      return;
    }

    const t = now();
    let bucket = buckets.get(key);

    if (!bucket || t - bucket.windowStart >= windowMs) {
      if (!bucket && buckets.size >= maxBuckets) {
        sweepExpired(t);
        if (buckets.size >= maxBuckets) {
          res.status(429).json({ error: message });
          return;
        }
      }
      bucket = { count: 0, windowStart: t };
      buckets.set(key, bucket);
    }

    bucket.count++;

    if (bucket.count > maxRequests) {
      const retryAfter = Math.max(1, Math.ceil((bucket.windowStart + windowMs - t) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: message });
      return;
    }

    next();
  };
}

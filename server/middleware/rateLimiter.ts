"use strict";
/**
 * ============================================================
 * © 2025 Diploy — a brand of Bisht Technologies Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Distributed under the Envato / CodeCanyon License Agreement.
 * Licensed to the purchaser for use as defined by the
 * Envato Market (CodeCanyon) Regular or Extended License.
 *
 * You are NOT permitted to redistribute, resell, sublicense,
 * or share this source code, in whole or in part.
 * Respect the author's rights and Envato licensing terms.
 * ============================================================
 */

import type { Request, Response, NextFunction } from "express";
import { RateLimitError } from "../utils/errors.ts";
import type { AuthenticatedRequest } from "./errorHandler.ts";

interface RateLimitEntry {
  count: number;
  firstRequest: number;
  lastRequest: number;
}

interface RateLimiterOptions {
  windowMs: number;
  maxRequests: number;
  keyGenerator?: (req: Request) => string;
  skip?: (req: Request) => boolean;
  message?: string;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

const CLEANUP_INTERVAL = 60 * 1000;
let cleanupTimer: NodeJS.Timeout | null = null;

function startCleanup() {
  if (cleanupTimer) return;
  
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    const entries = Array.from(rateLimitStore.entries());
    for (const [key, entry] of entries) {
      if (now - entry.lastRequest > 60 * 60 * 1000) {
        rateLimitStore.delete(key);
      }
    }
  }, CLEANUP_INTERVAL);
  
  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }
}

function defaultKeyGenerator(req: Request): string {
  const authReq = req as AuthenticatedRequest;
  if (authReq.userId) {
    return `user:${authReq.userId}`;
  }
  
  // Key on the socket-derived req.ip only. The raw X-Forwarded-For header is
  // client-controlled and must never select a bucket.
  const ip = req.ip ||
             req.socket.remoteAddress ||
             "unknown";
  
  return `ip:${ip}`;
}

export function createRateLimiter(options: RateLimiterOptions) {
  const {
    windowMs,
    maxRequests,
    keyGenerator = defaultKeyGenerator,
    skip,
    message = "Too many requests, please try again later"
  } = options;

  startCleanup();

  return (req: Request, res: Response, next: NextFunction): void => {
    if (skip && skip(req)) {
      return next();
    }

    const key = keyGenerator(req);
    const now = Date.now();
    
    let entry = rateLimitStore.get(key);
    
    if (!entry || now - entry.firstRequest > windowMs) {
      entry = {
        count: 1,
        firstRequest: now,
        lastRequest: now
      };
      rateLimitStore.set(key, entry);
    } else {
      entry.count++;
      entry.lastRequest = now;
    }

    const remaining = Math.max(0, maxRequests - entry.count);
    const reset = Math.ceil((entry.firstRequest + windowMs - now) / 1000);
    
    res.setHeader("X-RateLimit-Limit", String(maxRequests));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(reset));

    if (entry.count > maxRequests) {
      res.setHeader("Retry-After", String(reset));
      const error = new RateLimitError(message, reset);
      return next(error);
    }

    next();
  };
}

// 60 requests per minute. Keyed by the signed-in user when present, otherwise
// by socket IP (req.ip). Public widget routes are unauthenticated, so they are
// limited per IP.
export const apiRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 60,
  message: "Too many API requests, please try again later"
});

// Webhooks are unauthenticated provider callbacks, so they are keyed by
// route path plus source IP rather than by user.
export const webhookRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 160,
  keyGenerator: (req: Request) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const route = `${req.baseUrl || ""}${req.path || ""}`;
    return `webhook:${route}:${ip}`;
  },
  message: "Too many webhook requests, please try again later"
});

export const authRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 10,
  keyGenerator: (req: Request) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    return `auth:${ip}`;
  },
  message: "Too many login attempts, please try again later"
});

export const strictRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 10,
  message: "Rate limit exceeded for this sensitive operation"
});

export const paymentRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 5,
  message: "Too many payment requests, please wait before trying again"
});

export function getRateLimitStats(): { totalKeys: number; entries: Array<{ key: string; count: number }> } {
  const entries = Array.from(rateLimitStore.entries())
    .map(([key, entry]) => ({ key, count: entry.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  
  return {
    totalKeys: rateLimitStore.size,
    entries
  };
}

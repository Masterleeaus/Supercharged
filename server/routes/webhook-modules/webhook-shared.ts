'use strict';
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
import { Request, Response } from 'express';
import { and } from 'drizzle-orm';
import WebSocket from 'ws';
import { webhookRateLimiter } from '../../middleware/rateLimiter';

/**
 * Runs the shared webhook rate limiter inside a handler. The handlers in this file are mounted
 * from server/routes.ts, so the limiter cannot be added as route middleware here. Resolves true
 * when the request may continue; on overflow it sends 429 and resolves false.
 */
export async function enforceWebhookRateLimit(req: Request, res: Response): Promise<boolean> {
  const allowed = await new Promise<boolean>((resolve) => {
    (webhookRateLimiter as unknown as (q: Request, s: Response, n: (err?: unknown) => void) => void)(
      req,
      res,
      (err?: unknown) => resolve(!err),
    );
  });
  if (!allowed) {
    res.status(429).json({ error: 'Too many webhook requests, please try again later' });
  }
  return allowed;
}

export const activeConnections = new Map<string, WebSocket>();

// Pending call initiation failures cache — handles race condition where
// call_initiation_failure webhook arrives before the SIP call record is created.
// Key: conversation_id, Value: { failure_reason, metadata, timestamp }
export const pendingCallFailures = new Map<string, { failure_reason: string; metadata: any; timestamp: number }>();

// Auto-clean pending failures after 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [key, value] of Array.from(pendingCallFailures.entries())) {
    if (value.timestamp < cutoff) pendingCallFailures.delete(key);
  }
}, 60_000);

/**
 * Check if a conversation_id has a pending failure (race condition handler).
 * Returns the failure reason if found, null otherwise.
 */
export function consumePendingFailure(conversationId: string): { failure_reason: string; metadata: any } | null {
  const pending = pendingCallFailures.get(conversationId);
  if (pending) {
    pendingCallFailures.delete(conversationId);
    return { failure_reason: pending.failure_reason, metadata: pending.metadata };
  }
  return null;
}

/**
 * Helper: Detect PostgreSQL type mismatch errors (varchar vs uuid)
 * Production databases may have uuid-typed columns where schema defines varchar.
 * Error codes: 42804 = datatype_mismatch, 42883 = undefined_function (operator mismatch)
 */
export function isTypeMismatchError(error: any): boolean {
  return error?.code === '42804' || error?.code === '42883' ||
    (error?.message && error.message.includes('character varying') && error.message.includes('uuid'));
}

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

import { logger } from '../utils/logger';
import { db } from "../db";
import { auditLogs } from "@shared/schema";
import { computeAuditHash } from "./audit-chain.mjs";
import { redactArguments, redactString } from "./redaction";

export { computeAuditHash };

export type AuditAction = 
  | "user.login"
  | "user.login_failed"
  | "user.logout"
  | "user.register"
  | "user.password_reset"
  | "user.delete"
  | "admin.login"
  | "admin.user_update"
  | "admin.user_credit_adjust"
  | "admin.plan_update"
  | "admin.settings_update"
  | "admin.api_key_create"
  | "admin.api_key_delete"
  | "payment.subscription_created"
  | "payment.subscription_cancelled"
  | "payment.credits_purchased"
  | "payment.refund"
  | "agent.create"
  | "agent.update"
  | "agent.delete"
  | "campaign.create"
  | "campaign.start"
  | "campaign.pause"
  | "campaign.resume"
  | "campaign.delete"
  | "phone.purchase"
  | "phone.release"
  | "approval.requested"
  | "approval.approved"
  | "approval.rejected"
  | "approval.expired"
  | "approval.revoked"
  | "approval.executed"
  | "policy.evaluated"
  | "security.rate_limit_exceeded"
  | "security.invalid_token"
  | "security.unauthorized_access"
  | "workforce.export"
  | "contacts_merged"
  | "comms.audience_export"
  | "comms.suppression_changed"
  | "comms.draft_created"
  | "comms.draft_edited"
  | "comms.approval_recorded"
  | "comms.message_sent"
  | "comms.assignment_changed"
  | "comms.campaign_changed"
  | "comms.provider_event"
  | "comms.human_override";

export interface AuditLogEntry {
  action: AuditAction;
  userId?: string;
  targetUserId?: string;
  resourceType?: string;
  resourceId?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  severity?: "info" | "warning" | "error" | "critical";
}

const auditLogQueue: AuditLogEntry[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let flushInProgress = false;
let consecutiveFlushFailures = 0;
let overflowRejectedCount = 0;

// Events stay queued until their insert succeeds. The queue is bounded: when it is
// full, the incoming (newest) event is rejected and counted, and the buffered
// (oldest) events are kept for retry.
const AUDIT_FLUSH_INTERVAL_MS = 5000;
const AUDIT_FLUSH_BATCH_SIZE = 500;
const AUDIT_RETRY_BASE_MS = 1000;
const AUDIT_RETRY_MAX_MS = 30000;
const AUDIT_QUEUE_MAX_EVENTS = 10000;

const USER_AGENT_MAX_LENGTH = 500;

/**
 * Redacts secrets from a free-text field and optionally truncates it. Runs
 * before queueing, so the queued value is the persisted value and any hash
 * computed over it (see audit-chain.mjs) covers the redacted text.
 */
function redactFreeText(value: string | undefined, maxLength?: number): string | undefined {
  if (value === undefined) return undefined;
  const { text } = redactString(value);
  return maxLength === undefined ? text : text.substring(0, maxLength);
}

export async function logAuditEvent(entry: AuditLogEntry): Promise<void> {
  const logEntry: AuditLogEntry & { timestamp: string; severity: "info" | "warning" | "error" | "critical" } = {
    ...entry,
    resourceType: redactFreeText(entry.resourceType),
    resourceId: redactFreeText(entry.resourceId),
    userAgent: redactFreeText(entry.userAgent, USER_AGENT_MAX_LENGTH),
    metadata: redactArguments(entry.metadata).result,
    timestamp: new Date().toISOString(),
    severity: entry.severity || getSeverityForAction(entry.action),
  };

  const severityEmoji = {
    info: "ℹ️",
    warning: "⚠️",
    error: "❌",
    critical: "🚨"
  };

  logger.info(`${severityEmoji[logEntry.severity]} [Audit] ${logEntry.action}`, JSON.stringify({
      userId: logEntry.userId,
      targetUserId: logEntry.targetUserId,
      resourceType: logEntry.resourceType,
      resourceId: logEntry.resourceId,
      ip: logEntry.ipAddress,
      ...logEntry.metadata
    }));

  if (auditLogQueue.length >= AUDIT_QUEUE_MAX_EVENTS) {
    recordOverflow();
    return;
  }

  auditLogQueue.push(logEntry);
  scheduleFlush(AUDIT_FLUSH_INTERVAL_MS);
}

function scheduleFlush(delayMs: number): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    void flushAuditLogs();
  }, delayMs);

  if (flushTimer.unref) {
    flushTimer.unref();
  }
}

function recordOverflow(): void {
  overflowRejectedCount += 1;
  if (overflowRejectedCount === 1 || overflowRejectedCount % 100 === 0) {
    logger.error(
      `[Audit] ERROR: audit queue full (${AUDIT_QUEUE_MAX_EVENTS} events buffered, database writes failing). ` +
      `Rejected ${overflowRejectedCount} newest audit event(s) since the last successful flush; oldest events are kept.`
    );
  }
}

function getSeverityForAction(action: AuditAction): "info" | "warning" | "error" | "critical" {
  const severityMap: Record<string, "info" | "warning" | "error" | "critical"> = {
    "security.rate_limit_exceeded": "warning",
    "security.invalid_token": "warning",
    "security.unauthorized_access": "error",
    "user.login_failed": "warning",
    "admin.user_delete": "warning",
    "admin.api_key_delete": "warning",
    "payment.refund": "warning",
    "user.delete": "warning",
    "user.password_reset": "info",
    "user.login": "info",
    "user.register": "info",
    "admin.login": "info",
    "payment.credits_purchased": "info",
    "payment.subscription_created": "info",
    "approval.rejected": "warning",
    "approval.expired": "warning"
  };
  
  return severityMap[action] || "info";
}

async function flushAuditLogs(): Promise<void> {
  flushTimer = null;

  // Only one flush runs at a time. A flush already in progress drains any events
  // queued while it runs, so the caller can return without writing.
  if (flushInProgress) return;
  flushInProgress = true;

  try {
    while (auditLogQueue.length > 0) {
      // Oldest events first. They stay at the head of the queue until the insert
      // succeeds, so a failed batch is retried in its original order.
      const batch = auditLogQueue.slice(0, AUDIT_FLUSH_BATCH_SIZE);

      try {
        const insertValues = batch.map(log => ({
          action: log.action,
          userId: log.userId || null,
          targetUserId: log.targetUserId || null,
          resourceType: log.resourceType || null,
          resourceId: log.resourceId || null,
          ipAddress: log.ipAddress || null,
          userAgent: log.userAgent || null, // already redacted and truncated in logAuditEvent
          metadata: log.metadata || {},
          severity: log.severity || "info"
        }));

        await db.insert(auditLogs).values(insertValues);
      } catch (error: unknown) {
        consecutiveFlushFailures += 1;
        const delayMs = Math.min(
          AUDIT_RETRY_BASE_MS * 2 ** (consecutiveFlushFailures - 1),
          AUDIT_RETRY_MAX_MS
        );
        logger.error(
          `[Audit] Failed to flush ${batch.length} event(s); ${auditLogQueue.length} buffered, ` +
          `retry ${consecutiveFlushFailures} in ${delayMs}ms:`, error
        );
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        scheduleFlush(delayMs);
        return;
      }

      auditLogQueue.splice(0, batch.length);
      consecutiveFlushFailures = 0;
    }

    if (overflowRejectedCount > 0) {
      logger.error(
        `[Audit] Queue drained after outage; ${overflowRejectedCount} newest audit event(s) were rejected while it was full.`
      );
      overflowRejectedCount = 0;
    }
  } finally {
    flushInProgress = false;
  }
}

const SHUTDOWN_FLUSH_POLL_MS = 50;
const SHUTDOWN_FLUSH_RETRY_GAP_MS = 250;

/**
 * Best-effort final flush of buffered audit events, for use during process shutdown.
 * Meant to be called from the existing shutdown path (graceful-shutdown.ts), before
 * the database pool closes. Bounded by timeoutMs: events still queued at the deadline
 * are reported and lost. Never throws.
 */
export async function flushAuditLogsOnShutdown(timeoutMs = 5000): Promise<void> {
  try {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

    const drain = async (): Promise<void> => {
      while (auditLogQueue.length > 0 && Date.now() < deadline) {
        if (flushInProgress) {
          // A timer-driven flush is running; wait for it to finish instead of returning early.
          await sleep(SHUTDOWN_FLUSH_POLL_MS);
          continue;
        }
        const before = auditLogQueue.length;
        await flushAuditLogs();
        if (auditLogQueue.length >= before) {
          // Insert failed. Pause briefly before retrying, but never past the deadline.
          await sleep(Math.min(SHUTDOWN_FLUSH_RETRY_GAP_MS, Math.max(0, deadline - Date.now())));
        }
      }
    };

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>(resolve => {
      timer = setTimeout(resolve, Math.max(0, timeoutMs));
    });
    try {
      await Promise.race([drain(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (auditLogQueue.length > 0) {
      logger.error(
        `[Audit] Shutdown flush stopped after ${timeoutMs}ms; ${auditLogQueue.length} audit event(s) not persisted.`
      );
    }
  } catch (error: unknown) {
    logger.error("[Audit] Shutdown flush failed:", error);
  }
}

export function extractRequestInfo(req: any): { ipAddress: string; userAgent: string } {
  // req.ip honours the app's trust proxy setting (TRUST_PROXY); X-Forwarded-For is not read directly.
  const ipAddress = req.ip ||
    req.socket?.remoteAddress ||
    "unknown";
    
  const userAgent = req.headers?.["user-agent"] || "unknown";
  
  return { ipAddress, userAgent };
}

export async function logUserLogin(userId: string, req: any, success: boolean): Promise<void> {
  const { ipAddress, userAgent } = extractRequestInfo(req);
  
  await logAuditEvent({
    action: success ? "user.login" : "user.login_failed",
    userId: success ? userId : undefined,
    ipAddress,
    userAgent,
    metadata: { email: req.body?.email },
    severity: success ? "info" : "warning"
  });
}

export async function logAdminAction(
  adminUserId: string, 
  action: AuditAction, 
  targetUserId: string | undefined, 
  resourceType: string, 
  resourceId: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await logAuditEvent({
    action,
    userId: adminUserId,
    targetUserId,
    resourceType,
    resourceId,
    metadata
  });
}

export async function logPaymentEvent(
  userId: string,
  action: AuditAction,
  metadata: Record<string, unknown>
): Promise<void> {
  await logAuditEvent({
    action,
    userId,
    resourceType: "payment",
    metadata,
    severity: action === "payment.refund" ? "warning" : "info"
  });
}

export async function logSecurityEvent(
  action: AuditAction,
  req: any,
  userId?: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  const { ipAddress, userAgent } = extractRequestInfo(req);
  
  await logAuditEvent({
    action,
    userId,
    ipAddress,
    userAgent,
    metadata,
    severity: action === "security.unauthorized_access" ? "error" : "warning"
  });
}

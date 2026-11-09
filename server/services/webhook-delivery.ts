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
import crypto from 'crypto';
import { storage } from '../storage';
import { db } from '../db';
import { webhooks, webhookLogs, Webhook, WebhookLog } from '@shared/schema';

// Table insert shape for webhook logs; the drizzle-zod insert type resolves to {}.
type WebhookLogInsertRow = typeof webhookLogs.$inferInsert;
import { eq, and, desc } from 'drizzle-orm';
import { validateWebhookUrl } from '../utils/url-validator';

export interface WebhookPayload {
  event: string;
  timestamp: string;
  data: Record<string, any>;
}

export interface DeliveryResult {
  success: boolean;
  httpStatus?: number;
  responseBody?: string;
  responseTime?: number;
  error?: string;
}

const RETRY_DELAYS = [0, 60000, 300000]; // 0s, 1min, 5min

// Header names the platform sets itself. Tenant custom headers may not use them (any casing).
const RESERVED_HEADER_NAMES = new Set([
  'authorization',
  'content-type',
  'content-length',
  'host',
  'connection',
  'transfer-encoding',
  'user-agent',
  'x-webhook-event',
  'x-webhook-delivery',
  'x-webhook-signature',
]);

export class WebhookDeliveryService {
  private generateSignature(payload: string, secret: string): string {
    return crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');
  }

  private buildHeaders(webhook: Webhook, payloadString: string, deliveryId: string): Record<string, string> {
    const headers: Record<string, string> = {};

    // Custom headers go first. Reserved names are skipped here and then set below,
    // so a custom header can never replace the signature, delivery id or auth.
    if (webhook.headers && typeof webhook.headers === 'object') {
      for (const [name, value] of Object.entries(webhook.headers as Record<string, unknown>)) {
        if (typeof value !== 'string') continue;
        if (RESERVED_HEADER_NAMES.has(name.toLowerCase())) continue;
        headers[name] = value;
      }
    }

    headers['Content-Type'] = 'application/json';
    headers['User-Agent'] = 'Platform-Webhook/1.0';
    headers['X-Webhook-Event'] = webhook.events?.[0] || 'unknown';
    headers['X-Webhook-Delivery'] = deliveryId;
    headers['X-Webhook-Signature'] = `sha256=${this.generateSignature(payloadString, webhook.secret)}`;

    if (webhook.authType === 'basic' && webhook.authCredentials) {
      const creds = webhook.authCredentials as { username?: string; password?: string };
      if (creds.username && creds.password) {
        const basicAuth = Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
        headers['Authorization'] = `Basic ${basicAuth}`;
      }
    } else if (webhook.authType === 'bearer' && webhook.authCredentials) {
      const creds = webhook.authCredentials as { token?: string };
      if (creds.token) {
        headers['Authorization'] = `Bearer ${creds.token}`;
      }
    }

    return headers;
  }

  async deliverWebhook(
    webhook: Webhook,
    payload: WebhookPayload,
    attemptNumber: number = 1,
    deliveryId: string = crypto.randomUUID()
  ): Promise<DeliveryResult> {
    const payloadString = JSON.stringify(payload);
    const headers = this.buildHeaders(webhook, payloadString, deliveryId);
    const startTime = Date.now();

    logger.info(`📤 [Webhook] Delivering to ${webhook.url} (attempt ${attemptNumber})`);
    logger.info(`   Event: ${payload.event}`);

    try {
      const urlCheck = await validateWebhookUrl(webhook.url);
      if (!urlCheck.valid) {
        logger.warn(`🚫 [Webhook] SSRF blocked: ${urlCheck.error} for URL ${webhook.url}`);
        return {
          success: false,
          httpStatus: 0,
          responseBody: `Blocked: ${urlCheck.error}`,
          responseTime: 0,
          error: urlCheck.error,
        };
      }

      const response = await fetch(webhook.url, {
        method: webhook.method || 'POST',
        headers,
        body: payloadString,
        signal: AbortSignal.timeout(30000),
        redirect: 'error',
      });

      const responseTime = Date.now() - startTime;
      let responseBody = '';
      
      try {
        responseBody = await response.text();
        if (responseBody.length > 10000) {
          responseBody = responseBody.substring(0, 10000) + '...[truncated]';
        }
      } catch {
        responseBody = 'Unable to read response body';
      }

      const success = response.ok;
      
      logger.info(`${success ? '✅' : '❌'} [Webhook] Status: ${response.status}, Time: ${responseTime}ms`);

      return {
        success,
        httpStatus: response.status,
        responseBody,
        responseTime,
      };
    } catch (error: unknown) {
      const responseTime = Date.now() - startTime;
      const errorMessage = error instanceof Error && error.name === 'TimeoutError'
        ? 'Request timed out after 30 seconds'
        : (error instanceof Error && error.message) || 'Unknown error';

      logger.error(`❌ [Webhook] Delivery failed: ${errorMessage}`);

      return {
        success: false,
        responseTime,
        error: errorMessage,
      };
    }
  }

  async deliverWithRetry(
    webhook: Webhook,
    payload: WebhookPayload,
    companyId: string | null,
    maxAttemptsInput: number = 3
  ): Promise<void> {
    // Normalise to a finite integer >= 1. A fractional value would skip the
    // final-attempt check (dead_letter never written), and NaN or Infinity would
    // either skip the loop or never end.
    const maxAttempts = Number.isFinite(maxAttemptsInput)
      ? Math.max(1, Math.floor(maxAttemptsInput))
      : 3;

    // One id per delivery. Every retry reuses it so a receiver can drop repeats.
    const deliveryId = crypto.randomUUID();

    // Ids of earlier rows this delivery wrote with 'retrying'. Once the delivery
    // ends, each of them is moved to 'superseded' so none stays 'retrying'.
    const retryingRowIds: number[] = [];
    // Whether the row for the latest attempt was written. Earlier rows are only
    // superseded when the terminal row exists, so a failed write does not hide history.
    let latestAttemptLogged = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await this.deliverWebhook(webhook, payload, attempt, deliveryId);

      // delivery_status: 'delivered' on success, 'retrying' while attempts remain,
      // 'dead_letter' on the final failed attempt (error carries the last failure).
      // Earlier 'retrying' rows become 'superseded' once the delivery ends (see supersedeEarlierAttempts).
      const deliveryStatus = result.success ? 'delivered' : attempt < maxAttempts ? 'retrying' : 'dead_letter';
      const lastError = deliveryStatus === 'dead_letter'
        ? (result.error || (result.httpStatus ? `HTTP ${result.httpStatus}` : null))
        : (result.error || null);

      // insertWebhookLogSchema omits companyId, so widen the type here.
      const logData: WebhookLogInsertRow & { companyId: string | null } = {
        webhookId: webhook.id,
        event: payload.event,
        payload: payload,
        success: result.success,
        httpStatus: result.httpStatus || null,
        responseBody: result.responseBody || null,
        responseTime: result.responseTime || null,
        error: lastError,
        attemptNumber: attempt,
        maxAttempts,
        nextRetryAt: null,
        deliveryStatus,
        companyId,
      };

      if (!result.success && attempt < maxAttempts) {
        const delay = RETRY_DELAYS[attempt] || 300000;
        logData.nextRetryAt = new Date(Date.now() + delay);
        logger.info(`⏳ [Webhook] Scheduling retry in ${delay / 1000}s`);
      }

      latestAttemptLogged = false;
      try {
        // Check if webhook still exists before logging (might have been deleted)
        const webhookExists = await storage.getWebhook(webhook.id);
        if (webhookExists) {
          const newLog = await storage.createWebhookLog(logData);
          latestAttemptLogged = true;
          if (deliveryStatus === 'retrying' && newLog?.id !== undefined) {
            retryingRowIds.push(newLog.id);
          }
        } else {
          logger.warn(`ℹ️ [Webhook] Skipping log - webhook ${webhook.id} was deleted`);
        }
      } catch (err: unknown) {
        // Handle foreign key constraint violations gracefully (webhook was deleted)
        const errCode = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
        const errMessage = err instanceof Error ? err.message : '';
        if (errCode === '23503' || errMessage.includes('foreign key constraint')) {
          logger.warn(`ℹ️ [Webhook] Skipping log - webhook ${webhook.id} no longer exists`);
        } else {
          logger.error(`❌ [Webhook] Failed to log delivery:`, err);
        }
      }

      if (result.success) {
        logger.info(`✅ [Webhook] Delivery successful on attempt ${attempt}`);
        if (latestAttemptLogged) {
          await this.supersedeEarlierAttempts(retryingRowIds);
        }
        return;
      }

      if (attempt < maxAttempts) {
        const delay = RETRY_DELAYS[attempt] || 60000;
        logger.info(`⏳ [Webhook] Waiting ${delay / 1000}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    // The loop only reaches here when the final attempt failed and was written as dead_letter.
    if (latestAttemptLogged) {
      await this.supersedeEarlierAttempts(retryingRowIds);
    }
    logger.error(`❌ [Webhook] All ${maxAttempts} attempts failed for ${webhook.url}`);
  }

  /**
   * Moves earlier attempt rows of one delivery from 'retrying' to 'superseded'.
   * The latest row carries the delivery's outcome (delivered or dead_letter), so
   * only one row per delivery shows as dead-lettered. Each row keeps its own
   * success flag and error, so the per-attempt history is still readable.
   * A failed update is logged and does not change the delivery outcome.
   */
  private async supersedeEarlierAttempts(rowIds: number[]): Promise<void> {
    for (const rowId of rowIds) {
      try {
        await storage.updateWebhookLog(rowId, { deliveryStatus: 'superseded', nextRetryAt: null });
      } catch (err) {
        logger.error(`❌ [Webhook] Failed to supersede earlier attempt row ${rowId}:`, err);
      }
    }
  }

  async triggerEvent(
    companyId: string,
    userId: string,
    event: string,
    data: Record<string, any>,
    campaignId?: string | null
  ): Promise<void> {
    // Fail closed: without a company there is no tenant to deliver for.
    if (!companyId) {
      logger.error(`❌ [Webhook] Refused dispatch of ${event}: company context missing`);
      return;
    }

    logger.info(`🔔 [Webhook] Triggering event: ${event}`);
    logger.info(`   UserId: ${userId}, CampaignId: ${campaignId || 'N/A'}`);

    try {
      const webhooks = (await storage.getWebhooksForEvent(userId, event, campaignId || undefined))
        .filter((webhook) => webhook.companyId === companyId);

      if (webhooks.length === 0) {
        logger.info(`ℹ️ [Webhook] No webhooks configured for event: ${event}`);
        return;
      }

      logger.info(`📤 [Webhook] Found ${webhooks.length} webhook(s) to deliver`);

      const payload: WebhookPayload = {
        event,
        timestamp: new Date().toISOString(),
        data,
      };

      const deliveryPromises = webhooks.map(webhook =>
        this.deliverWithRetry(webhook, payload, companyId).catch(err => {
          logger.error(`❌ [Webhook] Error delivering to ${webhook.url}:`, err);
        })
      );

      await Promise.allSettled(deliveryPromises);
      
      logger.info(`✅ [Webhook] Event ${event} processing complete`);
    } catch (error) {
      logger.error(`❌ [Webhook] Error triggering event ${event}:`, error);
    }
  }

  async testWebhook(companyId: string, webhookId: string, userId: string): Promise<{
    success: boolean;
    statusCode: number;
    responseTime: number;
    responseBody: string;
    error?: string;
  }> {
    if (!companyId) {
      throw new Error('Company context required');
    }

    const [webhook] = await db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.id, webhookId), eq(webhooks.userId, userId), eq(webhooks.companyId, companyId)));

    if (!webhook) {
      throw new Error('Webhook not found');
    }

    const testPayload: WebhookPayload = {
      event: 'webhook.test',
      timestamp: new Date().toISOString(),
      data: {
        test: true,
        message: 'This is a test webhook from your platform',
      }
    };

    logger.info(`🧪 Testing webhook ${webhookId}...`);

    const result = await this.deliverWebhook(webhook, testPayload, 1);

    return {
      success: result.success,
      statusCode: result.httpStatus || 0,
      responseTime: result.responseTime || 0,
      responseBody: result.responseBody || '',
      error: result.error
    };
  }

  async retryWebhook(companyId: string, logId: number, userId: string): Promise<{
    success: boolean;
    newLogId?: number;
    error?: string;
  }> {
    if (!companyId) {
      throw new Error('Company context required');
    }

    const [log] = await db
      .select()
      .from(webhookLogs)
      .where(eq(webhookLogs.id, logId));

    // A log under another company is reported as not found, not as access denied.
    if (!log || (log.companyId && log.companyId !== companyId)) {
      throw new Error('Webhook log not found');
    }

    const [webhook] = await db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.id, log.webhookId!), eq(webhooks.userId, userId), eq(webhooks.companyId, companyId)));

    if (!webhook) {
      throw new Error('Webhook not found or access denied');
    }

    logger.info(`🔄 Manually retrying webhook ${webhook.id} (log ${logId})...`);

    const payload: WebhookPayload = {
      event: log.event,
      timestamp: new Date().toISOString(),
      data: (log.payload as { data?: WebhookPayload['data'] } | null)?.data || (log.payload as WebhookPayload['data'])
    };

    const attempt = 1;
    const maxAttempts = 1;
    const result = await this.deliverWebhook(webhook, payload, attempt);

    // Same status rule as deliverWithRetry. A manual retry is a single attempt,
    // so a failure here is the final attempt and becomes a dead letter.
    const deliveryStatus = result.success ? 'delivered' : attempt < maxAttempts ? 'retrying' : 'dead_letter';
    const lastError = deliveryStatus === 'dead_letter'
      ? (result.error || (result.httpStatus ? `HTTP ${result.httpStatus}` : null))
      : (result.error || null);

    // insertWebhookLogSchema omits companyId, so widen the type here.
    const logData: WebhookLogInsertRow & { companyId: string | null } = {
      webhookId: webhook.id,
      event: log.event,
      payload: log.payload,
      success: result.success,
      httpStatus: result.httpStatus || null,
      responseBody: result.responseBody || null,
      responseTime: result.responseTime || null,
      error: lastError,
      attemptNumber: attempt,
      maxAttempts,
      nextRetryAt: null,
      deliveryStatus,
      // Keep the tenant the original delivery was logged under. Fall back to the
      // subscription's company only for legacy logs that have no company_id.
      companyId: log.companyId ?? webhook.companyId ?? null,
    };

    try {
      const newLog = await storage.createWebhookLog(logData);
      return {
        success: result.success,
        newLogId: newLog?.id,
        error: result.error
      };
    } catch (err) {
      logger.error(`❌ [Webhook] Failed to log retry:`, err);
      return {
        success: result.success,
        error: result.error
      };
    }
  }
}

/**
 * Returns outbound webhook log rows with delivery_status = 'dead_letter' for one company.
 * webhook_logs carries company_id (schema column; populated by the company-scope migration).
 */
export async function listOutboundDeadLetters(companyId: string, limit = 100): Promise<WebhookLog[]> {
  if (!companyId) {
    throw new Error('listOutboundDeadLetters requires a companyId');
  }
  return db
    .select()
    .from(webhookLogs)
    .where(and(
      eq(webhookLogs.deliveryStatus, 'dead_letter'),
      eq(webhookLogs.companyId, companyId),
    ))
    .orderBy(desc(webhookLogs.createdAt))
    .limit(limit);
}

export const webhookDeliveryService = new WebhookDeliveryService();

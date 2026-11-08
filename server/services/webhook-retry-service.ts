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

import { storage } from '../storage';
import { db } from '../db';
import { paymentWebhookQueue } from '@shared/schema';
import type { PaymentWebhookQueue, InsertPaymentWebhookQueue } from '@shared/schema';
import { and, desc, eq, sql } from 'drizzle-orm';

// Default retry delays - used as fallback if database unavailable
const DEFAULT_RETRY_INTERVALS_MINUTES = [1, 5, 15, 30, 60];
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WEBHOOK_EXPIRY_HOURS = 24;

// Dead-letter state: reuses the existing terminal status 'failed' (no new enum value).
// A row is dead-lettered when status is 'failed' and attemptCount >= maxAttempts.
const DEAD_LETTER_STATUS = 'failed';

// Cache for webhook settings
let cachedRetryIntervals: number[] = DEFAULT_RETRY_INTERVALS_MINUTES;
let cachedMaxAttempts: number = DEFAULT_MAX_ATTEMPTS;
let cachedExpiryHours: number = DEFAULT_WEBHOOK_EXPIRY_HOURS;
let settingsCacheTime: number = 0;
const SETTINGS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function loadWebhookSettings(): Promise<void> {
  const now = Date.now();
  if ((now - settingsCacheTime) < SETTINGS_CACHE_TTL) {
    return;
  }
  
  try {
    const [intervalsSetting, maxAttemptsSetting, expirySetting] = await Promise.all([
      storage.getGlobalSetting('webhook_retry_intervals_minutes'),
      storage.getGlobalSetting('webhook_retry_max_attempts'),
      storage.getGlobalSetting('webhook_expiry_hours'),
    ]);
    
    if (Array.isArray(intervalsSetting?.value)) {
      cachedRetryIntervals = intervalsSetting.value;
    }
    if (typeof maxAttemptsSetting?.value === 'number') {
      cachedMaxAttempts = maxAttemptsSetting.value;
    }
    if (typeof expirySetting?.value === 'number') {
      cachedExpiryHours = expirySetting.value;
    }
    settingsCacheTime = now;
  } catch (error) {
    console.error('[WebhookRetry] Failed to load settings from database, using defaults:', error);
  }
}

function getRetryDelayMs(attemptNumber: number): number {
  const intervalMinutes = cachedRetryIntervals[attemptNumber - 1] || cachedRetryIntervals[cachedRetryIntervals.length - 1] || 60;
  return intervalMinutes * 60 * 1000;
}

function getMaxAttempts(): number {
  return cachedMaxAttempts;
}

function getExpiryHours(): number {
  return cachedExpiryHours;
}

function isDeadLetter(webhook: PaymentWebhookQueue): boolean {
  return webhook.status === DEAD_LETTER_STATUS &&
    (webhook.attemptCount || 0) >= (webhook.maxAttempts || getMaxAttempts());
}

const SCHEDULER_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

type WebhookOutcomeStatus = 'completed' | 'pending' | typeof DEAD_LETTER_STATUS;

// Only rows waiting for a retry or already dead-lettered can be replayed by an operator.
// 'processing', 'completed' and 'expired' are refused so a finished event is not run twice.
const REPLAYABLE_STATUSES = new Set<string>(['pending', 'failed']);

export type CompanyReprocessOutcome =
  | { ok: true; status: WebhookOutcomeStatus }
  | { ok: false; reason: 'missing_scope' | 'not_found' | 'not_replayable' };

type ReprocessResult = { success: boolean; action?: string; error?: string };
type Reprocessor = (eventType: string, payload: any) => Promise<ReprocessResult>;

// Each reprocessor mirrors the dispatch in the gateway's live webhook route, so a retried
// event goes through the same handler, with the same arguments, as the original delivery.
// Stripe and Razorpay queue event.data.object and event.payload respectively; Paystack queues data.
// Handler modules load lazily so this service does not pull in gateway code until a retry runs.
async function reprocessStripe(eventType: string, object: any): Promise<ReprocessResult> {
  const h = await import('../engines/payment/gateways/stripe/handlers');
  switch (eventType) {
    case 'checkout.session.completed':
      return h.handleCheckoutSessionCompleted(object);
    case 'invoice.payment_succeeded':
      return h.handleInvoicePaymentSucceeded(object);
    case 'invoice.payment_failed':
      return h.handleInvoicePaymentFailed(object);
    case 'customer.subscription.deleted':
      return h.handleSubscriptionDeleted(object);
    case 'customer.subscription.updated':
      return h.handleSubscriptionUpdated(object);
    case 'charge.dispute.created':
      return h.handleChargeDispute(object);
    case 'charge.refunded':
      return h.handleChargeRefunded(object);
    default:
      return { success: true, action: 'unhandled' };
  }
}

async function reprocessRazorpay(eventType: string, payload: any): Promise<ReprocessResult> {
  const h = await import('../engines/payment/gateways/razorpay/handlers');
  const subscription = payload?.subscription?.entity;
  const payment = payload?.payment?.entity;
  switch (eventType) {
    case 'subscription.authenticated':
      return h.handleSubscriptionAuthenticated();
    case 'subscription.activated':
      return h.handleSubscriptionActivated(subscription, payment);
    case 'subscription.charged':
      return h.handleSubscriptionCharged(subscription, payment);
    case 'subscription.pending':
      return h.handleSubscriptionPending(subscription);
    case 'subscription.halted':
      return h.handleSubscriptionHalted(subscription);
    case 'subscription.cancelled':
      return h.handleSubscriptionCancelled(subscription);
    case 'subscription.completed':
      return h.handleSubscriptionCompleted(subscription);
    case 'payment.captured':
      return h.handlePaymentCaptured(payment);
    case 'payment.failed':
      return h.handlePaymentFailed(payment);
    case 'refund.created':
      return h.handleRefundCreated(payload?.refund?.entity, payload?.payment?.entity);
    case 'payment.dispute.created':
    case 'payment.dispute.won':
    case 'payment.dispute.lost':
      return h.handleDispute(payload?.dispute?.entity, payload?.payment?.entity);
    default:
      return { success: true, action: 'unhandled' };
  }
}

async function reprocessPaystack(eventType: string, data: any): Promise<ReprocessResult> {
  const h = await import('../engines/payment/gateways/paystack/handlers');
  switch (eventType) {
    case 'charge.success':
      return h.handleChargeSuccess(data);
    case 'subscription.create':
      return h.handleSubscriptionCreate(data);
    case 'subscription.disable':
      return h.handleSubscriptionDisable(data);
    case 'subscription.not_renew':
      return h.handleSubscriptionNotRenew(data);
    case 'invoice.create':
      return h.handleInvoiceCreate(data);
    case 'invoice.payment_failed':
      return h.handleInvoicePaymentFailed(data);
    case 'transfer.success':
      return h.handleTransferSuccess(data);
    case 'transfer.failed':
      return h.handleTransferFailed(data);
    case 'refund.processed':
      return h.handleRefundProcessed(data);
    case 'charge.dispute.create':
    case 'charge.dispute.remind':
    case 'charge.dispute.resolve':
      return h.handleChargeback(data);
    case 'paymentrequest.pending':
      return h.handlePaymentRequestPending(data);
    case 'paymentrequest.success':
      return h.handlePaymentRequestSuccess(data);
    default:
      return { success: true, action: 'unhandled' };
  }
}

// A Map rather than a plain object, so lookups like 'constructor' cannot hit Object.prototype.
// Absent on purpose: PayPal and MercadoPago have no handler module here, and YooKassa's route
// never queues failed events, so no dead-letter rows exist for it to retry.
const REPROCESSORS = new Map<string, Reprocessor>([
  ['stripe', reprocessStripe],
  ['razorpay', reprocessRazorpay],
  ['paystack', reprocessPaystack],
]);

export class WebhookRetryService {
  private schedulerInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;

  start(): void {
    if (this.schedulerInterval) {
      console.log('⚠️ [WebhookRetry] Scheduler already running');
      return;
    }

    console.log('🚀 [WebhookRetry] Starting webhook retry scheduler (runs every 5 minutes)');
    
    this.schedulerInterval = setInterval(() => {
      this.processRetryableWebhooks().catch(err => {
        console.error('❌ [WebhookRetry] Error in scheduled processing:', err);
      });
    }, SCHEDULER_INTERVAL_MS);

    this.processRetryableWebhooks().catch(err => {
      console.error('❌ [WebhookRetry] Error in initial processing:', err);
    });
  }

  stop(): void {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
      console.log('⏹️ [WebhookRetry] Scheduler stopped');
    }
  }

  async processRetryableWebhooks(): Promise<void> {
    if (this.isProcessing) {
      console.log('⏳ [WebhookRetry] Already processing, skipping this cycle');
      return;
    }

    this.isProcessing = true;

    try {
      // Load latest settings from database
      await loadWebhookSettings();
      
      await this.markExpired();

      // Dead-letter rows are never retried, even if the storage query returns them.
      const webhooks = (await storage.getRetryableWebhooks()).filter(w => !isDeadLetter(w));

      if (webhooks.length === 0) {
        return;
      }

      console.log(`📋 [WebhookRetry] Processing ${webhooks.length} retryable webhook(s)`);

      for (const webhook of webhooks) {
        try {
          await this.processWebhook(webhook);
        } catch (error: any) {
          console.error(`❌ [WebhookRetry] Error processing webhook ${webhook.id}:`, error);
        }
      }

      console.log(`✅ [WebhookRetry] Finished processing ${webhooks.length} webhook(s)`);
    } catch (error: any) {
      console.error('❌ [WebhookRetry] Error in processRetryableWebhooks:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  async processWebhook(webhook: PaymentWebhookQueue): Promise<void> {
    if (isDeadLetter(webhook)) {
      console.log(`🪦 [WebhookRetry] Webhook ${webhook.id} is dead-lettered; not retrying`);
      return;
    }

    // The scheduler's copy of the row can be stale: an operator replay may already own it.
    if (!(await this.claimReplayableRow(webhook.id))) {
      console.log(`⏭️ [WebhookRetry] Webhook ${webhook.id} is no longer replayable (claimed or finished); skipping`);
      return;
    }

    await this.attemptWebhook(webhook);
  }

  /**
   * Atomic claim shared by the scheduler and operator replay. Moves the row to 'processing' only
   * if it is still pending or failed and, when companyId is given, still belongs to that company.
   * Returns false when another attempt holds the row, so the caller must run no handler.
   */
  private async claimReplayableRow(queueId: string, companyId?: string): Promise<boolean> {
    const claimed = await db
      .update(paymentWebhookQueue)
      .set({ status: 'processing', lastAttemptAt: new Date() })
      .where(and(
        eq(paymentWebhookQueue.id, queueId),
        companyId ? eq(paymentWebhookQueue.companyId, companyId) : undefined,
        // Literal list kept in step with REPLAYABLE_STATUSES ('pending', 'failed').
        sql`${paymentWebhookQueue.status} in ('pending', 'failed')`,
      ))
      .returning({ id: paymentWebhookQueue.id });
    return claimed.length > 0;
  }

  /**
   * Runs one attempt and records its outcome. Returns the status written to the row.
   * Callers must have already checked the row's company and dead-letter state.
   */
  private async attemptWebhook(webhook: PaymentWebhookQueue): Promise<WebhookOutcomeStatus> {
    const attemptCount = (webhook.attemptCount || 0) + 1;

    console.log(`🔄 [WebhookRetry] Processing webhook ${webhook.id} (${webhook.gateway}/${webhook.eventType}) - Attempt ${attemptCount}/${getMaxAttempts()}`);

    try {
      await storage.updateWebhookQueueItem(webhook.id, {
        status: 'processing',
        lastAttemptAt: new Date(),
      });

      const result = await this.reprocessWebhookEvent(webhook);

      if (result.success) {
        await storage.updateWebhookQueueItem(webhook.id, {
          status: 'completed',
          processedAt: new Date(),
          attemptCount,
        });
        console.log(`✅ [WebhookRetry] Successfully processed webhook ${webhook.id}`);
        return 'completed';
      } else {
        throw new Error(result.error || 'Unknown error during reprocessing');
      }
    } catch (error: any) {
      const errorMessage = error.message || 'Unknown error';
      const errorHistory = [...(webhook.errorHistory || []), {
        attempt: attemptCount,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      }];

      if (attemptCount >= getMaxAttempts()) {
        await storage.updateWebhookQueueItem(webhook.id, {
          status: DEAD_LETTER_STATUS,
          attemptCount,
          maxAttempts: getMaxAttempts(),
          lastError: errorMessage,
          errorHistory,
        });
        console.log(`🪦 [WebhookRetry] Webhook ${webhook.id} dead-lettered after ${getMaxAttempts()} attempts`);
        return DEAD_LETTER_STATUS;
      } else {
        const nextRetryAt = this.calculateNextRetry(attemptCount);
        await storage.updateWebhookQueueItem(webhook.id, {
          status: 'pending',
          attemptCount,
          lastError: errorMessage,
          errorHistory,
          nextRetryAt,
        });
        console.log(`⏳ [WebhookRetry] Webhook ${webhook.id} will retry at ${nextRetryAt.toISOString()}`);
        return 'pending';
      }
    }
  }

  /**
   * Operator-initiated replay of one queued event, scoped to one company.
   * Loads the row by id, refuses unless it belongs to companyId, then runs the same attempt
   * path as the scheduler (same handler, same outcome marking). Dead-lettered rows are allowed
   * here because a manual replay is the way out of the dead-letter state.
   * Missing and other-company rows return the same 'not_found' answer, so ids cannot be probed.
   */
  async reprocessForCompany(companyId: string, queueId: string): Promise<CompanyReprocessOutcome> {
    if (!companyId || !queueId) {
      return { ok: false, reason: 'missing_scope' };
    }

    const item = await storage.getWebhookQueueItem(queueId);
    if (!item || !item.companyId || item.companyId !== companyId) {
      return { ok: false, reason: 'not_found' };
    }

    if (!REPLAYABLE_STATUSES.has(item.status)) {
      return { ok: false, reason: 'not_replayable' };
    }

    // Atomic claim: the row moves to 'processing' only if it is still replayable and still
    // belongs to this company. A concurrent replay or scheduler attempt that holds it runs no handler.
    if (!(await this.claimReplayableRow(queueId, companyId))) {
      return { ok: false, reason: 'not_replayable' };
    }

    const status = await this.attemptWebhook(item);
    return { ok: true, status };
  }

  calculateNextRetry(attemptCount: number): Date {
    const delayMs = getRetryDelayMs(attemptCount);
    return new Date(Date.now() + delayMs);
  }

  async markExpired(): Promise<void> {
    try {
      const expiredWebhooks = await storage.getExpiredWebhooks();
      
      if (expiredWebhooks.length === 0) {
        return;
      }

      console.log(`⏰ [WebhookRetry] Marking ${expiredWebhooks.length} webhook(s) as expired`);

      for (const webhook of expiredWebhooks) {
        await storage.updateWebhookQueueItem(webhook.id, {
          status: 'expired',
        });
      }
    } catch (error: any) {
      console.error('❌ [WebhookRetry] Error marking expired webhooks:', error);
    }
  }

  private async reprocessWebhookEvent(webhook: PaymentWebhookQueue): Promise<{ success: boolean; error?: string }> {
    const reprocessor = REPROCESSORS.get(webhook.gateway);
    if (!reprocessor) {
      // No handler for this gateway. Report failure rather than fake success.
      return {
        success: false,
        error: `Reprocessing not implemented for ${webhook.gateway} event ${webhook.eventType}`,
      };
    }

    try {
      console.log(`🔍 [WebhookRetry] Re-processing ${webhook.gateway} event: ${webhook.eventType}`);

      const result = await reprocessor(webhook.eventType, webhook.payload);
      if (result?.success) {
        return { success: true };
      }
      return {
        success: false,
        error: result?.error || `Handler reported failure for ${webhook.gateway} event ${webhook.eventType}`,
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}

export async function queueFailedWebhook(
  gateway: string,
  eventType: string,
  eventId: string,
  payload: any,
  error: string,
  userId?: string
): Promise<void> {
  try {
    const existingWebhook = await storage.getWebhookByEventId(gateway, eventId);
    if (existingWebhook) {
      console.log(`ℹ️ [WebhookRetry] Webhook with eventId ${eventId} already queued, skipping`);
      return;
    }

    // Load latest settings before queueing
    await loadWebhookSettings();
    const expiresAt = new Date(Date.now() + getExpiryHours() * 60 * 60 * 1000);

    const queueItem: InsertPaymentWebhookQueue = {
      gateway,
      eventType,
      eventId,
      payload,
      status: 'pending',
      attemptCount: 0,
      maxAttempts: getMaxAttempts(),
      lastError: error,
      errorHistory: [{
        attempt: 0,
        error,
        timestamp: new Date().toISOString(),
      }],
      expiresAt,
      userId: userId || null,
    };

    await storage.createWebhookQueueItem(queueItem);
    console.log(`📥 [WebhookRetry] Queued failed ${gateway} webhook: ${eventType} (${eventId})`);
  } catch (queueError: any) {
    console.error(`❌ [WebhookRetry] Failed to queue webhook:`, queueError);
  }
}

/**
 * Returns dead-lettered queue items (status 'failed' with attemptCount >= maxAttempts)
 * for one company. companyId is required: payment_webhook_queue carries company_id,
 * so results are always scoped to that company.
 */
export async function listDeadLetterDeliveries(companyId: string, limit = 100): Promise<PaymentWebhookQueue[]> {
  if (!companyId) {
    throw new Error('listDeadLetterDeliveries requires a companyId');
  }
  return db
    .select()
    .from(paymentWebhookQueue)
    .where(and(
      eq(paymentWebhookQueue.status, DEAD_LETTER_STATUS),
      eq(paymentWebhookQueue.companyId, companyId),
      sql`${paymentWebhookQueue.attemptCount} >= ${paymentWebhookQueue.maxAttempts}`,
    ))
    .orderBy(desc(paymentWebhookQueue.receivedAt))
    .limit(limit);
}

export const webhookRetryService = new WebhookRetryService();

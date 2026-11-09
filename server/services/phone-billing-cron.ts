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
import { logger } from '../utils/logger';
import { db } from "../db";
import { phoneNumbers, creditTransactions, phoneNumberRentals, campaigns, phoneReleaseRetryQueue } from "@shared/schema";
import type { PhoneNumber } from "@shared/schema";
import { storage } from "../storage";
import { twilioService } from "./twilio";
import { lte, eq, sql, and } from "drizzle-orm";
import { NotificationService } from "./notification-service";
import { emailService } from "./email-service";
import { withRetry } from "../utils/with-retry";

const BILLING_CHECK_INTERVAL = 60 * 60 * 1000; // Check every hour

/**
 * Get the phone number monthly cost from global settings
 */
async function getPhoneNumberMonthlyCost(): Promise<number> {
  const setting = await storage.getGlobalSetting('phone_number_monthly_credits');
  return (setting?.value as number) || 50; // Default to 50 if not configured
}

/**
 * Process monthly billing for all phone numbers with due billing dates
 * Runs as a cron job checking every hour
 */
export async function processPhoneNumberBilling() {
  logger.info('📞 [Phone Billing] Starting monthly billing check...');
  
  try {
    // Claim due phone numbers one at a time with row-level locking so overlapping
    // cron runs on different instances do not double-bill the same row.
    // SKIP LOCKED lets multiple workers pick disjoint rows without blocking each other.
    let processed = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const claimed: PhoneNumber | null = await db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(phoneNumbers)
          .where(and(lte(phoneNumbers.nextBillingDate, new Date()), eq(phoneNumbers.status, 'active')))
          .orderBy(phoneNumbers.nextBillingDate)
          .limit(1)
          .for('update', { skipLocked: true });
        const row = rows[0];
        if (!row) return null;
        // Re-stamp nextBillingDate optimistically to 1 hour in the future so another
        // worker doesn't re-pick this row while we're processing it. The actual billing
        // date is set correctly inside renewPhoneNumber's transaction.
        const holdUntil = new Date(Date.now() + 60 * 60 * 1000);
        await tx.update(phoneNumbers)
          .set({ nextBillingDate: holdUntil })
          .where(eq(phoneNumbers.id, row.id));
        return row;
      });

      if (!claimed) break;
      await processPhoneNumberRenewal(claimed);
      processed++;
      if (processed >= 1000) {
        // Safety cap per tick to avoid unbounded loops
        break;
      }
    }

    logger.info(`📞 [Phone Billing] Processed ${processed} phone numbers`);

    logger.info('📞 [Phone Billing] Monthly billing check complete');
  } catch (error: any) {
    logger.error('📞 [Phone Billing] Error processing monthly billing:', error);
  }
}

/**
 * Process renewal for a single phone number
 */
async function processPhoneNumberRenewal(phoneNumber: any) {
  logger.info(`📞 [Phone Billing] Processing renewal for [redacted]`);

  try {
    // Get user to check credits
    const user = await storage.getUser(phoneNumber.userId);
    if (!user) {
      logger.error(`📞 [Phone Billing] User not found for phone number [redacted]`);
      return;
    }

    // Get monthly cost from phone number record, or fall back to global setting
    const defaultCost = await getPhoneNumberMonthlyCost();
    const monthlyCredits = phoneNumber.monthlyCredits || defaultCost;

    // Check if user has sufficient credits
    if ((user.credits || 0) >= monthlyCredits) {
      // Sufficient credits - deduct and renew
      await renewPhoneNumber(phoneNumber, user, monthlyCredits);
    } else {
      // Insufficient credits - disable and release
      await disablePhoneNumber(phoneNumber, user, monthlyCredits);
    }
  } catch (error: any) {
    logger.error(`📞 [Phone Billing] Error processing renewal for [redacted]:`, error);
  }
}

/**
 * Renew phone number by deducting credits and updating billing date
 */
async function renewPhoneNumber(phoneNumber: any, user: any, monthlyCredits: number) {
  logger.info(`📞 [Phone Billing] Renewing [redacted] (sufficient credits)`);

  try {
    // Atomic transaction: deduct credits, create rental record, update next billing date
    await db.transaction(async (tx) => {
      // Create debit transaction
      const [transaction] = await tx.insert(creditTransactions).values({
        userId: user.id,
        type: 'debit',
        amount: monthlyCredits,
        description: `Monthly phone number rental: ${phoneNumber.phoneNumber}`,
      }).returning();

      // Atomically deduct credits
      await tx.execute(sql`
        UPDATE users 
        SET credits = COALESCE(credits, 0) - ${monthlyCredits}
        WHERE id = ${user.id}
      `);

      // Create rental record
      await tx.insert(phoneNumberRentals).values({
        phoneNumberId: phoneNumber.id,
        userId: user.id,
        creditsCharged: monthlyCredits,
        status: 'success',
        transactionId: transaction.id,
      });

      // Update next billing date to 30 days from now
      const nextBillingDate = new Date();
      nextBillingDate.setDate(nextBillingDate.getDate() + 30);

      await tx.update(phoneNumbers)
        .set({ nextBillingDate })
        .where(eq(phoneNumbers.id, phoneNumber.id));
    });

    logger.info(`✅ [Phone Billing] Successfully renewed [redacted]`);
    
    // Send success notification
    await NotificationService.notifyPhoneBillingSuccess(
      user.id,
      phoneNumber.phoneNumber,
      monthlyCredits
    );

    // Check if user should be notified about low credits
    const updatedUser = await storage.getUser(user.id);
    if (updatedUser && await NotificationService.shouldNotifyLowCredits(updatedUser.credits || 0)) {
      await NotificationService.notifyLowCredits(user.id, updatedUser.credits || 0);
      
      // Send low credits email notification
      try {
        await emailService.sendLowCreditsAlert(user.id, updatedUser.credits || 0);
        logger.info(`✅ [Phone Billing] Low credits email sent to user ${user.id}`);
      } catch (emailError: any) {
        logger.error(`❌ [Phone Billing] Failed to send low credits email:`);
      }
    }
  } catch (error: any) {
    logger.error(`❌ [Phone Billing] Failed to renew [redacted]:`, error);
    
    // Create failed rental record
    try {
      await storage.createPhoneNumberRental({
        phoneNumberId: phoneNumber.id,
        userId: user.id,
        creditsCharged: monthlyCredits,
        status: 'failed',
      });
    } catch (rentalError) {
      logger.error(`❌ [Phone Billing] Failed to create failed rental record:`, rentalError);
    }
  }
}

/**
 * Disable phone number due to insufficient credits
 * - Release from Twilio immediately
 * - Pause all campaigns using this number
 * - Create failed rental record
 */
async function disablePhoneNumber(phoneNumber: any, user: any, monthlyCredits: number) {
  logger.info(`⚠️  [Phone Billing] Disabling [redacted] (insufficient credits)`);

  try {
    await db.transaction(async (tx) => {
      // Create failed rental record
      await tx.insert(phoneNumberRentals).values({
        phoneNumberId: phoneNumber.id,
        userId: user.id,
        creditsCharged: monthlyCredits,
        status: 'insufficient_credits',
      });

      // Update phone number status to inactive
      await tx.update(phoneNumbers)
        .set({ 
          status: 'inactive',
          nextBillingDate: null, // Clear billing date since it's inactive
        })
        .where(eq(phoneNumbers.id, phoneNumber.id));

      // Pause all campaigns using this phone number
      await tx.execute(sql`
        UPDATE campaigns 
        SET status = 'paused'
        WHERE phone_number_id = ${phoneNumber.id} AND status = 'active'
      `);
    });

    // Release phone number from Twilio (outside transaction).
    // Retry on transient 429/5xx + network errors before falling back to the durable queue.
    try {
      await withRetry(
        () => twilioService.releasePhoneNumber(phoneNumber.twilioSid!),
        { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 4000, label: 'twilio.releasePhoneNumber' }
      );
      logger.info(`✅ [Phone Billing] Released [redacted] from Twilio`);
    } catch (twilioError: any) {
      logger.error(`⚠️  [Phone Billing] Failed to release [redacted] from Twilio:`, twilioError);
      // Enqueue durable retry so the release is not lost on transient errors.
      try {
        await db.insert(phoneReleaseRetryQueue).values({
          phoneNumberId: phoneNumber.id,
          provider: 'twilio',
          providerSid: phoneNumber.twilioSid,
          userId: user.id,
          attempts: 0,
          lastError: twilioError?.message?.slice(0, 500) ?? String(twilioError).slice(0, 500),
          nextRetryAt: new Date(Date.now() + 5 * 60 * 1000), // retry in 5 min
        });
        logger.info(`📥 [Phone Billing] Queued release retry for [redacted]`);
      } catch (queueError: any) {
        logger.error(`❌ [Phone Billing] Failed to queue release retry:`, queueError);
      }
    }

    logger.info(`✅ [Phone Billing] Disabled [redacted] and paused campaigns`);
    
    // Send notification about phone number being released
    await NotificationService.notifyPhoneBillingFailed(
      user.id,
      phoneNumber.phoneNumber,
      `Insufficient credits (${user.credits || 0} available, ${monthlyCredits} required)`
    );
  } catch (error: any) {
    logger.error(`❌ [Phone Billing] Failed to disable [redacted]:`, error);
  }
}

let billingIntervalId: NodeJS.Timeout | null = null;

/**
 * Start the phone billing cron job
 */
export function startPhoneBillingCron() {
  if (billingIntervalId) {
    logger.info('📞 [Phone Billing] Cron job already running');
    return;
  }
  
  logger.info('📞 [Phone Billing] Starting cron job (checking every hour)');
  
  // Run immediately on startup
  processPhoneNumberBilling();
  
  // Then run every hour
  billingIntervalId = setInterval(processPhoneNumberBilling, BILLING_CHECK_INTERVAL);
}

/**
 * Stop the phone billing cron job
 */
export function stopPhoneBillingCron() {
  if (billingIntervalId) {
    clearInterval(billingIntervalId);
    billingIntervalId = null;
    logger.info('📞 [Phone Billing] Cron job stopped');
  }
}

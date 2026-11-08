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
import { Campaign, campaigns, calls, contacts } from "@shared/schema";
import { db } from '../db';
import { eq, and, or, isNotNull, isNull, sql, lte, inArray } from 'drizzle-orm';
import { emailService } from './email-service';
import { BatchCallingService } from './batch-calling';

/** Call rows still eligible for ElevenLabs batch recipient sync (final status from poll). */
const EL_BATCH_SYNCABLE_CALL_STATUSES = [
  'pending',
  'queued',
  'initiated',
  'ringing',
  'answered',
  'in-progress',
  'in_progress',
] as const;

function isBullMQEnabled(): boolean {
  return process.env.ENABLE_BULLMQ === 'true' && !!process.env.REDIS_URL;
}

export class CampaignScheduler {
  private static intervalId: NodeJS.Timeout | null = null;
  private static isRunning = false;

  /**
   * Start the background scheduler that checks campaigns every minute
   * NOTE: When BullMQ is enabled, this scheduler still handles:
   * - Time window-based pause/resume (scheduleEnabled, scheduleDays, scheduleTimeStart/End)
   * - ElevenLabs batch job polling and completion
   * BullMQ's scheduler-worker handles:
   * - Starting campaigns with scheduledFor timestamp
   * - Recovery of stuck campaigns
   * - Cleanup of stale calls
   */
  static startBackgroundScheduler(): void {
    if (this.intervalId) {
      logger.info('[Campaign Scheduler] Background scheduler already running');
      return;
    }

    const bullmqMode = isBullMQEnabled();
    logger.info(`🕐 [Campaign Scheduler] Starting background scheduler (30s interval)${bullmqMode ? ' - BullMQ handles scheduled starts' : ''}`);
    
    // Run immediately on start
    this.checkScheduledCampaigns().catch(err => {
      console.error('[Campaign Scheduler] Initial check failed:', err);
    });
    this.pollRunningBatchJobs().catch(err => {
      console.error('[Campaign Scheduler] Initial batch poll failed:', err);
    });

    // Then run every 30 seconds for faster campaign status sync
    this.intervalId = setInterval(() => {
      this.checkScheduledCampaigns().catch(err => {
        console.error('[Campaign Scheduler] Scheduled check failed:', err);
      });
      this.pollRunningBatchJobs().catch(err => {
        console.error('[Campaign Scheduler] Batch poll failed:', err);
      });
      CampaignScheduler.checkPendingRetryPasses().catch(err => {
        console.error('[Campaign Scheduler] Retry pass check failed:', err);
      });
    }, 30 * 1000);
  }

  /**
   * Stop the background scheduler
   */
  static stopBackgroundScheduler(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('[Campaign Scheduler] Background scheduler stopped');
    }
  }

  /**
   * Check all scheduled campaigns and auto-pause/resume based on time windows
   */
  static async checkScheduledCampaigns(): Promise<void> {
    if (this.isRunning) {
      logger.warn('[Campaign Scheduler] Check already in progress, skipping...');
      return;
    }

    this.isRunning = true;
    
    try {
      // Import campaignExecutor dynamically to avoid circular dependency
      const { campaignExecutor } = await import('./campaign-executor');

      // Check for campaigns scheduled to start (only if BullMQ is NOT enabled)
      // BullMQ has its own scheduler-worker for this
      if (!isBullMQEnabled()) {
        await this.checkAndStartScheduledCampaigns(campaignExecutor);
      }

      // Find running campaigns that need to be paused (outside time window)
      const runningCampaigns = await db
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.status, 'running'),
            eq(campaigns.scheduleEnabled, true),
            isNotNull(campaigns.batchJobId)
          )
        );

      for (const campaign of runningCampaigns) {
        const isWithinWindow = this.isWithinCallWindow(campaign);
        
        if (!isWithinWindow) {
          logger.info(`⏸️ [Campaign Scheduler] Auto-pausing campaign "${campaign.name}" (outside time window)`);
          try {
            await campaignExecutor.pauseCampaign(campaign.id, 'scheduled');
          } catch (err: any) {
            console.error(`   Failed to pause: ${err.message}`);
          }
        }
      }

      // Find paused campaigns that can be resumed (inside time window)
      const pausedCampaigns = await db
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.status, 'paused'),
            eq(campaigns.scheduleEnabled, true),
            isNotNull(campaigns.batchJobId)
          )
        );

      for (const campaign of pausedCampaigns) {
        // Only auto-resume if it was paused by the scheduler (not manually)
        const config = campaign.config as Record<string, any> || {};
        if (config.pauseReason !== 'scheduled') {
          continue;
        }

        const isWithinWindow = this.isWithinCallWindow(campaign);
        
        if (isWithinWindow) {
          logger.info(`▶️ [Campaign Scheduler] Auto-resuming campaign "${campaign.name}" (inside time window)`);
          try {
            await campaignExecutor.resumeCampaign(campaign.id, 'scheduled');
          } catch (err: any) {
            console.error(`   Failed to resume: ${err.message}`);
          }
        }
      }

    } catch (error) {
      console.error('[Campaign Scheduler] Error checking campaigns:', error);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Check for campaigns with scheduledFor timestamp that are due to start
   * This is only called when BullMQ is NOT enabled
   */
  private static async checkAndStartScheduledCampaigns(campaignExecutor: any): Promise<void> {
    const now = new Date();
    
    const scheduledCampaigns = await db.select()
      .from(campaigns)
      .where(
        and(
          eq(campaigns.status, 'scheduled'),
          isNotNull(campaigns.scheduledFor),
          lte(campaigns.scheduledFor, now)
        )
      )
      .limit(10);
    
    if (scheduledCampaigns.length > 0) {
      logger.info(`[Campaign Scheduler] Found ${scheduledCampaigns.length} campaigns ready to start`);
    }
    
    for (const campaign of scheduledCampaigns) {
      try {
        await db.update(campaigns)
          .set({ status: 'queued' })
          .where(
            and(
              eq(campaigns.id, campaign.id),
              eq(campaigns.status, 'scheduled')
            )
          );
        
        await campaignExecutor.executeCampaign(campaign.id);
        logger.info(`[Campaign Scheduler] Started scheduled campaign ${campaign.id}`);
      } catch (error: any) {
        console.error(`[Campaign Scheduler] Failed to start campaign ${campaign.id}:`, error.message);
        
        await db.update(campaigns)
          .set({ 
            status: 'failed',
            errorMessage: error.message,
            errorCode: 'SCHEDULER_ERROR',
          })
          .where(eq(campaigns.id, campaign.id));
      }
    }
  }

  static isWithinCallWindow(campaign: Campaign): boolean {
    if (!campaign.scheduleEnabled) {
      return true;
    }

    const now = new Date();
    const timezone = campaign.scheduleTimezone || "America/New_York";
    
    const currentTimeInZone = new Date(now.toLocaleString("en-US", { timeZone: timezone }));
    const dayOfWeek = currentTimeInZone.toLocaleDateString("en-US", { weekday: "long", timeZone: timezone }).toLowerCase();
    
    if (campaign.scheduleDays && campaign.scheduleDays.length > 0) {
      if (!campaign.scheduleDays.includes(dayOfWeek)) {
        return false;
      }
    }
    
    if (campaign.scheduleTimeStart && campaign.scheduleTimeEnd) {
      const currentHours = currentTimeInZone.getHours();
      const currentMinutes = currentTimeInZone.getMinutes();
      const currentTimeMinutes = currentHours * 60 + currentMinutes;
      
      const [startHours, startMinutes] = campaign.scheduleTimeStart.split(":").map(Number);
      const startTimeMinutes = startHours * 60 + startMinutes;
      
      const [endHours, endMinutes] = campaign.scheduleTimeEnd.split(":").map(Number);
      const endTimeMinutes = endHours * 60 + endMinutes;
      
      if (currentTimeMinutes < startTimeMinutes || currentTimeMinutes > endTimeMinutes) {
        return false;
      }
    }
    
    return true;
  }

  static getNextCallWindow(campaign: Campaign): Date | null {
    if (!campaign.scheduleEnabled) {
      return new Date();
    }

    if (CampaignScheduler.isWithinCallWindow(campaign)) {
      return new Date();
    }

    const timezone = campaign.scheduleTimezone || "America/New_York";
    const now = new Date();
    
    for (let daysAhead = 0; daysAhead < 7; daysAhead++) {
      const checkDate = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
      
      const dayOfWeek = checkDate.toLocaleDateString("en-US", { 
        weekday: "long", 
        timeZone: timezone 
      }).toLowerCase();
      
      if (campaign.scheduleDays && campaign.scheduleDays.length > 0) {
        if (!campaign.scheduleDays.includes(dayOfWeek)) {
          continue;
        }
      }
      
      if (campaign.scheduleTimeStart) {
        const [startHours, startMinutes] = campaign.scheduleTimeStart.split(":").map(Number);
        
        // NOTE: This timezone conversion uses an iterative approach to handle most cases.
        // Known limitation: May have edge cases during DST transitions (spring forward/fall back).
        // For production use with precise DST handling, consider using a library like Temporal or luxon.
        
        const formatter = new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        });
        
        const parts = formatter.formatToParts(checkDate);
        const targetYear = parseInt(parts.find(p => p.type === "year")!.value, 10);
        const targetMonth = parseInt(parts.find(p => p.type === "month")!.value, 10) - 1;
        const targetDay = parseInt(parts.find(p => p.type === "day")!.value, 10);
        
        let guessUTC = Date.UTC(targetYear, targetMonth, targetDay, startHours, startMinutes, 0);
        let iterations = 0;
        const maxIterations = 3;
        
        while (iterations < maxIterations) {
          const guessDate = new Date(guessUTC);
          const guessParts = formatter.formatToParts(guessDate);
          
          const guessYear = parseInt(guessParts.find(p => p.type === "year")!.value, 10);
          const guessMonth = parseInt(guessParts.find(p => p.type === "month")!.value, 10) - 1;
          const guessDay = parseInt(guessParts.find(p => p.type === "day")!.value, 10);
          const guessHour = parseInt(guessParts.find(p => p.type === "hour")!.value, 10);
          const guessMinute = parseInt(guessParts.find(p => p.type === "minute")!.value, 10);
          
          if (guessYear === targetYear && guessMonth === targetMonth && guessDay === targetDay && guessHour === startHours && guessMinute === startMinutes) {
            break;
          }
          
          const actualLocalTime = Date.UTC(guessYear, guessMonth, guessDay, guessHour, guessMinute, 0);
          const desiredLocalTime = Date.UTC(targetYear, targetMonth, targetDay, startHours, startMinutes, 0);
          const offset = actualLocalTime - guessUTC;
          
          guessUTC = desiredLocalTime - offset;
          iterations++;
        }
        
        const correctUTC = new Date(guessUTC);
        
        if (correctUTC > now) {
          return correctUTC;
        }
      } else {
        return checkDate;
      }
    }
    
    return null;
  }

  static formatTimeWindow(campaign: Campaign): string {
    if (!campaign.scheduleEnabled) {
      return "24/7 (No restrictions)";
    }

    const parts: string[] = [];
    
    if (campaign.scheduleDays && campaign.scheduleDays.length > 0) {
      const days = campaign.scheduleDays.map(d => 
        d.charAt(0).toUpperCase() + d.slice(1)
      ).join(", ");
      parts.push(days);
    }
    
    if (campaign.scheduleTimeStart && campaign.scheduleTimeEnd) {
      parts.push(`${campaign.scheduleTimeStart} - ${campaign.scheduleTimeEnd}`);
    }
    
    if (campaign.scheduleTimezone) {
      parts.push(campaign.scheduleTimezone);
    }
    
    return parts.join(" | ");
  }

  /**
   * Poll running campaigns with batch jobs and sync status from ElevenLabs
   */
  static async pollRunningBatchJobs(): Promise<void> {
    try {
      // Find running campaigns with batch job IDs
      const runningCampaigns = await db
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.status, 'running'),
            isNotNull(campaigns.batchJobId)
          )
        );

      if (runningCampaigns.length === 0) {
        return;
      }

      logger.info(`🔄 [Campaign Scheduler] Polling ${runningCampaigns.length} running batch jobs`);

      // Import campaignExecutor dynamically to avoid circular dependency
      const { campaignExecutor } = await import('./campaign-executor');

      for (const campaign of runningCampaigns) {
        try {
          logger.info(`   Checking batch status for "${campaign.name}" (${campaign.batchJobId})`);
          
          // Capture the batch status from the PREVIOUS poll cycle.
          // getBatchJobStatus (called below) updates batchJobStatus in the DB,
          // but `campaign` was fetched BEFORE that update, so this reflects
          // the last-saved value. We use this to implement a grace period.
          const previousBatchStatus = campaign.batchJobStatus;

          // Get latest batch status from ElevenLabs
          const batchJob = await campaignExecutor.getBatchJobStatus(campaign.id);
          
          if (batchJob) {
            logger.info(`   Batch status: ${batchJob.status}, dispatched: ${batchJob.total_calls_dispatched}/${batchJob.total_calls_scheduled}`);
            
            // Update pending call records based on recipient status (do this first to capture final states before termination)
            if (batchJob.recipients && batchJob.recipients.length > 0) {
              await this.syncCallRecordsFromBatch(campaign.id, batchJob.recipients);
            }

            if (batchJob.status === 'failed' || batchJob.status === 'cancelled') {
              console.warn(`⚠️ [Campaign Scheduler] Batch job status is ${batchJob.status} for "${campaign.name}" (${campaign.batchJobId}) — terminating campaign`);
              await this.terminateBatchCampaign(campaign.id, campaign.name, batchJob.status);
              continue;
            }
            
            if (batchJob.status === 'completed') {
              // GRACE PERIOD: ElevenLabs batch 'completed' fires BEFORE post_call webhooks
              // arrive. If we expire pending calls immediately, the webhooks can't match them.
              // Solution: Only expire on the SECOND+ observation of 'completed'.
              // First time we see completed (previousBatchStatus != 'completed'), skip expire
              // and wait 30s for webhooks to arrive and update the calls.
              if (previousBatchStatus === 'completed') {
                await this.expireRemainingPendingCalls(campaign.id, batchJob.recipients || []);
              } else {
                logger.info(`   [Campaign Scheduler] Batch just completed — waiting one cycle for webhooks before expiring calls`);
              }
            }

            // Always check campaign completion on every poll
            // This handles cases where webhooks already updated call statuses
            // or when ElevenLabs batch is complete but recipients list is empty
            await this.checkCampaignCompletion(campaign.id);
          }
        } catch (err: any) {
          // If ElevenLabs returns 404, the batch job has been purged from their system.
          // Stop polling by marking all pending calls as failed and completing the campaign.
          const is404 = err.statusCode === 404 ||
            /404/.test(err.message) ||
            /not found/i.test(err.message);

          if (is404) {
            console.warn(`⚠️ [Campaign Scheduler] Batch job not found on ElevenLabs for "${campaign.name}" (${campaign.batchJobId}) — marking expired`);
            await this.expireBatchCampaign(campaign.id, campaign.name);
          } else {
            console.error(`   Error polling batch for "${campaign.name}": ${err.message}`);
          }
        }
      }
    } catch (error) {
      console.error('[Campaign Scheduler] Error polling batch jobs:', error);
    }
  }

  /**
   * Handle a campaign whose ElevenLabs batch job was not found (404/purged).
   * Marks all pending call records as failed, then triggers campaign completion.
   */
  private static async expireBatchCampaign(campaignId: string, campaignName: string): Promise<void> {
    try {
      // Mark all still-pending call records as failed
      const updatedCalls = await db
        .update(calls)
        .set({
          status: 'failed',
          endedAt: new Date(),
          metadata: sql`COALESCE(${calls.metadata}, '{}'::jsonb) || ${JSON.stringify({ errorMessage: 'Batch job expired or not found on ElevenLabs' })}::jsonb`,
        })
        .where(
          and(
            eq(calls.campaignId, campaignId),
            eq(calls.status, 'pending')
          )
        )
        .returning({ id: calls.id });

      logger.warn(`   Marked ${updatedCalls.length} pending call(s) as failed for expired campaign "${campaignName}"`);

      // Now that all calls are in a final state, complete the campaign
      await this.checkCampaignCompletion(campaignId);
    } catch (expireErr: any) {
      console.error(`   Failed to expire campaign "${campaignName}": ${expireErr.message}`);
    }
  }

  /**
   * Clean up remaining pending calls for a completed batch job to prevent stuck campaigns.
   * Only expires calls when ALL ElevenLabs recipients have reached a final status.
   * This prevents the race condition where a recipient is still 'in_progress' on ElevenLabs
   * but the batch status shows 'completed' (dispatching done, not calls done).
   */
  private static async expireRemainingPendingCalls(
    campaignId: string,
    recipients: Array<{ status: string; phone_number: string }> = []
  ): Promise<void> {
    try {
      // Check if any ElevenLabs recipients are still in a non-final status.
      // If so, do NOT expire local pending calls yet — they may still complete.
      const nonFinalRecipientStatuses = ['pending', 'in_progress', 'dispatched', 'ringing', 'initiated'];
      const stillInProgressRecipients = recipients.filter(r =>
        nonFinalRecipientStatuses.includes(r.status)
      );

      if (stillInProgressRecipients.length > 0) {
        logger.warn(`   [Campaign Scheduler] ${stillInProgressRecipients.length} recipient(s) still in progress on ElevenLabs — skipping expire`);
        for (const r of stillInProgressRecipients) {
          logger.info(`      [redacted]: ${r.status}`);
        }
        return;
      }

      const updatedCalls = await db
        .update(calls)
        .set({
          status: 'failed',
          endedAt: new Date(),
          metadata: sql`COALESCE(${calls.metadata}, '{}'::jsonb) || '{"errorMessage": "Not dispatched by ElevenLabs"}'::jsonb`,
        })
        .where(
          and(
            eq(calls.campaignId, campaignId),
            inArray(calls.status, ['pending', 'queued', 'initiated', 'ringing'])
          )
        )
        .returning({ id: calls.id });

      if (updatedCalls.length > 0) {
        logger.info(`   [Campaign Scheduler] Marked ${updatedCalls.length} remaining pending call(s) as failed for completed campaign`);
      }
    } catch (err: any) {
      console.error(`   Failed to expire remaining pending calls for campaign ${campaignId}: ${err.message}`);
    }
  }

  /**
   * Terminate a campaign whose ElevenLabs batch job failed or was cancelled
   */
  private static async terminateBatchCampaign(campaignId: string, campaignName: string, status: 'failed' | 'cancelled'): Promise<void> {
    try {
      const finalCallStatus = status === 'cancelled' ? 'cancelled' : 'failed';

      // Mark all still-pending call records with the appropriate status
      const updatedCalls = await db
        .update(calls)
        .set({
          status: finalCallStatus,
          endedAt: new Date(),
          metadata: sql`COALESCE(${calls.metadata}, '{}'::jsonb) || ${JSON.stringify({ errorMessage: `Batch job ${status} on ElevenLabs` })}::jsonb`,
        })
        .where(
          and(
            eq(calls.campaignId, campaignId),
            inArray(calls.status, ['pending', 'queued', 'initiated', 'ringing', 'in-progress', 'in_progress'])
          )
        )
        .returning({ id: calls.id });

      logger.info(`   Marked ${updatedCalls.length} pending call(s) as ${finalCallStatus} for ${status} campaign "${campaignName}"`);

      // Fetch all calls to compute stats
      const campaignCalls = await db.select().from(calls).where(eq(calls.campaignId, campaignId));
      const successfulCalls = campaignCalls.filter(c => c.status === 'completed').length;
      const failedCalls = campaignCalls.filter(c => 
        ['failed', 'busy', 'no-answer', 'cancelled'].includes(c.status)
      ).length;

      // Update campaign status
      await db
        .update(campaigns)
        .set({
          status: status,
          completedAt: new Date(),
          completedCalls: campaignCalls.length,
          successfulCalls,
          failedCalls,
        })
        .where(eq(campaigns.id, campaignId));

      // Trigger webhook dynamically
      const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
      if (campaign?.userId) {
        const { webhookDeliveryService } = await import('./webhook-delivery');
        const eventType = status === 'cancelled' ? 'campaign.cancelled' : 'campaign.failed';
        
        await webhookDeliveryService.triggerEvent(campaign.companyId ?? null, campaign.userId, eventType, {
          campaignId: campaign.id,
          campaignName: campaign.name,
          status: status,
          startedAt: campaign.startedAt,
          completedAt: new Date().toISOString(),
          totalContacts: campaign.totalContacts,
          completedCalls: campaignCalls.length,
          successfulCalls,
          failedCalls,
          ...(status === 'failed' && {
            error: {
              code: 'BATCH_JOB_FAILED',
              message: 'Batch calling job failed during execution',
              details: { batchJobId: campaign.batchJobId }
            }
          })
        }, campaignId);
      }
    } catch (err: any) {
      console.error(`   Failed to terminate campaign "${campaignName}": ${err.message}`);
    }
  }

  private static async syncCallRecordsFromBatch(
    campaignId: string, 
    recipients: Array<{
      recipient_id: string;
      phone_number: string;
      status: string;
      conversation_id?: string;
      call_duration_secs?: number;
      error_message?: string;
    }>
  ) {
    // Fetch all syncable calls for this campaign to avoid N+1 database queries.
    // Include 'failed' calls that have NO elevenLabsConversationId — these may have been
    // prematurely marked as failed by expireRemainingPendingCalls before the ElevenLabs
    // batch finished dispatching. If ElevenLabs now reports them as 'completed', we rescue them.
    const campaignCalls = await db
      .select()
      .from(calls)
      .where(
        and(
          eq(calls.campaignId, campaignId),
          or(
            inArray(calls.status, [...EL_BATCH_SYNCABLE_CALL_STATUSES]),
            // Rescue prematurely-failed calls: failed + no conversation_id = never actually synced
            and(
              eq(calls.status, 'failed'),
              isNull(calls.elevenLabsConversationId)
            )
          )
        )
      );

    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i];
      // Yield occasionally so tens of thousands of recipient updates don't block the event loop
      if (i > 0 && i % 400 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      // Skip recipients that are still pending (no need to sync unchanged pending status)
      if (recipient.status === 'pending') {
        continue;
      }

      const recipientPhoneDigits = recipient.phone_number.replace(/[^\d]/g, '');
      if (!recipientPhoneDigits) continue;

      // Find the matching call record by comparing digits
      const callRecord = campaignCalls.find(c => {
        const dbPhoneDigits = (c.phoneNumber || '').replace(/[^\d]/g, '');
        return dbPhoneDigits === recipientPhoneDigits || 
               dbPhoneDigits.endsWith(recipientPhoneDigits) || 
               recipientPhoneDigits.endsWith(dbPhoneDigits);
      });

      if (!callRecord) {
        logger.warn(`   [Campaign Scheduler] No syncable call record found for recipient phone: [redacted]`);
        continue;
      }

      // Map recipient status to local call status string for comparison
      const targetCallStatus = recipient.status === 'completed' ? 'completed' :
        recipient.status === 'no_response' ? 'no-answer' :
        recipient.status === 'cancelled' ? 'cancelled' :
        ['in_progress', 'dispatched', 'ringing', 'initiated'].includes(recipient.status) ? 'in-progress' : 'failed';

      // Skip if the call already has the correct status and conversation_id
      // (already synced by a previous poll or webhook)
      if (callRecord.elevenLabsConversationId === recipient.conversation_id &&
          callRecord.status === targetCallStatus) {
        continue;
      }

      await this.updateCallRecordFromRecipient(callRecord.id, recipient, callRecord.contactId ?? undefined);
    }
  }

  /**
   * Update a call record based on recipient status from ElevenLabs.
   * Also syncs contacts.status and contacts.lastAttemptAt (but NOT attemptCount —
   * that is pre-incremented by maybeScheduleRetryPass when a retry is scheduled,
   * matching scheduleContactRetry semantics for Twilio/Plivo). Without the status
   * sync, maybeScheduleRetryPass's inArray(contacts.status, retryStatuses) filter
   * would never match ElevenLabs contacts (Task #145).
   */
  private static async updateCallRecordFromRecipient(
    callId: string,
    recipient: {
      status: string;
      conversation_id?: string;
      call_duration_secs?: number;
      error_message?: string;
    },
    contactId?: string
  ): Promise<void> {
    // Map ElevenLabs recipient status to our call status
    // ElevenLabs statuses: pending, in_progress, dispatched, completed, failed, no_response, cancelled
    let callStatus: 'completed' | 'failed' | 'no-answer' | 'cancelled' | 'in-progress' | 'pending';
    switch (recipient.status) {
      case 'completed':
        callStatus = 'completed';
        break;
      case 'no_response':
        callStatus = 'no-answer';
        break;
      case 'cancelled':
        callStatus = 'cancelled';
        break;
      case 'in_progress':
      case 'dispatched':
      case 'ringing':
      case 'initiated':
        callStatus = 'in-progress';
        break;
      case 'pending':
        callStatus = 'pending';
        break;
      case 'failed':
      default:
        callStatus = 'failed';
        break;
    }

    const updateData: Record<string, any> = {
      status: callStatus,
      duration: typeof recipient.call_duration_secs === 'number' ? recipient.call_duration_secs : null,
    };

    if (recipient.conversation_id) {
      updateData.elevenLabsConversationId = recipient.conversation_id;
    }

    // Store error message in metadata if present
    if (recipient.error_message) {
      updateData.metadata = sql`COALESCE(${calls.metadata}, '{}'::jsonb) || ${JSON.stringify({ errorMessage: recipient.error_message })}::jsonb`;
    }

    await db
      .update(calls)
      .set(updateData)
      .where(eq(calls.id, callId));

    // Sync the parent contact row so that maybeScheduleRetryPass can correctly
    // filter eligible contacts by status. Without this update, contacts.status stays
    // at 'pending' / 'in_progress' for ElevenLabs campaigns and maybeScheduleRetryPass
    // would never find any contacts to retry (Task #145).
    //
    // NOTE: attemptCount is intentionally NOT incremented here. It is incremented
    // inside maybeScheduleRetryPass when a retry is scheduled — matching the
    // pre-increment semantics of scheduleContactRetry used by Twilio/Plivo.
    if (contactId) {
      await db
        .update(contacts)
        .set({
          status: callStatus,
          lastAttemptAt: new Date(),
        })
        .where(eq(contacts.id, contactId));
    }

    logger.info(`   Updated call ${callId}: status=${callStatus}, conversation_id=${recipient.conversation_id || 'N/A'}`);

    // Trigger full data sync for ElevenLabs conversations
    // This fetches transcript, AI summary, and recording URL which are not in the batch response
    if (recipient.conversation_id) {
      try {
        const { callSyncService } = await import('./call-sync');
        // Run in background (don't await) to avoid blocking the scheduler loop
        callSyncService.syncCall(callId).catch(err => {
          console.error(`❌ [Campaign Scheduler] Background sync failed for call ${callId}:`, err.message);
        });
      } catch (importErr) {
        console.error(`❌ [Campaign Scheduler] Failed to import callSyncService:`, importErr);
      }
    }
  }

  /**
   * Check if all calls in a campaign have reached a final status.
   * If retryEnabled is true and there are contacts that qualify for retry,
   * schedule a retry pass instead of marking the campaign completed.
   */
  private static async checkCampaignCompletion(campaignId: string): Promise<void> {
    // Get all calls for this campaign
    const campaignCalls = await db
      .select()
      .from(calls)
      .where(eq(calls.campaignId, campaignId));

    if (campaignCalls.length === 0) {
      return;
    }

    // Final statuses - calls that have finished processing
    const finalStatuses = ['completed', 'failed', 'no-answer', 'busy', 'cancelled'];
    
    // Check if ALL calls have reached a final status
    const pendingCalls = campaignCalls.filter(c => !finalStatuses.includes(c.status));
    
    if (pendingCalls.length > 0) {
      logger.info(`   Campaign ${campaignId}: ${pendingCalls.length}/${campaignCalls.length} calls still pending`);
      return;
    }

    // All calls are complete! Check if we already marked this campaign as completed
    const [campaign] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);

    if (!campaign || campaign.status === 'completed') {
      return; // Already completed or not found
    }

    logger.info(`✅ [Campaign Scheduler] All ${campaignCalls.length} calls complete for campaign "${campaign.name}"`);

    // === RETRY PASS CHECK ===
    // Before marking completed, check if retryEnabled and contacts qualify for retry
    if (campaign.retryEnabled) {
      const didScheduleRetry = await this.maybeScheduleRetryPass(campaign, campaignCalls);
      if (didScheduleRetry) {
        return; // Retry pass scheduled — don't mark completed yet
      }
    }

    // Calculate final stats
    const successfulCalls = campaignCalls.filter(c => c.status === 'completed').length;
    const failedCalls = campaignCalls.filter(c => 
      ['failed', 'busy', 'no-answer', 'cancelled'].includes(c.status)
    ).length;

    // Update campaign status to completed
    await db
      .update(campaigns)
      .set({
        status: 'completed',
        completedAt: new Date(),
        completedCalls: campaignCalls.length,
        successfulCalls,
        failedCalls,
      })
      .where(eq(campaigns.id, campaignId));

    logger.info(`   Campaign stats: ${successfulCalls} successful, ${failedCalls} failed`);

    // Send campaign completion email and trigger webhook
    try {
      // Send completion email
      await emailService.sendCampaignCompleted(campaignId);
      logger.info(`   ✅ Campaign completion email sent for "${campaign.name}"`);
    } catch (emailError: any) {
      console.error(`   ❌ Failed to send campaign completion email: ${emailError.message}`);
    }

    try {
      // Trigger campaign.completed webhook dynamically
      if (campaign.userId) {
        const { webhookDeliveryService } = await import('./webhook-delivery');
        
        // Fetch contacts for this campaign
        const campaignContacts = await db
          .select()
          .from(contacts)
          .where(eq(contacts.campaignId, campaignId));
        
        // Build contact lookup map
        const contactMap = new Map(campaignContacts.map(c => [c.id, c]));
        
        // Build rich call data with all details
        const callsData = campaignCalls.map(call => {
          const contact = call.contactId ? contactMap.get(call.contactId) : null;
          return {
            id: call.id,
            status: call.status,
            classification: call.classification,
            sentiment: call.sentiment,
            duration: call.duration,
            phoneNumber: call.phoneNumber,
            transcript: call.transcript,
            aiSummary: call.aiSummary,
            recordingUrl: call.recordingUrl,
            startedAt: call.startedAt,
            endedAt: call.endedAt,
            contact: contact ? {
              id: contact.id,
              firstName: contact.firstName,
              lastName: contact.lastName,
              phone: contact.phone,
              email: contact.email,
              customFields: contact.customFields,
            } : null,
          };
        });
        
        // Build rich contacts data
        const contactsData = campaignContacts.map(contact => ({
          id: contact.id,
          firstName: contact.firstName,
          lastName: contact.lastName,
          phone: contact.phone,
          email: contact.email,
          customFields: contact.customFields,
          status: contact.status,
        }));

        await webhookDeliveryService.triggerEvent(campaign.companyId ?? null, campaign.userId, 'campaign.completed', {
          campaign: {
            id: campaign.id,
            name: campaign.name,
            type: campaign.type,
            status: 'completed',
            totalContacts: campaign.totalContacts,
            startedAt: campaign.startedAt,
            completedAt: new Date().toISOString(),
            createdAt: campaign.createdAt,
          },
          stats: {
            successfulCalls,
            failedCalls,
            totalCalls: campaignCalls.length,
            completedCalls: campaignCalls.length,
            hotLeads: campaignCalls.filter(c => c.classification === 'hot').length,
            warmLeads: campaignCalls.filter(c => c.classification === 'warm').length,
            coldLeads: campaignCalls.filter(c => c.classification === 'cold').length,
            lostLeads: campaignCalls.filter(c => c.classification === 'lost').length,
          },
          calls: callsData,
          contacts: contactsData,
        }, campaignId);
        logger.info(`   ✅ Webhook triggered for campaign.completed`);
      }
    } catch (webhookError: any) {
      console.error(`   ❌ Failed to trigger campaign.completed webhook: ${webhookError.message}`);
    }
  }

  /**
   * Determine if campaign completion should be deferred because there are
   * contacts that either have a retry already scheduled (nextRetryAt IS NOT NULL)
   * or that are still eligible to receive one (status qualifies AND attemptCount
   * has not yet reached retryMaxAttempts).
   *
   * Returns true to defer completion, false to proceed with marking completed.
   */
  private static async maybeScheduleRetryPass(
    campaign: any,
    campaignCalls: any[]
  ): Promise<boolean> {
    // 1. Defer if any contact already has a retry queued
    const [pendingRetry] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.campaignId, campaign.id),
          isNotNull(contacts.nextRetryAt)
        )
      )
      .limit(1);

    if (pendingRetry) {
      logger.info(`🔄 [Campaign Scheduler] Campaign "${campaign.name}" has pending retry contacts — deferring completion`);
      return true;
    }

    // 2. Check if any contacts are eligible for retry based on their CURRENT status
    //    (contacts.status is authoritative — it's updated by scheduleContactRetry when
    //    each call terminates, so a contact that answered on retry will have status='completed'
    //    and won't appear here, even if an older call record still shows 'no-answer').
    const retryStatuses: string[] = [];
    if (campaign.retryOnNoAnswer !== false) retryStatuses.push('no-answer');
    if (campaign.retryOnBusy === true) retryStatuses.push('busy');
    if (campaign.retryOnFailed === true) retryStatuses.push('failed');

    if (retryStatuses.length === 0) return false;

    const maxAttempts = campaign.retryMaxAttempts ?? 3;
    const intervalMinutes = campaign.retryIntervalMinutes ?? 60;
    const nextRetryAt = new Date(Date.now() + intervalMinutes * 60 * 1000);

    // Query contacts directly by current status — avoids false positives from stale call history.
    // Pre-increment attemptCount here (matching scheduleContactRetry semantics for Twilio/Plivo)
    // so that at retry-pass execution time, COALESCE(attemptCount,1) <= maxAttempts is the right
    // guard. For ElevenLabs, contacts.status is updated by updateCallRecordFromRecipient when the
    // poll resolves, making the inArray(status, retryStatuses) condition work correctly (Task #145).
    const scheduledResult = await db
      .update(contacts)
      .set({
        nextRetryAt,
        attemptCount: sql`COALESCE(${contacts.attemptCount}, 1) + 1`,
      })
      .where(
        and(
          eq(contacts.campaignId, campaign.id),
          inArray(contacts.status, retryStatuses),
          sql`COALESCE(${contacts.attemptCount}, 1) < ${maxAttempts}`,
          isNull(contacts.nextRetryAt)
        )
      )
      .returning({ id: contacts.id });

    if (scheduledResult.length > 0) {
      logger.info(`🔄 [Campaign Scheduler] Campaign "${campaign.name}" scheduled ${scheduledResult.length} contact(s) for retry at ${nextRetryAt.toISOString()} — deferring completion`);
      return true;
    }

    return false;
  }

  /**
   * Poll for campaigns with pending retry passes that are due to execute.
   * Fires the retry pass via campaignExecutor.executeRetryPass().
   */
  static async checkPendingRetryPasses(): Promise<void> {
    try {
      const now = new Date();

      // Find contacts with nextRetryAt in the past (due for retry)
      const dueContacts = await db
        .select({ campaignId: contacts.campaignId })
        .from(contacts)
        .where(
          and(
            isNotNull(contacts.nextRetryAt),
            lte(contacts.nextRetryAt, now)
          )
        );

      if (dueContacts.length === 0) return;

      // Deduplicate campaign IDs
      const campaignIds = Array.from(new Set(dueContacts.map(c => c.campaignId).filter(Boolean))) as string[];

      if (campaignIds.length === 0) return;

      logger.info(`🔄 [Campaign Scheduler] Found ${campaignIds.length} campaign(s) with due retry passes`);

      // Load campaign records to check schedule windows
      const campaignRecords = await db
        .select()
        .from(campaigns)
        .where(inArray(campaigns.id, campaignIds));

      const { campaignExecutor } = await import('./campaign-executor');

      for (const campaign of campaignRecords) {
        // Respect the campaign's call window for retry passes too
        if (campaign.scheduleEnabled && !CampaignScheduler.isWithinCallWindow(campaign)) {
          const nextWindow = CampaignScheduler.getNextCallWindow(campaign);
          logger.warn(`⏳ [Campaign Scheduler] Retry pass deferred for "${campaign.name}" — outside call window. Next: ${nextWindow?.toISOString() ?? 'unknown'}`);

          // Push overdue nextRetryAt to the next open window slot so they don't keep triggering
          if (nextWindow) {
            await db
              .update(contacts)
              .set({ nextRetryAt: nextWindow })
              .where(
                and(
                  eq(contacts.campaignId, campaign.id),
                  isNotNull(contacts.nextRetryAt),
                  lte(contacts.nextRetryAt, now)
                )
              );
          }
          continue;
        }

        try {
          await campaignExecutor.executeRetryPass(campaign.id);
        } catch (err: any) {
          console.error(`   Failed to execute retry pass for campaign ${campaign.id}: ${err.message}`);
        }
      }
    } catch (error) {
      console.error('[Campaign Scheduler] Error checking retry passes:', error);
    }
  }
}

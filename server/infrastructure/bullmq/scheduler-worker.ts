'use strict';
/**
 * ============================================================
 * BullMQ Scheduler Worker
 * Handles scheduled campaign execution and recovery
 * 
 * Environment Variables:
 * - BULLMQ_STUCK_CAMPAIGN_MAX_AGE_MS: Max age for stuck campaigns (default: 30 min)
 * - BULLMQ_STALE_CALL_MAX_AGE_MS: Max age for stale calls (default: 60 min)
 * - BULLMQ_RECOVERY_CHECK_INTERVAL_MS: Recovery check interval (default: 5 min)
 * - BULLMQ_STALE_CLEANUP_INTERVAL_MS: Stale call cleanup interval (default: 15 min)
 * ============================================================
 */

import { Worker, Job } from 'bullmq';
import { getRedisConnection } from './redis-connection';
import { QUEUE_NAMES, SchedulerJob, RecoveryJob, getCampaignSchedulerQueue, getCampaignRecoveryQueue } from './queues';
import { logger } from '../../utils/logger.ts';

const STUCK_CAMPAIGN_MAX_AGE_MS = parseInt(process.env.BULLMQ_STUCK_CAMPAIGN_MAX_AGE_MS || String(30 * 60 * 1000), 10);
const STALE_CALL_MAX_AGE_MS = parseInt(process.env.BULLMQ_STALE_CALL_MAX_AGE_MS || String(60 * 60 * 1000), 10);
const RECOVERY_CHECK_INTERVAL_MS = parseInt(process.env.BULLMQ_RECOVERY_CHECK_INTERVAL_MS || String(5 * 60 * 1000), 10);
const STALE_CLEANUP_INTERVAL_MS = parseInt(process.env.BULLMQ_STALE_CLEANUP_INTERVAL_MS || String(15 * 60 * 1000), 10);

let schedulerWorker: Worker<SchedulerJob> | null = null;
let recoveryWorker: Worker<RecoveryJob> | null = null;

async function processSchedulerJob(job: Job<SchedulerJob>): Promise<void> {
  const { type, campaignId } = job.data;
  
  logger.info(`[SchedulerWorker] Processing ${type} job`);
  
  switch (type) {
    case 'check_scheduled':
      await checkScheduledCampaigns();
      break;
    case 'resume_campaign':
      if (campaignId) {
        await resumeCampaign(campaignId);
      }
      break;
    default:
      logger.warn(`[SchedulerWorker] Unknown job type: ${type}`);
  }
}

async function checkScheduledCampaigns(): Promise<void> {
  try {
    const { db } = await import('../../db');
    const { campaigns } = await import('../../../shared/schema');
    const { eq, and, lte, isNotNull } = await import('drizzle-orm');
    
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
    
    logger.info(`[SchedulerWorker] Found ${scheduledCampaigns.length} campaigns ready to start`);
    
    for (const campaign of scheduledCampaigns) {
      try {
        await db.update(campaigns)
          .set({ status: 'queued' })
          .where(eq(campaigns.id, campaign.id));
        
        const { campaignExecutor } = await import('../../services/campaign-executor');
        await campaignExecutor.executeCampaign(campaign.id);
        
        logger.info(`[SchedulerWorker] Started campaign ${campaign.id}`);
      } catch (error: any) {
        logger.error(`[SchedulerWorker] Failed to start campaign ${campaign.id}:`, error.message);
        
        await db.update(campaigns)
          .set({ 
            status: 'failed',
            errorMessage: error.message,
            errorCode: 'SCHEDULER_ERROR',
          })
          .where(eq(campaigns.id, campaign.id));
      }
    }
  } catch (error: any) {
    logger.error('[SchedulerWorker] Failed to check scheduled campaigns:', error.message);
    throw error;
  }
}

async function resumeCampaign(campaignId: string): Promise<void> {
  try {
    const { campaignExecutor } = await import('../../services/campaign-executor');
    await campaignExecutor.resumeCampaign(campaignId);
    logger.info(`[SchedulerWorker] Resumed campaign ${campaignId}`);
  } catch (error: any) {
    logger.error(`[SchedulerWorker] Failed to resume campaign ${campaignId}:`, error.message);
    throw error;
  }
}

async function processRecoveryJob(job: Job<RecoveryJob>): Promise<void> {
  const { type, campaignId, maxAge } = job.data;
  
  logger.info(`[RecoveryWorker] Processing ${type} job`);
  
  switch (type) {
    case 'recover_stuck':
      await recoverStuckCampaigns(maxAge || 30 * 60 * 1000);
      break;
    case 'cleanup_stale':
      await cleanupStaleCalls(maxAge || 60 * 60 * 1000);
      break;
    default:
      logger.warn(`[RecoveryWorker] Unknown job type: ${type}`);
  }
}

async function recoverStuckCampaigns(maxAgeMs: number): Promise<void> {
  try {
    const { db } = await import('../../db');
    const { campaigns, contacts } = await import('../../../shared/schema');
    const { eq, and, lt, isNotNull } = await import('drizzle-orm');
    
    const cutoffTime = new Date(Date.now() - maxAgeMs);
    
    const stuckCampaigns = await db.select()
      .from(campaigns)
      .where(
        and(
          eq(campaigns.status, 'in_progress'),
          isNotNull(campaigns.startedAt),
          lt(campaigns.startedAt, cutoffTime)
        )
      )
      .limit(10);
    
    logger.info(`[RecoveryWorker] Found ${stuckCampaigns.length} stuck campaigns`);
    
    for (const campaign of stuckCampaigns) {
      const stuckContacts = await db.select()
        .from(contacts)
        .where(
          and(
            eq(contacts.campaignId, campaign.id),
            eq(contacts.status, 'in_progress')
          )
        );
      
      for (const contact of stuckContacts) {
        await db.update(contacts)
          .set({ status: 'pending' })
          .where(eq(contacts.id, contact.id));
      }
      
      logger.info(`[RecoveryWorker] Reset ${stuckContacts.length} stuck contacts for campaign ${campaign.id}`);
    }
  } catch (error: any) {
    logger.error('[RecoveryWorker] Failed to recover stuck campaigns:', error.message);
    throw error;
  }
}

async function cleanupStaleCalls(maxAgeMs: number): Promise<void> {
  try {
    const { db } = await import('../../db');
    const { calls } = await import('../../../shared/schema');
    const { eq, and, lt, isNull } = await import('drizzle-orm');
    
    const cutoffTime = new Date(Date.now() - maxAgeMs);
    
    const staleCalls = await db.select()
      .from(calls)
      .where(
        and(
          eq(calls.status, 'in_progress'),
          lt(calls.startedAt, cutoffTime),
          isNull(calls.endedAt)
        )
      )
      .limit(100);
    
    if (staleCalls.length === 0) {
      return;
    }
    
    logger.info(`[RecoveryWorker] Found ${staleCalls.length} potentially stale calls`);
    
    let cleanedUp = 0;
    for (const call of staleCalls) {
      const metadata = call.metadata as Record<string, any> || {};
      const lastWebhookAt = metadata.lastWebhookAt ? new Date(metadata.lastWebhookAt) : null;
      
      if (lastWebhookAt && lastWebhookAt > cutoffTime) {
        logger.info(`[RecoveryWorker] Skipping call ${call.id} - recent webhook at ${lastWebhookAt.toISOString()}`);
        continue;
      }
      
      await db.update(calls)
        .set({ 
          status: 'failed',
          endedAt: new Date(),
        })
        .where(eq(calls.id, call.id));
      cleanedUp++;
    }
    
    if (cleanedUp > 0) {
      logger.info(`[RecoveryWorker] Cleaned up ${cleanedUp} stale calls`);
    }
    
  } catch (error: any) {
    logger.error('[RecoveryWorker] Failed to cleanup stale calls:', error.message);
    throw error;
  }
}

export function startSchedulerWorker(): Worker<SchedulerJob> {
  if (schedulerWorker) {
    return schedulerWorker;
  }
  
  schedulerWorker = new Worker<SchedulerJob>(
    QUEUE_NAMES.CAMPAIGN_SCHEDULER,
    processSchedulerJob,
    {
      connection: getRedisConnection() as any,
      concurrency: 1,
    }
  );
  
  schedulerWorker.on('completed', (job) => {
    logger.info(`[SchedulerWorker] Job ${job.id} completed`);
  });
  
  schedulerWorker.on('failed', (job, err) => {
    if (job) {
      logger.error(`[SchedulerWorker] Job ${job.id} failed:`, err.message);
    }
  });
  
  logger.info('[SchedulerWorker] Started');
  return schedulerWorker;
}

export function startRecoveryWorker(): Worker<RecoveryJob> {
  if (recoveryWorker) {
    return recoveryWorker;
  }
  
  recoveryWorker = new Worker<RecoveryJob>(
    QUEUE_NAMES.CAMPAIGN_RECOVERY,
    processRecoveryJob,
    {
      connection: getRedisConnection() as any,
      concurrency: 1,
    }
  );
  
  recoveryWorker.on('completed', (job) => {
    logger.info(`[RecoveryWorker] Job ${job.id} completed`);
  });
  
  recoveryWorker.on('failed', (job, err) => {
    if (job) {
      logger.error(`[RecoveryWorker] Job ${job.id} failed:`, err.message);
    }
  });
  
  logger.info('[RecoveryWorker] Started');
  return recoveryWorker;
}

export async function setupRecurringJobs(): Promise<void> {
  const schedulerQueue = getCampaignSchedulerQueue();
  const recoveryQueue = getCampaignRecoveryQueue();
  
  await schedulerQueue.upsertJobScheduler(
    'check-scheduled-campaigns',
    { every: 60000 },
    {
      name: 'check-scheduled',
      data: { type: 'check_scheduled' },
    }
  );
  
  await recoveryQueue.upsertJobScheduler(
    'recover-stuck-campaigns',
    { every: RECOVERY_CHECK_INTERVAL_MS },
    {
      name: 'recover-stuck',
      data: { type: 'recover_stuck', maxAge: STUCK_CAMPAIGN_MAX_AGE_MS },
    }
  );
  
  await recoveryQueue.upsertJobScheduler(
    'cleanup-stale-calls',
    { every: STALE_CLEANUP_INTERVAL_MS },
    {
      name: 'cleanup-stale',
      data: { type: 'cleanup_stale', maxAge: STALE_CALL_MAX_AGE_MS },
    }
  );
  
  logger.info(`[BullMQ] Recurring jobs scheduled:
   - Campaign scheduler: every 60s
   - Stuck recovery: every ${RECOVERY_CHECK_INTERVAL_MS / 1000}s (max age: ${STUCK_CAMPAIGN_MAX_AGE_MS / 60000} min)
   - Stale cleanup: every ${STALE_CLEANUP_INTERVAL_MS / 1000}s (max age: ${STALE_CALL_MAX_AGE_MS / 60000} min)`);
}

export async function stopSchedulerWorkers(): Promise<void> {
  const closePromises: Promise<void>[] = [];
  
  if (schedulerWorker) {
    closePromises.push(schedulerWorker.close());
    schedulerWorker = null;
  }
  if (recoveryWorker) {
    closePromises.push(recoveryWorker.close());
    recoveryWorker = null;
  }
  
  await Promise.all(closePromises);
  logger.info('[SchedulerWorker] All scheduler workers stopped');
}

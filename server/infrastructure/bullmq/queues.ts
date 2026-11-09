'use strict';
/**
 * ============================================================
 * BullMQ Queue Definitions
 * Defines all queues used for campaign processing
 * ============================================================
 */

import { Queue, QueueEvents } from 'bullmq';
import { getRedisConnection } from './redis-connection';
import { logger } from '../../utils/logger.ts';

export const QUEUE_NAMES = {
  CAMPAIGN_CALLS: 'campaign-calls',
  CAMPAIGN_SCHEDULER: 'campaign-scheduler',
  CAMPAIGN_RECOVERY: 'campaign-recovery',
  GENERIC_JOBS: 'desk-generic-jobs',
} as const;

export type QueueName = typeof QUEUE_NAMES[keyof typeof QUEUE_NAMES];

export interface CampaignCallJob {
  campaignId: string;
  contactId: string;
  callId: string;
  phone: string;
  agentId: string;
  userId: string;
  engine: 'openai' | 'sip' | 'elevenlabs';
  flowId?: string;
  retryCount: number;
  metadata?: Record<string, any>;
}

export interface SchedulerJob {
  type: 'check_scheduled' | 'resume_campaign';
  campaignId?: string;
}

export interface RecoveryJob {
  type: 'recover_stuck' | 'cleanup_stale';
  campaignId?: string;
  maxAge?: number;
}

let campaignCallsQueue: Queue<CampaignCallJob> | null = null;
let campaignSchedulerQueue: Queue<SchedulerJob> | null = null;
let campaignRecoveryQueue: Queue<RecoveryJob> | null = null;
let genericJobsQueue: Queue<unknown> | null = null;

const defaultQueueOptions = {
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential' as const,
      delay: 5000,
    },
    removeOnComplete: {
      age: 3600,
      count: 1000,
    },
    removeOnFail: {
      age: 86400,
      count: 5000,
    },
  },
};

export function getCampaignCallsQueue(): Queue<CampaignCallJob> {
  if (!campaignCallsQueue) {
    campaignCallsQueue = new Queue<CampaignCallJob>(QUEUE_NAMES.CAMPAIGN_CALLS, {
      connection: getRedisConnection() as any,
      ...defaultQueueOptions,
    });
  }
  return campaignCallsQueue;
}

export function getCampaignSchedulerQueue(): Queue<SchedulerJob> {
  if (!campaignSchedulerQueue) {
    campaignSchedulerQueue = new Queue<SchedulerJob>(QUEUE_NAMES.CAMPAIGN_SCHEDULER, {
      connection: getRedisConnection() as any,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: {
          age: 3600,
          count: 100,
        },
      },
    });
  }
  return campaignSchedulerQueue;
}

export function getCampaignRecoveryQueue(): Queue<RecoveryJob> {
  if (!campaignRecoveryQueue) {
    campaignRecoveryQueue = new Queue<RecoveryJob>(QUEUE_NAMES.CAMPAIGN_RECOVERY, {
      connection: getRedisConnection() as any,
      defaultJobOptions: {
        attempts: 2,
        backoff: {
          type: 'fixed' as const,
          delay: 10000,
        },
        removeOnComplete: true,
        removeOnFail: {
          age: 86400,
          count: 100,
        },
      },
    });
  }
  return campaignRecoveryQueue;
}

/**
 * Shared queue for the generic typed-job layer (generic-jobs.ts).
 * Per-type retry options are passed on each add, so these are fallbacks.
 * Completed jobs are kept 24h (or up to 10000 records), which sets how long a jobId stays
 * reserved for dedupe. The count cap can release a jobId earlier under heavy load.
 */
export function getGenericJobsQueue(): Queue<unknown> {
  if (!genericJobsQueue) {
    genericJobsQueue = new Queue<unknown>(QUEUE_NAMES.GENERIC_JOBS, {
      connection: getRedisConnection() as any,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential' as const,
          delay: 5000,
        },
        removeOnComplete: {
          age: 86400,
          count: 10000,
        },
        removeOnFail: {
          age: 604800,
          count: 5000,
        },
      },
    });
  }
  return genericJobsQueue;
}

export async function closeAllQueues(): Promise<void> {
  const closePromises: Promise<void>[] = [];
  
  if (campaignCallsQueue) {
    closePromises.push(campaignCallsQueue.close());
    campaignCallsQueue = null;
  }
  if (campaignSchedulerQueue) {
    closePromises.push(campaignSchedulerQueue.close());
    campaignSchedulerQueue = null;
  }
  if (campaignRecoveryQueue) {
    closePromises.push(campaignRecoveryQueue.close());
    campaignRecoveryQueue = null;
  }
  if (genericJobsQueue) {
    closePromises.push(genericJobsQueue.close());
    genericJobsQueue = null;
  }

  await Promise.all(closePromises);
  logger.info('[BullMQ] All queues closed');
}

export async function addCampaignCallJobs(jobs: CampaignCallJob[]): Promise<void> {
  const queue = getCampaignCallsQueue();
  const bulkJobs = jobs.map((job) => ({
    name: `call-${job.callId}`,
    data: job,
    opts: {
      jobId: job.callId,
      priority: job.retryCount > 0 ? 10 : 1,
    },
  }));
  
  await queue.addBulk(bulkJobs);
  logger.info(`[BullMQ] Added ${jobs.length} call jobs to queue`);
}

export async function getQueueStats(queueName: QueueName): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}> {
  let queue: Queue;
  switch (queueName) {
    case QUEUE_NAMES.CAMPAIGN_CALLS:
      queue = getCampaignCallsQueue();
      break;
    case QUEUE_NAMES.CAMPAIGN_SCHEDULER:
      queue = getCampaignSchedulerQueue();
      break;
    case QUEUE_NAMES.CAMPAIGN_RECOVERY:
      queue = getCampaignRecoveryQueue();
      break;
    case QUEUE_NAMES.GENERIC_JOBS:
      queue = getGenericJobsQueue();
      break;
    default:
      throw new Error(`Unknown queue: ${queueName}`);
  }
  
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
  ]);
  
  return { waiting, active, completed, failed, delayed };
}

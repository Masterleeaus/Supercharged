'use strict';
/**
 * ============================================================
 * Approval expiry job type (defined, NOT started)
 *
 * Nothing registers this job type on import. A future approvals
 * module calls registerApprovalExpiryJob(registry, { expireApproval })
 * once at startup, then enqueues one delayed job per approval with
 * approvalExpiryEnqueue(approvalId, ttlMs).
 *
 * The handler only calls the injected expireApproval(approvalId).
 * It does not read or write approval data.
 *
 * expireApproval MUST be idempotent: it should check the approval's
 * current state and do nothing if the approval was already decided
 * or expired. The job can run again after a retry, or after its
 * jobId record is removed and the job is enqueued again.
 * ============================================================
 */

import type { EnqueueOptions, GenericJobs, JobRetryOptions } from '../generic-jobs';

export const APPROVAL_EXPIRY_JOB_TYPE = 'approval-expiry';

export interface ApprovalExpiryPayload {
  approvalId: string;
}

export interface ApprovalExpiryDeps {
  expireApproval: (approvalId: string) => Promise<void> | void;
}

export const APPROVAL_EXPIRY_RETRY_OPTIONS: JobRetryOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 10000 },
};

/**
 * jobId for an approval's expiry job. The prefix keeps it from being
 * all digits, which BullMQ rejects, and makes it readable in Redis.
 */
export function approvalExpiryJobId(approvalId: string): string {
  return `approval-expiry-${approvalId}`;
}

/**
 * Registers the approval-expiry job type on the given registry.
 * Call once at startup. A second call throws DuplicateJobTypeError.
 */
export function registerApprovalExpiryJob(
  registry: Pick<GenericJobs, 'registerJobType'>,
  deps: ApprovalExpiryDeps,
): void {
  if (!deps || typeof deps.expireApproval !== 'function') {
    throw new TypeError('registerApprovalExpiryJob requires deps.expireApproval as a function');
  }
  registry.registerJobType<ApprovalExpiryPayload>(
    APPROVAL_EXPIRY_JOB_TYPE,
    async (payload) => {
      if (!payload || typeof payload.approvalId !== 'string' || payload.approvalId.length === 0) {
        throw new TypeError('approval-expiry payload requires a non-empty approvalId');
      }
      await deps.expireApproval(payload.approvalId);
    },
    APPROVAL_EXPIRY_RETRY_OPTIONS,
  );
}

/**
 * Builds the arguments for enqueueJob. The delay equals the approval TTL,
 * and the jobId makes a repeat enqueue for the same approval a no-op
 * (see the idempotency notes in generic-jobs.ts).
 *
 * Usage: const { name, payload, opts } = approvalExpiryEnqueue(id, ttlMs);
 *        await enqueueJob(name, payload, opts);
 */
export function approvalExpiryEnqueue(
  approvalId: string,
  ttlMs: number,
): { name: string; payload: ApprovalExpiryPayload; opts: EnqueueOptions } {
  if (typeof approvalId !== 'string' || approvalId.length === 0) {
    throw new TypeError('approvalExpiryEnqueue requires a non-empty approvalId');
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new TypeError('approvalExpiryEnqueue requires ttlMs as a positive integer (ms)');
  }
  return {
    name: APPROVAL_EXPIRY_JOB_TYPE,
    payload: { approvalId },
    opts: { delay: ttlMs, jobId: approvalExpiryJobId(approvalId) },
  };
}

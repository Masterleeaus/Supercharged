/*
 * In-process send queue for campaign send jobs. It only drives CampaignService.dispatchJob;
 * it never calls a transport itself, so consent and suppression re-checks in the service still
 * run before every send.
 *
 *   - Idempotency: one queue entry per (company, campaign, step, channel, address). Enqueuing
 *     the same recipient twice is a no-op.
 *   - Claiming: claimJob marks one job as held by one worker (a token). The store only sets a
 *     claim when none is held, so a second claim returns null. The job row is also moved
 *     queued -> sending by compare-and-set inside dispatchJob, so two queues over the same store
 *     still cannot send twice.
 *   - Bounded retries: the attempt count goes up before each transport call. A transport error
 *     requeues the job while attempts < maxAttempts. After that the job is failed and its entry
 *     is dead-lettered.
 *   - Dead letter: a dead-lettered entry is never claimed or recovered again. It stays visible
 *     through deadLetters(companyId) until someone deals with it outside this queue.
 *   - Recovery: a claim older than claimTimeoutMs is released. A job still 'sending' is requeued
 *     (or failed and dead-lettered when its attempts are used up). A job that is already sent,
 *     skipped or failed is never sent again.
 *
 * Not durable across restarts. The queue state lives in SendQueueStore. The durable version is
 * in migrations/DRAFT_campaign_send_queue.sql and needs a Drizzle store before use.
 * Not mounted and not started by any scheduler.
 */
import { randomUUID } from 'node:crypto';
import { requireCompanyId } from '../chatbot/chatbot-scope.ts';
import { CampaignError, sha256, type CampaignService } from './campaign-service.ts';
import type { CampaignStore } from './ports.ts';
import type { SendJob } from './types.ts';

export interface QueueEntry {
  companyId: string;
  /** Idempotency key: sha256 over company, campaign, step, channel and address. */
  key: string;
  jobId: string;
  /** Transport calls made so far for this job. Counted before each call. */
  attempts: number;
  nextAttemptAt: Date;
  claimToken: string | null;
  claimedAt: Date | null;
  lastErrorCode: string | null;
  /** Set once the job has used its attempts or ended failed. A dead entry is never claimed. */
  deadLetteredAt: Date | null;
}

export type QueueEntryPatch = Partial<
  Pick<QueueEntry, 'attempts' | 'nextAttemptAt' | 'claimToken' | 'claimedAt' | 'lastErrorCode' | 'deadLetteredAt'>
>;

/** A job held by one worker. Pass `token` back to the queue as the proof of the claim. */
export interface ClaimedJob {
  companyId: string;
  key: string;
  jobId: string;
  token: string;
  /** Attempts already made before this claim. */
  attempts: number;
  job: SendJob;
}

/** Queue state. Every write that depends on a claim names the token that must still hold it. */
export interface SendQueueStore {
  /** Inserts the entry unless its key already exists. Returns false for a duplicate. */
  insertIfAbsent(entry: QueueEntry): Promise<boolean>;
  list(companyId: string): Promise<QueueEntry[]>;
  /**
   * Sets the claim only when no claim is held and the entry is not dead-lettered.
   * Returns the claimed entry, or null.
   */
  claim(companyId: string, key: string, token: string, at: Date): Promise<QueueEntry | null>;
  /** Applies the patch only while `token` holds the claim. Returns null otherwise. */
  update(companyId: string, key: string, token: string, patch: QueueEntryPatch): Promise<QueueEntry | null>;
}

const clone = (e: QueueEntry): QueueEntry => ({ ...e });

/** Single-process store. Each method is synchronous inside, so the compare-and-set is atomic. */
export class InMemorySendQueueStore implements SendQueueStore {
  private readonly rows = new Map<string, QueueEntry>();

  private static slot(companyId: string, key: string): string {
    return `${companyId}\u0000${key}`;
  }

  async insertIfAbsent(entry: QueueEntry): Promise<boolean> {
    const slot = InMemorySendQueueStore.slot(entry.companyId, entry.key);
    if (this.rows.has(slot)) return false;
    this.rows.set(slot, clone(entry));
    return true;
  }

  async list(companyId: string): Promise<QueueEntry[]> {
    return [...this.rows.values()].filter((r) => r.companyId === companyId).map(clone);
  }

  async claim(companyId: string, key: string, token: string, at: Date): Promise<QueueEntry | null> {
    const row = this.rows.get(InMemorySendQueueStore.slot(companyId, key));
    if (!row || row.claimToken !== null || row.deadLetteredAt !== null) return null;
    row.claimToken = token;
    row.claimedAt = at;
    return clone(row);
  }

  async update(companyId: string, key: string, token: string, patch: QueueEntryPatch): Promise<QueueEntry | null> {
    const row = this.rows.get(InMemorySendQueueStore.slot(companyId, key));
    if (!row || row.claimToken !== token) return null;
    Object.assign(row, patch);
    return clone(row);
  }
}

export interface SendQueueDeps {
  service: Pick<CampaignService, 'dispatchJob'>;
  store: CampaignStore;
  queue?: SendQueueStore;
  /** Transport calls allowed per job, including the first. Integer 1 to 10. Default 3. */
  maxAttempts?: number;
  /** A claim older than this is treated as stuck. Default 5 minutes. */
  claimTimeoutMs?: number;
  /** Delay before a retry after a transport error, doubled per attempt. Default 30 seconds. */
  retryBaseMs?: number;
  /** Upper bound on the retry delay. Default 30 minutes. */
  retryMaxMs?: number;
  /** Delay before a job deferred by quiet hours is tried again. Default 15 minutes. */
  deferMs?: number;
  now?: () => Date;
  newToken?: () => string;
}

export interface RunSummary {
  /** Stale claims released. Jobs moved back to queued, or failed when attempts ran out. */
  recovered: number;
  /** Jobs claimed and passed to dispatchJob in this run. */
  dispatched: number;
  sent: number;
  /** Transport error, job back to queued for a later attempt. */
  requeued: number;
  /** Deferred by quiet hours. No attempt was used. */
  deferred: number;
  /** Ended skipped or failed. Nothing further will happen to this job. */
  finished: number;
  /** Outcome unknown (job left 'sending'). Left for recovery, not released early. */
  held: number;
}

export interface SendQueue {
  enqueue(companyId: string, jobs: SendJob[]): Promise<{ enqueued: number; duplicates: number; ignored: number }>;
  /**
   * Claims one queued job for one worker. Returns null when the job is unknown, not queued, not
   * yet due, dead-lettered, or already held. A caller that never releases the claim loses it
   * after claimTimeoutMs, when recovery releases it.
   */
  claimJob(companyId: string, jobId: string): Promise<ClaimedJob | null>;
  /** Entries that used their attempts or ended failed. Nothing sends them again. */
  deadLetters(companyId: string): Promise<QueueEntry[]>;
  runOnce(companyId: string, options?: { limit?: number }): Promise<RunSummary>;
}

/** Idempotency key for one recipient in one step of one campaign. */
export function idempotencyKey(job: Pick<SendJob, 'companyId' | 'campaignId' | 'stepId' | 'channel' | 'address'>): string {
  return sha256(JSON.stringify([job.companyId, job.campaignId, job.stepId, job.channel, job.address]));
}

function assertInt(value: number, name: string, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`send-queue: ${name} must be an integer from ${min} to ${max}`);
  }
}

function emptySummary(): RunSummary {
  return { recovered: 0, dispatched: 0, sent: 0, requeued: 0, deferred: 0, finished: 0, held: 0 };
}

export function createSendQueue(deps: SendQueueDeps): SendQueue {
  const { service, store } = deps;
  const state = deps.queue ?? new InMemorySendQueueStore();
  const maxAttempts = deps.maxAttempts ?? 3;
  const claimTimeoutMs = deps.claimTimeoutMs ?? 5 * 60 * 1000;
  const retryBaseMs = deps.retryBaseMs ?? 30 * 1000;
  const retryMaxMs = deps.retryMaxMs ?? 30 * 60 * 1000;
  const deferMs = deps.deferMs ?? 15 * 60 * 1000;
  const now = deps.now ?? (() => new Date());
  const newToken = deps.newToken ?? (() => randomUUID());

  assertInt(maxAttempts, 'maxAttempts', 1, 10);
  if (!Number.isFinite(claimTimeoutMs) || claimTimeoutMs <= 0) throw new RangeError('send-queue: claimTimeoutMs must be positive');
  if (!Number.isFinite(retryBaseMs) || retryBaseMs < 0) throw new RangeError('send-queue: retryBaseMs must be zero or more');
  if (!Number.isFinite(retryMaxMs) || retryMaxMs < retryBaseMs) throw new RangeError('send-queue: retryMaxMs must be at least retryBaseMs');
  if (!Number.isFinite(deferMs) || deferMs < 0) throw new RangeError('send-queue: deferMs must be zero or more');

  const addMs = (at: Date, ms: number): Date => new Date(at.getTime() + ms);

  function retryDelayMs(attempts: number): number {
    return Math.min(retryBaseMs * 2 ** Math.max(0, attempts - 1), retryMaxMs);
  }

  /** Releases a claim the caller holds. Returns false when the claim is no longer held by the token. */
  async function release(companyId: string, key: string, token: string, patch: QueueEntryPatch = {}): Promise<boolean> {
    const next = await state.update(companyId, key, token, { ...patch, claimToken: null, claimedAt: null });
    return next !== null;
  }

  /** Releases the claim and dead-letters the entry. Used when a job must never be sent again. */
  async function deadLetter(companyId: string, key: string, token: string, code: string): Promise<boolean> {
    return release(companyId, key, token, { deadLetteredAt: now(), lastErrorCode: code });
  }

  /**
   * Claims an entry if it is due, not held, not dead, and its job is still queued. The one place
   * a claim is taken, so the rules cannot drift between claimJob and runOnce.
   */
  async function claimEntry(companyId: string, entry: QueueEntry): Promise<ClaimedJob | null> {
    if (entry.claimToken !== null || entry.deadLetteredAt !== null) return null;
    if (entry.nextAttemptAt.getTime() > now().getTime()) return null;
    const job = await store.findJob(companyId, entry.jobId);
    if (!job || job.status !== 'queued') return null;
    const token = newToken();
    const row = await state.claim(companyId, entry.key, token, now());
    if (!row) return null; // another worker holds this entry
    return { companyId, key: row.key, jobId: row.jobId, token, attempts: row.attempts, job };
  }

  /**
   * Releases claims that have timed out. A job still 'sending' is requeued while attempts remain.
   * When they do not, the job is failed and its entry dead-lettered. Any other job is only
   * unlocked, never sent again.
   */
  async function recover(companyId: string): Promise<number> {
    const at = now();
    const cutoff = at.getTime() - claimTimeoutMs;
    let recovered = 0;
    for (const entry of await state.list(companyId)) {
      if (entry.claimToken === null || entry.claimedAt === null || entry.claimedAt.getTime() > cutoff) continue;
      const token = entry.claimToken;
      const job = await store.findJob(companyId, entry.jobId);
      if (job && job.status === 'sending') {
        if (entry.attempts < maxAttempts) {
          const moved = await store.transitionJob(companyId, job.id, 'sending', { status: 'queued', updatedAt: at });
          if (moved) recovered += 1;
          await release(companyId, entry.key, token, { nextAttemptAt: at, lastErrorCode: 'claim_timeout' });
        } else {
          const moved = await store.transitionJob(companyId, job.id, 'sending', { status: 'failed', updatedAt: at });
          if (moved) recovered += 1;
          await deadLetter(companyId, entry.key, token, 'claim_timeout');
        }
      } else {
        await release(companyId, entry.key, token);
      }
    }
    return recovered;
  }

  async function dispatchClaimed(claimed: ClaimedJob, summary: RunSummary): Promise<void> {
    const { companyId, key, token, job } = claimed;
    let attempts = claimed.attempts;
    try {
      const result = await service.dispatchJob(companyId, job.id, {
        // Counted before the transport runs. If the update fails, the transport is not called.
        onTransportAttempt: async () => {
          const next = await state.update(companyId, key, token, { attempts: claimed.attempts + 1 });
          if (!next) throw new CampaignError('Queue claim lost before send', 'conflict');
          attempts = next.attempts;
        },
        onTransportError: claimed.attempts + 1 < maxAttempts ? 'requeue' : 'fail',
      });

      switch (result.status) {
        case 'queued':
          if (attempts > claimed.attempts) {
            summary.requeued += 1;
            await release(companyId, key, token, { nextAttemptAt: addMs(now(), retryDelayMs(attempts)), lastErrorCode: 'transport_error' });
          } else {
            summary.deferred += 1;
            await release(companyId, key, token, { nextAttemptAt: addMs(now(), deferMs), lastErrorCode: 'quiet_hours' });
          }
          return;
        case 'sending':
          // Outcome unknown. Keep the claim so recovery decides after the timeout.
          summary.held += 1;
          return;
        case 'sent':
          summary.sent += 1;
          await release(companyId, key, token, { lastErrorCode: null });
          return;
        case 'failed':
          // Only reached when the transport error used the last attempt. Never retried.
          summary.finished += 1;
          await deadLetter(companyId, key, token, 'max_attempts');
          return;
        default:
          summary.finished += 1;
          await release(companyId, key, token);
          return;
      }
    } catch {
      // Generic: no provider payload or message text is kept. Decide from the stored job status.
      const latest = await store.findJob(companyId, job.id);
      if (latest && latest.status === 'sending') {
        summary.held += 1;
        return;
      }
      if (latest && latest.status === 'queued') {
        await release(companyId, key, token, { nextAttemptAt: now(), lastErrorCode: 'dispatch_error' });
        return;
      }
      if (latest && latest.status === 'failed') {
        summary.finished += 1;
        await deadLetter(companyId, key, token, 'max_attempts');
        return;
      }
      await release(companyId, key, token);
      summary.finished += 1;
    }
  }

  return {
    async enqueue(rawCompanyId, jobs) {
      const companyId = requireCompanyId(rawCompanyId);
      for (const job of jobs) {
        if (job.companyId !== companyId) throw new CampaignError('Send job belongs to another company', 'forbidden');
      }
      let enqueued = 0;
      let duplicates = 0;
      let ignored = 0;
      for (const job of jobs) {
        if (job.status !== 'queued') {
          ignored += 1;
          continue;
        }
        const inserted = await state.insertIfAbsent({
          companyId,
          key: idempotencyKey(job),
          jobId: job.id,
          attempts: 0,
          nextAttemptAt: now(),
          claimToken: null,
          claimedAt: null,
          lastErrorCode: null,
          deadLetteredAt: null,
        });
        if (inserted) enqueued += 1;
        else duplicates += 1;
      }
      return { enqueued, duplicates, ignored };
    },

    async claimJob(rawCompanyId, jobId) {
      const companyId = requireCompanyId(rawCompanyId);
      const entry = (await state.list(companyId)).find((e) => e.jobId === jobId);
      if (!entry) return null;
      return claimEntry(companyId, entry);
    },

    async deadLetters(rawCompanyId) {
      const companyId = requireCompanyId(rawCompanyId);
      return (await state.list(companyId)).filter((e) => e.deadLetteredAt !== null);
    },

    async runOnce(rawCompanyId, options = {}) {
      const companyId = requireCompanyId(rawCompanyId);
      const limit = options.limit ?? 50;
      assertInt(limit, 'limit', 1, 10000);

      const summary = emptySummary();
      summary.recovered = await recover(companyId);

      let remaining = limit;
      for (const entry of await state.list(companyId)) {
        if (remaining <= 0) break;
        const claimed = await claimEntry(companyId, entry);
        if (!claimed) continue;
        remaining -= 1;

        if (claimed.attempts >= maxAttempts) {
          // Defensive: a queued job with no attempts left is failed and dead-lettered, never sent.
          await store.transitionJob(companyId, claimed.job.id, 'queued', { status: 'failed', updatedAt: now() });
          await deadLetter(companyId, claimed.key, claimed.token, 'max_attempts');
          summary.finished += 1;
          continue;
        }

        summary.dispatched += 1;
        await dispatchClaimed(claimed, summary);
      }
      return summary;
    },
  };
}

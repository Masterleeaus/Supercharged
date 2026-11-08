'use strict';
/**
 * ============================================================
 * Generic BullMQ job layer (Titan Desk)
 *
 * A feature registers a named job type once (handler + default
 * retry options) and then enqueues typed jobs without writing its
 * own queue file. It runs on the existing BullMQ setup and adds no
 * second queue system.
 *
 * Pure by design: this module has NO runtime imports. The BullMQ
 * queue is injected through bindGenericJobQueue(), so registration,
 * validation and dispatch can be tested with fakes and no Redis.
 * The only import is `import type`, which is erased at runtime.
 *
 * Idempotency (relies on BullMQ jobId behaviour):
 * - enqueueJob passes opts.jobId to BullMQ Queue.add unchanged.
 * - BullMQ silently ignores an add whose jobId already exists.
 *   The job is not duplicated and the existing job is left as is.
 * - The id stays reserved only while that job record exists. Once
 *   the record is removed (removeOnComplete / removeOnFail retention
 *   on the generic queue), the same jobId can be added again and
 *   creates a new job. Callers must not rely on the dedupe window
 *   lasting longer than the retention window.
 * - BullMQ rejects custom ids made only of digits. This module
 *   rejects them first with a clearer error.
 * - Handlers must still be idempotent, because a retry or a
 *   re-enqueue after removal can run them again.
 * ============================================================
 */

import type { JobsOptions } from 'bullmq';

// ---------- Types ----------

/** Retry and retention options a job type carries by default. */
export type JobRetryOptions = Pick<
  JobsOptions,
  'attempts' | 'backoff' | 'removeOnComplete' | 'removeOnFail'
>;

export interface JobMeta {
  name: string;
  jobId: string | undefined;
  attemptsMade: number;
}

export type JobHandler<P = unknown> = (payload: P, meta: JobMeta) => Promise<void> | void;

export interface EnqueueOptions {
  /** Milliseconds to wait before the job becomes runnable. Integer >= 0. */
  delay?: number;
  /** Idempotency key. See the header comment for BullMQ behaviour. */
  jobId?: string;
  /** BullMQ priority, integer 1 (highest) to 2097152. */
  priority?: number;
}

/** The subset of BullMQ Queue this layer uses. A real Queue satisfies it. */
export interface GenericJobQueue {
  add(name: string, data: unknown, opts: JobsOptions): Promise<{ id?: string }>;
}

export interface GenericJobRecord {
  name: string;
  data: unknown;
  id?: string;
  attemptsMade?: number;
}

export interface GenericJobs {
  registerJobType<P = unknown>(name: string, handler: JobHandler<P>, options?: JobRetryOptions): void;
  getJobTypes(): string[];
  bindGenericJobQueue(queue: GenericJobQueue | null): void;
  enqueueJob(name: string, payload: unknown, opts?: EnqueueOptions): Promise<{ jobId: string | undefined }>;
  processGenericJob(job: GenericJobRecord): Promise<void>;
}

// ---------- Errors ----------

export class GenericJobError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GenericJobError';
    this.code = code;
  }
}

export class UnknownJobTypeError extends GenericJobError {
  constructor(message: string) {
    super('UNKNOWN_JOB_TYPE', message);
    this.name = 'UnknownJobTypeError';
  }
}

export class DuplicateJobTypeError extends GenericJobError {
  constructor(message: string) {
    super('DUPLICATE_JOB_TYPE', message);
    this.name = 'DuplicateJobTypeError';
  }
}

export class InvalidJobOptionsError extends GenericJobError {
  constructor(message: string) {
    super('INVALID_JOB_OPTIONS', message);
    this.name = 'InvalidJobOptionsError';
  }
}

export class QueueNotBoundError extends GenericJobError {
  constructor(message: string) {
    super('QUEUE_NOT_BOUND', message);
    this.name = 'QueueNotBoundError';
  }
}

// ---------- Validation helpers ----------

const JOB_TYPE_NAME_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
const MAX_JOB_ID_LENGTH = 256;
const MAX_BULLMQ_PRIORITY = 2097152;

function assertJobTypeName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !JOB_TYPE_NAME_PATTERN.test(name)) {
    throw new InvalidJobOptionsError(
      `Invalid job type name ${JSON.stringify(name)}. Use lowercase letters, digits and hyphens, 2-63 chars, starting with a letter.`,
    );
  }
}

function assertEnqueueOptions(opts: EnqueueOptions): void {
  if (opts.delay !== undefined) {
    if (!Number.isSafeInteger(opts.delay) || opts.delay < 0) {
      throw new InvalidJobOptionsError(`delay must be a non-negative integer (ms), got ${String(opts.delay)}`);
    }
  }
  if (opts.jobId !== undefined) {
    if (typeof opts.jobId !== 'string' || opts.jobId.length === 0 || opts.jobId.length > MAX_JOB_ID_LENGTH) {
      throw new InvalidJobOptionsError(`jobId must be a non-empty string up to ${MAX_JOB_ID_LENGTH} chars`);
    }
    if (/^\d+$/.test(opts.jobId)) {
      throw new InvalidJobOptionsError(`jobId "${opts.jobId}" is digits only; BullMQ rejects integer-like custom ids`);
    }
  }
  if (opts.priority !== undefined) {
    if (!Number.isSafeInteger(opts.priority) || opts.priority < 1 || opts.priority > MAX_BULLMQ_PRIORITY) {
      throw new InvalidJobOptionsError(`priority must be an integer from 1 to ${MAX_BULLMQ_PRIORITY}, got ${String(opts.priority)}`);
    }
  }
}

function cloneRetryOptions(options: JobRetryOptions): JobRetryOptions {
  const copy: JobRetryOptions = {};
  if (options.attempts !== undefined) {
    if (!Number.isSafeInteger(options.attempts) || options.attempts < 1) {
      throw new InvalidJobOptionsError(`attempts must be an integer >= 1, got ${String(options.attempts)}`);
    }
    copy.attempts = options.attempts;
  }
  if (options.backoff !== undefined) {
    copy.backoff = typeof options.backoff === 'number'
      ? options.backoff
      : { ...options.backoff };
  }
  if (options.removeOnComplete !== undefined) {
    copy.removeOnComplete = typeof options.removeOnComplete === 'object'
      ? { ...options.removeOnComplete }
      : options.removeOnComplete;
  }
  if (options.removeOnFail !== undefined) {
    copy.removeOnFail = typeof options.removeOnFail === 'object'
      ? { ...options.removeOnFail }
      : options.removeOnFail;
  }
  return copy;
}

// ---------- Registry factory (pure) ----------

interface RegisteredJobType {
  name: string;
  handler: JobHandler<unknown>;
  options: Readonly<JobRetryOptions>;
}

/**
 * Creates an independent registry. Tests and features that need
 * isolation use this. The module-level functions below share one default
 * registry.
 */
export function createGenericJobs(): GenericJobs {
  const types = new Map<string, RegisteredJobType>();
  let queue: GenericJobQueue | null = null;

  function registerJobType<P = unknown>(
    name: string,
    handler: JobHandler<P>,
    options: JobRetryOptions = {},
  ): void {
    assertJobTypeName(name);
    if (typeof handler !== 'function') {
      throw new InvalidJobOptionsError(`handler for job type "${name}" must be a function`);
    }
    if (types.has(name)) {
      throw new DuplicateJobTypeError(`Job type "${name}" is already registered`);
    }
    types.set(name, {
      name,
      handler: handler as JobHandler<unknown>,
      options: Object.freeze(cloneRetryOptions(options)),
    });
  }

  function getJobTypes(): string[] {
    return [...types.keys()].sort();
  }

  function bindGenericJobQueue(next: GenericJobQueue | null): void {
    queue = next;
  }

  async function enqueueJob(
    name: string,
    payload: unknown,
    opts: EnqueueOptions = {},
  ): Promise<{ jobId: string | undefined }> {
    const type = types.get(name);
    if (!type) {
      throw new UnknownJobTypeError(
        `Unknown job type "${name}". Register it with registerJobType before enqueueing.`,
      );
    }
    assertEnqueueOptions(opts);
    if (!queue) {
      throw new QueueNotBoundError('No BullMQ queue bound. Call bindGenericJobQueue() at startup.');
    }

    // Start from the registered retry defaults, then layer per-call options on top.
    const jobOpts: JobsOptions = cloneRetryOptions(type.options);
    if (opts.delay !== undefined) jobOpts.delay = opts.delay;
    if (opts.jobId !== undefined) jobOpts.jobId = opts.jobId;
    if (opts.priority !== undefined) jobOpts.priority = opts.priority;

    const job = await queue.add(name, payload, jobOpts);
    return { jobId: job.id };
  }

  async function processGenericJob(job: GenericJobRecord): Promise<void> {
    const type = types.get(job.name);
    if (!type) {
      throw new UnknownJobTypeError(`No handler registered for job type "${job.name}"`);
    }
    await type.handler(job.data, {
      name: job.name,
      jobId: job.id,
      attemptsMade: job.attemptsMade ?? 0,
    });
  }

  return {
    registerJobType,
    getJobTypes,
    bindGenericJobQueue,
    enqueueJob,
    processGenericJob,
  };
}

// ---------- Module-level default registry ----------

const defaultGenericJobs = createGenericJobs();

export function registerJobType<P = unknown>(
  name: string,
  handler: JobHandler<P>,
  options?: JobRetryOptions,
): void {
  defaultGenericJobs.registerJobType(name, handler, options);
}

export function getJobTypes(): string[] {
  return defaultGenericJobs.getJobTypes();
}

export function bindGenericJobQueue(queue: GenericJobQueue | null): void {
  defaultGenericJobs.bindGenericJobQueue(queue);
}

export function enqueueJob(
  name: string,
  payload: unknown,
  opts?: EnqueueOptions,
): Promise<{ jobId: string | undefined }> {
  return defaultGenericJobs.enqueueJob(name, payload, opts);
}

export function processGenericJob(job: GenericJobRecord): Promise<void> {
  return defaultGenericJobs.processGenericJob(job);
}

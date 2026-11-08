/**
 * Workflow runs: dispatch with idempotency, resume, complete, fail, retry with backoff, cancel, and a
 * claim for workers. Also runStep, which runs a named step at most once per run even when the run is retried.
 *
 * Port of extensions/chatbot/System/Services/WorkflowRuntime.php. Differences are listed in DECISIONS.md.
 */
import type { WorkflowDispatchOptions, WorkflowRunStatus, WorkflowRuntime } from "../contracts/index.ts";
import { EventsError, type EventsDeps, type WorkflowRunRecord, type WorkflowStore } from "./types.ts";

const TERMINAL: readonly WorkflowRunStatus[] = ["completed", "failed", "cancelled"];
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS_CEILING = 25;
const RETRY_BASE_SECONDS = 30;
const RETRY_CAP_SECONDS = 3600;
const DEFAULT_STALE_SECONDS = 300;
const MAX_KEY_LENGTH = 191;

/** Options the PHP runtime accepts beyond the contract's WorkflowDispatchOptions. */
export interface WorkflowDispatchOptionsExt extends WorkflowDispatchOptions {
  conversationId?: string | null;
  maxAttempts?: number;
}

export interface StepResult<T> {
  output: T;
  /** True when the step had already completed on an earlier attempt and fn was not called. */
  reused: boolean;
}

export interface WorkflowRuntimeExt extends Omit<WorkflowRuntime, "dispatch" | "cancel"> {
  dispatch(
    companyId: string,
    workflow: string,
    context?: Record<string, unknown>,
    options?: WorkflowDispatchOptionsExt,
  ): Promise<WorkflowRunRecord>;
  cancel(companyId: string, runId: string): Promise<WorkflowRunRecord | null>;
  claimNext(companyId: string, staleAfterSeconds?: number): Promise<WorkflowRunRecord | null>;
  runStep<T extends Record<string, unknown>>(
    companyId: string,
    runId: string,
    stepKey: string,
    fn: () => Promise<T>,
  ): Promise<StepResult<T> | null>;
}

/** Backoff used when the caller gives no delay: 30s, 60s, 120s, ... capped at one hour. */
export function workflowRetryDelaySeconds(attempt: number): number {
  return Math.min(RETRY_CAP_SECONDS, RETRY_BASE_SECONDS * 2 ** Math.max(0, attempt - 1));
}

function clampMaxAttempts(value: number | undefined): number {
  const n = Math.trunc(value ?? DEFAULT_MAX_ATTEMPTS);
  return Math.max(1, Math.min(MAX_ATTEMPTS_CEILING, Number.isFinite(n) ? n : DEFAULT_MAX_ATTEMPTS));
}

function requireText(value: unknown, message: string, maxLength = MAX_KEY_LENGTH): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "" || text.length > maxLength) throw new EventsError("VALIDATION", message);
  return text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep merge for resume input. Arrays and scalars in input replace the stored value. */
function mergeContext(base: Record<string, unknown>, input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(input)) {
    const existing = out[key];
    out[key] = isPlainObject(existing) && isPlainObject(value) ? mergeContext(existing, value) : value;
  }
  return out;
}

function assertNotTerminal(run: WorkflowRunRecord): void {
  if (TERMINAL.includes(run.status)) {
    throw new EventsError("INVALID_STATE", `Workflow run is already ${run.status}.`);
  }
}

export function createWorkflowRuntime(store: WorkflowStore, deps: EventsDeps): WorkflowRuntimeExt {
  return {
    async dispatch(companyId, workflow, context = {}, options = {}) {
      const name = requireText(workflow, "A workflow name is required.");
      if (!isPlainObject(context)) throw new EventsError("VALIDATION", "Workflow context must be an object.");

      const idempotencyKey = options.idempotencyKey ? requireText(options.idempotencyKey, "Idempotency key is too long.") : null;
      if (idempotencyKey) {
        const existing = await store.findRunByIdempotencyKey(companyId, name, idempotencyKey);
        if (existing) return existing;
      }

      const now = deps.now();
      const delay = Math.max(0, Math.trunc(options.delaySeconds ?? 0));
      const run: WorkflowRunRecord = {
        id: deps.newId(),
        companyId,
        workflow: name,
        status: "queued",
        attempt: 1,
        maxAttempts: clampMaxAttempts(options.maxAttempts),
        context,
        output: null,
        error: null,
        nextRunAt: new Date(now.getTime() + delay * 1000),
        conversationId: options.conversationId ?? null,
        idempotencyKey,
        lockedAt: null,
        lockToken: null,
        startedAt: null,
        finishedAt: null,
        createdAt: now,
        updatedAt: now,
      };

      const inserted = await store.insertRun(companyId, run);
      if (inserted) return inserted;
      // Lost a race on the idempotency key: the other writer's run is the answer.
      const winner = idempotencyKey ? await store.findRunByIdempotencyKey(companyId, name, idempotencyKey) : null;
      if (winner) return winner;
      throw new EventsError("INVALID_STATE", "Could not create the workflow run.");
    },

    get(companyId, runId) {
      return store.getRun(companyId, runId);
    },

    resume(companyId, runId, input) {
      const now = deps.now();
      return store.mutateRun(companyId, runId, (run) => {
        assertNotTerminal(run);
        return {
          status: "running",
          context: mergeContext(run.context ?? {}, input ?? {}),
          startedAt: run.startedAt ?? now,
          nextRunAt: null,
          lockedAt: null,
          lockToken: null,
          error: null,
          updatedAt: now,
        };
      });
    },

    complete(companyId, runId, output) {
      const now = deps.now();
      return store.mutateRun(companyId, runId, (run) => {
        assertNotTerminal(run);
        return { status: "completed", output, finishedAt: now, lockedAt: null, lockToken: null, updatedAt: now };
      });
    },

    fail(companyId, runId, error, output) {
      const reason = requireText(error, "A workflow failure reason is required.", 4000);
      const now = deps.now();
      return store.mutateRun(companyId, runId, (run) => {
        assertNotTerminal(run);
        return {
          status: "failed",
          error: reason,
          output: output ?? run.output,
          finishedAt: now,
          lockedAt: null,
          lockToken: null,
          updatedAt: now,
        };
      });
    },

    retry(companyId, runId, delaySeconds) {
      const now = deps.now();
      return store.mutateRun(companyId, runId, (run) => {
        if (run.status !== "failed") {
          throw new EventsError("INVALID_STATE", "Only failed workflow runs can be retried.");
        }
        if (run.attempt >= run.maxAttempts) {
          throw new EventsError("INVALID_STATE", "The workflow run has reached its maximum attempts.");
        }
        const delay = Math.max(0, delaySeconds ?? workflowRetryDelaySeconds(run.attempt));
        return {
          status: "queued",
          attempt: run.attempt + 1,
          nextRunAt: new Date(now.getTime() + delay * 1000),
          lockedAt: null,
          lockToken: null,
          error: null,
          startedAt: null,
          finishedAt: null,
          updatedAt: now,
        };
      });
    },

    cancel(companyId, runId) {
      const now = deps.now();
      return store.mutateRun(companyId, runId, (run) => {
        if (TERMINAL.includes(run.status)) return null;
        return { status: "cancelled", finishedAt: now, lockedAt: null, lockToken: null, updatedAt: now };
      });
    },

    claimNext(companyId, staleAfterSeconds = DEFAULT_STALE_SECONDS) {
      return store.claimRun(companyId, deps.now(), Math.max(1, staleAfterSeconds), deps.newId());
    },

    async runStep<T extends Record<string, unknown>>(companyId: string, runId: string, stepKey: string, fn: () => Promise<T>) {
      const key = requireText(stepKey, "A step key is required.");
      const run = await store.getRun(companyId, runId);
      if (!run) return null;
      assertNotTerminal(run);

      const now = deps.now();
      const token = deps.newId();
      const claim = await store.claimStep(companyId, runId, key, token, now, DEFAULT_STALE_SECONDS);
      if (claim.state === "done") return { output: claim.output as T, reused: true };
      if (claim.state === "busy") throw new EventsError("INVALID_STATE", "This step is already running.");

      let output: T;
      try {
        output = await fn();
      } catch (error) {
        // The step did not finish, so a retry is allowed to run it again.
        await store.releaseStep(companyId, runId, key, token);
        throw error;
      }
      const saved = await store.completeStep(companyId, runId, key, token, output, deps.now());
      if (!saved) throw new EventsError("INVALID_STATE", "The step lock was lost before the result was saved.");
      return { output, reused: false };
    },
  };
}

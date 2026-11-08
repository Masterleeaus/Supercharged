/**
 * Smart Task execution receipts (handoff sections 7, 8 P0, 11).
 *
 * Pure logic. The receipt store, provider executor and state verifier are all injected, so there is no
 * database, network or real timer in this module. Each execute() call makes at most one provider call.
 *
 * Guarantees:
 *   - Refuses unless the decision is 'approved', complete, and its execution capability matches the executor.
 *   - The receipt is written as in_progress before the provider is called. A later call that finds an
 *     in_progress receipt treats it as uncertain and does not call the provider again.
 *   - A thrown error or timeout is 'uncertain', never 'failed'. The receipt says the outcome must be verified
 *     before any retry.
 *   - 'succeeded' needs a provider success AND a verifier read that passes. Otherwise 'unverified'.
 *   - A definitive provider rejection is 'failed' and may be retried with the same key until maxAttempts is
 *     reached, then the receipt is dead-lettered and never retried automatically.
 *   - Terminal receipts (succeeded, uncertain, unverified, dead_lettered) are returned without a provider call.
 */
import type {
  ApprovableDecision,
  ExecuteResult,
  ExecutionReceipt,
  ProviderExecutor,
  ProviderResponse,
  ReceiptRefusalReason,
  ReceiptScheduler,
  ReceiptStore,
  StateVerifier,
} from './receipt-types.ts';

export interface VerifyResult {
  outcome: 'succeeded' | 'unverified';
  evidence_ref: string | null;
  reason: string | null;
}

export interface VerifyTiming {
  timeoutMs: number;
  schedule?: ReceiptScheduler;
}

type Settled<T> = { kind: 'value'; value: T } | { kind: 'timeout' } | { kind: 'error' };

const defaultSchedule: ReceiptScheduler = (ms, onFire) => {
  const handle = setTimeout(onFire, ms);
  handle.unref?.();
  return { cancel: () => clearTimeout(handle) };
};

/** Runs work and resolves once, with the first of: its result, its error, or the timeout. */
function settleWithin<T>(work: () => Promise<T>, ms: number, schedule: ReceiptScheduler): Promise<Settled<T>> {
  return new Promise<Settled<T>>((resolve) => {
    let done = false;
    let timer: { cancel(): void } | null = null;
    const finish = (result: Settled<T>) => {
      if (done) return;
      done = true;
      timer?.cancel();
      resolve(result);
    };
    let pending: Promise<T>;
    try {
      pending = Promise.resolve(work());
    } catch {
      pending = Promise.reject(new Error('sync-throw'));
    }
    pending.then(
      (value) => finish({ kind: 'value', value }),
      () => finish({ kind: 'error' }),
    );
    timer = schedule(ms, () => finish({ kind: 'timeout' }));
    if (done) timer.cancel();
  });
}

const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** A receipt is terminal when no further provider call may be made for its key. */
export function isTerminal(receipt: ExecutionReceipt): boolean {
  if (receipt.status === 'dead_lettered') return true;
  return receipt.status === 'settled' && receipt.outcome !== 'failed';
}

function refusalFor(decision: ApprovableDecision | null | undefined, executor: ProviderExecutor | null | undefined): ReceiptRefusalReason | null {
  if (!decision || typeof decision !== 'object') return 'incomplete_decision';
  if (decision.status !== 'approved') return 'not_approved';
  if (
    !isNonEmpty(decision.decision_id) ||
    !isNonEmpty(decision.business_id) ||
    !isNonEmpty(decision.idempotency_key) ||
    !isNonEmpty(decision.execution_capability)
  ) {
    return 'incomplete_decision';
  }
  if (
    !executor ||
    !isNonEmpty(executor.capability) ||
    typeof executor.invoke !== 'function' ||
    !executor.verifier ||
    typeof executor.verifier.read !== 'function' ||
    !Number.isInteger(executor.maxAttempts) ||
    executor.maxAttempts < 1 ||
    !Number.isInteger(executor.timeoutMs) ||
    executor.timeoutMs < 1
  ) {
    return 'invalid_executor';
  }
  if (executor.capability !== decision.execution_capability) return 'capability_mismatch';
  return null;
}

function withState(
  base: ExecutionReceipt,
  patch: Partial<ExecutionReceipt>,
  now: string,
): ExecutionReceipt {
  return { ...base, ...patch, updated_at: now };
}

/**
 * Verifies a provider success by re-reading business state. Only a strict passed === true counts.
 * Any throw, timeout or failed check yields 'unverified'.
 */
export async function verify(
  decision: ApprovableDecision,
  providerOutcome: ProviderResponse,
  verifier: StateVerifier,
  timing: VerifyTiming,
): Promise<VerifyResult> {
  if (providerOutcome.ok !== true) {
    return { outcome: 'unverified', evidence_ref: null, reason: 'no_provider_success' };
  }
  const schedule = timing.schedule ?? defaultSchedule;
  const read = await settleWithin(() => verifier.read(decision), timing.timeoutMs, schedule);
  if (read.kind === 'timeout') return { outcome: 'unverified', evidence_ref: null, reason: 'verification_timeout' };
  if (read.kind === 'error') return { outcome: 'unverified', evidence_ref: null, reason: 'verification_error' };
  if (read.value?.passed !== true) return { outcome: 'unverified', evidence_ref: null, reason: 'state_mismatch' };
  return {
    outcome: 'succeeded',
    evidence_ref: read.value.evidence_ref ?? providerOutcome.evidence_ref ?? null,
    reason: null,
  };
}

/**
 * Executes one approved decision through the executor, or returns the stored receipt for its idempotency key.
 * `now` returns the current ISO-8601 timestamp.
 */
export async function execute(
  decision: ApprovableDecision,
  executor: ProviderExecutor,
  store: ReceiptStore,
  now: () => string,
): Promise<ExecuteResult> {
  const refusal = refusalFor(decision, executor);
  if (refusal) return { refused: true, reason: refusal };

  const key = decision.idempotency_key;
  const existing = await store.get(key);
  const timestamp = now();
  const schedule = executor.schedule ?? defaultSchedule;

  let base: ExecutionReceipt;
  let attemptsSoFar = 0;

  if (existing) {
    if (
      existing.decision_id !== decision.decision_id ||
      existing.business_id !== decision.business_id ||
      existing.capability !== decision.execution_capability
    ) {
      return { refused: true, reason: 'idempotency_key_conflict' };
    }
    if (existing.status === 'in_progress') {
      // A previous attempt was started but never settled (worker crash or concurrent call).
      // The provider may have acted, so record uncertainty and do not call it again.
      const uncertain = withState(existing, {
        status: 'settled',
        outcome: 'uncertain',
        reason: 'attempt_unsettled',
        must_verify_before_retry: true,
        settled_at: timestamp,
      }, timestamp);
      await store.put(uncertain);
      return { refused: false, receipt: uncertain };
    }
    if (isTerminal(existing)) return { refused: false, receipt: existing };
    // Retryable failed receipt.
    if (existing.attempt_count >= executor.maxAttempts) {
      const dead = withState(existing, { status: 'dead_lettered', reason: 'retry_bound_reached' }, timestamp);
      await store.put(dead);
      return { refused: false, receipt: dead };
    }
    attemptsSoFar = existing.attempt_count;
    base = existing;
  } else {
    base = {
      decision_id: decision.decision_id,
      business_id: decision.business_id,
      capability: decision.execution_capability,
      idempotency_key: key,
      attempt_count: 0,
      status: 'settled',
      outcome: null,
      evidence_ref: null,
      reason: null,
      must_verify_before_retry: false,
      created_at: timestamp,
      updated_at: timestamp,
      last_attempt_at: timestamp,
      settled_at: null,
    };
  }

  const attempt = attemptsSoFar + 1;
  const started = withState(base, {
    status: 'in_progress',
    attempt_count: attempt,
    outcome: null,
    reason: null,
    evidence_ref: null,
    must_verify_before_retry: false,
    last_attempt_at: timestamp,
    settled_at: null,
  }, timestamp);
  // Persist before the provider call. If this write fails, the provider is never called.
  await store.put(started);

  const call = await settleWithin(
    () => executor.invoke({
      decision_id: decision.decision_id,
      business_id: decision.business_id,
      capability: decision.execution_capability,
      idempotency_key: key,
      attempt,
    }),
    executor.timeoutMs,
    schedule,
  );

  const settledAt = now();
  let final: ExecutionReceipt;

  if (call.kind === 'timeout' || call.kind === 'error') {
    final = withState(started, {
      status: 'settled',
      outcome: 'uncertain',
      reason: call.kind === 'timeout' ? 'provider_timeout' : 'provider_error',
      must_verify_before_retry: true,
      settled_at: settledAt,
    }, settledAt);
  } else if (call.value?.ok !== true) {
    const bounded = attempt >= executor.maxAttempts;
    final = withState(started, {
      status: bounded ? 'dead_lettered' : 'settled',
      outcome: 'failed',
      reason: bounded ? 'retry_bound_reached' : 'provider_rejected',
      settled_at: settledAt,
    }, settledAt);
  } else {
    const result = await verify(decision, call.value, executor.verifier, {
      timeoutMs: executor.timeoutMs,
      schedule,
    });
    final = withState(started, {
      status: 'settled',
      outcome: result.outcome,
      evidence_ref: result.evidence_ref,
      reason: result.reason,
      settled_at: settledAt,
    }, settledAt);
  }

  // If this write fails, the in_progress record remains. The next call reads it as uncertain, so no
  // success is claimed and no duplicate call is made.
  await store.put(final);
  return { refused: false, receipt: final };
}

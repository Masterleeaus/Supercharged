/**
 * Types for the Smart Task execution receipt module (handoff sections 7, 8 P0, 11).
 * Type-only: no runtime code lives here.
 */

export type ReceiptDecisionStatus = 'awaiting_approval' | 'approved' | 'rejected' | 'snoozed';

/** The fields of a decision card (handoff section 5) that execution depends on. */
export interface ApprovableDecision {
  decision_id: string;
  business_id: string;
  status: ReceiptDecisionStatus;
  execution_capability: string;
  idempotency_key: string;
}

/**
 * in_progress: a provider call was about to start (persisted first, so a crash is visible).
 * settled: the attempt has an outcome.
 * dead_lettered: the retry bound was reached; never retried automatically.
 */
export type ReceiptStatus = 'in_progress' | 'settled' | 'dead_lettered';

export type ReceiptOutcome = 'succeeded' | 'failed' | 'uncertain' | 'unverified';

export interface ExecutionReceipt {
  decision_id: string;
  business_id: string;
  capability: string;
  idempotency_key: string;
  attempt_count: number;
  status: ReceiptStatus;
  outcome: ReceiptOutcome | null;
  evidence_ref: string | null;
  /** Generic machine code only (for example provider_timeout). Never a provider payload. */
  reason: string | null;
  must_verify_before_retry: boolean;
  created_at: string;
  updated_at: string;
  last_attempt_at: string;
  settled_at: string | null;
}

export interface ProviderRequest {
  decision_id: string;
  business_id: string;
  capability: string;
  idempotency_key: string;
  attempt: number;
}

/** ok: true means the provider reports it acted. Anything else is a definitive rejection. */
export type ProviderResponse =
  | { ok: true; evidence_ref?: string | null }
  | { ok: false };

export interface VerificationResult {
  passed: boolean;
  evidence_ref: string | null;
}

/** Re-reads the business state from the owning service. Must not trust the provider response. */
export interface StateVerifier {
  read(decision: ApprovableDecision): Promise<VerificationResult>;
}

/** Injected timer. Returns a handle whose cancel() must stop the timer. */
export type ReceiptScheduler = (ms: number, onFire: () => void) => { cancel(): void };

export interface ProviderExecutor {
  readonly capability: string;
  /** Upper bound on provider calls for one idempotency key (failed attempts only are retried). */
  readonly maxAttempts: number;
  /** Explicit timeout applied to the provider call and to the verification read. */
  readonly timeoutMs: number;
  invoke(request: ProviderRequest): Promise<ProviderResponse>;
  readonly verifier: StateVerifier;
  /** Optional injected timer; defaults to setTimeout. */
  readonly schedule?: ReceiptScheduler;
}

export interface ReceiptStore {
  get(idempotencyKey: string): Promise<ExecutionReceipt | null>;
  put(receipt: ExecutionReceipt): Promise<void>;
}

export type ReceiptRefusalReason =
  | 'incomplete_decision'
  | 'not_approved'
  | 'capability_mismatch'
  | 'invalid_executor'
  | 'idempotency_key_conflict';

export type ExecuteResult =
  | { refused: true; reason: ReceiptRefusalReason }
  | { refused: false; receipt: ExecutionReceipt };

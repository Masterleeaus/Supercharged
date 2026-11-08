/**
 * Port between Titan Desk and the Titan workforce runtime (canonical source: GitHub services/workforce).
 *
 * Desk calls the runtime only through this interface. Field and other callers never reach the
 * runtime directly. The runtime may stop a task in `awaiting_approval`; Desk's approvals module
 * decides that stop. This port has no approve method by design.
 */

// The runtime is a separate service, so the status set is part of this contract and must match
// services/workforce. ASSUMED until verified.
export const WORKFORCE_TASK_STATUSES = [
  'pending',
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
] as const;

export type WorkforceTaskStatus = (typeof WORKFORCE_TASK_STATUSES)[number];

export type WorkforceErrorCode =
  | 'runtime_not_configured'
  | 'runtime_unreachable'
  | 'runtime_timeout'
  | 'runtime_http_error'
  | 'runtime_redirect_refused'
  | 'runtime_bad_response'
  | 'runtime_invalid_input'
  | 'runtime_signature_rejected'
  | 'runtime_url_invalid'
  | 'runtime_url_insecure'
  | 'runtime_url_not_origin'
  | 'runtime_secret_invalid';

export interface WorkforceResourceRef {
  kind: string;
  reference: string;
}

export interface WorkforceTaskInput {
  /** Caller-supplied key so that a retried submit does not create a second task. */
  idempotency_key: string;
  company_id: string;
  /** Workflow name from the Desk workflow catalog, for example `lead_followup`. */
  workflow: string;
  /** Desk actor on whose behalf the task runs. */
  requested_by: string;
  resource?: WorkforceResourceRef;
  /** JSON object only. Keep it small: the adapter rejects payloads over 64 KiB. */
  payload: Record<string, unknown>;
}

export interface WorkforceTask {
  id: string;
  status: WorkforceTaskStatus;
  workflow: string;
  company_id: string;
  result: Record<string, unknown> | null;
  error_code: string | null;
  /** Set when status is `awaiting_approval`. Desk's approvals module resolves it. */
  approval_reference: string | null;
}

export interface WorkforceHealth {
  ok: true;
}

export interface WorkforceRuntimePort {
  /** `disabled` for the fail-closed default, `http` for a configured client. */
  readonly kind: 'disabled' | 'http';
  submitTask(task: WorkforceTaskInput): Promise<WorkforceTask>;
  getTask(id: string): Promise<WorkforceTask>;
  cancelTask(id: string): Promise<WorkforceTask>;
  health(): Promise<WorkforceHealth>;
}

// Shared error class lives in wire.mjs so that the pure helpers and this typed port use one
// class, and `instanceof` works everywhere. It carries a stable `code` and never a secret.
// @ts-ignore pure ESM helper, typed loosely by design
export { WorkforceRuntimeError } from './wire.mjs';

/**
 * Human review inbox for exceptions: uncertain results, policy conflicts, failed actions, and actions
 * the agent cannot safely complete. Pure function over plain arrays. No database, network or timers;
 * the only clock access is the injectable `now`.
 *
 * Item kinds:
 *   approval_pending          pending approval older than approvalPendingAfterMs            (medium)
 *   approval_expired_unhandled approval expired and nobody has handled it                  (low)
 *   run_needs_attention       run failed (high), or awaiting_approval longer than
 *                             runAwaitingAfterMs (low)
 *   tool_failed               tool call outcome failed or uncertain                         (high)
 *   policy_conflict           tool call refused with a reason mentioning 'policy' or
 *                             'company_rule'                                                (low)
 *
 * Every input is filtered to companyId first. A row with a missing or different companyId never
 * produces an item. Output is sorted by severity (high, medium, low), then createdAt oldest first.
 */

export const REVIEW_KINDS = [
  'approval_pending',
  'approval_expired_unhandled',
  'run_needs_attention',
  'tool_failed',
  'policy_conflict',
] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export type ReviewSeverity = 'high' | 'medium' | 'low';

export interface ReviewItem {
  id: string;
  kind: ReviewKind;
  companyId: string;
  runId?: string;
  approvalId?: string;
  agentId?: string;
  reason: string;
  createdAt: string;
  severity: ReviewSeverity;
}

export interface InboxApproval {
  id: string;
  companyId: string;
  agentId?: string;
  runId?: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'revoked' | string;
  createdAt: Date | string;
  /** Set once a human or the system has acted on an expired approval. */
  handled?: boolean;
}

export interface InboxRun {
  id: string;
  companyId: string;
  agentId?: string;
  status: 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'stopped' | string;
  createdAt: Date | string;
  /** When the run last changed status. Used for the awaiting_approval age. Falls back to createdAt. */
  updatedAt?: Date | string;
}

export interface InboxToolCall {
  id: string;
  companyId: string;
  runId?: string;
  agentId?: string;
  toolId?: string;
  outcome: 'executed' | 'failed' | 'uncertain' | 'refused' | 'awaiting_approval' | string;
  /** Refusal reason or failure reason, e.g. 'policy_denied' or 'company_rule_blocked'. */
  reason?: string;
  createdAt: Date | string;
}

export interface ReviewInboxInput {
  companyId: string;
  approvals: readonly InboxApproval[];
  runs: readonly InboxRun[];
  toolCalls: readonly InboxToolCall[];
}

export interface ReviewInboxOptions {
  /** Clock. Defaults to the real clock. Injected in tests. */
  now?: () => Date;
  /** Pending approvals older than this are flagged. Default 4 hours. */
  approvalPendingAfterMs?: number;
  /** Runs awaiting approval longer than this are flagged. Default 1 hour. */
  runAwaitingAfterMs?: number;
}

const DEFAULT_APPROVAL_PENDING_AFTER_MS = 4 * 60 * 60 * 1000;
const DEFAULT_RUN_AWAITING_AFTER_MS = 60 * 60 * 1000;

const SEVERITY_RANK: Readonly<Record<ReviewSeverity, number>> = { high: 0, medium: 1, low: 2 };

function toMs(value: Date | string | undefined): number | null {
  if (value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function containsRule(reason: string | undefined): boolean {
  if (typeof reason !== 'string') return false;
  const lower = reason.toLowerCase();
  return lower.includes('policy') || lower.includes('company_rule');
}

/**
 * Build the review inbox for one company. Returns [] when companyId is empty.
 * Items whose createdAt cannot be parsed are skipped rather than guessed at.
 */
export function buildReviewInbox(input: ReviewInboxInput, options: ReviewInboxOptions = {}): ReviewItem[] {
  const companyId = input.companyId;
  if (typeof companyId !== 'string' || companyId.length === 0) return [];

  const nowMs = (options.now ?? (() => new Date()))().getTime();
  const pendingAfter = options.approvalPendingAfterMs ?? DEFAULT_APPROVAL_PENDING_AFTER_MS;
  const awaitingAfter = options.runAwaitingAfterMs ?? DEFAULT_RUN_AWAITING_AFTER_MS;
  const items: ReviewItem[] = [];

  for (const a of input.approvals ?? []) {
    if (a.companyId !== companyId) continue;
    const createdMs = toMs(a.createdAt);
    if (createdMs === null) continue;

    if (a.status === 'pending' && nowMs - createdMs > pendingAfter) {
      items.push({
        id: `approval_pending:${a.id}`,
        kind: 'approval_pending',
        companyId,
        approvalId: a.id,
        ...(a.agentId !== undefined ? { agentId: a.agentId } : {}),
        ...(a.runId !== undefined ? { runId: a.runId } : {}),
        reason: `approval waiting for a decision for more than ${pendingAfter} ms`,
        createdAt: toIso(createdMs),
        severity: 'medium',
      });
    } else if (a.status === 'expired' && a.handled !== true) {
      items.push({
        id: `approval_expired_unhandled:${a.id}`,
        kind: 'approval_expired_unhandled',
        companyId,
        approvalId: a.id,
        ...(a.agentId !== undefined ? { agentId: a.agentId } : {}),
        ...(a.runId !== undefined ? { runId: a.runId } : {}),
        reason: 'approval expired without a human handling it',
        createdAt: toIso(createdMs),
        severity: 'low',
      });
    }
  }

  for (const r of input.runs ?? []) {
    if (r.companyId !== companyId) continue;
    const createdMs = toMs(r.createdAt);
    if (createdMs === null) continue;
    const sinceMs = toMs(r.updatedAt) ?? createdMs;

    if (r.status === 'failed') {
      items.push({
        id: `run_needs_attention:${r.id}`,
        kind: 'run_needs_attention',
        companyId,
        runId: r.id,
        ...(r.agentId !== undefined ? { agentId: r.agentId } : {}),
        reason: 'run failed',
        createdAt: toIso(createdMs),
        severity: 'high',
      });
    } else if (r.status === 'awaiting_approval' && nowMs - sinceMs > awaitingAfter) {
      items.push({
        id: `run_needs_attention:${r.id}`,
        kind: 'run_needs_attention',
        companyId,
        runId: r.id,
        ...(r.agentId !== undefined ? { agentId: r.agentId } : {}),
        reason: `run awaiting approval for more than ${awaitingAfter} ms`,
        createdAt: toIso(sinceMs),
        severity: 'low',
      });
    }
  }

  for (const t of input.toolCalls ?? []) {
    if (t.companyId !== companyId) continue;
    const createdMs = toMs(t.createdAt);
    if (createdMs === null) continue;
    const base = {
      companyId,
      ...(t.runId !== undefined ? { runId: t.runId } : {}),
      ...(t.agentId !== undefined ? { agentId: t.agentId } : {}),
      createdAt: toIso(createdMs),
    };

    if (t.outcome === 'failed' || t.outcome === 'uncertain') {
      items.push({
        ...base,
        id: `tool_failed:${t.id}`,
        kind: 'tool_failed',
        reason: t.outcome === 'uncertain' ? 'tool result is uncertain' : 'tool call failed',
        severity: 'high',
      });
    } else if (t.outcome === 'refused' && containsRule(t.reason)) {
      items.push({
        ...base,
        id: `policy_conflict:${t.id}`,
        kind: 'policy_conflict',
        reason: `tool call refused: ${t.reason}`,
        severity: 'low',
      });
    }
  }

  return items.sort((x, y) => {
    const bySeverity = SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity];
    if (bySeverity !== 0) return bySeverity;
    const byTime = Date.parse(x.createdAt) - Date.parse(y.createdAt);
    if (byTime !== 0) return byTime;
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  });
}

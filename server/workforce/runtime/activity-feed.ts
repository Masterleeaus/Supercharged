/**
 * Dashboard activity stream for the workforce: work completed, approvals waiting for the owner, and
 * runs that need attention. Pure function over plain arrays. No database, network or timers; the only
 * clock access is the injectable `now`.
 *
 * Item kinds:
 *   completed        run status 'completed'                                               (source time: finishedAt)
 *   needs_approval   approval status 'pending'; carries suggestedAction (swipe right)      (source time: requestedAt)
 *   needs_attention  run status 'failed', or 'awaiting_approval' for longer than 1 hour    (source time: finishedAt, else startedAt)
 *
 * Every input row is filtered to companyId first. A row with a missing or different companyId never
 * produces an item. A companyId that is not a UUID is refused with the error 'invalid_company'.
 * Unknown fields are shown as the string 'unknown'. Output is newest first; items with an unknown
 * timestamp sort last. The list is capped at `limit`.
 */

export const ACTIVITY_KINDS = ['completed', 'needs_approval', 'needs_attention'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const AWAITING_APPROVAL_ATTENTION_MS = 60 * 60 * 1000;
export const DEFAULT_ACTIVITY_LIMIT = 50;

export interface WorkforceRunInput {
  id: string;
  companyId: string;
  status: string;
  roleId?: string;
  finishedAt?: string | Date;
  startedAt?: string | Date;
  outcomeText?: string;
}

export interface WorkforceApprovalInput {
  id: string;
  companyId: string;
  status: string;
  action: string;
  requestedAt: string | Date;
  expiresAt?: string | Date;
}

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  title: string;
  detail: string;
  source: 'workforce';
  createdAt: string;
  suggestedAction?: { label: 'Approve and run'; approvalId: string };
}

export interface BuildWorkforceActivityInput {
  companyId: string;
  runs: WorkforceRunInput[];
  approvals: WorkforceApprovalInput[];
  now: Date | string | number;
  limit?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN = 'unknown';

const text = (value: unknown): string =>
  typeof value === 'string' && value.trim() !== '' ? value : UNKNOWN;

/** Returns epoch milliseconds, or null when the value is missing or not a valid date. */
function toMs(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value as string | number).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function toIso(value: unknown): string {
  const ms = toMs(value);
  return ms === null ? UNKNOWN : new Date(ms).toISOString();
}

function normalisedLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_ACTIVITY_LIMIT;
  return Math.max(0, Math.floor(limit));
}

export function buildWorkforceActivity(input: BuildWorkforceActivityInput): ActivityItem[] {
  const { companyId, runs, approvals, limit } = input ?? ({} as BuildWorkforceActivityInput);
  if (typeof companyId !== 'string' || !UUID.test(companyId)) {
    throw new Error('invalid_company');
  }

  const nowMs = toMs(input.now) ?? Date.now();
  const cap = normalisedLimit(limit);
  const items: ActivityItem[] = [];

  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run || run.companyId !== companyId) continue;
    const finishedMs = toMs(run.finishedAt);
    const startedMs = toMs(run.startedAt);
    const role = text(run.roleId);
    const outcome = text(run.outcomeText);

    if (run.status === 'completed') {
      items.push({
        id: `completed:${text(run.id)}`,
        kind: 'completed',
        title: `Work completed by ${role}`,
        detail: outcome,
        source: 'workforce',
        createdAt: toIso(run.finishedAt),
      });
    } else if (run.status === 'failed') {
      items.push({
        id: `needs_attention:${text(run.id)}`,
        kind: 'needs_attention',
        title: `Run failed for ${role}`,
        detail: outcome,
        source: 'workforce',
        createdAt: toIso(run.finishedAt),
      });
    } else if (run.status === 'awaiting_approval') {
      const sinceMs = finishedMs ?? startedMs;
      if (sinceMs === null || nowMs - sinceMs <= AWAITING_APPROVAL_ATTENTION_MS) continue;
      items.push({
        id: `needs_attention:${text(run.id)}`,
        kind: 'needs_attention',
        title: `Run waiting for approval for ${role}`,
        detail: outcome,
        source: 'workforce',
        createdAt: toIso(finishedMs !== null ? run.finishedAt : run.startedAt),
      });
    }
  }

  for (const approval of Array.isArray(approvals) ? approvals : []) {
    if (!approval || approval.companyId !== companyId || approval.status !== 'pending') continue;
    const approvalId = text(approval.id);
    items.push({
      id: `needs_approval:${approvalId}`,
      kind: 'needs_approval',
      title: `Approval needed: ${text(approval.action)}`,
      detail: approval.expiresAt !== undefined ? `Expires ${toIso(approval.expiresAt)}` : UNKNOWN,
      source: 'workforce',
      createdAt: toIso(approval.requestedAt),
      suggestedAction: { label: 'Approve and run', approvalId },
    });
  }

  items.sort((a, b) => {
    const aMs = toMs(a.createdAt);
    const bMs = toMs(b.createdAt);
    if (aMs === null && bMs === null) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    if (aMs === null) return 1;
    if (bMs === null) return -1;
    if (aMs !== bMs) return bMs - aMs;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return items.slice(0, cap);
}

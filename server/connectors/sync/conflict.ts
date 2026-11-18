/**
 * Conflict rules per entity (#352). A rule decides what happens when a remote change meets a canonical
 * record that already exists. Pure: no I/O.
 *
 * - system_of_record: one side owns the entity. The owner's copy always wins; the other side's change is
 *   ignored and reported, never silently applied. Jobs, invoices, quotes and bookings are owned locally.
 * - latest_wins: the change with the later vendor timestamp wins. A stale change is ignored.
 * - manual: when the two copies differ, nothing is applied. The event is dead-lettered with reason
 *   conflict_manual so an operator decides in the admin view.
 */
import type { EntityType } from '../sdk/contract.ts';

export type ConflictRule =
  | { strategy: 'system_of_record'; owner: 'local' | 'remote' }
  | { strategy: 'latest_wins' }
  | { strategy: 'manual' };

export const DEFAULT_CONFLICT_RULES: Record<EntityType, ConflictRule> = {
  job: { strategy: 'system_of_record', owner: 'local' },
  invoice: { strategy: 'system_of_record', owner: 'local' },
  quote: { strategy: 'system_of_record', owner: 'local' },
  booking: { strategy: 'system_of_record', owner: 'local' },
  contact: { strategy: 'latest_wins' },
  message: { strategy: 'system_of_record', owner: 'remote' },
};

export type Resolution =
  | { action: 'apply' }
  | { action: 'ignore'; reason: 'system_of_record' | 'stale' | 'unchanged' }
  | { action: 'manual' };

export interface Side {
  updatedAt: string;
  data: Record<string, unknown>;
}

function sameData(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (JSON.stringify(a[key] ?? null) !== JSON.stringify(b[key] ?? null)) return false;
  }
  return true;
}

export type OutboundResolution =
  | { action: 'push' }
  | { action: 'ignore'; reason: 'system_of_record' | 'stale' }
  | { action: 'manual' };

/**
 * Decides whether a pending local change may be pushed to the vendor. remoteUpdatedAt is the newest vendor
 * version we have seen for the linked record (null when unlinked). baseUpdatedAt is the vendor version the
 * local edit was made against. Pure.
 */
export function resolveOutbound(
  rule: ConflictRule,
  local: { updatedAt: string; baseUpdatedAt: string | null },
  remoteUpdatedAt: string | null,
): OutboundResolution {
  if (rule.strategy === 'system_of_record') {
    return rule.owner === 'local' ? { action: 'push' } : { action: 'ignore', reason: 'system_of_record' };
  }
  if (rule.strategy === 'latest_wins') {
    return remoteUpdatedAt !== null && Date.parse(remoteUpdatedAt) > Date.parse(local.updatedAt)
      ? { action: 'ignore', reason: 'stale' }
      : { action: 'push' };
  }
  // manual: the vendor changed after the edit was made against it (or the edit never saw a linked record).
  if (remoteUpdatedAt === null) return { action: 'push' };
  if (local.baseUpdatedAt === null || Date.parse(remoteUpdatedAt) > Date.parse(local.baseUpdatedAt)) return { action: 'manual' };
  return { action: 'push' };
}

/** Decides an incoming remote change against the current canonical copy. */
export function resolveConflict(rule: ConflictRule, local: Side, incoming: Side): Resolution {
  if (rule.strategy === 'system_of_record') {
    return rule.owner === 'remote' ? { action: 'apply' } : { action: 'ignore', reason: 'system_of_record' };
  }
  if (rule.strategy === 'latest_wins') {
    return Date.parse(incoming.updatedAt) >= Date.parse(local.updatedAt)
      ? { action: 'apply' }
      : { action: 'ignore', reason: 'stale' };
  }
  return sameData(local.data, incoming.data) ? { action: 'ignore', reason: 'unchanged' } : { action: 'manual' };
}

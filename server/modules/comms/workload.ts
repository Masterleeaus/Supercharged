/*
 * Workload balancing for new inbox threads. Pure function: no I/O, no store, no clock.
 *
 * Candidates are staff in the same company who are available and have a free slot
 * (open threads below maxOpen). Open threads are counted per assignee, and only
 * threads from the same company count.
 *
 * Rules:
 *   1. If a channel is given and some candidate has it in their channels, the pool is
 *      narrowed to those candidates. Otherwise the pool is every candidate, and the
 *      reason says the channel fell back.
 *   2. Within the pool, the fewest open threads wins. Ties go to the smaller id.
 */

export const WORKLOAD_REASON = {
  leastLoaded: 'least_loaded',
  channelMatch: 'channel_match',
  channelFallback: 'channel_fallback',
} as const;

export interface StaffForWorkload {
  id: string;
  companyId: string;
  available: boolean;
  maxOpen: number;
  channels: string[];
}

export interface OpenThreadForWorkload {
  id: string;
  companyId: string;
  assigneeId: string | null;
  channel: string;
}

export interface ChooseAssigneeInput {
  companyId: string;
  staff: StaffForWorkload[];
  openThreads: OpenThreadForWorkload[];
  /** Channel of the new thread. Optional. When absent, no channel preference applies. */
  channel?: string | null;
}

export type ChooseAssigneeResult =
  | { ok: true; assigneeId: string; reason: string }
  | { ok: false; reason: 'no_available_staff' | 'invalid_company' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a canonical UUID string. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Pick the staff member who should receive a new thread.
 * Returns { ok: false, reason: 'invalid_company' } when companyId is not a UUID, and
 * { ok: false, reason: 'no_available_staff' } when no one qualifies.
 */
export function chooseAssignee(input: ChooseAssigneeInput): ChooseAssigneeResult {
  const { companyId, channel } = input;
  if (!isUuid(companyId)) {
    return { ok: false, reason: 'invalid_company' };
  }

  const staff = Array.isArray(input.staff) ? input.staff : [];
  const threads = Array.isArray(input.openThreads) ? input.openThreads : [];

  // Open thread count per assignee, same company only.
  const load = new Map<string, number>();
  for (const thread of threads) {
    if (thread.companyId !== companyId || thread.assigneeId == null) continue;
    load.set(thread.assigneeId, (load.get(thread.assigneeId) ?? 0) + 1);
  }

  const candidates = staff
    .filter((person) => person.companyId === companyId && person.available === true)
    .map((person) => ({
      id: person.id,
      channels: Array.isArray(person.channels) ? person.channels : [],
      open: load.get(person.id) ?? 0,
      maxOpen: person.maxOpen,
    }))
    .filter((person) => person.open < person.maxOpen);

  if (candidates.length === 0) {
    return { ok: false, reason: 'no_available_staff' };
  }

  let pool = candidates;
  let reason: string = WORKLOAD_REASON.leastLoaded;
  if (typeof channel === 'string' && channel.length > 0) {
    const withChannel = candidates.filter((person) => person.channels.includes(channel));
    if (withChannel.length > 0) {
      pool = withChannel;
      reason = WORKLOAD_REASON.channelMatch;
    } else {
      reason = WORKLOAD_REASON.channelFallback;
    }
  }

  const chosen = [...pool].sort((a, b) => {
    if (a.open !== b.open) return a.open - b.open;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];

  return { ok: true, assigneeId: chosen.id, reason };
}

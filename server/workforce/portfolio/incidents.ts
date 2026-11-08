/**
 * Incident and exception engine for Managed Portfolio Operations (P0 exception classification).
 *
 * Pure functions only. No I/O, no clock reads (time is passed in), no randomness (ids are passed in).
 *
 * Rules:
 * - Healthy observations never create a case.
 * - Unknown status is a monitoring gap, never an outage or a degraded service.
 * - Unavailable on the live website, hosting, DNS or SSL is critical. So is unavailable on security, data or backup.
 * - Degraded service is high or medium and never critical.
 */
import {
  CASE_PRIORITIES,
  type CasePriority,
  type CaseSignal,
  type Classification,
  type IncidentObservation,
  type OpenOrUpdateResult,
  type OperationalCase,
} from './incident-types.ts'

/** Systems whose availability faces the customer directly. */
const LIVE_FACING: ReadonlySet<string> = new Set(['website', 'hosting', 'dns', 'ssl'])

/** Systems where a monitoring gap matters enough to rank as medium rather than low. */
const SENSITIVE: ReadonlySet<string> = new Set(['website', 'hosting', 'dns', 'ssl', 'security', 'data', 'backup'])

const PRIORITY_RANK: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(CASE_PRIORITIES.map((priority, rank) => [priority, rank])),
)

function rankOf(priority: CasePriority): number {
  // Unrecognised priorities sort last rather than throwing mid-briefing.
  return PRIORITY_RANK[priority] ?? CASE_PRIORITIES.length
}

function higherPriority(a: CasePriority, b: CasePriority): CasePriority {
  return rankOf(a) <= rankOf(b) ? a : b
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Maps one health observation to a case category and priority, or null when the system is healthy. */
export function classify(observation: IncidentObservation): Classification | null {
  const { system, status } = observation

  if (status === 'healthy') return null

  // Unknown, or any status we do not recognise, is a gap in evidence. It is never reported as a failure.
  if (status !== 'degraded' && status !== 'unavailable') {
    return {
      category: 'monitoring_gap',
      priority: SENSITIVE.has(system) ? 'medium' : 'low',
      reason: status === 'unknown' ? 'no_fresh_evidence' : 'unrecognised_status',
    }
  }

  const unavailable = status === 'unavailable'

  if (system === 'security') {
    return { category: 'security', priority: unavailable ? 'critical' : 'high', reason: `${status}:security` }
  }

  if (system === 'data' || system === 'backup') {
    return { category: 'data_integrity', priority: unavailable ? 'critical' : 'high', reason: `${status}:data` }
  }

  if (system === 'maintenance') {
    return { category: 'maintenance', priority: unavailable ? 'high' : 'medium', reason: `${status}:maintenance` }
  }

  if (LIVE_FACING.has(system)) {
    return {
      category: unavailable ? 'outage' : 'degraded_service',
      priority: unavailable ? 'critical' : 'high',
      reason: `${status}:live`,
    }
  }

  // Integrations and any other system: unavailable is high, degraded is medium.
  return {
    category: unavailable ? 'outage' : 'degraded_service',
    priority: unavailable ? 'high' : 'medium',
    reason: `${status}:other`,
  }
}

function caseKey(c: Pick<OperationalCase, 'business_id' | 'system' | 'category'>): string {
  return JSON.stringify([c.business_id, c.system, c.category])
}

function byStartThenId(a: OperationalCase, b: OperationalCase): number {
  return a.started_at - b.started_at || compareText(a.id, b.id)
}

/**
 * Merges cases that share business, system and category and whose starts fall within windowMs of the first
 * start of the group. Cases starting after now are not merged; they pass through unchanged.
 * Merged case: earliest start and id, highest priority, latest evidence and state, summed observation count.
 */
export function deduplicate(cases: readonly OperationalCase[], now: number, windowMs: number): OperationalCase[] {
  if (!Number.isFinite(now)) throw new TypeError('now must be a finite number')
  if (!Number.isFinite(windowMs) || windowMs < 0) throw new TypeError('windowMs must be a finite, non-negative number')

  const sorted = [...cases].sort(byStartThenId)
  const groups: OperationalCase[][] = []
  const anchors = new Map<string, { anchor: number; members: OperationalCase[] }>()
  const passThrough: OperationalCase[] = []

  for (const c of sorted) {
    if (c.started_at > now) {
      passThrough.push(c)
      continue
    }
    const key = caseKey(c)
    const current = anchors.get(key)
    if (current && c.started_at - current.anchor <= windowMs) {
      current.members.push(c)
    } else {
      const members = [c]
      anchors.set(key, { anchor: c.started_at, members })
      groups.push(members)
    }
  }

  const merged = groups.map((members) => (members.length === 1 ? { ...members[0] } : mergeGroup(members, now)))
  return [...merged, ...passThrough.map((c) => ({ ...c }))].sort(byStartThenId)
}

function mergeGroup(members: OperationalCase[], now: number): OperationalCase {
  const first = members[0]
  // Latest means the greatest last_seen_at. On a tie the later member in start order wins.
  let latest = members[0]
  for (const m of members) {
    if (m.last_seen_at >= latest.last_seen_at) latest = m
  }
  let priority = first.priority
  let started_at = first.started_at
  let last_seen_at = first.last_seen_at
  let observation_count = 0
  for (const m of members) {
    priority = higherPriority(priority, m.priority)
    started_at = Math.min(started_at, m.started_at)
    last_seen_at = Math.max(last_seen_at, m.last_seen_at)
    observation_count += m.observation_count
  }
  return {
    id: first.id,
    business_id: first.business_id,
    system: first.system,
    category: first.category,
    priority,
    state: latest.state,
    started_at,
    last_seen_at,
    resolved_at: latest.resolved_at,
    observation_count,
    evidence: [...latest.evidence],
    updated_at: now,
  }
}

/**
 * Returns the case to create, the updated case, or none.
 * - No existing case and a failure: create an open case.
 * - Open or acknowledged, same failure: update counts, evidence and priority (priority only goes up). State is kept.
 * - Open or acknowledged, recovered signal: resolve.
 * - Resolved, failure observed after the resolution: reopen as a new episode.
 * - Resolved, failure observed at or before the resolution, or recovery of a resolved case: none (stale).
 */
export function openOrUpdate(
  existing: OperationalCase | null,
  incoming: CaseSignal,
  now: number,
): OpenOrUpdateResult {
  if (!Number.isFinite(now)) throw new TypeError('now must be a finite number')
  if (!Number.isFinite(incoming.observed_at)) throw new TypeError('observed_at must be a finite number')

  if (existing === null) {
    if (incoming.recovered) return { action: 'none', case: null }
    return {
      action: 'create',
      case: {
        id: incoming.id,
        business_id: incoming.business_id,
        system: incoming.system,
        category: incoming.category,
        priority: incoming.priority,
        state: 'open',
        started_at: incoming.observed_at,
        last_seen_at: incoming.observed_at,
        resolved_at: null,
        observation_count: 1,
        evidence: [...incoming.evidence],
        updated_at: now,
      },
    }
  }

  if (
    existing.business_id !== incoming.business_id ||
    existing.system !== incoming.system ||
    existing.category !== incoming.category
  ) {
    throw new TypeError('existing case and incoming signal do not share business, system and category')
  }

  if (incoming.recovered) {
    if (existing.state === 'resolved') return { action: 'none', case: existing }
    return {
      action: 'update',
      case: {
        ...existing,
        state: 'resolved',
        resolved_at: now,
        last_seen_at: Math.max(existing.last_seen_at, incoming.observed_at),
        evidence: [...incoming.evidence],
        updated_at: now,
      },
    }
  }

  if (existing.state === 'resolved') {
    // A failure observed at or before the resolution is stale and must not reopen the case.
    if (existing.resolved_at !== null && incoming.observed_at <= existing.resolved_at) {
      return { action: 'none', case: existing }
    }
    return {
      action: 'update',
      case: {
        ...existing,
        state: 'open',
        started_at: incoming.observed_at,
        last_seen_at: incoming.observed_at,
        resolved_at: null,
        observation_count: existing.observation_count + 1,
        evidence: [...incoming.evidence],
        priority: incoming.priority,
        updated_at: now,
      },
    }
  }

  const newer = incoming.observed_at >= existing.last_seen_at
  return {
    action: 'update',
    case: {
      ...existing,
      started_at: Math.min(existing.started_at, incoming.observed_at),
      last_seen_at: Math.max(existing.last_seen_at, incoming.observed_at),
      observation_count: existing.observation_count + 1,
      evidence: newer ? [...incoming.evidence] : existing.evidence,
      priority: higherPriority(existing.priority, incoming.priority),
      updated_at: now,
    },
  }
}

/**
 * Sorts critical first, then high, medium and low. Within a priority: business id, then start time, then input order.
 * Returns a new array. The input is not changed.
 */
export function prioritise(cases: readonly OperationalCase[]): OperationalCase[] {
  return cases
    .map((c, index) => ({ c, index }))
    .sort(
      (a, b) =>
        rankOf(a.c.priority) - rankOf(b.c.priority) ||
        compareText(a.c.business_id, b.c.business_id) ||
        a.c.started_at - b.c.started_at ||
        a.index - b.index,
    )
    .map((entry) => entry.c)
}

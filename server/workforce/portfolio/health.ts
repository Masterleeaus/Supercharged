/**
 * Portfolio health evidence. Pure functions over injected collectors and an injected timer.
 *
 * - normaliseObservations(raw, scope): validates raw observations. Refuses any with a missing business id, a status
 *   outside healthy/degraded/unavailable, or other invalid fields. Refused observations never count as evidence.
 * - evaluateHealth(observations, businesses, options): one record per business × system. Healthy needs a fresh
 *   observation (age <= maxAgeMs, not future-dated). Otherwise the status is unknown, with the reason recorded.
 * - collectHealth(collectors, businesses, options): runs each collector per business. A throw yields a failure
 *   with the error class only. A timeout (injected scheduler) yields a failure with reason 'timeout'.
 * - summarisePortfolio(observations, businesses, now, options): per-business overall status (unknown counted
 *   separately) and the businesses needing attention.
 *
 * Precedence: among fresh observations the worst status wins (unavailable > degraded > healthy). A failure only
 * matters when no fresh observation exists for that business and system.
 */

import type {
  CollectorFailure,
  HealthCollector,
  HealthObservation,
  HealthRecord,
  HealthRecordReason,
  HealthScheduler,
  HealthStatus,
  HealthSystem,
  ObservedStatus,
  PortfolioBusiness,
  RefusedObservation,
} from './health-types.ts'
import { HEALTH_SYSTEMS, OBSERVED_STATUSES } from './health-types.ts'

const SYSTEM_SET: ReadonlySet<string> = new Set<string>(HEALTH_SYSTEMS)
const STATUS_SET: ReadonlySet<string> = new Set<string>(OBSERVED_STATUSES)
const STATUS_RANK: Record<ObservedStatus, number> = { healthy: 0, degraded: 1, unavailable: 2 }
const BUSINESS_RANK: Record<HealthStatus, number> = { healthy: 0, unknown: 1, degraded: 2, unavailable: 3 }

export interface ObservationScope {
  /** When given, observations for any other business are refused. */
  businessIds?: ReadonlySet<string>
  /** When given, observations for systems outside this list are refused. */
  systems?: readonly HealthSystem[]
  /** When given, observations whose source_id differs are refused. */
  sourceId?: string
}

export interface NormalisedObservations {
  accepted: HealthObservation[]
  refused: RefusedObservation[]
}

export interface HealthEvaluationOptions {
  now: number
  maxAgeMs: number
  systems?: readonly HealthSystem[]
  failures?: readonly CollectorFailure[]
}

export interface HealthEvaluation {
  records: HealthRecord[]
  refused: RefusedObservation[]
}

export interface CollectOptions {
  timeoutMs: number
  scheduler: HealthScheduler
}

export interface CollectionResult {
  observations: HealthObservation[]
  failures: CollectorFailure[]
  refused: RefusedObservation[]
}

export interface PortfolioSummary {
  businesses: { total: number; healthy: number; degraded: number; unavailable: number; unknown: number }
  systems: { total: number; healthy: number; degraded: number; unavailable: number; unknown: number }
  /** Businesses whose overall status is not healthy, most severe first, then by id. */
  attention: Array<{
    business_id: string
    status: Exclude<HealthStatus, 'healthy'>
    systems: Array<{ system: HealthSystem; status: HealthStatus; reason: HealthRecordReason }>
  }>
  refused: RefusedObservation[]
}

export interface PortfolioSummaryOptions {
  maxAgeMs: number
  systems?: readonly HealthSystem[]
  failures?: readonly CollectorFailure[]
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function assertTiming(now: number, maxAgeMs: number): void {
  if (!Number.isFinite(now)) throw new TypeError('now must be a finite epoch-ms number')
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new TypeError('maxAgeMs must be a positive finite number')
}

function resolveSystems(systems: readonly HealthSystem[] | undefined): readonly HealthSystem[] {
  if (systems === undefined) return HEALTH_SYSTEMS
  if (!Array.isArray(systems) || systems.length === 0) throw new TypeError('systems must be a non-empty array')
  for (const system of systems) {
    if (!SYSTEM_SET.has(system)) throw new TypeError('systems contains an unknown health system')
  }
  return systems
}

function portfolioIds(businesses: readonly PortfolioBusiness[]): string[] {
  if (!Array.isArray(businesses)) throw new TypeError('businesses must be an array')
  const ids: string[] = []
  const seen = new Set<string>()
  for (const business of businesses) {
    if (!business || !isNonEmptyString(business.id)) throw new TypeError('every business needs a non-empty id')
    if (seen.has(business.id)) throw new TypeError('duplicate business id in portfolio')
    seen.add(business.id)
    ids.push(business.id)
  }
  return ids
}

/** Returns the refusal reason for one raw observation, or null when it is valid. */
function refusalReason(raw: unknown, scope: ObservationScope): string | null {
  if (!raw || typeof raw !== 'object') return 'not_an_object'
  const o = raw as Record<string, unknown>
  if (!isNonEmptyString(o.business_id)) return 'missing_business_id'
  if (scope.businessIds && !scope.businessIds.has(o.business_id)) return 'business_not_in_scope'
  if (typeof o.system !== 'string' || !SYSTEM_SET.has(o.system)) return 'invalid_system'
  if (scope.systems && !scope.systems.includes(o.system as HealthSystem)) return 'system_not_covered'
  if (typeof o.status !== 'string' || !STATUS_SET.has(o.status)) return 'invalid_status'
  if (typeof o.observed_at !== 'number' || !Number.isFinite(o.observed_at)) return 'invalid_observed_at'
  if (!isNonEmptyString(o.source_id)) return 'missing_source_id'
  if (scope.sourceId !== undefined && o.source_id !== scope.sourceId) return 'source_mismatch'
  if (!isNonEmptyString(o.evidence_ref)) return 'missing_evidence_ref'
  return null
}

/** Splits raw observations into accepted ones and refused ones with reasons. Refused input is never returned as evidence. */
export function normaliseObservations(raw: readonly unknown[], scope: ObservationScope = {}): NormalisedObservations {
  if (!Array.isArray(raw)) throw new TypeError('observations must be an array')
  const accepted: HealthObservation[] = []
  const refused: RefusedObservation[] = []
  raw.forEach((item, index) => {
    const reason = refusalReason(item, scope)
    if (reason === null) {
      accepted.push(item as HealthObservation)
      return
    }
    const id = item && typeof item === 'object' ? (item as Record<string, unknown>).business_id : undefined
    refused.push({ index, business_id: isNonEmptyString(id) ? id : null, reason })
  })
  return { accepted, refused }
}

function newest(observations: readonly HealthObservation[]): HealthObservation | null {
  let best: HealthObservation | null = null
  for (const o of observations) if (best === null || o.observed_at > best.observed_at) best = o
  return best
}

function worstFresh(observations: readonly HealthObservation[]): HealthObservation {
  let best = observations[0]
  for (const o of observations.slice(1)) {
    const rank = STATUS_RANK[o.status] - STATUS_RANK[best.status]
    if (rank > 0 || (rank === 0 && o.observed_at > best.observed_at)) best = o
  }
  return best
}

function recordFor(
  businessId: string,
  system: HealthSystem,
  accepted: readonly HealthObservation[],
  failures: readonly CollectorFailure[],
  now: number,
  maxAgeMs: number,
): HealthRecord {
  const mine = accepted.filter((o) => o.business_id === businessId && o.system === system)
  const fresh = mine.filter((o) => o.observed_at <= now && now - o.observed_at <= maxAgeMs)
  if (fresh.length > 0) {
    const chosen = worstFresh(fresh)
    return {
      business_id: businessId,
      system,
      status: chosen.status,
      reason: 'fresh',
      observed_at: chosen.observed_at,
      source_id: chosen.source_id,
      evidence_ref: chosen.evidence_ref,
      error_class: null,
    }
  }

  const latest = newest(mine)
  const failure = failures.find((f) => f.business_id === businessId && f.systems.includes(system))
  let reason: HealthRecordReason
  if (failure) reason = failure.reason === 'timeout' ? 'timeout' : 'collector_error'
  else if (mine.some((o) => o.observed_at > now)) reason = 'future_timestamp'
  else if (mine.length > 0) reason = 'stale'
  else reason = 'missing'

  return {
    business_id: businessId,
    system,
    status: 'unknown',
    reason,
    observed_at: latest ? latest.observed_at : null,
    source_id: failure ? failure.source_id : latest ? latest.source_id : null,
    evidence_ref: latest ? latest.evidence_ref : null,
    error_class: failure ? failure.error_class : null,
  }
}

/** One record per business × system. Only a fresh observation can yield 'healthy'. */
export function evaluateHealth(
  observations: readonly unknown[],
  businesses: readonly PortfolioBusiness[],
  options: HealthEvaluationOptions,
): HealthEvaluation {
  assertTiming(options.now, options.maxAgeMs)
  const ids = portfolioIds(businesses)
  const systems = resolveSystems(options.systems)
  const { accepted, refused } = normaliseObservations(observations, { businessIds: new Set(ids) })
  const failures = options.failures ?? []

  const records: HealthRecord[] = []
  for (const businessId of ids) {
    for (const system of systems) {
      records.push(recordFor(businessId, system, accepted, failures, options.now, options.maxAgeMs))
    }
  }
  return { records, refused }
}

/** Class name of a thrown value. The message is deliberately not kept, since it may carry provider payloads. */
function errorClass(err: unknown): string {
  if (err && typeof err === 'object') {
    const name = (err as { constructor?: { name?: unknown } }).constructor?.name
    if (typeof name === 'string' && name.length > 0) return name
  }
  return 'NonError'
}

type CollectOutcome =
  | { ok: true; value: unknown[] }
  | { ok: false; reason: 'error' | 'timeout'; error_class: string }

function collectWithTimeout(
  collector: HealthCollector,
  business: PortfolioBusiness,
  options: CollectOptions,
): Promise<CollectOutcome> {
  return new Promise((resolve) => {
    let settled = false
    let cancelTimer: () => void = () => {}
    const finish = (outcome: CollectOutcome): void => {
      if (settled) return
      settled = true
      cancelTimer()
      resolve(outcome)
    }
    cancelTimer = options.scheduler.schedule(options.timeoutMs, () =>
      finish({ ok: false, reason: 'timeout', error_class: 'TimeoutError' }),
    )
    Promise.resolve()
      .then(() => collector.collect(business))
      .then(
        (value) =>
          Array.isArray(value)
            ? finish({ ok: true, value })
            : finish({ ok: false, reason: 'error', error_class: 'InvalidCollectorResult' }),
        (err: unknown) => finish({ ok: false, reason: 'error', error_class: errorClass(err) }),
      )
  })
}

function assertCollectors(collectors: readonly HealthCollector[]): void {
  if (!Array.isArray(collectors)) throw new TypeError('collectors must be an array')
  for (const collector of collectors) {
    if (!collector || !isNonEmptyString(collector.source_id)) throw new TypeError('every collector needs a source_id')
    if (typeof collector.collect !== 'function') throw new TypeError('every collector needs a collect function')
    resolveSystems(collector.systems)
  }
}

/**
 * Runs every collector for every business, one call at a time. Returns validated observations, failures for throws
 * and timeouts, and refused observations. Nothing is retried and nothing is treated as healthy by default.
 */
export async function collectHealth(
  collectors: readonly HealthCollector[],
  businesses: readonly PortfolioBusiness[],
  options: CollectOptions,
): Promise<CollectionResult> {
  assertCollectors(collectors)
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive finite number')
  }
  const ids = portfolioIds(businesses)
  const result: CollectionResult = { observations: [], failures: [], refused: [] }

  for (const businessId of ids) {
    const business: PortfolioBusiness = { id: businessId }
    for (const collector of collectors) {
      const outcome = await collectWithTimeout(collector, business, options)
      if (!outcome.ok) {
        result.failures.push({
          business_id: businessId,
          source_id: collector.source_id,
          systems: collector.systems,
          reason: outcome.reason,
          error_class: outcome.error_class,
        })
        continue
      }
      const checked = normaliseObservations(outcome.value, {
        businessIds: new Set([businessId]),
        systems: collector.systems,
        sourceId: collector.source_id,
      })
      result.observations.push(...checked.accepted)
      result.refused.push(...checked.refused)
    }
  }
  return result
}

/** Business-level status is the most severe of its systems: unavailable > degraded > unknown > healthy. */
function overallStatus(records: readonly HealthRecord[]): HealthStatus {
  let worst: HealthStatus = 'healthy'
  for (const record of records) {
    if (BUSINESS_RANK[record.status] > BUSINESS_RANK[worst]) worst = record.status
  }
  return worst
}

/** Portfolio counts across businesses and across business × system pairs. Unknown is its own bucket, never healthy. */
export function summarisePortfolio(
  observations: readonly unknown[],
  businesses: readonly PortfolioBusiness[],
  now: number,
  options: PortfolioSummaryOptions,
): PortfolioSummary {
  const evaluation = evaluateHealth(observations, businesses, {
    now,
    maxAgeMs: options.maxAgeMs,
    systems: options.systems,
    failures: options.failures,
  })

  const systemCounts = { total: 0, healthy: 0, degraded: 0, unavailable: 0, unknown: 0 }
  const businessCounts = { total: 0, healthy: 0, degraded: 0, unavailable: 0, unknown: 0 }
  const attention: PortfolioSummary['attention'] = []

  const byBusiness = new Map<string, HealthRecord[]>()
  for (const record of evaluation.records) {
    systemCounts.total += 1
    systemCounts[record.status] += 1
    const list = byBusiness.get(record.business_id) ?? []
    list.push(record)
    byBusiness.set(record.business_id, list)
  }

  for (const [businessId, records] of byBusiness) {
    const status = overallStatus(records)
    businessCounts.total += 1
    businessCounts[status] += 1
    if (status !== 'healthy') {
      attention.push({
        business_id: businessId,
        status: status as Exclude<HealthStatus, 'healthy'>,
        systems: records
          .filter((r) => r.status !== 'healthy')
          .map((r) => ({ system: r.system, status: r.status, reason: r.reason })),
      })
    }
  }

  attention.sort((a, b) => BUSINESS_RANK[b.status] - BUSINESS_RANK[a.status] || a.business_id.localeCompare(b.business_id))

  return {
    businesses: businessCounts,
    systems: systemCounts,
    attention,
    refused: evaluation.refused,
  }
}

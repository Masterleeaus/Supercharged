/**
 * Types and constants for portfolio health evidence (Managed Portfolio Operations, P0 system-health collection).
 *
 * Pure definitions. No I/O. A health status is only ever 'healthy' when a fresh observation backs it. 'unknown' is
 * the reported state whenever fresh evidence is absent, and it is never treated as healthy.
 */

export const HEALTH_SYSTEMS = ['website', 'hosting', 'ssl', 'dns', 'backup', 'integration'] as const
export type HealthSystem = (typeof HEALTH_SYSTEMS)[number]

/** The three statuses a source may report. Anything else is refused. */
export const OBSERVED_STATUSES = ['healthy', 'degraded', 'unavailable'] as const
export type ObservedStatus = (typeof OBSERVED_STATUSES)[number]

/** Reported status. 'unknown' covers missing, stale, future-dated, failed and timed-out evidence. */
export type HealthStatus = ObservedStatus | 'unknown'

export interface HealthObservation {
  /** Authoritative business (company) id the observation belongs to. */
  business_id: string
  system: HealthSystem
  status: ObservedStatus
  /** Epoch milliseconds at which the source observed the system. */
  observed_at: number
  /** Id of the collector or external source that produced the observation. */
  source_id: string
  /** Reference to the stored evidence record. Not the evidence payload. */
  evidence_ref: string
}

export interface PortfolioBusiness {
  id: string
}

/** A collector call that threw or timed out, recorded per business and per system it covers. */
export interface CollectorFailure {
  business_id: string
  source_id: string
  systems: readonly HealthSystem[]
  reason: 'error' | 'timeout'
  /** Class name of the thrown error only. No message and no provider payload. */
  error_class: string
}

/**
 * A health source for one or more systems. collect() returns raw observations for one business, or throws.
 * Observations are validated by the module, so a collector's output is not trusted.
 */
export interface HealthCollector {
  source_id: string
  systems: readonly HealthSystem[]
  collect(business: PortfolioBusiness): Promise<unknown[]> | unknown[]
}

/** Injected timer. schedule() runs fn after ms and returns a function that cancels the timer. */
export interface HealthScheduler {
  schedule(ms: number, fn: () => void): () => void
}

export interface RefusedObservation {
  index: number
  /** The business id as given, or null when it was missing or not a string. */
  business_id: string | null
  reason: string
}

export type HealthRecordReason =
  | 'fresh'
  | 'stale'
  | 'missing'
  | 'future_timestamp'
  | 'collector_error'
  | 'timeout'

/** One business × system status with its evidence. Unknown records carry the reason they are unknown. */
export interface HealthRecord {
  business_id: string
  system: HealthSystem
  status: HealthStatus
  reason: HealthRecordReason
  observed_at: number | null
  source_id: string | null
  evidence_ref: string | null
  error_class: string | null
}

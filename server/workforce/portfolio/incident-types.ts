/**
 * Types and constants for the incident and exception engine (Managed Portfolio Operations, P0 exception classification).
 *
 * Pure definitions. No I/O. The engine in incidents.ts only reads these shapes.
 */

/** Status of one business system as reported by a health source. 'unknown' means no fresh evidence, never healthy. */
export const INCIDENT_STATUSES = ['healthy', 'degraded', 'unavailable', 'unknown'] as const
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number]

/**
 * Systems the classifier understands. 'website' is the live customer site. 'security' and 'data' are the
 * security-category and data-integrity systems named in the handoff, and 'maintenance' covers update services.
 */
export const INCIDENT_SYSTEMS = [
  'website',
  'hosting',
  'ssl',
  'dns',
  'backup',
  'integration',
  'security',
  'data',
  'maintenance',
] as const
export type IncidentSystem = (typeof INCIDENT_SYSTEMS)[number]

export const CASE_CATEGORIES = [
  'outage',
  'degraded_service',
  'security',
  'data_integrity',
  'support',
  'maintenance',
  'monitoring_gap',
] as const
export type CaseCategory = (typeof CASE_CATEGORIES)[number]

/** Ordered from most to least urgent. prioritise() relies on this order. */
export const CASE_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const
export type CasePriority = (typeof CASE_PRIORITIES)[number]

export const CASE_STATES = ['open', 'acknowledged', 'resolved'] as const
export type CaseState = (typeof CASE_STATES)[number]

/** One health observation for one business and one system. */
export interface IncidentObservation {
  /** Authoritative company id. Never taken from a request. */
  business_id: string
  system: IncidentSystem
  status: IncidentStatus
  /** Epoch milliseconds at which the system was observed. */
  observed_at: number
  /** Evidence references or short evidence lines. Copied, never interpreted. */
  evidence: string[]
}

/** The classification of one observation. classify() returns null when no case is needed (healthy). */
export interface Classification {
  category: CaseCategory
  priority: CasePriority
  /** Short, stable reason code for audit, such as 'unavailable:live'. */
  reason: string
}

/** One operational case. One case per business, system and category. */
export interface OperationalCase {
  id: string
  business_id: string
  system: IncidentSystem
  category: CaseCategory
  priority: CasePriority
  state: CaseState
  /** Start of the current episode. */
  started_at: number
  last_seen_at: number
  resolved_at: number | null
  observation_count: number
  /** Latest evidence list for this case. */
  evidence: string[]
  updated_at: number
}

/**
 * Input to openOrUpdate(). recovered: true means a healthy observation for the same business, system and
 * category, which resolves an open case. id is used only when a new case is created.
 */
export interface CaseSignal {
  id: string
  business_id: string
  system: IncidentSystem
  category: CaseCategory
  priority: CasePriority
  evidence: string[]
  observed_at: number
  recovered: boolean
}

export type OpenOrUpdateResult =
  | { action: 'create'; case: OperationalCase }
  | { action: 'update'; case: OperationalCase }
  | { action: 'none'; case: OperationalCase | null }

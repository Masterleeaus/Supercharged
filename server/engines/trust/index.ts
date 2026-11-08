/*
 * Desk entry point for the Trust readiness port. Clean-room, see README.md.
 * Re-exports the pure evaluator. Nothing here is mounted in routes or index.ts.
 */
export {
  DEFAULT_REQUIREMENT_TYPES,
  TrustReadinessError,
  evaluateEvidenceReadiness,
  selectEvidenceRule,
  type EvidenceItem,
  type EvidenceRule,
  type ReadinessQuery,
  type ReadinessResult,
  type ReadinessStatus,
} from './evaluator.ts';

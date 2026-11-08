export {
  AUTHORITY_LEASE_STATES,
  normalizeAuthorityDecisionProvenance, buildAuthorityDecisionProvenanceSeal, assertAuthorityDecisionProvenanceContinuity, assertAuthorityDecisionProvenanceHistory,
  evaluateAuthorityDecisionLease,
} from './authority-lease.mjs';
export {
  COMPANY_ID_FIELD, LEGACY_COMPANY_FIELDS,
  assertAuthorityCompanyId, rejectLegacyAuthorityBoundaryDeep,
} from './company-boundary.mjs';
export {
  LEGACY_AUTONOMY_LEVELS, LEGACY_RISK_LEVELS,
  createWorkerIdentity, createAuthorityRequirement, createApprovalState,
} from './worker-authority.mjs';

export const RUNTIME_ID = 'authority';
export const RUNTIME_NAME = 'Authority Runtime';
export const RUNTIME_KIND = 'authority';
export const RUNTIME_PURPOSE = 'Enforces company-scoped worker authority boundaries; identity and activation never grant authority.';
export const AUTHORITY_CONFERRED_BY_ACTIVATION = false;
export const runtimeDescriptor = Object.freeze({
  id:RUNTIME_ID, name:RUNTIME_NAME, kind:RUNTIME_KIND, purpose:RUNTIME_PURPOSE,
  authority_conferred_by_activation:false,
});
export {
  AUTONOMY_BANDS, bandForScore,
  normalizeVerifiedAutonomySnapshot, computeContractionOnlyAuthority,
} from './autonomy.mjs';
export { isProtectedAction } from './protected-actions.mjs';
export {
  AUTHORITY_DECISIONS, RISK_LEVELS,
  evaluateWorkerAuthorityDecision, assertAuthorityDecisionAllowsExecution, assertAuthorityDecisionSupersessionContinuity, assertAuthorityDecisionSupersessionGraph, buildAuthorityDecisionSupersessionHistorySeal, assertAuthorityDecisionSupersessionPersistenceContinuity, buildAuthorityDecisionSupersessionHistorySnapshotSeal, assertAuthorityDecisionSupersessionHistorySnapshotChain,
} from './authority-evaluator.mjs';
export {
  prepareGovernedCommandEnvelope, buildGovernedReplayBinding, buildExecutionContextBinding, assertCommandProofCurrent, assertCurrentExecutionContextBinding, assertCommandAuthorityCurrentAt,
  assertAuthoritativeExecutionReceipt, assertAuthoritativeExecutionReceiptContinuity, assertAuthoritativeExecutionReceiptHistory, buildAuthoritativeExecutionReceiptHistorySeal, assertAuthoritativeExecutionReceiptPersistenceContinuity, assertExecutionReceiptForCommand,
  assertPostActionVerification, assertPostActionVerificationContinuity, assertPostActionVerificationHistory, buildPostActionVerificationHistorySeal, assertPostActionVerificationPersistenceContinuity, assertReceiptVerificationHistoryLink, buildReceiptVerificationHistoryPairSeal, buildReceiptVerificationHistorySnapshotSeal, assertReceiptVerificationHistorySnapshotChain, assertReceiptVerificationPersistenceContinuity, assertPostActionVerificationForCommand,
} from './execution-boundary.mjs';

export {
  MAX_AUTHORITY_DELEGATION_DEPTH, DELEGATION_EXTINCTION_REASONS,
  normalizeAuthorityDelegation, assertAuthorityDelegationContinuity, assertAuthorityDelegationAncestry, buildAuthorityDelegationHistorySeal, buildAuthorityDelegationHistorySnapshotSeal, assertAuthorityDelegationHistorySnapshotChain, assertAuthorityDelegationPersistenceContinuity, assertAuthorityDelegationDecisionStatusContinuity, evaluateDelegationExtinction, evaluateDelegationChainExtinction,
} from './delegation.mjs';

export { normalizeAuthorityLeaseControl, assertAuthorityLeaseControlContinuity, assertAuthorityLeaseControlHistory, buildAuthorityLeaseControlHistorySeal, buildAuthorityLeaseControlHistorySnapshotSeal, assertAuthorityLeaseControlHistorySnapshotChain, assertAuthorityCurrentDecisionSnapshotContinuity, assertAuthorityLeaseControlPersistenceContinuity, assertAuthorityLeaseControlAgainstCurrentDecision, applyAuthorityLeaseControl } from './lease-control.mjs';

export { buildAuthorityHistoryIntegritySeal, buildAuthorityHistorySnapshotSeal, assertAuthorityHistorySnapshotLink, assertAuthorityHistorySnapshotChain, stableAuthorityHistoryCanonical } from './history-integrity.mjs';

export { SqliteAuthorityStore } from './sqlite-authority-store.mjs';
export { AuthorityContextResolver } from './authority-context-resolver.mjs';

export { RuntimeAuthorityGateway } from './runtime-authority-gateway.mjs';

export { CapabilityRequirementResolver } from './capability-requirement-resolver.mjs';

export { SqliteWorkerAccessStore, WorkerAccessResolver } from './worker-access-resolver.mjs';

export { INVOCATION_ENVELOPE_SCHEMA, CONTEXT_OWNER_SCHEMA, HANDOFF_RECEIPT_SCHEMA, createInvocationEnvelope, createContextOwnerRecord, DurableAgentContextOwner, createHandoffReceipt, HandoffReceiptInbox } from './invocation-context.mjs';

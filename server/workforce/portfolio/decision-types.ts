/**
 * Types and enum-like constant lists for the Managed Portfolio decision service
 * (server/workforce/portfolio/decisions.ts). No I/O.
 */

export const DECISION_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type DecisionPriority = (typeof DECISION_PRIORITIES)[number];

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const DECISION_CATEGORIES = [
  'onboarding',
  'system_care',
  'customer_success',
  'customer_support',
  'business_improvement',
  'commercial',
  'risk_quality',
] as const;
export type DecisionCategory = (typeof DECISION_CATEGORIES)[number];

/** Categories whose actions reach customers. Batch approval and approval-free cards are refused for these. */
export const CUSTOMER_FACING_CATEGORIES: readonly DecisionCategory[] = [
  'customer_success',
  'customer_support',
  'business_improvement',
];
/** Categories whose actions move money. Same restrictions as customer-facing categories. */
export const FINANCIAL_CATEGORIES: readonly DecisionCategory[] = ['commercial'];

export const APPROVAL_AUTHORITIES = ['managed_service_operator', 'business_owner'] as const;
export type ApprovalAuthority = (typeof APPROVAL_AUTHORITIES)[number];

export const DECISION_STATUSES = ['awaiting_approval', 'approved', 'rejected', 'snoozed'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export type ScalarParameter = string | number | boolean;

/** A reference to supporting evidence. The timestamp is when the evidence was observed. */
export interface EvidenceRef {
  ref: string;
  timestamp: string;
}

/** Who is acting on a card. `authority` is the approval authority the actor holds; null means none. */
export interface DecisionActor {
  actor_id: string;
  actor_type: 'human' | 'agent';
  authority: ApprovalAuthority | null;
  /** Business ids this actor is separately authorised to decide for. Fail closed when empty. */
  business_scopes: readonly string[];
}

export interface DelegateRef {
  actor_id: string;
  actor_type: 'human' | 'agent';
}

export interface DecisionCard {
  decision_id: string;
  business_id: string;
  category: DecisionCategory;
  priority: DecisionPriority;
  issue: string;
  evidence: EvidenceRef[];
  recommended_action: string;
  expected_result: string;
  risk_level: RiskLevel;
  approval_required: boolean;
  approval_authority: ApprovalAuthority;
  execution_capability: string;
  status: DecisionStatus;
  policy_version: string;
  idempotency_key: string;
  created_at: string;
  /** Parameter names that a modify transition may change. Set at creation; empty by default. */
  permitted_parameters: readonly string[];
  parameters: Record<string, ScalarParameter>;
  /** Batch eligibility flags. Any true value excludes the card from batch approval. */
  irreversible: boolean;
  destructive: boolean;
  disputed: boolean;
  delegated_to: DelegateRef | null;
  snoozed_until: string | null;
  snooze_condition: string | null;
  rejection_reason: string | null;
  approved_by: string | null;
  approved_at: string | null;
}

export type DecisionAction =
  | 'create'
  | 'approve'
  | 'reject'
  | 'modify'
  | 'snooze'
  | 'delegate'
  | 'wake'
  | 'batch_approve';

export interface DecisionAuditEntry {
  decision_id: string;
  business_id: string;
  action: DecisionAction;
  outcome: 'applied' | 'refused';
  refusal_code: string | null;
  actor_id: string | null;
  actor_type: 'human' | 'agent' | null;
  target_actor_id: string | null;
  from_status: DecisionStatus | null;
  to_status: DecisionStatus | null;
  reason: string | null;
  at: string;
  policy_version: string | null;
  idempotency_key: string | null;
}

export interface DecisionError {
  code: string;
  message: string;
}

export type DecisionResult<T> =
  | { ok: true; value: T; audit: DecisionAuditEntry }
  | { ok: false; error: DecisionError; audit: DecisionAuditEntry };

export interface BatchItemResult {
  decision_id: string;
  business_id: string;
  ok: boolean;
  card: DecisionCard | null;
  error: DecisionError | null;
  audit: DecisionAuditEntry;
}

export interface BatchApproveResult {
  results: BatchItemResult[];
}

/**
 * Types for the portfolio business registry (portfolio/registry.ts). Pure data shapes only; no I/O.
 */

export type BusinessStatus = 'active' | 'suspended' | 'ended';

export interface CustomerGrant {
  grantId: string;
  /** Action categories this grant covers. */
  categories: string[];
  /** Epoch milliseconds after which the grant no longer applies. */
  expiresAt: number;
  /** Epoch milliseconds when the grant was revoked, or null while live. */
  revokedAt: number | null;
  createdAt: number;
  grantedBy: string;
}

export interface ManagedBusiness {
  businessId: string;
  /** Owning company, taken from the verified session at registration. */
  companyId: string;
  managingOperatorId: string;
  agreementId: string;
  /** Action categories the managed-service agreement permits. */
  agreementScope: string[];
  /** Scoped delegated service accounts that may act for this business. */
  delegatedServiceAccounts: string[];
  status: BusinessStatus;
  grants: CustomerGrant[];
}

export interface RegisterBusinessInput {
  managingOperatorId: string;
  agreementId: string;
  agreementScope: string[];
  delegatedServiceAccounts?: string[];
}

export interface GrantAccessInput {
  categories: string[];
  expiresAt: number;
  grantedBy: string;
}

/** The only reason code returned to callers. Specifics live in the audit entry. */
export const REFUSAL_REASON = 'refused' as const;
export type RefusalReason = typeof REFUSAL_REASON;

export type AuditEvent =
  | 'business_registered'
  | 'grant_created'
  | 'grant_revoked'
  | 'business_suspended'
  | 'agreement_ended'
  | 'access_refused';

export type AuditDetail =
  | 'missing_company'
  | 'missing_business_id'
  | 'missing_business'
  | 'invalid_record'
  | 'missing_actor'
  | 'missing_category'
  | 'missing_input'
  | 'invalid_time'
  | 'invalid_id'
  | 'duplicate_id'
  | 'unknown_business'
  | 'wrong_company'
  | 'business_suspended'
  | 'agreement_ended'
  | 'business_not_active'
  | 'unknown_status'
  | 'category_out_of_scope'
  | 'no_grant'
  | 'grant_revoked'
  | 'grant_expired'
  | 'unknown_grant'
  | 'already_revoked'
  | 'invalid_expiry'
  | 'invalid_transition'
  | 'actor_not_authorised';

export interface AuditEntry {
  event: AuditEvent;
  outcome: 'applied' | 'refused';
  callerCompanyId: string | null;
  businessId: string | null;
  actorId: string | null;
  actionCategory: string | null;
  grantId: string | null;
  detail: AuditDetail | null;
  /** Epoch milliseconds supplied by the caller or clock, or null when unknown. */
  at: number | null;
}

export type AccessDecision =
  | { allowed: true; reason: null; audit: null }
  | { allowed: false; reason: RefusalReason; audit: AuditEntry };

export type MutationResult<T> =
  | { ok: true; value: T; audit: AuditEntry }
  | { ok: false; reason: RefusalReason; audit: AuditEntry };

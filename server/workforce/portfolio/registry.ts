/**
 * Portfolio business registry. Pure and injectable: no database, network or provider calls.
 * Records live in an in-memory map created by createPortfolioRegistry(). Ids and the clock are injected.
 *
 * Fail closed: any missing, malformed or unknown input is refused. Callers only ever see the generic
 * REFUSAL_REASON. The specific cause is recorded in the returned audit entry for internal review.
 */
import {
  REFUSAL_REASON,
  type AccessDecision,
  type AuditDetail,
  type AuditEntry,
  type AuditEvent,
  type CustomerGrant,
  type GrantAccessInput,
  type ManagedBusiness,
  type MutationResult,
  type RefusalReason,
  type RegisterBusinessInput,
} from './registry-types.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES: readonly string[] = ['active', 'suspended', 'ended'];

interface AuditContext {
  callerCompanyId?: unknown;
  businessId?: unknown;
  actorId?: unknown;
  actionCategory?: unknown;
  grantId?: unknown;
  at?: unknown;
}

type Refused = { ok: false; reason: RefusalReason; audit: AuditEntry };
type Located = { ok: true; record: ManagedBusiness } | Refused;
type ReadResult<T> = { ok: true; value: T; audit: null } | Refused;

function isText(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isTime(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isTextList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isText);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isValidGrant(g: unknown): g is CustomerGrant {
  return (
    isObject(g) &&
    isText(g.grantId) &&
    isTextList(g.categories) &&
    g.categories.length > 0 &&
    isTime(g.expiresAt) &&
    (g.revokedAt === null || isTime(g.revokedAt)) &&
    isTime(g.createdAt) &&
    isText(g.grantedBy)
  );
}

function isValidRecord(b: unknown): b is ManagedBusiness {
  return (
    isObject(b) &&
    isText(b.businessId) &&
    isText(b.companyId) &&
    isText(b.managingOperatorId) &&
    isText(b.agreementId) &&
    isTextList(b.agreementScope) &&
    isTextList(b.delegatedServiceAccounts) &&
    typeof b.status === 'string' &&
    STATUSES.includes(b.status) &&
    Array.isArray(b.grants) &&
    b.grants.every(isValidGrant)
  );
}

function buildAudit(
  event: AuditEvent,
  outcome: 'applied' | 'refused',
  detail: AuditDetail | null,
  ctx: AuditContext,
): AuditEntry {
  return {
    event,
    outcome,
    callerCompanyId: isText(ctx.callerCompanyId) ? ctx.callerCompanyId : null,
    businessId: isText(ctx.businessId) ? ctx.businessId : null,
    actorId: isText(ctx.actorId) ? ctx.actorId : null,
    actionCategory: isText(ctx.actionCategory) ? ctx.actionCategory : null,
    grantId: isText(ctx.grantId) ? ctx.grantId : null,
    detail,
    at: isTime(ctx.at) ? ctx.at : null,
  };
}

function refuse(event: AuditEvent, detail: AuditDetail, ctx: AuditContext): Refused {
  return { ok: false, reason: REFUSAL_REASON, audit: buildAudit(event, 'refused', detail, ctx) };
}

function applied<T>(value: T, event: AuditEvent, ctx: AuditContext): MutationResult<T> {
  return { ok: true, value, audit: buildAudit(event, 'applied', null, ctx) };
}

/**
 * Pure access check. Allowed only when every condition holds:
 * valid record, matching company, active status, action in agreement scope, a live grant
 * (not revoked, not expired) covering the category, and the actor is the managing operator
 * or a listed delegated service account.
 */
export function canAct(
  business: unknown,
  actorIdentity: unknown,
  actionCategory: unknown,
  now: unknown,
  callerCompanyId: unknown,
): AccessDecision {
  const ctx: AuditContext = {
    callerCompanyId,
    businessId: isObject(business) ? business.businessId : undefined,
    actorId: actorIdentity,
    actionCategory,
    at: now,
  };
  const deny = (detail: AuditDetail): AccessDecision => ({
    allowed: false,
    reason: REFUSAL_REASON,
    audit: buildAudit('access_refused', 'refused', detail, ctx),
  });

  if (!isText(callerCompanyId)) return deny('missing_company');
  if (business === undefined || business === null) return deny('missing_business');
  if (!isValidRecord(business)) return deny('invalid_record');
  if (!isText(actorIdentity)) return deny('missing_actor');
  if (!isText(actionCategory)) return deny('missing_category');
  if (!isTime(now)) return deny('invalid_time');
  if (business.companyId !== callerCompanyId) return deny('wrong_company');
  if (business.status === 'suspended') return deny('business_suspended');
  if (business.status === 'ended') return deny('agreement_ended');
  if (business.status !== 'active') return deny('business_not_active');
  if (!business.agreementScope.includes(actionCategory)) return deny('category_out_of_scope');

  const covering = business.grants.filter((g) => g.categories.includes(actionCategory));
  const live = covering.some((g) => g.revokedAt === null && g.expiresAt > now);
  if (!live) {
    if (covering.length === 0) return deny('no_grant');
    return deny(covering.some((g) => g.revokedAt !== null) ? 'grant_revoked' : 'grant_expired');
  }

  const authorised =
    actorIdentity === business.managingOperatorId || business.delegatedServiceAccounts.includes(actorIdentity);
  if (!authorised) return deny('actor_not_authorised');

  return { allowed: true, reason: null, audit: null };
}

export interface PortfolioRegistryDeps {
  /** Returns a UUID for new business and grant ids. Defaults to crypto.randomUUID. */
  newId?: () => string;
  /** Returns epoch milliseconds. Defaults to Date.now. */
  now?: () => number;
}

export function createPortfolioRegistry(deps: PortfolioRegistryDeps = {}) {
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
  const clock = deps.now ?? (() => Date.now());
  const store = new Map<string, ManagedBusiness>();
  const clone = <T>(v: T): T => structuredClone(v);

  /** Company-scoped lookup. Unknown and foreign-company records are refused alike to the caller. */
  function locate(event: AuditEvent, callerCompanyId: unknown, businessId: unknown, extra: AuditContext = {}): Located {
    const ctx: AuditContext = { callerCompanyId, businessId, at: clock(), ...extra };
    if (!isText(callerCompanyId)) return refuse(event, 'missing_company', ctx);
    if (!isText(businessId)) return refuse(event, 'missing_business_id', ctx);
    const record = store.get(businessId);
    if (!record) return refuse(event, 'unknown_business', ctx);
    if (record.companyId !== callerCompanyId) return refuse(event, 'wrong_company', ctx);
    return { ok: true, record };
  }

  function registerBusiness(callerCompanyId: unknown, input: unknown): MutationResult<ManagedBusiness> {
    const event: AuditEvent = 'business_registered';
    const at = clock();
    const ctx: AuditContext = { callerCompanyId, at };
    if (!isText(callerCompanyId)) return refuse(event, 'missing_company', ctx);
    if (!isObject(input)) return refuse(event, 'missing_input', ctx);

    const { managingOperatorId, agreementId, agreementScope } = input as Partial<RegisterBusinessInput>;
    const delegated: unknown = input.delegatedServiceAccounts ?? [];
    if (!isText(managingOperatorId) || !isText(agreementId)) return refuse(event, 'missing_input', ctx);
    if (!isTextList(agreementScope) || agreementScope.length === 0) return refuse(event, 'missing_input', ctx);
    if (!isTextList(delegated)) return refuse(event, 'missing_input', ctx);

    const businessId = newId();
    if (typeof businessId !== 'string' || !UUID_RE.test(businessId)) return refuse(event, 'invalid_id', ctx);
    if (store.has(businessId)) return refuse(event, 'duplicate_id', ctx);

    const record: ManagedBusiness = {
      businessId,
      companyId: callerCompanyId,
      managingOperatorId,
      agreementId,
      agreementScope: [...agreementScope],
      delegatedServiceAccounts: [...delegated],
      status: 'active',
      grants: [],
    };
    store.set(businessId, record);
    return applied(clone(record), event, { ...ctx, businessId, actorId: managingOperatorId });
  }

  /** Reads do not change state, so a successful read carries no audit entry. Refusals still do. */
  function getBusiness(callerCompanyId: unknown, businessId: unknown): ReadResult<ManagedBusiness> {
    const located = locate('access_refused', callerCompanyId, businessId);
    if (!located.ok) return located;
    return { ok: true, value: clone(located.record), audit: null };
  }

  function grantAccess(callerCompanyId: unknown, businessId: unknown, input: unknown): MutationResult<CustomerGrant> {
    const event: AuditEvent = 'grant_created';
    const located = locate(event, callerCompanyId, businessId);
    if (!located.ok) return located;
    const record = located.record;
    const at = clock();
    const grantedBy = isObject(input) ? input.grantedBy : undefined;
    const ctx: AuditContext = { callerCompanyId, businessId, actorId: grantedBy, at };

    if (!isObject(input)) return refuse(event, 'missing_input', ctx);
    const { categories, expiresAt } = input as Partial<GrantAccessInput>;
    if (!isText(grantedBy)) return refuse(event, 'missing_input', ctx);
    if (!isTextList(categories) || categories.length === 0) return refuse(event, 'missing_input', ctx);
    if (record.status !== 'active') return refuse(event, 'business_not_active', ctx);
    if (!categories.every((c) => record.agreementScope.includes(c))) return refuse(event, 'category_out_of_scope', ctx);
    if (!isTime(expiresAt) || expiresAt <= at) return refuse(event, 'invalid_expiry', ctx);

    const grantId = newId();
    if (typeof grantId !== 'string' || !UUID_RE.test(grantId)) return refuse(event, 'invalid_id', ctx);
    if (record.grants.some((g) => g.grantId === grantId)) return refuse(event, 'duplicate_id', ctx);

    const grant: CustomerGrant = {
      grantId,
      categories: [...new Set(categories)],
      expiresAt,
      revokedAt: null,
      createdAt: at,
      grantedBy,
    };
    record.grants.push(grant);
    return applied(clone(grant), event, { ...ctx, grantId });
  }

  function revokeAccess(callerCompanyId: unknown, businessId: unknown, grantId: unknown): MutationResult<CustomerGrant> {
    const event: AuditEvent = 'grant_revoked';
    const located = locate(event, callerCompanyId, businessId, { grantId });
    if (!located.ok) return located;
    const record = located.record;
    const at = clock();
    const ctx: AuditContext = { callerCompanyId, businessId, grantId, at };

    if (!isText(grantId)) return refuse(event, 'missing_input', ctx);
    const grant = record.grants.find((g) => g.grantId === grantId);
    if (!grant) return refuse(event, 'unknown_grant', ctx);
    if (grant.revokedAt !== null) return refuse(event, 'already_revoked', ctx);

    grant.revokedAt = at;
    return applied(clone(grant), event, ctx);
  }

  function suspend(callerCompanyId: unknown, businessId: unknown): MutationResult<ManagedBusiness> {
    const event: AuditEvent = 'business_suspended';
    const located = locate(event, callerCompanyId, businessId);
    if (!located.ok) return located;
    const record = located.record;
    const ctx: AuditContext = { callerCompanyId, businessId, at: clock() };

    if (record.status !== 'active') return refuse(event, 'invalid_transition', ctx);
    record.status = 'suspended';
    return applied(clone(record), event, ctx);
  }

  function endAgreement(callerCompanyId: unknown, businessId: unknown): MutationResult<ManagedBusiness> {
    const event: AuditEvent = 'agreement_ended';
    const located = locate(event, callerCompanyId, businessId);
    if (!located.ok) return located;
    const record = located.record;
    const ctx: AuditContext = { callerCompanyId, businessId, at: clock() };

    if (record.status === 'ended') return refuse(event, 'invalid_transition', ctx);
    record.status = 'ended';
    return applied(clone(record), event, ctx);
  }

  /** Company-scoped wrapper around the pure canAct. */
  function checkAccess(
    callerCompanyId: unknown,
    businessId: unknown,
    actorIdentity: unknown,
    actionCategory: unknown,
    now: unknown,
  ): AccessDecision {
    const located = locate('access_refused', callerCompanyId, businessId, {
      actorId: actorIdentity,
      actionCategory,
      at: now,
    });
    if (!located.ok) return { allowed: false, reason: located.reason, audit: located.audit };
    return canAct(located.record, actorIdentity, actionCategory, now, callerCompanyId);
  }

  return {
    registerBusiness,
    getBusiness,
    grantAccess,
    revokeAccess,
    suspend,
    endAgreement,
    checkAccess,
  };
}

export type PortfolioRegistry = ReturnType<typeof createPortfolioRegistry>;

import { assertAuthorityCompanyId, rejectLegacyAuthorityBoundaryDeep } from './company-boundary.mjs';

export const LEGACY_AUTONOMY_LEVELS = Object.freeze(['suggest','assist','semi_auto','auto','trusted_auto','predictive']);
export const LEGACY_RISK_LEVELS = Object.freeze(['none','low','medium','high','critical']);

const PROTECTED_EFFECTS = new Set([
  'write','submit','purchase','payment','delete','publish','send','approve','sign','book','cancel','reschedule'
]);

function req(value, code) {
  const s = String(value ?? '').trim();
  if (!s) throw new Error(code);
  return s;
}
function opt(value) { return value == null || value === '' ? null : String(value).trim(); }
function list(value) {
  return Object.freeze(Array.isArray(value)
    ? [...new Set(value.map(v => String(v).trim()).filter(Boolean))].sort()
    : []);
}
function nonNegative(value, code) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(code);
  return n;
}
function nonNegativeInteger(value, code) {
  const n = nonNegative(value, code);
  if (n == null) return null;
  if (!Number.isInteger(n)) throw new Error(code);
  return n;
}
function normalizeLimits(input = {}) {
  if (input == null) return Object.freeze({
    currency:null,max_amount:null,max_provider_cost:null,max_messages:null,max_recipients:null,
  });
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('authority-limits-invalid');
  const currency = opt(input.currency)?.toUpperCase() ?? null;
  const max_amount = nonNegative(input.max_amount, 'authority-max-amount-invalid');
  const max_provider_cost = nonNegative(input.max_provider_cost, 'authority-max-provider-cost-invalid');
  const max_messages = nonNegativeInteger(input.max_messages, 'authority-max-messages-invalid');
  const max_recipients = nonNegativeInteger(input.max_recipients, 'authority-max-recipients-invalid');
  if ((max_amount != null || max_provider_cost != null) && !currency) throw new Error('authority-limit-currency-required');
  return Object.freeze({currency,max_amount,max_provider_cost,max_messages,max_recipients});
}

export function createWorkerIdentity(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('worker-identity-input-required');
  rejectLegacyAuthorityBoundaryDeep(input, 'worker_identity');
  const company_id = assertAuthorityCompanyId(input.company_id);
  return Object.freeze({
    schema_version: '1.0', company_id,
    worker_id: req(input.worker_id ?? input.actor_id, 'worker-id-required'),
    worker_type: opt(input.worker_type) ?? 'advanced-intelligence-worker',
    surface: opt(input.surface) ?? 'zero',
    identity_confers_authority: false,
  });
}

export function createAuthorityRequirement(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('authority-requirement-input-required');
  rejectLegacyAuthorityBoundaryDeep(input, 'authority_requirement');
  const company_id = assertAuthorityCompanyId(input.company_id);
  const effect = opt(input.effect) ?? 'read';
  return Object.freeze({
    schema_version: '1.0', company_id,
    capability: req(input.capability, 'capability-required'),
    variant: opt(input.variant),
    workflow: opt(input.workflow),
    context_ref: opt(input.context_ref),
    operation: opt(input.operation) ?? 'execute',
    effect,
    action_class: opt(input.action_class),
    target: opt(input.target),
    protected_action: input.protected_action == null ? PROTECTED_EFFECTS.has(effect) : Boolean(input.protected_action),
    required_permissions: list(input.required_permissions),
    required_entitlements: list(input.required_entitlements),
    required_evidence: list(input.required_evidence),
    minimum_autonomy_score: Number.isFinite(Number(input.minimum_autonomy_score)) ? Number(input.minimum_autonomy_score) : 0,
    approval_policy: opt(input.approval_policy),
    limits: normalizeLimits(input.limits),
    reversibility: opt(input.reversibility) ?? 'unknown',
    evidence_refs: list(input.evidence_refs),
    identity_confers_authority: false,
  });
}

export function createApprovalState(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('approval-input-required');
  rejectLegacyAuthorityBoundaryDeep(input, 'approval');
  const company_id = assertAuthorityCompanyId(input.company_id);
  const status = String(input.status ?? 'not_required').trim();
  const allowed = new Set(['not_required','required','pending','approved','denied','expired','revoked']);
  if (!allowed.has(status)) throw new Error(`invalid-approval-status:${status}`);
  return Object.freeze({
    schema_version:'1.0', company_id,
    approval_id: opt(input.approval_id), status,
    approver_id: opt(input.approver_id),
    approval_scope: opt(input.approval_scope),
    granted_at: opt(input.granted_at), expires_at: opt(input.expires_at),
    approval_confers_only_scoped_authority: true,
  });
}

import { assertAuthorityCompanyId, rejectLegacyAuthorityBoundaryDeep } from './company-boundary.mjs';
import { evaluateDelegationExtinction } from './delegation.mjs';
import { applyAuthorityLeaseControl } from './lease-control.mjs';

export const AUTHORITY_LEASE_STATES = Object.freeze([
  'fresh','stale','expired','revoked','suspended','unknown'
]);

function text(value){ return value == null ? null : String(value).trim() || null; }
function list(value){
  return Object.freeze(Array.isArray(value)
    ? [...new Set(value.map(v => String(v).trim()).filter(Boolean))].sort()
    : []);
}
function isoMs(value){
  const n = Date.parse(String(value ?? ''));
  return Number.isFinite(n) ? n : null;
}
function requiredText(value, code){
  const v = text(value);
  if(!v) throw new Error(code);
  return v;
}

function stableCanonical(value){
  if(value==null||typeof value!=='object') return JSON.stringify(value);
  if(Array.isArray(value)) return `[${value.map(stableCanonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stableCanonical(value[k])}`).join(',')}}`;
}
function fnv1a64(textValue){
  let hash=0xcbf29ce484222325n;
  const prime=0x100000001b3n;
  const mask=0xffffffffffffffffn;
  const bytes=new TextEncoder().encode(String(textValue));
  for(const byte of bytes){hash^=BigInt(byte);hash=(hash*prime)&mask;}
  return hash.toString(16).padStart(16,'0');
}
export function buildAuthorityDecisionProvenanceSeal(input){
  if(!input||typeof input!=='object'||Array.isArray(input)) throw new Error('authority-provenance-required');
  rejectLegacyAuthorityBoundaryDeep(input,'authority_provenance_seal');
  const canonical={
    company_id:assertAuthorityCompanyId(input.company_id),
    decision_id:requiredText(input.decision_id,'authority-provenance-decision-id-required'),
    capability:requiredText(input.capability,'authority-provenance-capability-required'),
    variant:text(input.variant),workflow:text(input.workflow),context_ref:text(input.context_ref),
    source:requiredText(input.source,'authority-provenance-source-required'),
    authority_owner:text(input.authority_owner)??'titan-autonomy',
    verified_at:requiredText(input.verified_at,'authority-provenance-verified-at-required'),
    decision_version:text(input.decision_version),evaluator_version:text(input.evaluator_version),
    policy_ref:text(input.policy_ref),risk_ref:text(input.risk_ref),assurance_ref:text(input.assurance_ref),
    source_receipt_ref:text(input.source_receipt_ref),signature_ref:text(input.signature_ref),
    evidence_refs:[...list(input.evidence_refs)],locally_issued:false,provenance_confers_authority:false,
  };
  const supersedes=text(input.supersedes_authority_decision_id);
  if(supersedes) canonical.supersedes_authority_decision_id=supersedes;
  return `titan.provenance.fnv1a64.v1:${fnv1a64(stableCanonical(canonical))}`;
}

export function assertAuthorityDecisionProvenanceContinuity(previousInput,nextInput){
  if(!previousInput||!nextInput||typeof previousInput!=='object'||typeof nextInput!=='object') throw new Error('authority-provenance-required');
  const previousSeal=buildAuthorityDecisionProvenanceSeal(previousInput);
  const nextSeal=buildAuthorityDecisionProvenanceSeal(nextInput);
  const previousCompany=assertAuthorityCompanyId(previousInput.company_id);
  const nextCompany=assertAuthorityCompanyId(nextInput.company_id);
  if(previousCompany!==nextCompany) throw new Error('authority-provenance-company-mismatch');
  const previousId=requiredText(previousInput.decision_id,'authority-provenance-decision-id-required');
  const nextId=requiredText(nextInput.decision_id,'authority-provenance-decision-id-required');
  if(previousId===nextId && previousSeal!==nextSeal) throw new Error('authority-provenance-seal-equivocation');
  normalizeAuthorityDecisionProvenance(previousInput);
  normalizeAuthorityDecisionProvenance(nextInput);
  return true;
}


export function assertAuthorityDecisionProvenanceHistory(history){
  if(!Array.isArray(history)||history.length===0) throw new Error('authority-provenance-history-required');
  const seen=new Map();
  let previous=null;
  for(const item of history){
    const current=normalizeAuthorityDecisionProvenance(item);
    if(previous){
      if(previous.company_id!==current.company_id) throw new Error('authority-provenance-company-mismatch');
      const previousMs=isoMs(previous.verified_at); const currentMs=isoMs(current.verified_at);
      if(currentMs<previousMs) throw new Error('authority-provenance-history-time-rollback');
      if(current.decision_id===previous.decision_id && current.provenance_seal!==previous.provenance_seal) throw new Error('authority-provenance-seal-equivocation');
      if(current.supersedes_authority_decision_id && current.supersedes_authority_decision_id!==previous.decision_id) throw new Error('authority-provenance-history-supersession-parent-mismatch');
      if(current.decision_id===previous.decision_id && current.supersedes_authority_decision_id) throw new Error('authority-provenance-history-self-supersession');
    }
    const prior=seen.get(current.decision_id);
    if(prior && previous && previous.decision_id!==current.decision_id) throw new Error('authority-provenance-history-decision-reuse');
    if(prior && prior.provenance_seal!==current.provenance_seal) throw new Error('authority-provenance-seal-equivocation');
    seen.set(current.decision_id,current);
    previous=current;
  }
  return true;
}

export function normalizeAuthorityDecisionProvenance(input){
  if(!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('authority-provenance-required');
  rejectLegacyAuthorityBoundaryDeep(input, 'authority_provenance');
  const company_id = assertAuthorityCompanyId(input.company_id);
  const source = requiredText(input.source, 'authority-provenance-source-required');
  if(source !== 'titan-autonomy') throw new Error('authority-provenance-source-invalid');
  const decision_id = requiredText(input.decision_id, 'authority-provenance-decision-id-required');
  const capability = requiredText(input.capability, 'authority-provenance-capability-required');
  const verified_at = requiredText(input.verified_at, 'authority-provenance-verified-at-required');
  if(isoMs(verified_at) == null) throw new Error('authority-provenance-verified-at-invalid');
  const provenance_seal=buildAuthorityDecisionProvenanceSeal({
    ...input,company_id,decision_id,capability,source:'titan-autonomy',authority_owner:'titan-autonomy',verified_at,
  });
  if(text(input.provenance_seal)&&text(input.provenance_seal)!==provenance_seal) throw new Error('authority-provenance-seal-mismatch');
  return Object.freeze({
    schema_version:'1.0',
    company_id,
    decision_id, capability,
    variant:text(input.variant),
    workflow:text(input.workflow),
    context_ref:text(input.context_ref),
    source:'titan-autonomy',
    authority_owner:'titan-autonomy',
    verified_at,
    decision_version:text(input.decision_version),
    evaluator_version:text(input.evaluator_version),
    policy_ref:text(input.policy_ref),
    risk_ref:text(input.risk_ref),
    assurance_ref:text(input.assurance_ref),
    source_receipt_ref:text(input.source_receipt_ref),
    signature_ref:text(input.signature_ref),
    supersedes_authority_decision_id:text(input.supersedes_authority_decision_id),
    evidence_refs:list(input.evidence_refs),
    provenance_seal, provenance_seal_algorithm:'fnv1a64-v1',
    locally_issued:false,
    provenance_confers_authority:false,
  });
}

function unknownLease(company_id, now){
  return Object.freeze({
    schema_version:'1.0', company_id,
    decision_id:null, capability:null, variant:null, workflow:null, context_ref:null,
    state:'unknown', lease_status:'unknown',
    verified_at:null, lease_expires_at:null, evaluated_at:now,
    age_ms:null,
    execution_eligible:false,
    authority_ceiling:0,
    provenance:null, delegation:null, delegation_extinction:null, lease_control:null,
    reason_codes:Object.freeze(['authority_lease_unknown']),
    local_can_raise_authority:false,
  });
}

export function evaluateAuthorityDecisionLease(input){
  if(!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('authority-lease-input-required');
  rejectLegacyAuthorityBoundaryDeep(input, 'authority_lease');
  const company_id = assertAuthorityCompanyId(input.company_id);
  const evaluated_at = String(input.now ?? new Date().toISOString());
  const nowMs = isoMs(evaluated_at);
  if(nowMs == null) throw new Error('authority-lease-now-invalid');
  if(!input.snapshot) return unknownLease(company_id, evaluated_at);

  const snapshot = input.snapshot;
  if(typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('authority-lease-snapshot-invalid');
  rejectLegacyAuthorityBoundaryDeep(snapshot, 'authority_lease_snapshot');
  const snapshotCompany = assertAuthorityCompanyId(snapshot.company_id);
  if(snapshotCompany !== company_id) throw new Error('authority-company-mismatch');
  const decision_id = requiredText(snapshot.decision_id, 'authority-lease-decision-id-required');
  const capability = requiredText(snapshot.capability, 'authority-lease-capability-required');
  const variant = text(snapshot.variant);
  const workflow = text(snapshot.workflow);
  const context_ref = text(snapshot.context_ref);
  const source = requiredText(snapshot.source, 'authority-lease-source-required');
  if(source !== 'titan-autonomy') throw new Error('authority-lease-source-invalid');
  const verified_at = requiredText(snapshot.verified_at, 'authority-lease-verified-at-required');
  const verifiedMs = isoMs(verified_at);
  if(verifiedMs == null) throw new Error('authority-lease-verified-at-invalid');
  const expires_at = text(snapshot.expires_at);
  const expiresMs = expires_at == null ? null : isoMs(expires_at);
  if(expires_at && expiresMs == null) throw new Error('authority-lease-expires-at-invalid');
  if(expiresMs != null && expiresMs < verifiedMs) throw new Error('authority-lease-window-invalid');
  if(verifiedMs > nowMs) throw new Error('authority-lease-verified-at-future');
  const status = String(snapshot.status ?? 'verified').trim();
  if(!['verified','suspended','revoked','expired'].includes(status)) throw new Error('authority-lease-status-invalid');
  const maxFreshAgeMs = Number(input.max_fresh_age_ms ?? 86_400_000);
  if(!Number.isFinite(maxFreshAgeMs) || maxFreshAgeMs < 0) throw new Error('authority-lease-max-fresh-age-invalid');

  const provenanceInput = snapshot.provenance && typeof snapshot.provenance === 'object'
    ? snapshot.provenance
    : snapshot;
  const binding = { company_id:snapshotCompany, decision_id, capability, variant, workflow, context_ref, source:'titan-autonomy', verified_at };
  for (const [field, expected] of Object.entries(binding)) {
    if (Object.prototype.hasOwnProperty.call(provenanceInput, field)) {
      const actual = text(provenanceInput[field]);
      const canonicalExpected = text(expected);
      if (actual !== canonicalExpected) throw new Error(`authority-provenance-binding-mismatch:${field}`);
    }
  }
  const provenance = normalizeAuthorityDecisionProvenance({
    ...provenanceInput,
    ...binding,
  });

  const delegation_extinction=evaluateDelegationExtinction(snapshot.delegation,{company_id:snapshotCompany,decision_id,capability,workflow,context_ref},evaluated_at);
  let superseded_by_decision_id=null;
  const currentDecision=input.current_authority_decision;
  if(currentDecision!=null){
    if(typeof currentDecision!=='object'||Array.isArray(currentDecision)) throw new Error('authority-current-decision-invalid');
    rejectLegacyAuthorityBoundaryDeep(currentDecision,'authority_current_decision');
    const currentCompany=assertAuthorityCompanyId(currentDecision.company_id);
    if(currentCompany!==snapshotCompany) throw new Error('authority-current-decision-company-mismatch');
    const currentCapability=text(currentDecision.capability);
    if(currentCapability&&currentCapability!==capability) throw new Error('authority-current-decision-capability-mismatch');
    const currentId=requiredText(currentDecision.authority_decision_id,'authority-current-decision-id-required');
    if(currentId===decision_id && text(currentDecision.provenance_seal) && text(currentDecision.provenance_seal)!==provenance.provenance_seal) throw new Error('authority-current-decision-provenance-seal-mismatch');
    const currentMs=isoMs(currentDecision.evaluated_at);
    if(currentMs==null) throw new Error('authority-current-decision-evaluated-at-invalid');
    if(currentMs<=nowMs && currentId!==decision_id){
      const parent=text(currentDecision.supersedes_authority_decision_id);
      if(parent&&parent!==decision_id) throw new Error('authority-current-decision-parent-mismatch');
      superseded_by_decision_id=currentId;
    }
  }
  const age_ms = Math.max(0, nowMs - verifiedMs);
  let state = 'fresh';
  const reasons = [];
  if(superseded_by_decision_id) { state='revoked'; reasons.push('authority_lease_superseded'); }
  else if(delegation_extinction.extinguished) { state='revoked'; reasons.push('authority_delegation_extinguished', ...delegation_extinction.reason_codes); }
  else if(status === 'revoked') { state='revoked'; reasons.push('authority_lease_revoked'); }
  else if(status === 'suspended') { state='suspended'; reasons.push('authority_lease_suspended'); }
  else if(status === 'expired' || (expiresMs != null && expiresMs <= nowMs)) { state='expired'; reasons.push('authority_lease_expired'); }
  else if(age_ms > maxFreshAgeMs) { state='stale'; reasons.push('authority_lease_stale'); }
  else reasons.push('authority_lease_fresh');

  const execution_eligible = state === 'fresh' || state === 'stale';
  const externalScore = Number(snapshot.effective_score);
  const normalizedScore = Number.isFinite(externalScore) ? Math.max(0, Math.min(100, Math.floor(externalScore))) : 0;
  const authority_ceiling = state === 'fresh' ? normalizedScore : state === 'stale' ? Math.min(normalizedScore, 30) : 0;

  const baseLease=Object.freeze({
    schema_version:'1.0', company_id:snapshotCompany, decision_id, capability, variant, workflow, context_ref,
    state,
    lease_status:execution_eligible ? 'active' : state,
    verified_at,
    lease_expires_at:expires_at,
    evaluated_at,
    age_ms,
    max_fresh_age_ms:maxFreshAgeMs,
    execution_eligible,
    authority_ceiling,
    provenance, delegation:delegation_extinction.delegation, delegation_extinction, lease_control:null, superseded_by_decision_id,
    reason_codes:Object.freeze([...new Set(reasons)]),
    local_can_raise_authority:false,
  });
  return applyAuthorityLeaseControl(baseLease, input.lease_control ?? snapshot.lease_control ?? null, evaluated_at);
}

const text = (value, code) => { const v = String(value ?? '').trim(); if (!v) throw new Error(code); return v; };
const arr = value => Array.isArray(value) ? value : [];
const company = value => text(value, 'evidence-provider-company-id-required');
const uniq = value => [...new Set(arr(value).map(v => text(v, 'evidence-provider-reference-required')))];

function rejectLegacy(value, path = 'evidence-provider') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) return value.forEach((v, i) => rejectLegacy(v, `${path}[${i}]`));
  for (const [key, nested] of Object.entries(value)) { if (['tenant_id','tenant_company_id','tenant_company','tenant'].includes(key)) throw new Error(`legacy-company-boundary:${path}.${key}`); rejectLegacy(nested, `${path}.${key}`); }
}
function assertSameCompany(a, b) { if (company(a) !== company(b)) throw new Error('evidence-provider-cross-company'); }

export class EvidenceProviderNetwork {
  #providers = new Map();
  #requests = new Map();
  register(input = {}) {
    rejectLegacy(input); const provider = Object.freeze({
      schema:'titan.evidence.provider.v1', provider_id:text(input.provider_id, 'evidence-provider-id-required'), company_id:company(input.company_id), capability_id:text(input.capability_id, 'evidence-provider-capability-required'), source_kind:text(input.source_kind, 'evidence-provider-source-kind-required'), health:text(input.health ?? 'HEALTHY', 'evidence-provider-health-required').toUpperCase(), privacy_class:text(input.privacy_class ?? 'company', 'evidence-provider-privacy-class-required'), egress_allowed:input.egress_allowed === true, estimated_cost:Number(input.estimated_cost ?? 0), confidence:Number(input.confidence ?? 0), replaceable:input.replaceable !== false,
    });
    if (!Number.isFinite(provider.estimated_cost) || provider.estimated_cost < 0) throw new Error('evidence-provider-cost-invalid');
    if (!Number.isFinite(provider.confidence) || provider.confidence < 0 || provider.confidence > 1) throw new Error('evidence-provider-confidence-invalid');
    this.#providers.set(`${provider.company_id}:${provider.provider_id}`, provider); return provider;
  }
  request(input = {}) {
    rejectLegacy(input); const company_id = company(input.company_id); const request_id = text(input.request_id, 'evidence-request-id-required');
    if (this.#requests.has(request_id)) return this.#requests.get(request_id);
    const capability_id = text(input.capability_id, 'evidence-request-capability-required'); const purpose = text(input.purpose, 'evidence-request-purpose-required');
    const consent = input.consent === true; const budget = Number(input.cost_budget ?? 0); const candidates = [...this.#providers.values()].filter(p => p.company_id === company_id && p.capability_id === capability_id && p.health === 'HEALTHY' && p.egress_allowed && p.privacy_class === (input.privacy_class ?? p.privacy_class) && p.estimated_cost <= budget).sort((a,b) => a.estimated_cost-b.estimated_cost || a.provider_id.localeCompare(b.provider_id));
    let state = 'READY'; let reason = 'provider-selected'; if (!consent) { state='DENIED'; reason='consent-required'; } else if (!candidates.length) { state='DEGRADED'; reason='no-eligible-provider'; }
    const result = Object.freeze({ schema:'titan.evidence.provider.request.v1', request_id, company_id, capability_id, purpose, provider_id:state === 'READY' ? candidates[0].provider_id : null, state, reason, cost_budget:budget, evidence_is_not_fact:true, authority_effect:false, grants_authority:false });
    this.#requests.set(request_id, result); return result;
  }
  normalizeResult(input = {}) {
    rejectLegacy(input); const request = this.#requests.get(text(input.request_id, 'evidence-request-id-required')); if (!request) throw new Error('evidence-request-not-found'); assertSameCompany(request.company_id, input.company_id);
    if (request.state !== 'READY') throw new Error('evidence-request-not-ready'); const provider = this.#providers.get(`${request.company_id}:${request.provider_id}`); if (!provider) throw new Error('evidence-provider-not-found');
    const evidence_refs = uniq(input.evidence_refs); if (!evidence_refs.length) throw new Error('evidence-provider-evidence-ref-required');
    return Object.freeze({ schema:'titan.evidence.provider.result.v1', company_id:request.company_id, request_id:request.request_id, provider_id:provider.provider_id, capability_id:request.capability_id, source_kind:provider.source_kind, evidence_refs:Object.freeze(evidence_refs.sort()), acquired_at:text(input.acquired_at, 'evidence-acquired-at-required'), freshness:text(input.freshness ?? 'unknown', 'evidence-freshness-required'), confidence:Math.max(0, Math.min(1, Number(input.confidence ?? provider.confidence))), actual_cost:Number(input.actual_cost ?? provider.estimated_cost), uncertainty:text(input.uncertainty ?? 'provider-result-requires-canonical-verification', 'evidence-uncertainty-required'), normalized_for_decision:true, evidence_is_fact:false, authority_effect:false, grants_authority:false });
  }
}

export function shouldRequestAdditionalEvidence(input = {}) { rejectLegacy(input); const confidence = Number(input.confidence ?? 0); const coverage = Number(input.coverage ?? 0); const threshold = Number(input.threshold ?? 0.8); return Object.freeze({ request_required:confidence < threshold || coverage < threshold, reason:confidence < threshold ? 'confidence-below-threshold' : coverage < threshold ? 'coverage-below-threshold' : 'sufficient-evidence', authority_effect:false }); }


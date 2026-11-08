import crypto from 'node:crypto';
import { buildRevenueJourneyCorrelation, bindRevenueJourneyEntity, REVENUE_JOURNEY_CORRELATION_SCHEMA } from './revenue-journey-correlation.mjs';

export const REVENUE_QUOTE_LIFECYCLE_SCHEMA = 'titan.zero.revenue-journey.quote-lifecycle.v1';
export const REVENUE_QUOTE_STATES = Object.freeze(['draft','issued','accepted','rejected','expired','cancelled']);
const LEGACY_COMPANY_KEYS = Object.freeze(['tenant_id','tenantId','tenant_company_id','business_id','account_id']);
const TERMINAL = new Set(['accepted','rejected','expired','cancelled']);
const ALLOWED = Object.freeze({
  draft: new Set(['draft','issued','cancelled']),
  issued: new Set(['issued','accepted','rejected','expired','cancelled']),
  accepted: new Set(['accepted']),
  rejected: new Set(['rejected']),
  expired: new Set(['expired']),
  cancelled: new Set(['cancelled'])
});
const clean=(v)=>typeof v==='string'&&v.trim()?v.trim():null;
function assertCompany(input={}){
 for(const k of LEGACY_COMPANY_KEYS) if(Object.prototype.hasOwnProperty.call(input,k)&&input[k]!=null) throw new TypeError(`revenue-quote-legacy-company-boundary-forbidden:${k}`);
 const id=clean(input.company_id); if(!id) throw new TypeError('revenue-quote-company-id-required'); return id;
}
function stable(parts){return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');}
function normalizeEvidence(items){
 if(!Array.isArray(items)||items.length===0) throw new TypeError('revenue-quote-evidence-required');
 return Object.freeze(items.map((x,i)=>{if(typeof x==='string'){const ref=clean(x); if(!ref) throw new TypeError(`revenue-quote-evidence-invalid:${i}`); return Object.freeze({source_ref:ref});}
   if(!x||typeof x!=='object') throw new TypeError(`revenue-quote-evidence-invalid:${i}`);
   const source_ref=clean(x.source_ref??x.ref); if(!source_ref) throw new TypeError(`revenue-quote-evidence-source-ref-required:${i}`);
   return Object.freeze({source_ref,kind:clean(x.kind),summary:clean(x.summary)});
 }));
}
function resolveCorrelation(input,companyId,quoteId){
 let corr=input.correlation;
 if(corr){
   if(corr.schema!==REVENUE_JOURNEY_CORRELATION_SCHEMA) throw new TypeError('revenue-quote-valid-correlation-required');
   if(corr.company_id!==companyId) throw new TypeError('revenue-quote-cross-company-correlation');
 } else {
   corr=buildRevenueJourneyCorrelation({company_id:companyId,revenue_journey_id:clean(input.revenue_journey_id)??undefined,correlation_id:clean(input.correlation_id)??undefined,lead_id:clean(input.lead_id)??undefined,opportunity_id:clean(input.opportunity_id)??undefined,quote_id:quoteId,provenance:input.provenance});
 }
 const existing=corr.entities?.quote_id;
 if(existing&&existing!==quoteId) throw new TypeError('revenue-quote-id-conflict');
 if(!existing) corr=bindRevenueJourneyEntity(corr,{company_id:companyId,stage:'quote',entity_id:quoteId,correlation_id:clean(input.correlation_id)??corr.correlation_id,provenance:input.provenance});
 return corr;
}
export function buildQuoteLifecycleTransition(input={}){
 const companyId=assertCompany(input); const quoteId=clean(input.quote_id); if(!quoteId) throw new TypeError('revenue-quote-id-required');
 const from=clean(input.from_state); const to=clean(input.to_state); if(!REVENUE_QUOTE_STATES.includes(from)||!REVENUE_QUOTE_STATES.includes(to)) throw new TypeError('revenue-quote-state-invalid');
 if(!ALLOWED[from].has(to)) throw new TypeError(`revenue-quote-transition-invalid:${from}->${to}`);
 const producer=clean(input.provenance?.producer), sourceEventId=clean(input.provenance?.source_event_id), observedAt=clean(input.provenance?.observed_at);
 if(!producer||!sourceEventId) throw new TypeError('revenue-quote-provenance-required');
 const evidence=normalizeEvidence(input.evidence_refs??input.evidence);
 const corr=resolveCorrelation(input,companyId,quoteId);
 const disposition=from===to?'idempotent_replay':'transition_observed';
 const outcome=to==='accepted'?'accepted_for_downstream_review':to==='rejected'?'rejected_terminal':to==='expired'?'expired_terminal':to==='cancelled'?'cancelled_terminal':null;
 const key=`revq:${stable([companyId,corr.revenue_journey_id,quoteId,from,to,sourceEventId]).slice(0,32)}`;
 return Object.freeze({
   schema:REVENUE_QUOTE_LIFECYCLE_SCHEMA, company_id:companyId, revenue_journey_id:corr.revenue_journey_id, quote_id:quoteId,
   correlation: corr,
   transition:Object.freeze({from_state:from,to_state:to,disposition,terminal:TERMINAL.has(to),outcome}),
   provenance:Object.freeze({producer,source_event_id:sourceEventId,observed_at:observedAt}), evidence,
   idempotency_key:key,
   quote_semantics:Object.freeze({
     quote_truth_owner:'crm.quote', workflow_path:'titan-business-services/workflows/create_quote.json', capability:'crm.quote.create',
     mutation_performed:false, quote_creation_performed:false, quote_status_mutation_performed:false,
     acceptance_is_not_booking_completion:true, accepted_quote_requires_separate_booking_handoff:true,
     rejection_or_expiry_never_grants_authority:true
   }),
   governance:Object.freeze({company_boundary:'company_id',owns_domain_truth:false,identity_is_authority:false,authority_granted:false,execution_permitted:false,may_create_entities:false,may_mutate_entities:false})
 });
}
export function assertQuoteLifecycleReplay(a,b){
 return Boolean(a&&b&&a.schema===REVENUE_QUOTE_LIFECYCLE_SCHEMA&&b.schema===REVENUE_QUOTE_LIFECYCLE_SCHEMA&&a.company_id===b.company_id&&a.revenue_journey_id===b.revenue_journey_id&&a.quote_id===b.quote_id&&a.idempotency_key===b.idempotency_key);
}

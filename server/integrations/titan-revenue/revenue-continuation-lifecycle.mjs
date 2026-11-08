import crypto from 'node:crypto';
import { REVENUE_JOURNEY_CORRELATION_SCHEMA, bindRevenueJourneyEntity } from './revenue-journey-correlation.mjs';
export const REVENUE_CONTINUATION_LIFECYCLE_SCHEMA='titan.zero.revenue-journey.continuation-lifecycle.v1';
const LEGACY=['tenant_id','tenantId','tenant_company_id','business_id','account_id'];
const KINDS=new Set(['repeat_service','referral']);
const REPEAT_EVENTS=new Set(['opportunity_detected','recommendation_ready','customer_yes','deferred','declined','frequency_change']);
const REFERRAL_EVENTS=new Set(['referral_received','referral_accepted','referral_declined']);
const clean=v=>typeof v==='string'&&v.trim()?v.trim():null;
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function company(i){for(const k of LEGACY)if(i?.[k]!=null)throw new TypeError(`revenue-continuation-legacy-company-boundary-forbidden:${k}`);const c=clean(i?.company_id);if(!c)throw new TypeError('revenue-continuation-company-id-required');return c;}
function provenance(i){const producer=clean(i?.producer),source_event_id=clean(i?.source_event_id),observed_at=clean(i?.observed_at);if(!producer||!source_event_id||!observed_at)throw new TypeError('revenue-continuation-provenance-required');return Object.freeze({producer,source_event_id,observed_at});}
function evidence(v){if(!Array.isArray(v)||!v.length)throw new TypeError('revenue-continuation-evidence-required');return Object.freeze(v.map((x,n)=>{const r=clean(typeof x==='string'?x:x?.source_ref??x?.ref);if(!r)throw new TypeError(`revenue-continuation-evidence-invalid:${n}`);return Object.freeze({source_ref:r,kind:typeof x==='object'?clean(x.kind):null});}));}
function correlation(i,c){const r=i?.correlation;if(!r||r.schema!==REVENUE_JOURNEY_CORRELATION_SCHEMA)throw new TypeError('revenue-continuation-valid-correlation-required');if(r.company_id!==c)throw new TypeError('revenue-continuation-cross-company-correlation');return r;}
function bind(r,c,stage,id,p){const old=r.entities?.[`${stage}_id`];if(old&&old!==id)throw new TypeError(`revenue-continuation-${stage}-id-conflict`);return old?r:bindRevenueJourneyEntity(r,{company_id:c,stage,entity_id:id,provenance:p});}
function nextJourney(company_id,parent,kind,id){return `revj:${company_id}:${hash(['continuation',parent,kind,id].join('\n')).slice(0,24)}`;}
export function buildRevenueContinuationLifecycle(input={}){
 const company_id=company(input),kind=clean(input.kind);if(!KINDS.has(kind))throw new TypeError('revenue-continuation-kind-invalid');
 const event_type=clean(input.event_type);const allowed=kind==='repeat_service'?REPEAT_EVENTS:REFERRAL_EVENTS;if(!allowed.has(event_type))throw new TypeError('revenue-continuation-event-type-invalid');
 const p=provenance(input.provenance),ev=evidence(input.evidence_refs??input.evidence);let corr=correlation(input,company_id);
 const entityId=clean(kind==='repeat_service'?input.repeat_id:input.referral_id);if(!entityId)throw new TypeError(`revenue-continuation-${kind==='repeat_service'?'repeat':'referral'}-id-required`);corr=bind(corr,company_id,kind==='repeat_service'?'repeat':'referral',entityId,p);
 if(clean(input.entity_company_id)&&clean(input.entity_company_id)!==company_id)throw new TypeError('revenue-continuation-cross-company-entity');
 const ui_state=clean(input.ui_state),recommendation_state=clean(input.recommendation_state),payment_history_state=clean(input.payment_history_state),customer_identity=clean(input.customer_id),referred_customer_id=clean(input.referred_customer_id);
 const customer_explicit=Boolean(input.customer_explicit===true),verified_intent=Boolean(input.verified_intent===true);
 if(event_type==='customer_yes'&&(!customer_explicit||!verified_intent))throw new TypeError('revenue-continuation-customer-yes-requires-verified-explicit-intent');
 if(event_type==='referral_accepted'&&input.referral_verified!==true)throw new TypeError('revenue-continuation-referral-accepted-requires-verification');
 const continuation_id=`revc:${hash([company_id,corr.revenue_journey_id,kind,entityId,event_type,p.source_event_id].join('\n')).slice(0,32)}`;
 const candidate=nextJourney(company_id,corr.revenue_journey_id,kind,entityId);
 let state='observed',handoff=null,terminal=false;
 if(kind==='repeat_service'){
   if(event_type==='customer_yes'){state='booking_review_ready';handoff=Object.freeze({target:'booking',workflow:'titan-business-services/workflows/service_booking.json',intent:'CUSTOMER_REPEAT_SERVICE_YES',customer_explicit:true,requires_authoritative_duplicate_check:true,requires_fresh_authority_evaluation:true,execution_permitted:false});}
   else if(event_type==='deferred'){state='deferred';handoff=Object.freeze({target:'scheduler_review',requires_future_governance_recheck:true,requires_fresh_consent_recheck:true,execution_permitted:false});}
   else if(event_type==='declined'){state='declined_terminal';terminal=true;}
   else if(event_type==='frequency_change'){state='schedule_review_ready';handoff=Object.freeze({target:'recurrence_review',canonical_engine:'titan.workforce.schedule-recurrence.v1',requires_existing_schedule_resolution:true,requires_fresh_authority_evaluation:true,execution_permitted:false});}
   else state=event_type==='recommendation_ready'?'recommendation_observed':'opportunity_observed';
 }else{
   if(event_type==='referral_accepted'){state='intake_review_ready';handoff=Object.freeze({target:'crm_intake_review',intent:'VERIFIED_REFERRAL_ACCEPTED',may_create_lead:false,requires_duplicate_customer_check:true,requires_fresh_authority_evaluation:true,execution_permitted:false});}
   else if(event_type==='referral_declined'){state='declined_terminal';terminal=true;}
   else state='referral_observed';
 }
 return Object.freeze({schema:REVENUE_CONTINUATION_LIFECYCLE_SCHEMA,company_id,kind,event_type,state,terminal,continuation_id,parent_revenue_journey_id:corr.revenue_journey_id,candidate_revenue_journey_id:candidate,repeat_id:kind==='repeat_service'?entityId:null,referral_id:kind==='referral'?entityId:null,customer_id:customer_identity,referred_customer_id,correlation:corr,idempotency_key:`revcont:${hash([continuation_id,p.source_event_id].join('\n')).slice(0,32)}`,provenance:p,evidence:ev,handoff,context:Object.freeze({ui_state,recommendation_state,payment_history_state,context_is_evidence_only:true,ui_state_grants_authority:false,recommendation_grants_authority:false,payment_history_grants_authority:false,customer_identity_grants_authority:false}),semantics:Object.freeze({continuation_is_linkage_not_domain_truth:true,candidate_journey_identity_is_not_authority:true,repeat_service_truth_owner:'Rebooking/Booking canonical domains',referral_truth_owner:'CRM/customer acquisition canonical domains',customer_yes_is_intent_not_booking_authority:true,referral_acceptance_is_intake_evidence_not_lead_creation:true,decline_is_terminal_for_this_continuation_only:true}),governance:Object.freeze({company_boundary:'company_id',owns_domain_truth:false,identity_is_authority:false,authority_granted:false,execution_permitted:false,may_create_booking:false,may_create_schedule:false,may_create_lead:false,may_send_outreach:false,may_mutate_entities:false})});
}
export function assertRevenueContinuationReplay(a,b){return Boolean(a&&b&&a.schema===REVENUE_CONTINUATION_LIFECYCLE_SCHEMA&&b.schema===REVENUE_CONTINUATION_LIFECYCLE_SCHEMA&&a.idempotency_key===b.idempotency_key&&a.company_id===b.company_id&&a.parent_revenue_journey_id===b.parent_revenue_journey_id);}

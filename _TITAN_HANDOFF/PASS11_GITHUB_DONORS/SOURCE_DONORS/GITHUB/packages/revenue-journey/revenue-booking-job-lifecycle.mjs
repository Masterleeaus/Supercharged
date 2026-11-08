import crypto from 'node:crypto';
import { REVENUE_JOURNEY_CORRELATION_SCHEMA, bindRevenueJourneyEntity } from './revenue-journey-correlation.mjs';

export const REVENUE_BOOKING_JOB_LIFECYCLE_SCHEMA='titan.zero.revenue-journey.booking-job-lifecycle.v1';
const LEGACY=['tenant_id','tenantId','tenant_company_id','business_id','account_id'];
const BOOKING_EVENTS=new Set(['confirmed','rescheduled','cancelled']);
const clean=v=>typeof v==='string'&&v.trim()?v.trim():null;
function company(input){for(const k of LEGACY)if(input?.[k]!=null)throw new TypeError(`revenue-booking-job-legacy-company-boundary-forbidden:${k}`);const c=clean(input?.company_id);if(!c)throw new TypeError('revenue-booking-job-company-id-required');return c;}
function hash(parts){return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');}
function evidence(v){if(!Array.isArray(v)||!v.length)throw new TypeError('revenue-booking-job-evidence-required');return Object.freeze(v.map((x,i)=>{const r=clean(typeof x==='string'?x:x?.source_ref??x?.ref);if(!r)throw new TypeError(`revenue-booking-job-evidence-invalid:${i}`);return Object.freeze({source_ref:r,kind:typeof x==='object'?clean(x.kind):null});}));}
function provenance(input){const producer=clean(input?.producer),source_event_id=clean(input?.source_event_id),observed_at=clean(input?.observed_at);if(!producer||!source_event_id)throw new TypeError('revenue-booking-job-provenance-required');return Object.freeze({producer,source_event_id,observed_at});}
function corr(input,c){const r=input?.correlation;if(!r||r.schema!==REVENUE_JOURNEY_CORRELATION_SCHEMA)throw new TypeError('revenue-booking-job-valid-correlation-required');if(r.company_id!==c)throw new TypeError('revenue-booking-job-cross-company-correlation');return r;}
function bind(correlation,company_id,stage,id,input){const existing=correlation.entities?.[`${stage}_id`];if(existing&&existing!==id)throw new TypeError(`revenue-booking-job-${stage}-id-conflict`);if(existing)return correlation;return bindRevenueJourneyEntity(correlation,{company_id,stage,entity_id:id,correlation_id:correlation.correlation_id,provenance:input.provenance});}
export function buildBookingJobLifecycleObservation(input={}){
 const company_id=company(input),booking_id=clean(input.booking_id); if(!booking_id)throw new TypeError('revenue-booking-job-booking-id-required');
 const booking_event=clean(input.booking_event); if(!BOOKING_EVENTS.has(booking_event))throw new TypeError('revenue-booking-job-booking-event-invalid');
 const p=provenance(input.provenance); const ev=evidence(input.evidence_refs??input.evidence); let correlation=corr(input,company_id);
 correlation=bind(correlation,company_id,'booking',booking_id,input);
 const job_id=clean(input.job_id); if(job_id)correlation=bind(correlation,company_id,'job',job_id,input);
 if(input.booking_company_id&&clean(input.booking_company_id)!==company_id)throw new TypeError('revenue-booking-job-cross-company-booking');
 if(input.job_company_id&&clean(input.job_company_id)!==company_id)throw new TypeError('revenue-booking-job-cross-company-job');
 if(job_id&&booking_event==='confirmed'&&input.job_materialization_verified!==true)throw new TypeError('revenue-booking-job-job-materialization-verification-required');
 const has_job=Boolean(job_id);
 const scheduling_review_required=booking_event==='rescheduled';
 const job_review_required=has_job&&(booking_event==='rescheduled'||booking_event==='cancelled');
 const cancellation_review_required=has_job&&booking_event==='cancelled';
 const downstream=booking_event==='confirmed'&&!has_job?'job_materialization_handoff_eligible':booking_event==='confirmed'&&has_job?'booking_job_link_verified':booking_event==='rescheduled'?'schedule_reconciliation_required':'cancellation_review_required';
 const key=`revbj:${hash([company_id,correlation.revenue_journey_id,booking_id,job_id??'-',booking_event,p.source_event_id]).slice(0,32)}`;
 return Object.freeze({schema:REVENUE_BOOKING_JOB_LIFECYCLE_SCHEMA,company_id,revenue_journey_id:correlation.revenue_journey_id,booking_id,job_id,booking_event,correlation,idempotency_key:key,provenance:p,evidence:ev,downstream,
  review:Object.freeze({scheduling_review_required,job_review_required,cancellation_review_required}),
  semantics:Object.freeze({booking_truth_owner:'Booking Agent / CRM appointment',job_truth_owner:'Jobs Agent / Titan Field',booking_confirmation_capability:'crm.appointment.create',job_creation_capability:'crm.work_order.create',confirmed_booking_does_not_mean_job_exists:true,reschedule_never_directly_mutates_job:true,cancellation_never_directly_closes_job:true,job_creation_requires_separate_governed_handoff:true}),
  governance:Object.freeze({company_boundary:'company_id',owns_domain_truth:false,identity_is_authority:false,authority_granted:false,execution_permitted:false,may_create_entities:false,may_mutate_entities:false})});
}
export function assertBookingJobReplay(a,b){return Boolean(a&&b&&a.schema===REVENUE_BOOKING_JOB_LIFECYCLE_SCHEMA&&b.schema===REVENUE_BOOKING_JOB_LIFECYCLE_SCHEMA&&a.idempotency_key===b.idempotency_key&&a.company_id===b.company_id&&a.revenue_journey_id===b.revenue_journey_id);}

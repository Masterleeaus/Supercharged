import crypto from 'node:crypto';
import { REVENUE_JOURNEY_CORRELATION_SCHEMA } from './revenue-journey-correlation.mjs';
export const REVENUE_JOURNEY_PROJECTION_SCHEMA='titan.zero.revenue-journey.projection.v1';
const SURFACES=new Set(['owner','workforce','customer']);
const LEGACY=['tenant_id','tenantId','tenant_company_id','business_id','account_id'];
const clean=v=>typeof v==='string'&&v.trim()?v.trim():null;
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function company(i){for(const k of LEGACY)if(i?.[k]!=null)throw new TypeError(`revenue-projection-legacy-company-boundary-forbidden:${k}`);const c=clean(i?.company_id);if(!c)throw new TypeError('revenue-projection-company-id-required');return c;}
function correlation(i,c){const r=i?.correlation;if(!r||r.schema!==REVENUE_JOURNEY_CORRELATION_SCHEMA)throw new TypeError('revenue-projection-valid-correlation-required');if(r.company_id!==c)throw new TypeError('revenue-projection-cross-company-correlation');return r;}
function sanitizeObservation(o,c,j){if(!o||typeof o!=='object')throw new TypeError('revenue-projection-observation-invalid');if(o.company_id&&o.company_id!==c)throw new TypeError('revenue-projection-cross-company-observation');const oid=clean(o.revenue_journey_id||o.parent_revenue_journey_id||o.correlation?.revenue_journey_id);if(oid&&oid!==j)throw new TypeError('revenue-projection-cross-journey-observation');return o;}
function stageOf(o){
  if(o.kind==='repeat_service'||o.kind==='referral')return o.kind==='repeat_service'?'repeat':'referral';
  if(o.kind==='opportunity')return 'opportunity';
  if(o.kind==='lead')return 'lead';
  if(o.payment_id)return 'payment';
  if(o.invoice_id)return 'invoice';
  if(o.job_id)return 'job';
  if(o.booking_id)return 'booking';
  if(o.quote_id)return 'quote';
  return clean(o.stage)||null;
}
function statusOf(o,stage){
  if(stage==='payment')return clean(o.payment_state||o.state||o.event_type)||'observed';
  if(stage==='invoice')return clean(o.invoice_state||o.state||o.event_type)||'observed';
  if(stage==='quote')return clean(o.transition?.to_state||o.to_state||o.state)||'observed';
  if(stage==='lead'||stage==='opportunity')return clean(o.transition?.to_state||o.to_state||o.state)||'observed';
  if(stage==='booking'||stage==='job')return clean(o.booking_event||o.state||o.event_type)||'observed';
  return clean(o.state||o.to_state||o.event_type)||'observed';
}
function reviewRequired(o){
  if(o.handoff) return true;
  if(o.review&&typeof o.review==='object'&&Object.values(o.review).some(v=>v===true)) return true;
  const d=clean(o.downstream);
  return Boolean(d&&(/required$/.test(d)||/handoff_eligible$/.test(d)));
}
function visible(o,surface){const stage=stageOf(o),status=statusOf(o,stage);const base={stage,status,observed_at:clean(o.provenance?.observed_at)||null,source_event_id:clean(o.provenance?.source_event_id)||null,terminal:o.terminal===true};if(surface==='owner')return {...base,entity_refs:{lead_id:o.correlation?.entities?.lead_id||null,opportunity_id:o.correlation?.entities?.opportunity_id||null,quote_id:o.correlation?.entities?.quote_id||null,booking_id:o.correlation?.entities?.booking_id||null,job_id:o.correlation?.entities?.job_id||null,invoice_id:o.correlation?.entities?.invoice_id||null,payment_id:o.correlation?.entities?.payment_id||null,repeat_id:o.correlation?.entities?.repeat_id||null,referral_id:o.correlation?.entities?.referral_id||null},review_required:reviewRequired(o)};
if(surface==='workforce')return {...base,work_relevant:['booking','job','invoice','payment','repeat'].includes(stage),review_required:reviewRequired(o)};
return {...base,customer_visible:['quote','booking','job','invoice','payment','repeat'].includes(stage)};
}
function identityOf(o){
  const explicit=clean(o.idempotency_key||o.lifecycle_event_id||o.continuation_id);
  if(explicit)return explicit;
  const source=clean(o.provenance?.source_event_id);
  const stage=stageOf(o)||'unknown';
  if(source)return `source:${clean(o.schema)||'unknown'}:${stage}:${source}`;
  return `anonymous:${hash(JSON.stringify(o))}`;
}
function canonicalObservations(observations,c,j,surface){
  const seen=new Map();
  for(const raw of observations){
    const o=sanitizeObservation(raw,c,j);
    const id=identityOf(o);
    const item=visible(o,surface);
    const fingerprint=JSON.stringify(item);
    const existing=seen.get(id);
    if(existing&&existing.fingerprint!==fingerprint)throw new TypeError(`revenue-projection-conflicting-replay:${id}`);
    if(!existing)seen.set(id,{o,item,fingerprint,id});
  }
  return [...seen.values()].sort((a,b)=>{
    const at=clean(a.item.observed_at)||'9999-12-31T23:59:59.999Z',bt=clean(b.item.observed_at)||'9999-12-31T23:59:59.999Z';
    if(at!==bt)return at.localeCompare(bt);
    const ae=clean(a.item.source_event_id)||'',be=clean(b.item.source_event_id)||'';if(ae!==be)return ae.localeCompare(be);
    const as=clean(a.item.stage)||'',bs=clean(b.item.stage)||'';if(as!==bs)return as.localeCompare(bs);
    return a.id.localeCompare(b.id);
  }).map(x=>x.item);
}
export function buildRevenueJourneyProjection(input={}){const company_id=company(input),surface=clean(input.surface);if(!SURFACES.has(surface))throw new TypeError('revenue-projection-surface-invalid');const corr=correlation(input,company_id),journey=corr.revenue_journey_id;const source=Array.isArray(input.observations)?input.observations:[];const canonical=canonicalObservations(source,company_id,journey,surface);const items=canonical.filter(x=>surface!=='customer'||x.customer_visible!==false);return Object.freeze({schema:REVENUE_JOURNEY_PROJECTION_SCHEMA,company_id,revenue_journey_id:journey,surface,items:Object.freeze(items),projection_id:`revproj:${hash([company_id,journey,surface,JSON.stringify(items)].join('\n')).slice(0,32)}`,projected_at:clean(input.projected_at)||null,source_of_truth:'canonical domain observations',persistence:Object.freeze({is_derived:true,owns_store:false,may_persist_domain_truth:false,duplicate_store_created:false}),governance:Object.freeze({company_boundary:'company_id',identity_is_authority:false,presentation_state_is_authority:false,authority_granted:false,execution_permitted:false,may_mutate_entities:false})});}
export function assertRevenueProjectionReplay(a,b){return Boolean(a&&b&&a.schema===REVENUE_JOURNEY_PROJECTION_SCHEMA&&b.schema===REVENUE_JOURNEY_PROJECTION_SCHEMA&&a.projection_id===b.projection_id&&a.company_id===b.company_id&&a.surface===b.surface);}

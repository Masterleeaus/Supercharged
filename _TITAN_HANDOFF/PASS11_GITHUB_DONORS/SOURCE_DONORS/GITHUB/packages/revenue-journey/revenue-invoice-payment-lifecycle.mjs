import crypto from 'node:crypto';
import { REVENUE_JOURNEY_CORRELATION_SCHEMA, bindRevenueJourneyEntity } from './revenue-journey-correlation.mjs';
export const REVENUE_INVOICE_PAYMENT_LIFECYCLE_SCHEMA='titan.zero.revenue-journey.invoice-payment-lifecycle.v1';
const LEGACY=['tenant_id','tenantId','tenant_company_id','business_id','account_id'];
const INVOICE_STATES=new Set(['draft','issued','partially_paid','paid','overdue','void','disputed']);
const PAYMENT_STATES=new Set(['pending','partial','settled','failed','refunded','partially_refunded','disputed','cancelled']);
const clean=v=>typeof v==='string'&&v.trim()?v.trim():null;
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function company(i){for(const k of LEGACY)if(i?.[k]!=null)throw new TypeError(`revenue-invoice-payment-legacy-company-boundary-forbidden:${k}`);const c=clean(i?.company_id);if(!c)throw new TypeError('revenue-invoice-payment-company-id-required');return c;}
function provenance(i){const producer=clean(i?.producer),source_event_id=clean(i?.source_event_id),observed_at=clean(i?.observed_at);if(!producer||!source_event_id||!observed_at)throw new TypeError('revenue-invoice-payment-provenance-required');return Object.freeze({producer,source_event_id,observed_at});}
function evidence(v){if(!Array.isArray(v)||!v.length)throw new TypeError('revenue-invoice-payment-evidence-required');return Object.freeze(v.map((x,n)=>{const r=clean(typeof x==='string'?x:x?.source_ref??x?.ref);if(!r)throw new TypeError(`revenue-invoice-payment-evidence-invalid:${n}`);return Object.freeze({source_ref:r,kind:typeof x==='object'?clean(x.kind):null});}));}
function corr(i,c){const r=i?.correlation;if(!r||r.schema!==REVENUE_JOURNEY_CORRELATION_SCHEMA)throw new TypeError('revenue-invoice-payment-valid-correlation-required');if(r.company_id!==c)throw new TypeError('revenue-invoice-payment-cross-company-correlation');return r;}
function bind(r,c,stage,id,p){const old=r.entities?.[`${stage}_id`];if(old&&old!==id)throw new TypeError(`revenue-invoice-payment-${stage}-id-conflict`);return old?r:bindRevenueJourneyEntity(r,{company_id:c,stage,entity_id:id,provenance:p});}
export function buildInvoicePaymentLifecycleObservation(input={}){
 const company_id=company(input),invoice_id=clean(input.invoice_id);if(!invoice_id)throw new TypeError('revenue-invoice-payment-invoice-id-required');
 const invoice_state=clean(input.invoice_state);if(!INVOICE_STATES.has(invoice_state))throw new TypeError('revenue-invoice-payment-invoice-state-invalid');
 const payment_id=clean(input.payment_id),payment_state=clean(input.payment_state);if(payment_id&&!PAYMENT_STATES.has(payment_state))throw new TypeError('revenue-invoice-payment-payment-state-invalid');if(!payment_id&&payment_state)throw new TypeError('revenue-invoice-payment-payment-id-required');
 const p=provenance(input.provenance),ev=evidence(input.evidence_refs??input.evidence);let correlation=corr(input,company_id);correlation=bind(correlation,company_id,'invoice',invoice_id,p);if(payment_id)correlation=bind(correlation,company_id,'payment',payment_id,p);
 if(clean(input.invoice_company_id)&&clean(input.invoice_company_id)!==company_id)throw new TypeError('revenue-invoice-payment-cross-company-invoice');if(clean(input.payment_company_id)&&clean(input.payment_company_id)!==company_id)throw new TypeError('revenue-invoice-payment-cross-company-payment');
 const amount_total=Number(input.amount_total??0),amount_paid=Number(input.amount_paid??0),amount_refunded=Number(input.amount_refunded??0);if([amount_total,amount_paid,amount_refunded].some(x=>!Number.isFinite(x)||x<0))throw new TypeError('revenue-invoice-payment-amount-invalid');if(amount_total&&amount_paid>amount_total)throw new TypeError('revenue-invoice-payment-paid-exceeds-total');if(amount_refunded>amount_paid)throw new TypeError('revenue-invoice-payment-refund-exceeds-paid');
 const outstanding=Math.max(0,amount_total-amount_paid+amount_refunded);const reconciliation_required=Boolean(payment_id)&&!['settled','cancelled'].includes(payment_state);const refund_review_required=['refunded','partially_refunded'].includes(payment_state);const failure_review_required=['failed','disputed'].includes(payment_state)||invoice_state==='disputed';
 const key=`revip:${hash([company_id,correlation.revenue_journey_id,invoice_id,payment_id??'-',invoice_state,payment_state??'-',String(amount_total),String(amount_paid),String(amount_refunded),p.source_event_id].join('\n')).slice(0,32)}`;
 return Object.freeze({schema:REVENUE_INVOICE_PAYMENT_LIFECYCLE_SCHEMA,company_id,revenue_journey_id:correlation.revenue_journey_id,invoice_id,payment_id,invoice_state,payment_state,amounts:Object.freeze({total:amount_total,paid:amount_paid,refunded:amount_refunded,outstanding}),correlation,idempotency_key:key,provenance:p,evidence:ev,review:Object.freeze({reconciliation_required,refund_review_required,failure_review_required}),semantics:Object.freeze({invoice_truth_owner:'Titan CRM revenue document authority',payment_truth_owner:'Titan CRM receivable/payment lifecycle pending dedicated Titan Pay master',invoice_creation_capability:'crm.invoice.create',payment_reconciliation_capability:'finance.payment.reconcile',payment_reconciliation_authority:'user_only',partial_payment_does_not_mean_settled:true,failed_payment_does_not_void_invoice:true,refund_state_does_not_execute_refund:true,invoice_paid_state_is_evidence_not_authority:true}),governance:Object.freeze({company_boundary:'company_id',owns_domain_truth:false,identity_is_authority:false,authority_granted:false,execution_permitted:false,may_move_money:false,may_refund:false,may_create_entities:false,may_mutate_entities:false})});
}
export function assertInvoicePaymentReplay(a,b){return Boolean(a&&b&&a.schema===REVENUE_INVOICE_PAYMENT_LIFECYCLE_SCHEMA&&b.schema===REVENUE_INVOICE_PAYMENT_LIFECYCLE_SCHEMA&&a.idempotency_key===b.idempotency_key&&a.company_id===b.company_id&&a.revenue_journey_id===b.revenue_journey_id);}


export function verifyInvoicePaymentOutcome(observation, input = {}) {
 if (!observation || observation.schema !== REVENUE_INVOICE_PAYMENT_LIFECYCLE_SCHEMA) throw new TypeError('revenue-invoice-payment-observation-required');
 const company_id = company(input);
 if (company_id !== observation.company_id) throw new TypeError('revenue-invoice-payment-cross-company-verification');
 if (input.provider_acknowledged === true && input.authoritative_reread !== true) throw new TypeError('revenue-invoice-payment-provider-ack-is-not-verification');
 if (input.authoritative_reread !== true) throw new TypeError('revenue-invoice-payment-authoritative-reread-required');
 const verified_evidence_refs = evidence(input.verified_evidence_refs);
 if (observation.payment_state !== 'settled') throw new TypeError('revenue-invoice-payment-settlement-not-observed');
 if (observation.amounts.paid < observation.amounts.total) throw new TypeError('revenue-invoice-payment-total-not-settled');
 const verified_at = clean(input.verified_at);
 if (!verified_at) throw new TypeError('revenue-invoice-payment-verification-time-required');
 return Object.freeze({
  schema: 'titan.zero.revenue-journey.invoice-payment-outcome.v1',
  company_id,
  revenue_journey_id: observation.revenue_journey_id,
  invoice_id: observation.invoice_id,
  payment_id: observation.payment_id,
  idempotency_key: `verified:${observation.idempotency_key}`,
  status: 'VERIFIED',
  verified_at,
  verified_evidence_refs,
  authoritative_reread: true,
  provider_acknowledged: input.provider_acknowledged === true,
  governance: Object.freeze({
   authority_granted: false,
   execution_permitted: false,
   may_move_money: false,
   owns_domain_truth: false,
  }),
 });
}

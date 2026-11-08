import test from 'node:test';
import assert from 'node:assert/strict';
import {planBookingConfirmationShadow,runBookingConfirmationShadow,BOOKING_SHADOW_SQL} from '../field/apps/web/lib/titan/desk-bridge/booking-shadow.mjs';
import {planEstimateFollowupShadow,runEstimateFollowupShadow,ESTIMATE_SHADOW_SQL} from '../field/apps/web/lib/titan/desk-bridge/estimate-shadow.mjs';
import {planInvoiceFollowupShadow,runInvoiceFollowupShadow,INVOICE_SHADOW_SQL} from '../field/apps/web/lib/titan/desk-bridge/invoice-shadow.mjs';
import {runRevenueShadowWorkflow,listRevenueShadowWorkflows} from '../field/apps/web/lib/titan/desk-bridge/shadow-router.mjs';
import {runShadowProjection,ShadowProjectionError,DAY,HOUR} from '../field/apps/web/lib/titan/desk-bridge/shadow-foundation.mjs';
const C='11111111-1111-4111-8111-111111111111';
const X='22222222-2222-4222-8222-222222222222';
const V='33333333-3333-4333-8333-333333333333';
const J='44444444-4444-4444-8444-444444444444';
const E='55555555-5555-4555-8555-555555555555';
const I='66666666-6666-4666-8666-666666666666';
const T=Date.parse('2026-11-02T12:00:00.000Z');
const iso=(time)=>new Date(time).toISOString();
const base=()=>({account_id:C,client_id:X,client_phone:'+61412345678',sms_consent:true,
  sms_consent_at:iso(T-30*DAY),sms_consent_source:'portal_opt_in'});
const booking=()=>({...base(),visit_id:V,job_id:J,visit_status:'scheduled',
  booking_created_at:iso(T-2*HOUR),scheduled_start:iso(T+2*DAY)});
const estimate=()=>({...base(),estimate_id:E,estimate_status:'sent',sent_at:iso(T-3*DAY-HOUR)});
const invoice=()=>({...base(),invoice_id:I,invoice_status:'overdue',total_cents:10000,
  paid_cents:2000,due_date:iso(T-8*DAY),job_id:J,job_status:'completed',invoice_kind:'final'});
const params={companyId:C,now:T};
const queryRows=(rows,spy)=>async(sql,params)=>{spy?.({sql,params});return rows;};

test('read-only booking SQL independently scopes jobs and clients by company',()=>{
  for(const clause of ['v.account_id = $1','j.account_id = v.account_id','c.account_id = v.account_id','LIMIT $2'])
    assert.ok(BOOKING_SHADOW_SQL.includes(clause));
});
test('read-only estimate SQL enforces sent status and company join',()=>{
  for(const clause of ["e.status = 'sent'",'c.account_id = e.account_id','e.account_id = $1'])assert.ok(ESTIMATE_SHADOW_SQL.includes(clause));
});
test('read-only invoice SQL scopes invoice/client/job joins and positive balance',()=>{
  for(const clause of ['i.account_id = $1','c.account_id = i.account_id','j.account_id = i.account_id','i.total_cents > i.paid_cents'])assert.ok(INVOICE_SHADOW_SQL.includes(clause));
});
test('booking projection: correct correlation, no PII, stable across retries',()=>{
  const a=planBookingConfirmationShadow(booking(),params),b=planBookingConfirmationShadow(booking(),params);
  assert.deepEqual(a,b);assert.equal(a.template_key,'booking_confirmation');
  assert.equal(a.resource.kind,'visit');assert.equal(a.company_id,C);
  assert.equal(a.requested_at,iso(T-2*HOUR));
  assert.equal(JSON.stringify(a).includes('+614'),false);
});
test('booking denies cancelled visits',()=>assert.throws(()=>planBookingConfirmationShadow({...booking(),visit_status:'cancelled'},params),/visit_not_scheduled/));
test('booking denies cross-company record',()=>assert.throws(()=>planBookingConfirmationShadow({...booking(),account_id:X},params),/company_mismatch/));
test('booking denies stale booking creation',()=>assert.throws(()=>planBookingConfirmationShadow({...booking(),booking_created_at:iso(T-21*HOUR)},params),/outside_eligibility_window/));
test('booking denies future booking-created time',()=>assert.throws(()=>planBookingConfirmationShadow({...booking(),booking_created_at:iso(T+1)},params),/outside_eligibility_window/));
test('booking denies past visit',()=>assert.throws(()=>planBookingConfirmationShadow({...booking(),scheduled_start:iso(T-1)},params),/visit_outside_booking_window/));
test('booking denies visit more than 30 days away',()=>assert.throws(()=>planBookingConfirmationShadow({...booking(),scheduled_start:iso(T+31*DAY)},params),/visit_outside_booking_window/));
test('booking rejects invalid and missing SMS consent',()=>{
 for(const o of [{sms_consent:false},{sms_consent_source:'sms_stop'},{sms_consent_at:null},{sms_consent_at:'not-a-date'},
   {sms_consent_at:iso(T+HOUR)},{client_phone:null}])assert.throws(()=>planBookingConfirmationShadow({...booking(),...o},params));
});
test('estimate projection uses stable due timestamp and includes no price or address',()=>{
  const p=planEstimateFollowupShadow(estimate(),params);
  assert.equal(p.requested_at,iso(T-HOUR));assert.equal(p.resource.kind,'estimate');
  assert.equal(JSON.stringify(p).includes('client_phone'),false);
});
test('estimate denies approved/declined and old followup window',()=>{
 assert.throws(()=>planEstimateFollowupShadow({...estimate(),estimate_status:'approved'},params),/estimate_not_sent/);
 assert.throws(()=>planEstimateFollowupShadow({...estimate(),sent_at:iso(T-4*DAY)},params),/outside_eligibility_window/);
});
test('invoice refuses unapproved billing date',()=>assert.throws(()=>planInvoiceFollowupShadow(invoice(),params),/billing_policy_approval_required/));
test('invoice shadow requires same-day explicitly approved billing date',()=>{
 const p=planInvoiceFollowupShadow(invoice(),{...params,approvedBillingDate:'2026-11-02'});
 assert.equal(p.template_key,'invoice_followup');assert.equal(p.resource.kind,'invoice');
 assert.equal(p.requested_at,'2026-11-02T00:00:00.000Z');
 assert.ok(!JSON.stringify(p).includes('10000'));
});
test('invoice denies not outstanding or fully paid',()=>{
 for(const o of [{invoice_status:'paid'},{paid_cents:10000},{paid_cents:10001},{paid_cents:-1},{total_cents:'10000'}])
   assert.throws(()=>planInvoiceFollowupShadow({...invoice(),...o},{...params,approvedBillingDate:'2026-11-02'}));
});
test('invoice honors deposit exception but refuses open whole-job invoice',()=>{
 assert.throws(()=>planInvoiceFollowupShadow({...invoice(),job_status:'in_progress'},{...params,approvedBillingDate:'2026-11-02'}),/invoice_job_not_complete/);
 const p=planInvoiceFollowupShadow({...invoice(),job_status:'in_progress',invoice_kind:'deposit'},
  {...params,approvedBillingDate:'2026-11-02'});assert.equal(p.template_key,'invoice_followup');
});
test('invoice fails closed when job state not verified',()=>assert.throws(()=>planInvoiceFollowupShadow({...invoice(),job_status:null},{...params,approvedBillingDate:'2026-11-02'}),/job_state_unverified/));
test('invoice rejects invalid approved calendar date and previous day',()=>{
 for(const date of ['2026-11-01','2026-11-31','02/11/2026'])
  assert.throws(()=>planInvoiceFollowupShadow(invoice(),{...params,approvedBillingDate:date}));
});
test('invoice refuses invoices whose due date is in the future',()=>assert.throws(()=>planInvoiceFollowupShadow({...invoice(),due_date:iso(T+DAY)},{...params,approvedBillingDate:'2026-11-02'}),/invoice_not_overdue/));
test('dry-run booking batch neither submits nor exposes recipient or source rows',async()=>{
 let called=0,seen;
 const result=await runBookingConfirmationShadow({...params,limit:2,dryRun:true,
  queryRows:queryRows([booking()],s=>seen=s),submitIntent:async()=>{called++}});
 assert.equal(called,0);assert.deepEqual(seen.params,[C,2]);assert.equal(result.eligible,1);
 assert.equal(result.events[0].delivery_status,'not_sent');assert.equal(JSON.stringify(result).includes('+614'),false);
});
test('estimate shadow requires valid Desk simulated receipt, not delivered',async()=>{
 const result=await runEstimateFollowupShadow({...params,dryRun:false,queryRows:queryRows([estimate()]),
  submitIntent:async(i)=>({schema:'titan.field-desk.communication-result.v1',source_event_id:i.event_id,
    company_id:i.company_id,correlation_id:i.correlation_id,status:'simulated',delivery_status:'not_sent'})});
 assert.equal(result.simulated,1);assert.equal(result.failed,0);
});
test('invalid Desk receipt counted as failed not successful',async()=>{
 const result=await runEstimateFollowupShadow({...params,dryRun:false,queryRows:queryRows([estimate()]),
  submitIntent:async(i)=>({source_event_id:i.event_id,delivery_status:'delivered'})});
 assert.equal(result.failed,1);assert.equal(result.simulated,0);
});
test('replay receives duplicate only with exact correlated receipt',async()=>{
 const result=await runBookingConfirmationShadow({...params,dryRun:false,queryRows:queryRows([booking()]),
  submitIntent:async(i)=>({schema:'titan.field-desk.communication-result.v1',source_event_id:i.event_id,
    company_id:i.company_id,correlation_id:i.correlation_id,status:'duplicate',delivery_status:'not_sent'})});
 assert.equal(result.duplicates,1);assert.equal(result.simulated,0);
});
test('queryRows failure propagates; cannot claim successful scan',async()=>{
 await assert.rejects(()=>runBookingConfirmationShadow({...params,queryRows:async()=>{throw new Error('unavailable')}}),/unavailable/);
});
test('bounded batch rejects large / malformed query results',async()=>{
 await assert.rejects(()=>runBookingConfirmationShadow({...params,limit:11,queryRows:queryRows([])}),/invalid_batch_limit/);
 await assert.rejects(()=>runBookingConfirmationShadow({...params,limit:1,queryRows:queryRows([booking(),booking()])}),/queue_query_invalid/);
});
test('job/client ids malformed: row never becomes eligible',async()=>{
 const result=await runBookingConfirmationShadow({...params,queryRows:queryRows([{...booking(),client_id:'wrong'}])});
 assert.equal(result.eligible,0);assert.equal(result.skipped,1);
});
test('workflow dispatcher allows exactly three revenue workflows',async()=>{
 assert.deepEqual(listRevenueShadowWorkflows(),['booking_confirmation','estimate_followup','invoice_followup']);
 await assert.rejects(()=>runRevenueShadowWorkflow('arbitrary',{...params}),/unsupported_workflow/);
});
test('wrong company in batch query is rejected per-row; no dispatch',async()=>{
 const result=await runBookingConfirmationShadow({...params,dryRun:false,queryRows:queryRows([{...booking(),account_id:X}]),submitIntent:async()=>{throw new Error('should not submit')}});
 assert.equal(result.skipped,1);assert.equal(result.failed,0);assert.equal(result.events[0].state,'skipped');
});
test('invoice job/money-sensitive workflow can be previewed without sending',async()=>{
 const result=await runInvoiceFollowupShadow({...params,approvedBillingDate:'2026-11-02',dryRun:true,
   queryRows:queryRows([invoice()])});
 assert.equal(result.eligible,1);assert.equal(result.simulated,0);
});

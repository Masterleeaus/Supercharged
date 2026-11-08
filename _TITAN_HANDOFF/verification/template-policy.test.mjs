import test from 'node:test';
import assert from 'node:assert/strict';
import {createCommunicationIntent,signBridgeRequest} from '../desk/server/integrations/titan-field/protocol.mjs';
import {approvedShadowTemplates,assertShadowTemplatePolicy} from '../desk/server/integrations/titan-field/template-policy.mjs';
import {receiveCommunicationIntent} from '../desk/server/integrations/titan-field/receiver.mjs';
const NOW=Date.parse('2026-11-02T12:00:00.000Z');
const SECRET='a'.repeat(48);
const intent=(overrides={})=>({...createCommunicationIntent({companyId:'company-A',eventId:'event-one',
 correlationId:'corr-one',channel:'sms',templateKey:'job_reminder',clientReference:'client-A',
 resourceKind:'visit',resourceReference:'visit-A',consentEvidenceReference:'consent-A',
 consentRecordedAt:new Date(NOW-10000).toISOString(),requestedAt:new Date(NOW).toISOString(),validationNow:NOW}),...overrides});
const sign=(value)=>{const body=Buffer.from(JSON.stringify(value)),timestamp=Math.floor(NOW/1000);
 return {body,headers:{'x-titan-bridge-timestamp':String(timestamp),
 'x-titan-bridge-signature':signBridgeRequest({rawBody:body,secret:SECRET,timestamp})}};
};
const ports=(hit)=>({async resolveCompany(company_id){hit.mapping++;return {company_id,desk_user_id:'mapped',active:true}},
 async verifyConsent(){hit.consent++;return true},async claimEvent(){hit.ledger++;return {state:'claimed'}},
 async recordResult(){hit.record++}});
test('Desk has explicit approved template catalogue',()=>assert.deepEqual(approvedShadowTemplates(),
 ['booking_confirmation','estimate_followup','invoice_followup','job_reminder','job_update']));
test('operational booking confirmation maps exclusively to visit SMS',()=>{
 const policy=assertShadowTemplatePolicy(intent({template_key:'booking_confirmation'}));
 assert.equal(policy.shadow_only,true);assert.equal(policy.kind,'operational');
});
test('unknown template forbidden even when protocol would parse',async()=>{
 const hit={mapping:0,consent:0,ledger:0,record:0};
 const outcome=await receiveCommunicationIntent(sign(intent({template_key:'freeform_spam'})),
  {secret:SECRET,now:NOW,ports:ports(hit)});
 assert.equal(outcome.status,422);assert.equal(outcome.body.error,'template_not_approved');
 assert.deepEqual(hit,{mapping:0,consent:0,ledger:0,record:0});
});
test('unapproved resource/channel pair denied before company lookup',async()=>{
 const hit={mapping:0,consent:0,ledger:0,record:0};
 for(const value of [intent({template_key:'invoice_followup'}),
  intent({template_key:'booking_confirmation',resource:{kind:'invoice',reference:'invoice-A'}}),
  intent({template_key:'job_update',channel:'email',resource:{kind:'job',reference:'job-A'}})]){
   const reply=await receiveCommunicationIntent(sign(value),{secret:SECRET,now:NOW,ports:ports(hit)});
   assert.equal(reply.status,422);assert.equal(reply.body.error,'template_resource_channel_mismatch');
 }
 assert.equal(hit.mapping,0);
});
test('valid invoice template still never dispatches a provider message',async()=>{
 const hit={mapping:0,consent:0,ledger:0,record:0};
 const reply=await receiveCommunicationIntent(sign(intent({template_key:'invoice_followup',resource:{kind:'invoice',reference:'invoice-A'}})),
  {secret:SECRET,now:NOW,ports:ports(hit)});
 assert.equal(reply.status,202);assert.equal(reply.body.delivery_status,'not_sent');
 assert.deepEqual(hit,{mapping:1,consent:1,ledger:1,record:1});
});

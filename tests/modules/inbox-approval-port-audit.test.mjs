import test from 'node:test';import assert from 'node:assert/strict';
import {createInboxApprovalPort} from '../../server/modules/inbox/approval-port.ts';
const A='11111111-1111-4111-8111-111111111111';
const canonical={id:'ap',action:'inbox.send_message',params:{bodySha256:'sha'},status:'approved'};
test('auditor re-reads a canonical approval before recording the committed event',async()=>{
 const events=[],p=createInboxApprovalPort({
 gateAction:async()=>({status:'pending',approval:{id:'ap'},decision:'route_to_human',policyId:null}),
 getApproval:async(company,id)=>{events.push(['read',company,id]);return canonical;},
 recordExecuted:async(company,row,actor)=>{events.push(['audit',company,row,actor]);}
 });
 await p.recordExecuted(A,{id:'ap',status:'approved',params:{},action:'inbox.send_message'},'staff-1');
 assert.deepEqual(events[0],['read',A,'ap']);
 assert.deepEqual(events[1],['audit',A,canonical,'staff-1']);
});
test('missing canonical approval suppresses all audit writes',async()=>{
 let writes=0;
 const p=createInboxApprovalPort({gateAction:async()=>({status:'pending',approval:{id:'ap'},decision:'route_to_human',policyId:null}),getApproval:async()=>null,recordExecuted:async()=>{writes++;}});
 await assert.rejects(p.recordExecuted(A,{id:'missing',status:'approved',params:{},action:'inbox.send_message'},null),/missing for audit/);
 assert.equal(writes,0);
});

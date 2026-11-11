import test from 'node:test';
import assert from 'node:assert/strict';
import {createInboxApprovalPort} from '../../server/modules/inbox/approval-port.ts';
const A='11111111-1111-4111-8111-111111111111';
const record={id:'ap-claim',action:'inbox.send_message',params:{messageId:'m',threadId:'t',bodySha256:'sha'},status:'approved'};
function setup(){const events=[];return{events,source:{
 gateAction:async()=>({status:'pending',approval:{id:record.id},decision:'route_to_human',policyId:null}),
 getApproval:async(company,id)=>{events.push(['read',company,id]);return {...record};},
 recordExecuted:async(company,row)=>{events.push(['audit',company,row.id]);}
}};}
test('conditional claim sees full canonical record before its SQL marker',async()=>{
 const s=setup(),port=createInboxApprovalPort(s.source);
 const claim=await port.markExecuted(A,record.id,null,{claimExecuted:async(company,id,at)=>{
  s.events.push(['claim',company,id]);assert.ok(at instanceof Date);return {id};
 }});
 assert.deepEqual(claim,record);
 assert.deepEqual(s.events.map(e=>e[0]),['read','claim']);
});
test('no successful SQL claim means no executable approval',async()=>{
 const s=setup(),port=createInboxApprovalPort(s.source);
 assert.equal(await port.markExecuted(A,record.id,null,{claimExecuted:async()=>null}),null);
 assert.deepEqual(s.events.map(e=>e[0]),['read']);
});
test('post-commit audit is separate from a conditional SQL claim',async()=>{
 const s=setup(),port=createInboxApprovalPort(s.source);
 const claim=await port.markExecuted(A,record.id,null,{claimExecuted:async()=>({id:record.id})});
 assert.equal(s.events.some(e=>e[0]==='audit'),false);
 await port.recordExecuted(A,claim,null);
 assert.deepEqual(s.events.map(e=>e[0]),['read','claim'].filter(x=>x==='read').concat(['read','audit']));
});

import test from 'node:test';import assert from 'node:assert/strict';
import {createInboxApprovalPort} from '../../server/modules/inbox/approval-port.ts';
const A='11111111-1111-4111-8111-111111111111';
test('canonical source is not permitted to bypass a SQL transaction',async()=>{
 let called=0;
 const src={gateAction:async()=>({status:'pending',approval:{id:'ap'},decision:'route_to_human',policyId:null}),
 getApproval:async()=>{called++;return{id:'ap',action:'inbox.send_message',params:{},status:'approved'};},
 recordExecuted:async()=>{}};
 const p=createInboxApprovalPort(src);
 await assert.rejects(p.markExecuted(A,'ap',null),/atomic PostgreSQL/);
 assert.equal(called,0);
});
test('a rejected approval cannot be conditionally claimed as approved',async()=>{
 const src={gateAction:async()=>({status:'rejected',approval:{id:'ap'},decision:'auto_deny',policyId:null}),
 getApproval:async()=>({id:'ap',action:'inbox.send_message',params:{},status:'rejected'}),
 recordExecuted:async()=>{}};
 let attempted=0;const p=createInboxApprovalPort(src);
 assert.equal(await p.markExecuted(A,'ap',null,{claimExecuted:async()=>{attempted++;return{id:'ap'};}}),null);
 assert.equal(attempted,0);
});

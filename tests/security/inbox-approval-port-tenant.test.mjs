import test from 'node:test';import assert from 'node:assert/strict';
import {createInboxApprovalPort} from '../../server/modules/inbox/approval-port.ts';
const A='11111111-1111-4111-8111-111111111111';
test('approval audit cannot change tenants using a forged approval object',async()=>{
 const calls=[],s={gateAction:async()=>({status:'pending',approval:{id:'id'},decision:'?',policyId:null}),getApproval:async(co,id)=>{calls.push([co,id]);return null;},recordExecuted:async()=>{throw Error('audit must not run')}};
 await assert.rejects(createInboxApprovalPort(s).recordExecuted(A,{id:'foreign',status:'approved',action:'inbox.send_message',params:{}},null),/missing for audit/);
 assert.deepEqual(calls,[[A,'foreign']]);
});

import test from 'node:test';import assert from 'node:assert/strict';
import {createInboxApprovalPort} from '../../server/modules/inbox/approval-port.ts';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
function src(row){const calls=[];return{calls,source:{
 gateAction:async req=>{calls.push(['gate',req.companyId]);return{status:'pending',approval:{id:'ap'},decision:'route_to_human',policyId:null};},
 getApproval:async(company,id)=>{calls.push(['read',company,id]);return company===A?row:null;},
 recordExecuted:async()=>{calls.push(['audit']);}
}};}
test('B cannot claim A approval even with matching id',async()=>{
 const {calls,source}=src({id:'ap',action:'inbox.send_message',params:{},status:'approved'});
 let claimed=false;const p=createInboxApprovalPort(source);
 assert.equal(await p.markExecuted(B,'ap',null,{claimExecuted:async()=>{claimed=true;return {id:'ap'};}}),null);
 assert.equal(claimed,false);assert.deepEqual(calls,[['read',B,'ap']]);
});
test('invalid approval record body is rejected before success is signalled',async()=>{
 const {source}=src({id:'ap',action:'inbox.send_message',params:null,status:'approved'});
 const p=createInboxApprovalPort(source);
 await assert.rejects(p.getApproval(A,'ap'),/incomplete/);
});
test('invalid company for gate cannot call canonical service',async()=>{
 const {calls,source}=src(null),p=createInboxApprovalPort(source);
 await assert.rejects(p.gateAction({companyId:'not-valid',params:{}}),/companyId/);
 assert.deepEqual(calls,[]);
});

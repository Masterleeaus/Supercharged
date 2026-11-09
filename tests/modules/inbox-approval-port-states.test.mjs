import test from 'node:test';import assert from 'node:assert/strict';
import {createInboxApprovalPort} from '../../server/modules/inbox/approval-port.ts';
const A='11111111-1111-4111-8111-111111111111';
for(const state of ['pending','rejected','expired']){
 test(state+' approvals cannot be claimed by a queued send',async()=>{
  let claimed=false;const s={gateAction:async()=>({status:state,approval:{id:'id'},decision:'route_to_human',policyId:null}),getApproval:async()=>({id:'id',action:'inbox.send_message',params:{},status:state}),recordExecuted:async()=>{}};
  const p=createInboxApprovalPort(s);
  assert.equal(await p.markExecuted(A,'id',null,{claimExecuted:async()=>{claimed=true;return{id:'id'}}}),null);
  assert.equal(claimed,false);
 });
}
test('unexpected approval state is refused at the adapter boundary',async()=>{
 const s={gateAction:async()=>({status:'unknown',approval:{id:'id'},decision:'?',policyId:null}),getApproval:async()=>null,recordExecuted:async()=>{}};
 const p=createInboxApprovalPort(s);
 await assert.rejects(p.gateAction({companyId:A}),/invalid state/);
});

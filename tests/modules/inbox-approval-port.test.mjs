import test from 'node:test';import assert from 'node:assert/strict';
import {createInboxApprovalPort} from '../../server/modules/inbox/approval-port.ts';
const A='11111111-1111-4111-8111-111111111111';
function source(){const calls=[],row={id:'ap-1',action:'inbox.send_message',params:{messageId:'m',threadId:'t',bodySha256:'hash'},status:'approved'};
 return{calls,row,gateAction:async request=>{calls.push(['gate',request.companyId]);return{status:'approved',approval:{id:row.id},decision:'auto_approve',policyId:'rule'};},getApproval:async co=>{calls.push(['read',co]);return row;},recordExecuted:async(co,view)=>{calls.push(['audit',co,view.id]);}};}
test('adapter passes canonical gate arguments with verified company',async()=>{const s=source(),p=createInboxApprovalPort(s);const v=await p.gateAction({companyId:A,requestedBy:null,agentId:'a',action:'inbox.send_message',params:{},context:{},urgency:'normal',ttlMs:60});assert.equal(v.approval.id,'ap-1');assert.deepEqual(s.calls[0],['gate',A]);});
test('adapter validates complete canonical approval records',async()=>{const s=source(),p=createInboxApprovalPort(s);assert.equal((await p.getApproval(A,'ap-1')).status,'approved');s.row.status='revoked';await assert.rejects(p.getApproval(A,'ap-1'),/unsupported approval/);});
test('approved claims use the pinned transaction once',async()=>{const s=source(),p=createInboxApprovalPort(s);const claims=[];const result=await p.markExecuted(A,'ap-1',null,{claimExecuted:async(co,id,at)=>{claims.push([co,id,at]);return{id};}});assert.equal(result.id,'ap-1');assert.equal(claims.length,1);assert.equal(claims[0][0],A);});
test('duplicate conditional claim returns null',async()=>{const p=createInboxApprovalPort(source());assert.equal(await p.markExecuted(A,'ap-1',null,{claimExecuted:async()=>null}),null);});
test('nontransactional approval execution is forbidden',async()=>{const p=createInboxApprovalPort(source());await assert.rejects(p.markExecuted(A,'ap-1',null),/atomic PostgreSQL/);});

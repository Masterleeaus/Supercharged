import test from 'node:test';import assert from 'node:assert/strict';
import {createInboxApprovalPort} from '../../server/modules/inbox/approval-port.ts';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const view={id:'a',status:'approved',action:'inbox.send_message',params:{bodySha256:'safe'}};
function src(){const calls=[];return{calls,gateAction:async()=>({status:'pending',approval:{id:'a'},decision:'route_to_human',policyId:null}),getApproval:async(company)=>{calls.push(company);return company===A?view:null;},recordExecuted:async()=>{}};}
test('cross-tenant approved claim never reaches transaction handler',async()=>{const s=src(),p=createInboxApprovalPort(s);let claimed=false;const result=await p.markExecuted(B,'a',null,{claimExecuted:async()=>{claimed=true;return{id:'a'};}});assert.equal(result,null);assert.equal(claimed,false);assert.deepEqual(s.calls,[B]);});
test('unknown and malformed company IDs cannot query the canonical approvals service',async()=>{const s=src(),p=createInboxApprovalPort(s);await assert.rejects(p.getApproval('invalid','a'),/companyId/);await assert.rejects(p.markExecuted('invalid','a',null,{claimExecuted:async()=>true}),/companyId/);assert.deepEqual(s.calls,[]);});
test('incomplete approval adapter fails closed during construction',()=>{assert.throws(()=>createInboxApprovalPort({}),/canonical approval/);});
test('audit receives the canonical record, not an incomplete tx marker',async()=>{const s=src(),events=[];s.recordExecuted=async(...args)=>events.push(args);const p=createInboxApprovalPort(s);await p.recordExecuted(A,{id:'a',action:'inbox.send_message',params:{},status:'approved'},null);assert.equal(events[0][1],view);});

import test from 'node:test';import assert from 'node:assert/strict';
import {registerVerifiedCommsRoutes} from '../../server/routes/core/verified-marketing-routes.ts';
import {fixture} from '../modules/inbox-schema-readiness.test.mjs';
const noop=(_req,_res,next)=>next(),guards={authenticate:noop,requireCompanyScope:noop,requireRole:()=>noop};
const canonical={gateAction:async()=>({status:'pending',approval:{id:'ap'},decision:'route_to_human',policyId:null}),getApproval:async()=>null,recordExecuted:async()=>{}};
test('both flags disabled never inspect the database',async()=>{
 const calls=[];const r=await registerVerifiedCommsRoutes({use:(...a)=>calls.push(a)},{...guards,pool:null,schemaProbe:null,env:{}});
 assert.deepEqual(r.mounted,[]);assert.deepEqual(calls,[]);
});
test('Inbox flag TRUE uppercase does not activate Inbox',async()=>{
 const calls=[];const r=await registerVerifiedCommsRoutes({use:(...a)=>calls.push(a)},{...guards,pool:null,schemaProbe:null,env:{COMMS_INBOX_ENABLED:'TRUE'}});
 assert.deepEqual(r.mounted,[]);assert.deepEqual(calls,[]);
});
test('a bad Marketing schema stops both routes before mounting',async()=>{
 const calls=[],pool={connect:async()=>{throw Error('no request')}};
 await assert.rejects(registerVerifiedCommsRoutes({use:(...a)=>calls.push(a)},{...guards,pool,schemaProbe:fixture(),approvalService:canonical,
 env:{COMMS_INBOX_ENABLED:'true',COMMS_MARKETING_ENABLED:'true'},chatbots:{findChatbot:async()=>null}}),/database security not ready/);
 assert.deepEqual(calls,[]);
});

import test from 'node:test';import assert from 'node:assert/strict';
import {registerVerifiedCommsRoutes} from '../../server/routes/core/verified-marketing-routes.ts';
import {fixture} from '../modules/inbox-schema-readiness.test.mjs';
const noop=(_req,_res,next)=>next(),guards={authenticate:noop,requireCompanyScope:noop,requireRole:()=>noop};
const pool={connect:async()=>{throw Error('not during construction')}};
const canonical={gateAction:async()=>({status:'pending',approval:{id:'ap'},decision:'route_to_human',policyId:null}),getApproval:async()=>null,recordExecuted:async()=>{}};
test('missing auth is rejected before inspecting policies or mounting routes',async()=>{
 let touched=false;const probe={query:async()=>{touched=true;throw Error('database touched')}},calls=[];
 await assert.rejects(registerVerifiedCommsRoutes({use:(...a)=>calls.push(a)},{...guards,authenticate:null,pool,schemaProbe:probe,approvalService:canonical,env:{COMMS_INBOX_ENABLED:'true'}}),/authentication/);
 assert.equal(touched,false);assert.deepEqual(calls,[]);
});
test('missing company middleware never exposes Inbox',async()=>{
 const calls=[];await assert.rejects(registerVerifiedCommsRoutes({use:(...a)=>calls.push(a)},{...guards,requireCompanyScope:null,pool,schemaProbe:fixture(),approvalService:canonical,env:{COMMS_INBOX_ENABLED:'true'}}),/company scope/);
 assert.deepEqual(calls,[]);
});

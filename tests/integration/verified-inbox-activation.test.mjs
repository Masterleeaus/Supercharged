import test from 'node:test';import assert from 'node:assert/strict';
import {registerVerifiedCommsRoutes} from '../../server/routes/core/verified-marketing-routes.ts';
import {fixture} from '../modules/inbox-schema-readiness.test.mjs';
const noop=(_req,_res,next)=>next(),guards={authenticate:noop,requireCompanyScope:noop,requireRole:()=>noop};
const canonical={gateAction:async()=>({status:'pending',approval:{id:'ap'},decision:'route_to_human',policyId:null}),getApproval:async()=>null,recordExecuted:async()=>{}};
const pool={connect:async()=>{throw Error('request needed')}};
function app(){const calls=[];return{calls,use:(...a)=>calls.push(a)};}
test('Inbox enabled with canonical approvals mounts the real durable service',async()=>{
 const a=app(),r=await registerVerifiedCommsRoutes(a,{...guards,pool,schemaProbe:fixture(),approvalService:canonical,env:{COMMS_INBOX_ENABLED:'true'}});
 assert.deepEqual(r.mounted,['inbox']);assert.equal(a.calls.length,1);
 assert.equal(a.calls[0][0],'/api/comms/inbox');
});
test('failed schema validation does not mount Inbox',async()=>{
 const a=app();await assert.rejects(registerVerifiedCommsRoutes(a,{...guards,pool,schemaProbe:{query:async()=>({rows:[]})},approvalService:canonical,env:{COMMS_INBOX_ENABLED:'true'}}),/database security not ready/);
 assert.deepEqual(a.calls,[]);
});

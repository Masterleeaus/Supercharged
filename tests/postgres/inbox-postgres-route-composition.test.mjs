import test from 'node:test';import assert from 'node:assert/strict';
import {enabled,fixture} from './inbox-postgres-support.mjs';
import {registerVerifiedCommsRoutes} from '../../server/routes/core/verified-marketing-routes.ts';
const noop=(_req,_res,next)=>next(),guards={authenticate:noop,requireCompanyScope:noop,requireRole:()=>noop};
test('PostgreSQL: verified Inbox route composition inspects live table security',{skip:!enabled},async()=>{
 const f=fixture(),calls=[];try{
  const canonical={gateAction:async()=>({status:'pending',approval:{id:'a'},decision:'route_to_human',policyId:null}),getApproval:async()=>null,recordExecuted:async()=>{}};
  const result=await registerVerifiedCommsRoutes({use:(...args)=>calls.push(args)},{...guards,pool:f.pool,schemaProbe:f.pool,approvalService:canonical,env:{COMMS_INBOX_ENABLED:'true'}});
  assert.deepEqual(result.mounted,['inbox']);assert.equal(calls.length,1);
 }finally{await f.close();}
});

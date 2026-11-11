import test from 'node:test';import assert from 'node:assert/strict';
import {registerVerifiedCommsRoutes} from '../../server/routes/core/verified-marketing-routes.ts';
const noop=(_req,_res,next)=>next(),guards={authenticate:noop,requireCompanyScope:noop,requireRole:()=>noop};
test('Inbox is not mounted by default even with an invalid database pool',async()=>{
 const calls=[];const r=await registerVerifiedCommsRoutes({use:(...a)=>calls.push(a)},{...guards,pool:{connect:async()=>{throw Error('unexpected')}},schemaProbe:null,env:{}});
 assert.deepEqual(r.mounted,[]);assert.deepEqual(calls,[]);
});
test('Marketing alone never initialises Inbox approval storage',async()=>{
 const calls=[];await assert.rejects(registerVerifiedCommsRoutes({use:(...a)=>calls.push(a)},{...guards,pool:null,schemaProbe:null,env:{COMMS_MARKETING_ENABLED:'true'}}),/PostgreSQL pool/);
 assert.deepEqual(calls,[]);
});

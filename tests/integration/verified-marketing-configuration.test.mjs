import test from 'node:test';
import assert from 'node:assert/strict';
import {registerVerifiedCommsRoutes} from '../../server/routes/core/verified-marketing-routes.ts';
const noop=(_req,_res,next)=>next();
const guards={authenticate:noop,requireCompanyScope:noop,requireRole:()=>noop};
test('exact flag true is required to enable Marketing',async()=>{
 for(const flag of ['TRUE','1','yes','false','']) {
  const calls=[];
  const result=await registerVerifiedCommsRoutes({use:(...args)=>calls.push(args)},{...guards,env:{COMMS_MARKETING_ENABLED:flag},pool:null,schemaProbe:null});
  assert.deepEqual(result.mounted,[]);assert.deepEqual(calls,[]);
 }
});
test('Inbox cannot turn on without a verified PostgreSQL pool',async()=>{
 const calls=[];
 await assert.rejects(registerVerifiedCommsRoutes({use:(...args)=>calls.push(args)},{...guards,env:{COMMS_INBOX_ENABLED:'true'},pool:null,schemaProbe:null}),/PostgreSQL pool/);
 assert.deepEqual(calls,[]);
});

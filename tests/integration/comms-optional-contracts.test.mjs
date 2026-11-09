import test from 'node:test';
import assert from 'node:assert/strict';
import { registerOptionalCommsRoutes } from '../../server/routes/core/optional-comms-routes.ts';
import { INBOX_OPERATIONS, MARKETING_OPERATIONS } from '../../server/modules/desk-modes/service-contracts.ts';
const noop=(_req,_res,next)=>next(),role=()=>noop;
const guards={authenticate:noop,requireCompanyScope:noop,requireRole:role};
const service=(methods)=>Object.fromEntries(methods.map(m=>[m,async()=>[]]));
test('an enabled inbox fails startup with an incomplete service',()=>{
 const mounted=[];
 assert.throws(()=>registerOptionalCommsRoutes({use:(...x)=>mounted.push(x)},{...guards,inbox:{listThreads:async()=>[]},env:{COMMS_INBOX_ENABLED:'true'}}),/missing operations/);
 assert.equal(mounted.length,0);
});
test('a complete service mounts the inbox route with guards',()=>{
 const mounted=[];
 const out=registerOptionalCommsRoutes({use:(...x)=>mounted.push(x)},{...guards,inbox:service(INBOX_OPERATIONS),env:{COMMS_INBOX_ENABLED:'true'}});
 assert.deepEqual(out.mounted,['inbox']);assert.equal(mounted.length,1);
 assert.equal(mounted[0][0],'/api/comms/inbox');
 assert.ok(mounted[0].length>=6);
});
test('a complete service mounts Marketing on its own API prefix',()=>{
 const mounted=[];
 const out=registerOptionalCommsRoutes({use:(...x)=>mounted.push(x)},{...guards,marketing:service(MARKETING_OPERATIONS),env:{COMMS_MARKETING_ENABLED:'true'}});
 assert.deepEqual(out.mounted,['marketing']);assert.equal(mounted[0][0],'/api/comms/marketing');
});
test('a partial two-module rollout cannot mount either router',()=>{
 const mounted=[];
 assert.throws(()=>registerOptionalCommsRoutes({use:(...x)=>mounted.push(x)},{...guards,inbox:service(INBOX_OPERATIONS),marketing:{listPages:async()=>[]},env:{COMMS_INBOX_ENABLED:'true',COMMS_MARKETING_ENABLED:'true'}}),/missing operations/);
 assert.equal(mounted.length,0);
});

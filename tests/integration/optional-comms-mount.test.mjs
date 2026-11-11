import test from 'node:test';
import assert from 'node:assert/strict';
import { registerOptionalCommsRoutes } from '../../server/routes/core/optional-comms-routes.ts';
import { INBOX_OPERATIONS, MARKETING_OPERATIONS } from '../../server/modules/desk-modes/service-contracts.ts';
const complete = ops => Object.fromEntries(ops.map(name=>[name,async()=>[]]));
const noop=(_req,_res,next)=>next(), role=()=>noop;
const guards={authenticate:noop,requireCompanyScope:noop,requireRole:role};
test('disabled flags mount no routers',()=>{const calls=[];const out=registerOptionalCommsRoutes({use:(...a)=>calls.push(a)},{...guards,env:{}});assert.deepEqual(out,{mounted:[],skipped:['inbox','marketing']});assert.equal(calls.length,0);});
test('enabling inbox without a service fails before mounting',()=>{const calls=[];assert.throws(()=>registerOptionalCommsRoutes({use:(...a)=>calls.push(a)},{...guards,env:{COMMS_INBOX_ENABLED:'true'}}),/InboxService/);assert.equal(calls.length,0);});
test('enabling marketing without a service fails before mounting',()=>{const calls=[];assert.throws(()=>registerOptionalCommsRoutes({use:(...a)=>calls.push(a)},{...guards,env:{COMMS_MARKETING_ENABLED:'true'}}),/MarketingService/);assert.equal(calls.length,0);});
test('partial dual rollout fails atomically',()=>{const calls=[];assert.throws(()=>registerOptionalCommsRoutes({use:(...a)=>calls.push(a)},{...guards,inbox:{},env:{COMMS_INBOX_ENABLED:'true',COMMS_MARKETING_ENABLED:'true'}}),/MarketingService/);assert.equal(calls.length,0);});
test('flags must exactly equal true',()=>{const out=registerOptionalCommsRoutes({use:()=>{throw Error('unexpected mount')}},{...guards,env:{COMMS_INBOX_ENABLED:'1',COMMS_MARKETING_ENABLED:'yes'}});assert.deepEqual(out.mounted,[]);});
test('missing auth guards fails closed',()=>{assert.throws(()=>registerOptionalCommsRoutes({use:()=>{}},{requireCompanyScope:noop,requireRole:role,env:{}}),/authentication/);});

test('a complete pair of dependencies mounts both surfaces',()=>{
 const calls=[];
 const report=registerOptionalCommsRoutes({use:(...x)=>calls.push(x)},{...guards,inbox:complete(INBOX_OPERATIONS),marketing:complete(MARKETING_OPERATIONS),env:{COMMS_INBOX_ENABLED:'true',COMMS_MARKETING_ENABLED:'true'}});
 assert.deepEqual(report.mounted,['inbox','marketing']);
 assert.deepEqual(calls.map(x=>x[0]),['/api/comms/inbox','/api/comms/marketing']);
});
test('a partially populated service fails before registering any route',()=>{
 const calls=[];
 assert.throws(()=>registerOptionalCommsRoutes({use:(...x)=>calls.push(x)},{...guards,inbox:{listThreads:async()=>[]},env:{COMMS_INBOX_ENABLED:'true'}}),/missing operations/);
 assert.deepEqual(calls,[]);
});

test('the existing synchronous router remains disabled by default as a compatibility entry point',()=>{
 const calls=[];
 const status=registerOptionalCommsRoutes({use:(...args)=>calls.push(args)},{...guards,env:{COMMS_MARKETING_ENABLED:'false'}});
 assert.deepEqual(status.mounted,[]);assert.deepEqual(calls,[]);
});

test('legacy synchronous mount still rejects absent Inbox service',()=>{
 const calls=[];assert.throws(()=>registerOptionalCommsRoutes({use:(...a)=>calls.push(a)},{...guards,env:{COMMS_INBOX_ENABLED:'true'}}),/durable InboxService/);assert.equal(calls.length,0);
});

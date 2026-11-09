import test from 'node:test';
import assert from 'node:assert/strict';
import { assertServiceContract, INBOX_OPERATIONS, MARKETING_OPERATIONS } from '../../server/modules/desk-modes/service-contracts.ts';
const stub=()=>Promise.resolve([]);
const serviceFor=(methods)=>Object.fromEntries(methods.map(method=>[method,stub]));
test('complete inbox service operation contract passes',()=>assert.doesNotThrow(()=>assertServiceContract('inbox',serviceFor(INBOX_OPERATIONS))));
test('complete marketing service operation contract passes',()=>assert.doesNotThrow(()=>assertServiceContract('marketing',serviceFor(MARKETING_OPERATIONS))));
test('inbox and marketing refuse missing required operations',()=>{
 for(const [name,methods] of [['inbox',INBOX_OPERATIONS],['marketing',MARKETING_OPERATIONS]]){
  for(const missing of methods){
   const service=serviceFor(methods);delete service[missing];
   assert.throws(()=>assertServiceContract(name,service),new RegExp('missing operations:.*'+missing));
  }
 }
});
test('truthy objects and inherited plain values do not satisfy the service contract',()=>{
 for(const value of [null,undefined,{},[],true,42,'service']) assert.throws(()=>assertServiceContract('inbox',value));
});

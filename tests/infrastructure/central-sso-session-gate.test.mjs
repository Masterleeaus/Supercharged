import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeskCentralSessionGate} from '../../server/infrastructure/central-sso/session-gate.ts';
const account={userId:'u-1',companyId:'00000000-0000-4000-8000-000000000001',role:'user',revision:1};
test('native Supercharged JWT issuer receives exact resolved local user and company',async()=>{
 const calls=[];
 const gate=createDeskCentralSessionGate({resolve:async()=>account,
 issueNativeToken:async(...args)=>{calls.push(args);return 'a'.repeat(65)}});
 assert.equal(await gate({verified:true}),'a'.repeat(65));
 assert.deepEqual(calls,[[account.userId,account.role,account.companyId]]);
});
test('denied account does not create native credentials',async()=>{
 let called=false;
 const gate=createDeskCentralSessionGate({resolve:async()=>null,
 issueNativeToken:async()=>{called=true;return 'a'.repeat(65)}});
 assert.equal(await gate({}),null);assert.equal(called,false);
});
test('invalid credentials and issuer errors fail closed',async()=>{
 for(const value of ['', 'bad token','a'.repeat(8193)]){
  const gate=createDeskCentralSessionGate({resolve:async()=>account,issueNativeToken:async()=>value});
  assert.equal(await gate({}),null);
 }
 const gate=createDeskCentralSessionGate({resolve:async()=>account,
 issueNativeToken:async()=>{throw Error('issuer unavailable')}});
 assert.equal(await gate({}),null);
});

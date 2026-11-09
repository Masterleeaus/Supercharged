import {describe,it,expect,vi} from 'vitest';
import {createDeskCentralSessionGate} from './session-gate';
const account={userId:'u-1',companyId:'00000000-0000-4000-8000-000000000001',role:'user',revision:1};
describe('Supercharged existing JWT handoff',()=>{
 it('issues only after live local account resolution',async()=>{
  const issueNativeToken=vi.fn(async()=> 'a'.repeat(65));
  const gate=createDeskCentralSessionGate({resolve:async()=>account,issueNativeToken});
  expect(await gate({verified:true})).toBe('a'.repeat(65));
  expect(issueNativeToken).toHaveBeenCalledWith(account.userId,account.role,account.companyId);
 });
 it('never issues on denied company or account',async()=>{
  const issueNativeToken=vi.fn(async()=> 'a'.repeat(65));
  const gate=createDeskCentralSessionGate({resolve:async()=>null,issueNativeToken});
  expect(await gate({})).toBeNull();
  expect(issueNativeToken).not.toHaveBeenCalled();
 });
 it('rejects invalid tokens and failed native session issuer',async()=>{
  for(const token of ['', 'bad token','a'.repeat(8193)]){
   const gate=createDeskCentralSessionGate({resolve:async()=>account,issueNativeToken:async()=>token});
   expect(await gate({})).toBeNull();
  }
  const gate=createDeskCentralSessionGate({resolve:async()=>account,
   issueNativeToken:async()=>{throw Error('signer down')}});
  expect(await gate({})).toBeNull();
 });
});

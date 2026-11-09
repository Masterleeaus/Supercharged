import test from 'node:test';
import assert from 'node:assert/strict';
import { commsScopeFromLocals } from '../../server/modules/desk-modes/express-comms-adapter.ts';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
test('trusted company comes exclusively from response locals',()=>{assert.deepEqual(commsScopeFromLocals({locals:{companyId:A,actor:{kind:'human',id:'u1'}},query:{companyId:B},body:{companyId:B},headers:{'x-company-id':B}}),{companyId:A,actor:{kind:'human',id:'u1'}});});
test('invalid locals fail even if the body looks valid',()=>{for(const locals of [undefined,{}, {companyId:'c1',actor:{kind:'human',id:'u'}},{companyId:A,actor:{kind:'human',id:'  '}},{companyId:A,actor:{kind:'system',id:'u'}}]) assert.equal(commsScopeFromLocals({locals,body:{companyId:A}}),null);});
test('trusted autonomy cannot be overridden from the body',()=>{assert.deepEqual(commsScopeFromLocals({locals:{companyId:A,actor:{kind:'agent',id:'a1',autonomy:'review'}},body:{autonomy:'full'}}),{companyId:A,actor:{kind:'agent',id:'a1',autonomy:'review'}});});

test('inherited tenant and actor locals do not confer authorization',()=>{
 const inherited=Object.create({companyId:A,actor:{kind:'human',id:'forged'}});
 assert.equal(commsScopeFromLocals({locals:inherited}),null);
 const ownCompany=Object.assign(Object.create({actor:{kind:'human',id:'forged'}}),{companyId:A});
 assert.equal(commsScopeFromLocals({locals:ownCompany}),null);
});
test('a body cannot supply a missing actor when company locals exist',()=>{
 assert.equal(commsScopeFromLocals({locals:{companyId:A},body:{actor:{kind:'human',id:'forged'}}}),null);
});

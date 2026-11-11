import test from 'node:test';
import assert from 'node:assert/strict';
import { commsScopeFromLocals } from '../../server/modules/desk-modes/express-comms-adapter.ts';
const A='11111111-1111-4111-8111-111111111111';
test('verified actor data is copied as a restricted field set',()=>{
 const user={kind:'human',id:'user-a',isAdmin:true,companyId:'injected'};
 const result=commsScopeFromLocals({locals:{companyId:A,actor:user}});
 assert.deepEqual(result,{companyId:A,actor:{kind:'human',id:'user-a'}});
 assert.equal('isAdmin' in result.actor,false);
});
test('agent autonomy uses only server locals, not body',()=>{
 const input={locals:{companyId:A,actor:{kind:'agent',id:'worker',autonomy:'review'}},body:{autonomy:'unlimited'}};
 assert.deepEqual(commsScopeFromLocals(input).actor,{kind:'agent',id:'worker',autonomy:'review'});
});
test('all malformed actor kinds fail scope extraction',()=>{
 for(const kind of ['system','service','administrator','bot',null,undefined]) assert.equal(commsScopeFromLocals({locals:{companyId:A,actor:{kind,id:'some-user'}}}),null);
});

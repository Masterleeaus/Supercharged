import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyOf, queryString } from '../../server/modules/desk-modes/comms-router.ts';
test('all supported tenant override fields are stripped without mutation',()=>{
  const original={companyId:'B',company_id:'B',tenantId:'B',tenant_id:'B',title:'hello',tags:['x']};
  const input={body:original};
  const clean=bodyOf(input);
  assert.deepEqual(clean,{title:'hello',tags:['x']});
  assert.equal(original.companyId,'B');
  assert.notEqual(clean,original);
});
test('arrays, scalars and prototype-shaped bodies do not set tenant identity',()=>{
  for(const input of [null,undefined,42,'B',[],new Date()]){
    const clean=bodyOf({body:input});
    assert.ok(!('companyId' in clean));
  }
});
test('queryString accepts only one non-empty string value',()=>{
  assert.equal(queryString({query:{status:'open'}},'status'),'open');
  assert.equal(queryString({query:{status:['open','closed']}},'status'),undefined);
  assert.equal(queryString({query:{status:''}},'status'),undefined);
});

test('query strings with only whitespace do not activate filters',()=>{
 assert.equal(queryString({query:{status:'   '}},'status'),undefined);
 assert.equal(queryString({query:{status:'open'}},'status'),'open');
});

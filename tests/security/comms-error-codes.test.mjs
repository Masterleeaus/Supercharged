import test from 'node:test';
import assert from 'node:assert/strict';
import { sendServiceError } from '../../server/modules/desk-modes/comms-router.ts';
function response() { return {statusCode:200,status(c){this.statusCode=c;return this;},json(body){this.body=body;}}; }
test('known domain errors retain actionable response status',()=>{
 const expected={invalid:400,not_found:404,forbidden:403,conflict:409,refused:422};
 for(const [code,status] of Object.entries(expected)){
  const res=response();sendServiceError(res,Object.assign(new Error('safe message'),{code}));
  assert.equal(res.statusCode,status);
  assert.deepEqual(res.body,{error:'safe message'});
 }
});
test('prototype keys and arbitrary exceptions never leak their message',()=>{
 for(const code of ['constructor','hasOwnProperty','toString','__proto__','stack']){
  const res=response();sendServiceError(res,Object.assign(new Error('private connection string'),{code}));
  assert.equal(res.statusCode,500);
  assert.deepEqual(res.body,{error:'internal_error'});
 }
});

test('inherited Object prototype error names never select an HTTP status',()=>{
 for(const code of ['valueOf','propertyIsEnumerable']){
  const res=response();sendServiceError(res,Object.assign(new Error('private'),{code}));
  assert.equal(res.statusCode,500);assert.deepEqual(res.body,{error:'internal_error'});
 }
});

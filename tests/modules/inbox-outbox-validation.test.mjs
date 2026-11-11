import test from 'node:test';import assert from 'node:assert/strict';
import {createSqlOutbox} from '../../server/modules/inbox/sql-outbox.ts';
const A='11111111-1111-4111-8111-111111111111';
function pool(){return{connect:async()=>{throw Error('should reject before connect')}};}
test('missing SQL pool fails at construction',()=>assert.throws(()=>createSqlOutbox(null),/PostgreSQL pool/));
test('invalid tenant refuses to query database',async()=>await assert.rejects(createSqlOutbox(pool()).claim('bad',1,120),/companyId/));
test('claim bounded by safe worker batch and lease TTL',async()=>{
 const r=createSqlOutbox(pool());
 for(const bad of [0,-1,101,1.5,NaN])await assert.rejects(r.claim(A,bad,120),/limit/);
 for(const bad of [0,4,3601])await assert.rejects(r.claim(A,1,bad),/leaseSeconds/);
});
test('enqueue cannot accept unlimited scan size',async()=>{
 const r=createSqlOutbox(pool());for(const bad of [0,-1,501,1.5])await assert.rejects(r.enqueueQueued(A,bad),/limit/);
});

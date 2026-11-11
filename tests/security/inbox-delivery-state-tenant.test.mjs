import test from 'node:test';import assert from 'node:assert/strict';
import {createSqlDeliveryStateReader} from '../../server/modules/inbox/sql-delivery-state.ts';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
test('tenant of caller cannot be replaced by an attacker-supplied message ID',async()=>{
 const calls=[],pool={async connect(){return{async query(sql,args){calls.push({sql,args});return{rows:[]}},release(){}};}};
 const reader=createSqlDeliveryStateReader(pool);
 await reader.getByMessage(A,B);const q=calls.find(x=>x.sql.includes('FROM public.inbox_delivery_state'));
 assert.deepEqual(q.args,[A,B]);assert.ok(!q.sql.includes(B));
});
test('invalid tenant is refused before any SQL query',async()=>{
 let calls=0;const pool={connect:async()=>{calls++;throw Error('no DB')}};
 await assert.rejects(createSqlDeliveryStateReader(pool).listRecent('invalid'),/companyId/);assert.equal(calls,0);
});

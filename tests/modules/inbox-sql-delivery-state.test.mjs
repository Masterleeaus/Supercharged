import test from 'node:test';import assert from 'node:assert/strict';
import {createSqlDeliveryStateReader} from '../../server/modules/inbox/sql-delivery-state.ts';
const A='11111111-1111-4111-8111-111111111111';
function db(rows=[]){const calls=[];return{calls,pool:{async connect(){return{async query(sql,args){calls.push({sql,args});return{rows:sql.includes('FROM public.inbox_delivery_state')?rows:[]}},release(){}}}}};}
test('message delivery lookup restricts both joined rows to the company',async()=>{
 const f=db(),reader=createSqlDeliveryStateReader(f.pool);
 assert.equal(await reader.getByMessage(A,'message'),null);
 const q=f.calls.find(x=>x.sql.includes('FROM public.inbox_delivery_state'));
 assert.deepEqual(q.args,[A,'message']);
 assert.match(q.sql,/o.company_id=s.company_id/);assert.match(q.sql,/s.company_id=\$1/);
});
test('recent delivery list is bounded, parameterized and tenant specific',async()=>{
 const f=db(),reader=createSqlDeliveryStateReader(f.pool);
 assert.deepEqual(await reader.listRecent(A,20),[]);
 const q=f.calls.find(x=>x.sql.includes('FROM public.inbox_delivery_state'));
 assert.deepEqual(q.args,[A,20]);assert.match(q.sql,/LIMIT \$2/);
});
test('out-of-range page size never touches the pool',async()=>{
 const f=db(),reader=createSqlDeliveryStateReader(f.pool);
 await assert.rejects(reader.listRecent(A,10000),/invalid limit/);assert.equal(f.calls.length,0);
});

import test from 'node:test';import assert from 'node:assert/strict';
import {createSqlDeliveryReceipts} from '../../server/modules/inbox/sql-delivery-receipts.ts';
const A='11111111-1111-4111-8111-111111111111';
const receipt={companyId:A,provider:'gateway',eventId:'event',providerId:'pid',outcome:'delivered',payloadSha256:'b'.repeat(64),providerEventAt:null};
test('receipt insertion updates projection atomically in a common SQL statement',async()=>{
 const queries=[],pool={async connect(){return {async query(sql,args){queries.push({sql,args});return{rows:sql.includes('WITH matched')?[{matching:1,inserted:1}]:[]}},release(){}}}};
 assert.equal(await createSqlDeliveryReceipts(pool).record(receipt),'recorded');
 const q=queries.find(x=>x.sql.includes('WITH matched'));
 assert.match(q.sql,/INSERT INTO public.inbox_delivery_state/);
 assert.match(q.sql,/FROM inserted WHERE true/);
 assert.match(q.sql,/ON CONFLICT\(company_id,outbox_id\) DO UPDATE/);
 assert.match(q.sql,/inbox_delivery_state.outcome<>'delivered'/);
 assert.deepEqual(q.args.slice(0,5),[A,'gateway','event','pid','delivered']);
});
test('unmatched provider references cannot project delivery',async()=>{
 const queries=[],pool={async connect(){return{async query(sql){queries.push(sql);return{rows:sql.includes('WITH matched')?[{matching:0,inserted:0}]:[]}},release(){}}}};
 assert.equal(await createSqlDeliveryReceipts(pool).record(receipt),'unmatched');
 assert.equal(queries.filter(q=>q.includes('INSERT INTO public.inbox_delivery_state')).length,1);
 assert.match(queries.find(q=>q.includes('WITH matched')),/FROM inserted WHERE true/);
});

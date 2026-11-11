import test from 'node:test';import assert from 'node:assert/strict';
import {createSqlDeliveryReceipts} from '../../server/modules/inbox/sql-delivery-receipts.ts';
const A='11111111-1111-4111-8111-111111111111';
const r={companyId:A,provider:'gateway',eventId:'one',providerId:'provider-a',outcome:'delivered',payloadSha256:'a'.repeat(64),providerEventAt:null};
function fixture(matching=1,inserted=1){const calls=[];const pool={connect:async()=>({query:async(sql,values)=>{calls.push({sql,values});return{rows:sql.includes('WITH matched')?[{matching,inserted}]:[]};},release(){}})};return{pool,calls};}
test('recorded receipt requires a matched tenant outbox and inserted event',async()=>{
 const f=fixture();assert.equal(await createSqlDeliveryReceipts(f.pool).record(r),'recorded');
 const q=f.calls.find(x=>x.sql.includes('WITH matched'));assert.deepEqual(q.values.slice(0,5),[A,'gateway','one','provider-a','delivered']);
 assert.match(q.sql,/company_id=\$1 AND provider_id=\$4 AND status='sent'/);
});
test('duplicate event ID is idempotent',async()=>assert.equal(await createSqlDeliveryReceipts(fixture(1,0).pool).record(r),'duplicate'));
test('unknown provider ID does not insert a receipt',async()=>assert.equal(await createSqlDeliveryReceipts(fixture(0,0).pool).record(r),'unmatched'));
test('foreign tenant is refused before querying a pool',async()=>{
 const f=fixture();await assert.rejects(createSqlDeliveryReceipts(f.pool).record({...r,companyId:'foreign'}),/companyId/);assert.equal(f.calls.length,0);
});

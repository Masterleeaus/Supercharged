import test from 'node:test';import assert from 'node:assert/strict';
import {createSqlOutbox} from '../../server/modules/inbox/sql-outbox.ts';
const A='11111111-1111-4111-8111-111111111111';
function fixture(){const calls=[];const pool={async connect(){return{async query(sql,values){calls.push({sql,values});return{rows:[]};},release(){}};}};return{pool,calls};}
test('queued reconciliation is conditional, deduped, and tenant-bound',async()=>{
 const f=fixture(),repo=createSqlOutbox(f.pool);
 assert.equal(await repo.enqueueQueued(A,10),0);
 const q=f.calls.find(x=>x.sql.includes('INSERT INTO public.inbox_outbox'));
 assert.deepEqual(q.values,[A,10]);assert.match(q.sql,/ON CONFLICT\(company_id,message_id\) DO NOTHING/);
 assert.match(q.sql,/m.status='queued'/);
});
test('claim locks individual due rows using SKIP LOCKED',async()=>{
 const f=fixture();await createSqlOutbox(f.pool).claim(A,10,120);
 const q=f.calls.find(x=>x.sql.includes('WITH selected'));
 assert.match(q.sql,/SKIP LOCKED/);assert.match(q.sql,/lease_token=\$3::uuid/);
 assert.equal(q.values[0],A);assert.equal(q.values[1],10);
});
test('lease acknowledgment always requires company, job and token',async()=>{
 const f=fixture();await createSqlOutbox(f.pool).markSent(A,'00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','provider');
 const q=f.calls.find(x=>x.sql.includes("SET status='sent'"));
 assert.deepEqual(q.values.slice(0,3),[A,'00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002']);
 assert.match(q.sql,/lease_token=\$3::uuid AND status='leased'/);
});

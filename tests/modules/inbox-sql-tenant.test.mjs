import test from 'node:test';
import assert from 'node:assert/strict';
import {createSqlInboxStore} from '../../server/modules/inbox/sql-store.ts';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
function db(){const seen=[];let releases=0;return {seen,get releases(){return releases},pool:{async connect(){return {async query(sql,values){seen.push({sql,values});return{rows:[]}},release(){releases++}};}}};}
test('each tenant read uses its own transaction-local database setting',async()=>{
 const h=db(),s=createSqlInboxStore(h.pool);
 await s.findThread(A,'t');await s.findThread(B,'t');
 assert.deepEqual(h.seen.filter(x=>x.sql.includes('set_config')).map(x=>x.values[1]),[A,B]);
 assert.equal(h.releases,2);
});
test('cross-tenant message ID cannot select without company equality',async()=>{
 const h=db(),s=createSqlInboxStore(h.pool);
 await s.findMessage(A,'a-message-owned-by-b');
 const q=h.seen.find(x=>x.sql.includes('FROM inbox_messages'));
 assert.match(q.sql,/company_id=\$1 AND id=\$2/);assert.deepEqual(q.values,[A,'a-message-owned-by-b']);
});
test('missing company fails before pool acquisition',()=>{
 const h=db(),s=createSqlInboxStore(h.pool);
 assert.throws(()=>s.listThreads('bad',{}),/companyId/);
 assert.deepEqual(h.seen,[]);
});

test('a company change installs a distinct scoped database setting',async()=>{
 const h=db(),s=createSqlInboxStore(h.pool);
 await s.findThread(A,'first');await s.findThread(B,'other');await s.findThread(A,'again');
 assert.deepEqual(h.seen.filter(q=>q.sql.includes('set_config')).map(q=>q.values[1]),[A,B,A]);
 assert.equal(h.releases,3);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createSqlInboxStore} from '../../server/modules/inbox/sql-store.ts';
const A='11111111-1111-4111-8111-111111111111';
function harness(){const seen=[];let releases=0;return {seen,get releases(){return releases;},pool:{async connect(){return {query:async(sql,values)=>{seen.push({sql,values});return{rows:[]};},release(){releases++}};}}};}
test('all entity find methods include the company in their query',async()=>{
 const h=harness(),s=createSqlInboxStore(h.pool);
 await s.findThread(A,'thread');await s.findMessage(A,'message');
 await s.findContactParticipant(A,'email','someone@example.com');
 await s.findMessageByExternalId(A,'email','id-from-provider');
 for(const q of h.seen.filter(x=>x.sql.startsWith('SELECT id')))assert.match(q.sql,/company_id\s*=\s*\$1/);
 assert.equal(h.releases,4);
});
test('thread and message list filters are parameterised',async()=>{
 const h=harness(),s=createSqlInboxStore(h.pool);
 await s.listThreads(A,{status:'open',assigneeId:"' OR true --"});
 await s.listMessages(A,"x' OR true --");
 const lists=h.seen.filter(x=>x.sql.startsWith('SELECT id'));
 assert.deepEqual(lists[0].values,[A,'open',"' OR true --"]);
 assert.deepEqual(lists[1].values,[A,"x' OR true --"]);
 assert.ok(!lists.some(x=>x.sql.includes('OR true --')));
});
test('invalid company IDs never acquire a connection',()=>{
 const h=harness(),s=createSqlInboxStore(h.pool);
 assert.throws(()=>s.findThread('bad','x'),/companyId/);
 assert.deepEqual(h.seen,[]);assert.equal(h.releases,0);
});

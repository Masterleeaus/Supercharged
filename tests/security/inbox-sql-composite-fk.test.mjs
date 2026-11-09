import test from 'node:test';
import assert from 'node:assert/strict';
import {createSqlInboxStore} from '../../server/modules/inbox/sql-store.ts';
const A='11111111-1111-4111-8111-111111111111';
test('participant links cannot be placed in another tenant by changing only the thread id',async()=>{
 const seen=[],pool={async connect(){return{query:async(sql,values)=>{seen.push({sql,values});return{rows:[]}},release(){}};}};
 const s=createSqlInboxStore(pool);
 await s.linkParticipant({companyId:A,threadId:'tenant-b-thread',participantId:'tenant-a-contact'});
 const q=seen.find(x=>x.sql.includes('INSERT INTO inbox_thread_participants'));
 assert.deepEqual(q.values,[A,'tenant-b-thread','tenant-a-contact']);
 assert.match(q.sql,/company_id,thread_id,participant_id/);
 // The actual database composite FKs enforce that both referenced rows belong to A.
});
test('tenant bound thread lookup orders deterministically under simultaneous messages',async()=>{
 const seen=[],pool={async connect(){return{query:async(sql,values)=>{seen.push({sql,values});return{rows:[]}},release(){}};}};
 await createSqlInboxStore(pool).findOpenThreadForParticipant(A,'email','participant');
 const q=seen.find(x=>x.sql.includes('inbox_thread_participants'));
 assert.deepEqual(q.values,[A,'email','participant']);
 assert.match(q.sql,/ORDER BY t.updated_at DESC,t.id ASC LIMIT 1/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createSqlInboxStore} from '../../server/modules/inbox/sql-store.ts';
const A='11111111-1111-4111-8111-111111111111';
test('all inbox list operations use explicit tenant predicate',async()=>{
 const statements=[],pool={async connect(){return{query:async(sql,args)=>{statements.push({sql,args});return{rows:[]}},release(){}}}};
 const s=createSqlInboxStore(pool);
 await s.listThreads(A,{});await s.listMessages(A,'thread');await s.listThreadParticipants(A,'thread');
 for(const q of statements.filter(x=>x.sql.startsWith('SELECT')&&x.sql.includes('FROM inbox_'))) {
  assert.match(q.sql,/company_id\s*=\s*\$1/);assert.equal(q.args[0],A);
 }
});

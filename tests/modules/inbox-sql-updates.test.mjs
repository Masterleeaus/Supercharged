import test from 'node:test';
import assert from 'node:assert/strict';
import {createSqlInboxStore} from '../../server/modules/inbox/sql-store.ts';
const A='11111111-1111-4111-8111-111111111111';
test('thread updates cannot change company or id',async()=>{
 const seen=[],pool={async connect(){return{query:async(sql,args)=>{seen.push({sql,args});return{rows:[]}},release(){}}}};
 await createSqlInboxStore(pool).updateThread(A,'thread',{status:'closed',updatedAt:new Date()});
 const q=seen.find(x=>x.sql.startsWith('UPDATE inbox_threads'));
 assert.match(q.sql,/WHERE company_id = \$1 AND id = \$2/);
 assert.deepEqual(q.args.slice(0,2),[A,'thread']);
});
test('message approval update is scoped and uses bound parameters',async()=>{
 const seen=[],pool={async connect(){return{query:async(sql,args)=>{seen.push({sql,args});return{rows:[]}},release(){}}}};
 await createSqlInboxStore(pool).updateMessage(A,'message',{status:'awaiting_approval',approvalId:'approval'});
 const q=seen.find(x=>x.sql.startsWith('UPDATE inbox_messages'));
 assert.match(q.sql,/company_id = \$1 AND id = \$2/);
 assert.ok(!q.sql.includes('approvalId'));assert.deepEqual(q.args.slice(0,2),[A,'message']);
});

test('bound transaction runner cannot update another tenant thread',async()=>{
 const {createInboxSqlTransactionRunner}=await import('../../server/modules/inbox/sql-transaction-runner.ts');
 const B='22222222-2222-4222-8222-222222222222',seen=[];
 const pool={async connect(){return{query:async sql=>{seen.push(sql);return{rows:[]}},release(){}};}};
 await assert.rejects(createInboxSqlTransactionRunner(pool,A).runInTransaction(tx=>tx.updateThread(B,'foreign',{status:'closed'})),/different company/);
 assert.ok(seen.includes('ROLLBACK'));assert.ok(!seen.some(sql=>sql.startsWith('UPDATE inbox_threads')));
});

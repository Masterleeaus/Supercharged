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

test('tenant thread list filter is parameterised without leaking company context',async()=>{
 const statements=[],pool={async connect(){return{query:async(sql,args)=>{statements.push({sql,args});return{rows:[]};},release(){}};}};
 await createSqlInboxStore(pool).listThreads(A,{status:'open',assigneeId:"a' OR true --"});
 const q=statements.find(x=>x.sql.includes('FROM inbox_threads'));
 assert.equal(q.args[0],A);assert.equal(q.args[2],"a' OR true --");
 assert.ok(!q.sql.includes("OR true --"));
});

test('runtime schema verifier requires all four tenant-owned Inbox tables',async()=>{
 const {verifyInboxSchema,INBOX_TABLES}=await import('../../server/modules/inbox/schema-readiness.ts');
 const inspected=[];const probe={async query(sql,values){if(Array.isArray(values?.[0]))inspected.push(...values[0]);return{rows:[]};}};
 const result=await verifyInboxSchema(probe);
 assert.equal(result.ready,false);assert.ok(INBOX_TABLES.every(t=>result.issues.includes(t+' missing')));
 assert.ok(INBOX_TABLES.every(t=>inspected.includes(t)));
});

test('cross-company claim attempt fails before any UPDATE approvals SQL runs',async()=>{
 const {createInboxSqlTransactionRunner}=await import('../../server/modules/inbox/sql-transaction-runner.ts');
 const B='22222222-2222-4222-8222-222222222222',queries=[];
 const pool={async connect(){return{query:async sql=>{queries.push(sql);return{rows:[]}},release(){}};}};
 await assert.rejects(createInboxSqlTransactionRunner(pool,A).runInTransaction(tx=>tx.markApprovalExecuted(B,'approval')),/different company/);
 assert.ok(!queries.some(sql=>sql.startsWith('UPDATE approvals')));
 assert.ok(queries.includes('ROLLBACK'));
});

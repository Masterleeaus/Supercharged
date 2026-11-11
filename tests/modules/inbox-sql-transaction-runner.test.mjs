import test from 'node:test';import assert from 'node:assert/strict';
import {createInboxSqlTransactionRunner,inboxTransactionsFor} from '../../server/modules/inbox/sql-transaction-runner.ts';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
function harness(){const calls=[];let releases=0;const pool={async connect(){return{async query(sql,args){calls.push({sql,args});return{rows:[]}},release(){releases++}};}};return{pool,calls,get releases(){return releases}};}
test('factory requires actual tenant pool and UUID',()=>{
 assert.throws(()=>inboxTransactionsFor(null),/pool/);const h=harness();
 assert.throws(()=>createInboxSqlTransactionRunner(h.pool,'bad'),/companyId/);
});
test('each invocation binds company, uses a single transaction and releases it',async()=>{
 const h=harness(),forCompany=inboxTransactionsFor(h.pool);
 await forCompany(A).runInTransaction(async tx=>{assert.equal(await tx.markApprovalExecuted(A,'approved'),false);});
 await forCompany(B).runInTransaction(async tx=>{assert.equal(await tx.markApprovalExecuted(B,'approved'),false);});
 assert.deepEqual(h.calls.filter(x=>x.sql.includes('set_config')).map(x=>x.args[1]),[A,B]);
 assert.deepEqual(h.calls.filter(x=>x.sql.startsWith('UPDATE approvals')).map(x=>x.args[0]),[A,B]);
 assert.equal(h.releases,2);
});
test('cannot reuse a bound transaction handle for another company',async()=>{
 const h=harness();await assert.rejects(createInboxSqlTransactionRunner(h.pool,A).runInTransaction(tx=>tx.markApprovalExecuted(B,'foreign')),/different company/);
 assert.ok(h.calls.some(x=>x.sql==='ROLLBACK'));assert.equal(h.releases,1);
});
test('a failed callback rolls back without committing',async()=>{
 const h=harness();await assert.rejects(createInboxSqlTransactionRunner(h.pool,A).runInTransaction(async()=>{throw Error('write failed')}),/write failed/);
 assert.ok(h.calls.some(x=>x.sql==='ROLLBACK'));assert.equal(h.calls.filter(x=>x.sql==='COMMIT').length,0);assert.equal(h.releases,1);
});

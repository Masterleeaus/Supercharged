import test from 'node:test';import assert from 'node:assert/strict';
import {inboxTransactionsFor} from '../../server/modules/inbox/sql-transaction-runner.ts';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
function db(){const calls=[];const pool={async connect(){return{async query(sql,values){calls.push({sql,values});return{rows:[]}},release(){}};}};return{calls,pool};}
test('concurrent company requests cannot overwrite each other tenant context',async()=>{
 const h=db(),forCompany=inboxTransactionsFor(h.pool);
 await Promise.all([
  forCompany(A).runInTransaction(tx=>tx.updateMessage(A,'message-a',{status:'queued'})),
  forCompany(B).runInTransaction(tx=>tx.updateMessage(B,'message-b',{status:'queued'})),
 ]);
 const rows=h.calls.filter(x=>x.sql.startsWith('UPDATE inbox_messages'));
 assert.deepEqual(rows.map(x=>x.values.slice(0,2)).sort(),[[A,'message-a'],[B,'message-b']].sort());
});
test('runner rejects invalid company before taking a pool client',()=>{
 const h=db(),make=inboxTransactionsFor(h.pool);
 assert.throws(()=>make('not-uuid'),/companyId/);
 assert.equal(h.calls.length,0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createSqlInboxStore} from '../../server/modules/inbox/sql-store.ts';
const A='11111111-1111-4111-8111-111111111111';
test('store requires a PostgreSQL-compatible connection pool',()=>{
 for(const pool of [null,undefined,{}])assert.throws(()=>createSqlInboxStore(pool),/PostgreSQL pool/);
});
test('read-only transaction releases a connection',async()=>{
 let releases=0;const seen=[],pool={async connect(){return{query:async sql=>{seen.push(sql);return{rows:[]}},release(){releases++}}}};
 await createSqlInboxStore(pool).listMessages(A,'t');
 assert.equal(releases,1);assert.ok(seen.includes('COMMIT'));
});

test('failed database work rolls back and releases a checked-out client',async()=>{
 const commands=[];let releases=0;
 const pool={async connect(){return{async query(sql){commands.push(sql);if(sql.startsWith('SELECT id,'))throw Error('db failure');return {rows:[]};},release(){releases++;}};}};
 await assert.rejects(createSqlInboxStore(pool).findMessage(A,'broken'),/db failure/);
 assert.ok(commands.includes('ROLLBACK'));assert.equal(releases,1);
});

test('company-bound approval transaction runner checks out one connection',async()=>{
 const {inboxTransactionsFor}=await import('../../server/modules/inbox/sql-transaction-runner.ts');
 let connected=0,released=0;
 const pool={async connect(){connected++;return{query:async()=>({rows:[]}),release(){released++;}};}};
 await inboxTransactionsFor(pool)(A).runInTransaction(async()=>null);
 assert.equal(connected,1);assert.equal(released,1);
});

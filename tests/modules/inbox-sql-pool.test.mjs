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

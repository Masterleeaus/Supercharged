import test from 'node:test';
import assert from 'node:assert/strict';
import {createSqlMarketingStore} from '../../server/modules/marketing/sql-store.ts';
const A='11111111-1111-4111-8111-111111111111';
test('a SQL error triggers rollback and never COMMIT',async()=>{
 const seen=[];let released=0;
 const pool={async connect(){return{async query(sql){seen.push(sql);if(sql.startsWith('SELECT id')) throw new Error('DB unavailable');return {rows:[]};},release(){released++;}};}};
 await assert.rejects(createSqlMarketingStore({pool}).findPage(A,'p'),/DB unavailable/);
 assert.ok(seen.includes('ROLLBACK'));assert.ok(!seen.includes('COMMIT'));assert.equal(released,1);
});
test('creation refuses missing tenant-capable pool',()=>{
 for(const pool of [null,undefined,{}]) assert.throws(()=>createSqlMarketingStore({pool}),/PostgreSQL pool/);
});

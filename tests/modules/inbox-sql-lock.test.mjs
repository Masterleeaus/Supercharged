import test from 'node:test';
import assert from 'node:assert/strict';
import {runInboundLocked,lockedInboxClient} from '../../server/modules/inbox/sql-lock.ts';
const A='11111111-1111-4111-8111-111111111111';
test('advisory lock and nested callback share one company transaction',async()=>{
 const calls=[];let releases=0;const pool={async connect(){return{query:async(sql,args)=>{calls.push({sql,args});return{rows:[]}},release(){releases++}};}};
 let inside=null;
 await runInboundLocked(pool,A,'email','a@example.com',async()=>{inside=lockedInboxClient();assert.ok(inside);await inside.query('SELECT 1');});
 assert.equal(calls.filter(x=>x.sql.startsWith('SELECT pg_advisory')).length,1);
 assert.equal(calls.filter(x=>x.sql==='COMMIT').length,1);assert.equal(releases,1);
 assert.equal(lockedInboxClient(),undefined);
});
test('callback errors roll back and release lock',async()=>{
 const calls=[];const pool={async connect(){return{query:async(sql)=>{calls.push(sql);return{rows:[]}},release(){}};}};
 await assert.rejects(runInboundLocked(pool,A,'sms','+1111',async()=>{throw Error('fail')}),/fail/);
 assert.ok(calls.includes('ROLLBACK'));assert.ok(!calls.includes('COMMIT'));
});

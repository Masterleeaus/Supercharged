import test from 'node:test';
import assert from 'node:assert/strict';
import {createSqlInboxStore} from '../../server/modules/inbox/sql-store.ts';
const A='11111111-1111-4111-8111-111111111111';
test('provider external ID lookup is scoped to tenant and channel',async()=>{
 const seen=[];const pool={async connect(){return{query:async(sql,values)=>{seen.push({sql,values});return{rows:[]}},release(){}}}};
 await createSqlInboxStore(pool).findMessageByExternalId(A,'email','provider-123');
 const q=seen.find(x=>x.sql.includes('external_id=$3'));
 assert.deepEqual(q.values,[A,'email','provider-123']);assert.match(q.sql,/company_id=\$1/);
});
test('inbound lock rejects absent company without querying database',()=>{
 const seen=[],pool={async connect(){seen.push('connect');throw Error('unexpected')}};
 assert.rejects(createSqlInboxStore(pool).lockInboundKey('bad','email','x',async()=>1),/companyId/);
 assert.deepEqual(seen,[]);
});

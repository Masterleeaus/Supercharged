import test from 'node:test';
import assert from 'node:assert/strict';
import {createSqlInboxStore} from '../../server/modules/inbox/sql-store.ts';
const A='11111111-1111-4111-8111-111111111111';
test('message and participant lookup never interpolate attacker strings',async()=>{
 const queries=[],pool={async connect(){return{query:async(sql,args)=>{queries.push({sql,args});return{rows:[]}},release(){}}}};
 const s=createSqlInboxStore(pool),payload="' OR true --";
 await s.findContactParticipant(A,'email',payload);await s.findMessageByExternalId(A,'sms',payload);
 for(const q of queries.filter(q=>q.sql.includes('FROM inbox_'))){assert.ok(!q.sql.includes(payload));assert.equal(q.args.at(-1),payload);}
});

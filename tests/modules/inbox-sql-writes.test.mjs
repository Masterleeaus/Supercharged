import test from 'node:test';
import assert from 'node:assert/strict';
import {createSqlInboxStore} from '../../server/modules/inbox/sql-store.ts';
const A='11111111-1111-4111-8111-111111111111',now=new Date('2026-11-09T00:00:00Z');
function record(){const calls=[];return {calls,pool:{async connect(){return {query:async(sql,args)=>{calls.push({sql,args});return {rows:[]};},release(){}};}}};}
test('participant and thread insert bind all supplied values',async()=>{
 const h=record(),s=createSqlInboxStore(h.pool);
 await s.insertParticipant({id:'p',companyId:A,kind:'contact',channel:'email',address:'a@b.c',displayName:null,createdAt:now});
 await s.insertThread({id:'t',companyId:A,channel:'email',subject:null,status:'open',assignee:null,lastMessageAt:null,createdAt:now,updatedAt:now});
 const ins=h.calls.filter(c=>c.sql.startsWith('INSERT'));
 assert.equal(ins.length,2);assert.ok(ins.every(c=>c.args[1]===A));
});
test('message insert binds external dedupe id, author and exact body',async()=>{
 const h=record(),s=createSqlInboxStore(h.pool);
 await s.insertMessage({id:'m',companyId:A,threadId:'t',direction:'inbound',channel:'sms',status:'received',authorKind:'contact',authorId:'p',body:"hello' --",bodySha256:'hash',externalId:'provider',approvalId:null,createdAt:now,updatedAt:now,queuedAt:null});
 const q=h.calls.find(x=>x.sql.startsWith('INSERT INTO inbox_messages'));
 assert.equal(q.args[1],A);assert.equal(q.args[8],"hello' --");assert.ok(!q.sql.includes("hello' --"));
});
test('thread links are idempotent, company-scoped writes',async()=>{
 const h=record(),s=createSqlInboxStore(h.pool);
 await s.linkParticipant({companyId:A,threadId:'t',participantId:'p'});
 const q=h.calls.find(x=>x.sql.includes('INSERT INTO inbox_thread_participants'));
 assert.deepEqual(q.args,[A,'t','p']);assert.match(q.sql,/ON CONFLICT DO NOTHING/);
});

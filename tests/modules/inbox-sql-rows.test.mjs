import test from 'node:test';
import assert from 'node:assert/strict';
import {fromParticipant,fromThread,fromMessage,fromLink} from '../../server/modules/inbox/sql-rows.ts';
const now=new Date('2026-11-09T00:00:00Z');
test('participant row retains its company and contact channel',()=>{const p=fromParticipant({id:'p',company_id:'company',kind:'contact',channel:'email',address:'a@b.c',display_name:null,created_at:now});assert.equal(p.companyId,'company');assert.equal(p.address,'a@b.c');});
test('thread row correctly maps assignment and timestamps',()=>{const t=fromThread({id:'t',company_id:'c',channel:'sms',subject:null,status:'open',assignee_kind:'agent',assignee_id:'ai',created_at:now,updated_at:now,last_message_at:null});assert.deepEqual(t.assignee,{kind:'agent',id:'ai'});assert.equal(t.lastMessageAt,null);});
test('message row retains dedupe and approval metadata',()=>{const m=fromMessage({id:'m',company_id:'c',thread_id:'t',direction:'inbound',channel:'email',status:'received',author_kind:'contact',body:'hello',body_sha256:'a',external_id:'provider1',approval_id:null,created_at:now,updated_at:now});assert.equal(m.externalId,'provider1');assert.equal(m.companyId,'c');});
test('thread membership preserves every composite key',()=>{assert.deepEqual(fromLink({company_id:'a',thread_id:'b',participant_id:'c'}),{companyId:'a',threadId:'b',participantId:'c'});});

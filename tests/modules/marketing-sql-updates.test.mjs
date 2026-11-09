import test from 'node:test';
import assert from 'node:assert/strict';
import {pageSqlPatch,contentSqlPatch} from '../../server/modules/marketing/sql-patch.ts';
const date=new Date('2026-11-09T00:00:00Z');
test('page patch maps null references to explicit bound null',()=>{
 const p=pageSqlPatch({campaignId:null,chatbotId:null,updatedAt:date});
 assert.deepEqual(p.params,[null,null,date]);
 assert.match(p.assignments,/campaign_id = \$3/);
 assert.match(p.assignments,/chatbot_id = \$4/);
});
test('content patch binds publication timestamps and statuses without changing ownership',()=>{
 const p=contentSqlPatch({status:'published',publishedAt:date,updatedAt:date});
 assert.deepEqual(p.params,['published',date,date]);
 assert.match(p.assignments,/status = \$3/);
 assert.match(p.assignments,/published_at = \$4/);
 assert.ok(!p.assignments.includes('company_id'));
});
test('empty patch contains no SQL assignments',()=>{
 assert.deepEqual(pageSqlPatch({}),{assignments:'',params:[]});
 assert.deepEqual(contentSqlPatch({}),{assignments:'',params:[]});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {pageFromSql,contentFromSql} from '../../server/modules/marketing/sql-row.ts';
const time='2026-11-09T00:00:00Z';
test('page row retains company, authorship, structured sections and timestamps',()=>{
 const p=pageFromSql({id:'p',company_id:'co',slug:'new-page',title:'Title',status:'draft',
  sections:'[{"kind":"text","props":{"body":"Hello"}}]',campaign_id:null,chatbot_id:'bot',
  author_kind:'agent',author_id:'agent1',published_at:null,created_at:time,updated_at:time});
 assert.equal(p.companyId,'co');assert.equal(p.sections[0].props.body,'Hello');assert.equal(p.chatbotId,'bot');
 assert.equal(p.publishedAt,null);assert.ok(p.updatedAt instanceof Date);
});
test('content row preserves publication and campaign metadata',()=>{
 const c=contentFromSql({id:'c',company_id:'co',kind:'blog_post',title:'Hi',body:'text',
 status:'published',campaign_id:'camp',author_kind:'human',author_id:'user1',published_at:time,created_at:time,updated_at:time});
 assert.equal(c.campaignId,'camp');assert.equal(c.status,'published');assert.ok(c.publishedAt instanceof Date);
});

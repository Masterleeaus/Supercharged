import test from 'node:test';
import assert from 'node:assert/strict';
import {createSqlMarketingStore} from '../../server/modules/marketing/sql-store.ts';
const A='11111111-1111-4111-8111-111111111111',now=new Date('2026-11-09T00:00:00Z');
function recorder(){const seen=[];return {seen,pool:{async connect(){return {query:async(sql,values)=>{seen.push({sql,values});return {rows:[]};},release(){}};}}};}
test('page insert uses binds for all values including JSON sections',async()=>{
 const r=recorder();const store=createSqlMarketingStore({pool:r.pool});
 await store.insertPage({id:'p',companyId:A,slug:'hello-world',title:'Hello',status:'draft',
 sections:[{kind:'text',props:{body:'hello'}}],campaignId:null,chatbotId:null,authorKind:'human',authorId:'u',publishedAt:null,createdAt:now,updatedAt:now});
 const q=r.seen.find(x=>x.sql.includes('INSERT INTO landing_pages'));
 assert.equal(q.values[1],A);assert.equal(q.values[5],'[{"kind":"text","props":{"body":"hello"}}]');
 assert.ok(q.sql.includes('$6::jsonb'));
});
test('content insert is company-scoped and parameterized',async()=>{
 const r=recorder(),store=createSqlMarketingStore({pool:r.pool});
 await store.insertContent({id:'c',companyId:A,kind:'blog_post',title:'T',body:"x'); DROP TABLE --",status:'draft',campaignId:null,authorKind:'agent',authorId:'a',publishedAt:null,createdAt:now,updatedAt:now});
 const q=r.seen.find(x=>x.sql.includes('INSERT INTO content_items'));
 assert.equal(q.values[1],A);assert.equal(q.values[4],"x'); DROP TABLE --");
 assert.ok(!q.sql.includes('DROP TABLE'));
});
test('updates cannot switch tenant or row identity',async()=>{
 const r=recorder(),store=createSqlMarketingStore({pool:r.pool});
 await store.updatePage(A,'p',{title:'Edited',updatedAt:now});
 await store.updateContent(A,'c',{body:'Changed',updatedAt:now});
 for(const q of r.seen.filter(x=>x.sql.startsWith('UPDATE '))) {
  assert.match(q.sql,/WHERE company_id = \$1 AND id = \$2/);
  assert.deepEqual(q.values.slice(0,2),[A,q.sql.includes('landing_pages')?'p':'c']);
  assert.ok(!q.sql.includes('SET company_id ='));
 }
});

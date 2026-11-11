import test from 'node:test';
import assert from 'node:assert/strict';
import {createSqlMarketingStore} from '../../server/modules/marketing/sql-store.ts';
const A='11111111-1111-4111-8111-111111111111';
function record(){const seen=[];const pool={async connect(){return{query:async(sql,values)=>{seen.push({sql,values});return {rows:[]};},release(){}};}};return{pool,seen};}
test('page draft edits are conditionally limited to a draft row',async()=>{
 const h=record();await createSqlMarketingStore({pool:h.pool}).updatePage(A,'p',{title:'edit',updatedAt:new Date()});
 const q=h.seen.find(x=>x.sql.startsWith('UPDATE landing_pages'));
 assert.match(q.sql,/status = 'draft'/);
});
test('page publication requires draft status atomically',async()=>{
 const h=record();await createSqlMarketingStore({pool:h.pool}).updatePage(A,'p',{status:'published',updatedAt:new Date()});
 const q=h.seen.find(x=>x.sql.startsWith('UPDATE landing_pages'));
 assert.match(q.sql,/status = 'draft'/);
});
test('approved content can only publish from approved status',async()=>{
 const h=record();await createSqlMarketingStore({pool:h.pool}).updateContent(A,'c',{status:'published',updatedAt:new Date()});
 const q=h.seen.find(x=>x.sql.startsWith('UPDATE content_items'));
 assert.match(q.sql,/status = 'approved'/);
});
test('content editing and approval require draft status',async()=>{
 for(const patch of [{body:'edit',updatedAt:new Date()},{status:'approved',updatedAt:new Date()}]){
  const h=record();await createSqlMarketingStore({pool:h.pool}).updateContent(A,'c',patch);
  assert.match(h.seen.find(x=>x.sql.startsWith('UPDATE content_items')).sql,/status = 'draft'/);
 }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createSqlMarketingStore} from '../../server/modules/marketing/sql-store.ts';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
function recordingPool(){const calls=[];return {calls,pool:{async connect(){return {async query(sql,values){calls.push({sql,values});return {rows:[]};},release(){}};}}};}
test('company A cannot update a company B page by providing its record id',async()=>{
 const h=recordingPool(),s=createSqlMarketingStore({pool:h.pool});
 assert.equal(await s.updatePage(A,'company-b-page',{title:'Hijack',updatedAt:new Date()}),null);
 const update=h.calls.find(x=>x.sql.startsWith('UPDATE landing_pages'));
 assert.match(update.sql,/WHERE company_id = \$1 AND id = \$2/);
 assert.deepEqual(update.values.slice(0,2),[A,'company-b-page']);
});
test('company B content operations use a separate transaction-scoped identity',async()=>{
 const h=recordingPool(),s=createSqlMarketingStore({pool:h.pool});
 await s.findContent(A,'x');await s.findContent(B,'x');
 const configs=h.calls.filter(x=>x.sql.includes('set_config'));
 assert.deepEqual(configs.map(x=>x.values[1]),[A,B]);
 assert.equal(h.calls.filter(x=>x.sql==='COMMIT').length,2);
});

test('a cross-company content update stays scoped even after a publication transition',async()=>{
 const h=recordingPool(),s=createSqlMarketingStore({pool:h.pool});
 assert.equal(await s.updateContent(B,'company-a-item',{status:'published',updatedAt:new Date()}),null);
 const update=h.calls.find(x=>x.sql.startsWith('UPDATE content_items'));
 assert.deepEqual(update.values.slice(0,2),[B,'company-a-item']);
 assert.match(update.sql,/status = 'approved'/);
});

test('every Marketing record read includes a bound company predicate',async()=>{
 const h=recordingPool(),s=createSqlMarketingStore({pool:h.pool});
 await s.findPage(A,'p');await s.findPageBySlug(B,'slug');await s.listPages(A,{});
 await s.findContent(B,'c');await s.listContent(A,{});
 for(const q of h.calls.filter(x=>x.sql.startsWith('SELECT id'))){
  assert.match(q.sql,/company_id = \$1/);assert.ok(q.values[0]===A||q.values[0]===B);
 }
});

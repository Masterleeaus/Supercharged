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

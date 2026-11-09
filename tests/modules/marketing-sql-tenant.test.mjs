import test from 'node:test';
import assert from 'node:assert/strict';
import {createSqlMarketingStore} from '../../server/modules/marketing/sql-store.ts';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
function harness(){const queries=[];let releases=0;const pool={async connect(){return {async query(sql,values){queries.push({sql,values});return {rows:[]};},release(){releases++;}};}};return {queries,pool,get releases(){return releases;}};}
test('page and content reads enforce company_id inside a restricted tenant transaction',async()=>{
 const h=harness(),s=createSqlMarketingStore({pool:h.pool});
 await s.findPage(A,'id1');await s.findContent(B,'id2');
 const statements=h.queries.filter(x=>x.sql.startsWith('SELECT id'));
 assert.equal(statements.length,2);
 assert.ok(statements.every(x=>/company_id = \$1 AND id = \$2/.test(x.sql)));
 assert.deepEqual(statements.map(x=>x.values[0]),[A,B]);
 assert.equal(h.queries.filter(x=>x.sql==='COMMIT').length,2);
 assert.equal(h.releases,2);
});
test('invalid company IDs fail without checking out a database connection',async()=>{
 const h=harness(),s=createSqlMarketingStore({pool:h.pool});
 assert.throws(()=>s.findPage('not-a-uuid','a'),/companyId/);
 assert.throws(()=>s.listContent('',{}),/companyId/);
 assert.deepEqual(h.queries,[]);assert.equal(h.releases,0);
});
test('every tenant transaction installs a company-local setting',async()=>{
 const h=harness(),s=createSqlMarketingStore({pool:h.pool});
 await s.listPages(B,{});
 const config=h.queries.find(x=>x.sql.includes('set_config'));
 assert.deepEqual(config.values,['app.company_id',B]);
 assert.ok(h.queries.some(x=>x.sql.startsWith('SET LOCAL ROLE')));
});

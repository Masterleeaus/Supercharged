import test from 'node:test';
import assert from 'node:assert/strict';
import {createSqlMarketingStore} from '../../server/modules/marketing/sql-store.ts';
const A='11111111-1111-4111-8111-111111111111';
function recorder(){const seen=[];return {seen,pool:{async connect(){return {query:async(sql,values)=>{seen.push({sql,values});return {rows:[]}},release(){}}}}};}
test('listPages combines company, status and campaign as bound parameters',async()=>{
 const r=recorder();await createSqlMarketingStore({pool:r.pool}).listPages(A,{status:'published',campaignId:'camp'});
 const q=r.seen.find(x=>x.sql.includes('FROM landing_pages'));
 assert.match(q.sql,/company_id = \$1 AND status = \$2 AND campaign_id = \$3/);
 assert.deepEqual(q.values,[A,'published','camp']);
});
test('listContent combines all three optional filters without interpolation',async()=>{
 const r=recorder();await createSqlMarketingStore({pool:r.pool}).listContent(A,{kind:'blog_post',status:'draft',campaignId:"' OR true --"});
 const q=r.seen.find(x=>x.sql.includes('FROM content_items'));
 assert.match(q.sql,/company_id = \$1 AND kind = \$2 AND status = \$3 AND campaign_id = \$4/);
 assert.ok(!q.sql.includes("OR true"));
 assert.equal(q.values[3],"' OR true --");
});
test('empty filters still constrain company and use deterministic ordering',async()=>{
 const r=recorder();await createSqlMarketingStore({pool:r.pool}).listPages(A,{});
 const q=r.seen.find(x=>x.sql.includes('FROM landing_pages'));
 assert.match(q.sql,/ORDER BY updated_at DESC, id ASC/);assert.deepEqual(q.values,[A]);
});

test('filter values resembling SQL do not alter the query structure',async()=>{
 const r=recorder(),value="draft' OR company_id <> '";
 await createSqlMarketingStore({pool:r.pool}).listContent(A,{status:value,campaignId:value});
 const q=r.seen.find(x=>x.sql.includes('FROM content_items'));
 assert.ok(!q.sql.includes(value));assert.deepEqual(q.values,[A,value,value]);
});

test('sequential tenants do not share company-scoped transaction settings',async()=>{
 const B='22222222-2222-4222-8222-222222222222';
 const r=recorder(),s=createSqlMarketingStore({pool:r.pool});
 await s.listPages(A,{});await s.listPages(B,{});
 assert.deepEqual(r.seen.filter(q=>q.sql.includes('set_config')).map(q=>q.values[1]),[A,B]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createSqlMarketingStore} from '../../server/modules/marketing/sql-store.ts';
import {createMarketingService,MarketingError,InMemoryRefs} from '../../server/modules/marketing/index.ts';
const A='11111111-1111-4111-8111-111111111111';
test('lookup by slug is bound to company and slug parameters',async()=>{
 const calls=[],pool={async connect(){return {async query(sql,vals){calls.push({sql,vals});return {rows:[]};},release(){}};}};
 const store=createSqlMarketingStore({pool});
 await store.findPageBySlug(A,"spring' OR 1=1 --");
 const q=calls.find(x=>x.sql.includes('FROM landing_pages'));
 assert.match(q.sql,/company_id = \$1 AND slug = \$2/);
 assert.deepEqual(q.vals,[A,"spring' OR 1=1 --"]);
 assert.ok(!q.sql.includes('OR 1=1'));
});
test('database unique-slug collision maps to marketing conflict instead of raw pg error',async()=>{
 const duplicate=Object.assign(new Error('duplicate key value'),{code:'23505',constraint:'landing_pages_company_slug_uidx'});
 const store={findPageBySlug:async()=>null,insertPage:async()=>{throw duplicate;}};
 const refs={campaignExists:async()=>true,chatbotExists:async()=>true};
 const service=createMarketingService({store,campaigns:refs,chatbots:refs});
 await assert.rejects(service.createPage(A,{kind:'human',id:'u'},{slug:'new-page',title:'Hello'}),err=>err instanceof MarketingError && err.code==='conflict');
});

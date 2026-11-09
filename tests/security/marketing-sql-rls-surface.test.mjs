import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CANDIDATE} from '../../scripts/check-marketing-migration.mjs';
const sql=readFileSync(CANDIDATE,'utf8');
test('marketing candidate does not create a privileged or password-bearing role',()=>{
 assert.doesNotMatch(sql,/CREATE ROLE desk_app|PASSWORD\s+'/);
 assert.match(sql,/NOT rolsuper AND NOT rolbypassrls/);
});
test('both marketing tables use company_id UUID not a text override',()=>{
 for(const table of ['landing_pages','content_items']) {
  const fragment=sql.split(`CREATE TABLE IF NOT EXISTS ${table}`)[1].split(');')[0];
  assert.match(fragment,/company_id uuid NOT NULL/);
 }
});
test('marketing migration candidate is not auto-listed in the production runner',()=>{
 const runner=readFileSync(new URL('../../scripts/run-safe-migration.mjs',import.meta.url),'utf8');
 assert.ok(!runner.includes('0017_marketing_tenant_rls.sql'));
});

test('both policies rely on transaction-local authenticated tenant context',()=>{
 for(const table of ['landing_pages','content_items']) assert.match(sql,new RegExp('CREATE POLICY '+table+'_tenant_boundary'));
 assert.match(sql,/current_setting\('app.company_id',true\)/);
});

test('an additional permissive public policy is rejected by the runtime inspector',async()=>{
 const {inspectMarketingPolicies}=await import('../../server/modules/marketing/policy-inspection.ts');
 const rule={tablename:'landing_pages',policyname:'landing_pages_tenant_boundary',roles:['desk_app'],cmd:'ALL',permissive:'PERMISSIVE',qual:"company_id = nullif(current_setting('app.company_id',true),'')::uuid",with_check:"company_id = nullif(current_setting('app.company_id',true),'')::uuid"};
 const bypass={tablename:'landing_pages',policyname:'world_read',roles:['public'],cmd:'SELECT',permissive:'PERMISSIVE',qual:'true'};
 assert.ok(inspectMarketingPolicies('landing_pages',[rule,bypass]).length>0);
});

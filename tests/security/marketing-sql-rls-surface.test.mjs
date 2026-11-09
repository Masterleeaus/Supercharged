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

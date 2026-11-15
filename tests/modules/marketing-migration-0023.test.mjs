import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateMarketingMigration,CANDIDATE} from '../../scripts/check-marketing-migration.mjs';
import {listedMigrations} from '../../scripts/check-migration-inventory.mjs';
const root=new URL('../../',import.meta.url);
const promoted=readFileSync(new URL('migrations/0023_marketing_tables_tenant_rls.sql',root),'utf8');
const candidate=readFileSync(CANDIDATE,'utf8');
const runner=readFileSync(new URL('scripts/run-safe-migration.mjs',root),'utf8');
const body=sql=>sql.split('\n').filter(l=>!l.trim().startsWith('--')).join('\n').replace(/\s+/g,' ').trim();
test('promoted migration 0023 passes the static marketing RLS preflight',()=>{
 assert.deepEqual(validateMarketingMigration(promoted),[]);
});
test('promoted migration 0023 has the same schema and policies as the reviewed candidate',()=>{
 assert.equal(body(promoted),body(candidate));
});
test('promoted migration 0023 is listed in the production runner manifest',()=>{
 const entries=listedMigrations(runner);
 assert.ok(entries.some(e=>e.file==='0023_marketing_tables_tenant_rls.sql'&&e.required===true));
});
test('promoted migration 0023 scopes both tables by company_id uuid and forces RLS',()=>{
 for(const table of ['landing_pages','content_items']){
  assert.match(promoted,new RegExp('CREATE TABLE IF NOT EXISTS '+table+' \\('));
  assert.match(promoted,new RegExp('ALTER TABLE '+table+' FORCE ROW LEVEL SECURITY'));
 }
 assert.equal((promoted.match(/company_id uuid NOT NULL/g)||[]).length,2);
 assert.match(promoted,/USING \(company_id = nullif\(current_setting\('app\.company_id',true\),''\)::uuid\)/);
});
test('promoted migration 0023 creates no roles, passwords or public grants',()=>{
 assert.doesNotMatch(promoted,/CREATE ROLE|PASSWORD\s+'/);
 assert.doesNotMatch(promoted,/GRANT [^;]* TO PUBLIC\b/i);
});

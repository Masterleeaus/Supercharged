import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CANDIDATE,validateMarketingMigration} from '../../scripts/check-marketing-migration.mjs';
test('candidate protects both tables with forced RLS and read/write company policies',()=>{
 assert.deepEqual(validateMarketingMigration(readFileSync(CANDIDATE,'utf8')),[]);
});
test('a missing FORCE RLS fails the preflight',()=>{
 const source=readFileSync(CANDIDATE,'utf8');
 assert.ok(validateMarketingMigration(source.replace('ALTER TABLE content_items FORCE ROW LEVEL SECURITY;','')).some(x=>x.includes('FORCE ROW LEVEL SECURITY')));
});
test('any PUBLIC grant fails preflight',()=>{
 const source=readFileSync(CANDIDATE,'utf8');
 assert.ok(validateMarketingMigration(source+'\nGRANT SELECT ON landing_pages TO PUBLIC;').some(x=>x.includes('Public grants')));
});
test('a missing tenant WITH CHECK fails preflight',()=>{
 const source=readFileSync(CANDIDATE,'utf8');
 assert.ok(validateMarketingMigration(source.replace('WITH CHECK (company_id = nullif', 'WITH CHECK (false AND company_id = nullif')).length>0);
});

test('candidate never provisions database passwords or privileged roles',()=>{
 const sql=readFileSync(CANDIDATE,'utf8');
 assert.doesNotMatch(sql,/CREATE ROLE desk_app|PASSWORD\s+'/);
 assert.match(sql,/NOT rolsuper AND NOT rolbypassrls/);
});

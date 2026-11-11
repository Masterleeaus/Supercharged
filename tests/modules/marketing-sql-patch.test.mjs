import test from 'node:test';
import assert from 'node:assert/strict';
import { pageSqlPatch,contentSqlPatch } from '../../server/modules/marketing/sql-patch.ts';
test('page patch has allowlisted bound fields and JSON-encoded sections',()=>{
 const p=pageSqlPatch({title:'new',sections:[{kind:'text',props:{body:'hi'}}],updatedAt:new Date('2026-11-09')});
 assert.match(p.assignments,/title = \$3/);assert.match(p.assignments,/sections = \$4::jsonb/);
 assert.deepEqual(JSON.parse(p.params[1]),[{kind:'text',props:{body:'hi'}}]);
});
test('arbitrary fields can never become SQL identifiers',()=>{
 const p=pageSqlPatch({updatedAt:new Date(),['company_id = null --']:'x'});
 assert.ok(!p.assignments.includes('company_id'));
 assert.ok(p.assignments.includes('updated_at'));
});
test('content patches never allow changing author, company or record id',()=>{
 const p=contentSqlPatch({body:'body',status:'approved',updatedAt:new Date(),companyId:'evil',id:'evil'});
 assert.deepEqual(p.assignments.split(', ').map(s=>s.split(' = ')[0]),['body','status','updated_at']);
});

test('page and content status transitions are bound rather than interpolated',()=>{
 const page=pageSqlPatch({status:'published',updatedAt:new Date()});
 const content=contentSqlPatch({status:'approved',updatedAt:new Date()});
 assert.ok(page.assignments.includes('status = $3'));
 assert.ok(content.assignments.includes('status = $3'));
 assert.equal(page.params[0],'published');assert.equal(content.params[0],'approved');
});

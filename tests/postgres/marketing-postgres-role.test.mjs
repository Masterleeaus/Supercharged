import test from 'node:test';
import assert from 'node:assert/strict';
import {enabled,createFixture} from './marketing-postgres-support.mjs';
test('PostgreSQL: application role cannot bypass RLS and tables enforce it', {skip:!enabled},async()=>{
 const f=createFixture();
 try {
  const roles=(await f.pool.query(`SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname='desk_app'`)).rows;
  assert.equal(roles.length,1);assert.equal(roles[0].rolsuper,false);assert.equal(roles[0].rolbypassrls,false);
  const tables=(await f.pool.query(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('landing_pages','content_items')`)).rows;
  assert.equal(tables.length,2);
  assert.ok(tables.every(r=>r.relrowsecurity===true&&r.relforcerowsecurity===true));
 } finally {await f.close();}
});

test('PostgreSQL: both tenant policies have read and write company predicates', {skip:!enabled},async()=>{
 const f=createFixture();try{
  const rows=(await f.pool.query(`SELECT tablename, policyname, roles, qual, with_check FROM pg_policies WHERE tablename IN ('landing_pages','content_items')`)).rows;
  for(const name of ['landing_pages','content_items']){
   const p=rows.find(x=>x.tablename===name&&x.policyname===name+'_tenant_boundary');
   assert.ok(p);assert.ok(p.roles.includes('desk_app'));
   assert.match(p.qual,/app.company_id/);assert.match(p.with_check,/app.company_id/);
  }
 }finally{await f.close();}
});

test('PostgreSQL: no additional permissive role policies bypass company RLS',{skip:!enabled},async()=>{
 const f=createFixture();try{
  const {inspectMarketingPolicies}=await import('../../server/modules/marketing/policy-inspection.ts');
  const rows=(await f.pool.query("SELECT tablename,policyname,roles,cmd,permissive,qual,with_check FROM pg_policies WHERE tablename IN ('landing_pages','content_items')")).rows;
  for(const table of ['landing_pages','content_items'])assert.deepEqual(inspectMarketingPolicies(table,rows),[]);
 }finally{await f.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {A,B,enabled,createFixture,page} from './marketing-postgres-support.mjs';
test('PostgreSQL: restricted role cannot read another company without a company predicate', {skip:!enabled},async()=>{
 const f=createFixture();
 try {
  await f.store.insertPage(page(A,'rls-owned-a','rls-a'));
  await f.store.insertPage(page(B,'rls-owned-b','rls-b'));
  const client=await f.pool.connect();
  try {
   await client.query('BEGIN');
   await client.query('SET LOCAL ROLE "desk_app"');
   await client.query('SELECT set_config($1,$2,true)',['app.company_id',A]);
   const rows=(await client.query('SELECT id,company_id FROM landing_pages ORDER BY id')).rows;
   assert.ok(rows.every(r=>r.company_id===A));
   assert.ok(rows.some(r=>r.id==='rls-owned-a'));
   assert.ok(!rows.some(r=>r.id==='rls-owned-b'));
   await client.query('ROLLBACK');
  } finally {client.release();}
 } finally {await f.close();}
});
test('PostgreSQL: RLS WITH CHECK refuses wrong-tenant inserts', {skip:!enabled},async()=>{
 const f=createFixture();
 try {
  const client=await f.pool.connect();
  try {
   await client.query('BEGIN');
   await client.query('SET LOCAL ROLE "desk_app"');
   await client.query('SELECT set_config($1,$2,true)',['app.company_id',A]);
   await assert.rejects(client.query(
    `INSERT INTO landing_pages (id,company_id,slug,title,author_kind,author_id)
      VALUES ($1,$2,$3,$4,$5,$6)`,
    ['rls-forged',B,'rls-forged','Forged','human','tester']),/row-level security/i);
   await client.query('ROLLBACK');
  } finally {client.release();}
 } finally {await f.close();}
});

test('PostgreSQL: no transaction-local company setting means zero readable Marketing rows',{skip:!enabled},async()=>{
 const f=createFixture();try{
  const client=await f.pool.connect();try{
   await client.query('BEGIN');await client.query('SET LOCAL ROLE "desk_app"');
   const pages=(await client.query('SELECT id FROM landing_pages')).rows;
   const content=(await client.query('SELECT id FROM content_items')).rows;
   assert.deepEqual(pages,[]);assert.deepEqual(content,[]);
   await client.query('ROLLBACK');
  }finally{client.release();}
 }finally{await f.close();}
});

test('PostgreSQL: actual tenant policy enforces both SELECT and INSERT constraints',{skip:!enabled},async()=>{
 const f=createFixture();try{
  const {tenantPredicate}=await import('../../server/modules/marketing/policy-inspection.ts');
  const rows=(await f.pool.query("SELECT tablename,qual,with_check FROM pg_policies WHERE tablename IN ('landing_pages','content_items')")).rows;
  for(const row of rows){assert.equal(tenantPredicate(row.qual),true);assert.equal(tenantPredicate(row.with_check),true);}
 }finally{await f.close();}
});

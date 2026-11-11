import test from 'node:test';
import assert from 'node:assert/strict';
import {A,B,enabled,createFixture,page} from './marketing-postgres-support.mjs';
test('PostgreSQL: same-company duplicate slug fails and other company may reuse it', {skip:!enabled},async()=>{
 const f=createFixture();
 try {
  await f.store.insertPage(page(A,'slug-a','same-slug'));
  await assert.rejects(f.store.insertPage(page(A,'slug-duplicate','same-slug')),e=>e.code==='23505'&&e.constraint==='landing_pages_company_slug_uidx');
  await f.store.insertPage(page(B,'slug-b','same-slug'));
  assert.equal((await f.store.findPageBySlug(A,'same-slug')).id,'slug-a');
  assert.equal((await f.store.findPageBySlug(B,'same-slug')).id,'slug-b');
 } finally {await f.close();}
});

test('PostgreSQL: simultaneous same-tenant slug creation permits at most one commit',{skip:!enabled},async()=>{
 const f=createFixture();try{
  const slug='parallel-unique-'+process.pid;
  const results=await Promise.allSettled([
   f.store.insertPage(page(A,'parallel-a-'+process.pid,slug)),
   f.store.insertPage(page(A,'parallel-b-'+process.pid,slug)),
  ]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(results.filter(x=>x.status==='rejected'&&x.reason?.code==='23505').length,1);
 }finally{await f.close();}
});

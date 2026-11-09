import test from 'node:test';
import assert from 'node:assert/strict';
import {A,B,NOW,enabled,createFixture,page,content} from './marketing-postgres-support.mjs';
test('PostgreSQL: two-company page and content visibility is isolated by real RLS', {skip:!enabled},async()=>{
 const f=createFixture();
 try {
  await f.store.insertPage(page(A,'pg-tenant-a','tenant-shared'));
  await f.store.insertPage(page(B,'pg-tenant-b','tenant-shared'));
  await f.store.insertContent(content(A,'pg-content-a'));
  await f.store.insertContent(content(B,'pg-content-b'));
  const pagesA=await f.store.listPages(A,{}),pagesB=await f.store.listPages(B,{});
  const contentA=await f.store.listContent(A,{}),contentB=await f.store.listContent(B,{});
  assert.ok(pagesA.some(p=>p.id==='pg-tenant-a'));
  assert.ok(pagesB.some(p=>p.id==='pg-tenant-b'));
  assert.ok(contentA.some(c=>c.id==='pg-content-a'));
  assert.ok(contentB.some(c=>c.id==='pg-content-b'));
  assert.ok(pagesA.every(p=>p.companyId===A));
  assert.ok(pagesB.every(p=>p.companyId===B));
  assert.ok(contentA.every(c=>c.companyId===A));
  assert.ok(contentB.every(c=>c.companyId===B));
  assert.equal(await f.store.findPage(A,'pg-tenant-b'),null);
  assert.equal(await f.store.findContent(B,'pg-content-a'),null);
  assert.equal(await f.store.updatePage(A,'pg-tenant-b',{title:'Blocked',updatedAt:NOW}),null);
  assert.equal(await f.store.updateContent(B,'pg-content-a',{body:'Blocked',updatedAt:NOW}),null);
 } finally {await f.close();}
});

test('PostgreSQL: reused connections cannot leak the previous company scope',{skip:!enabled},async()=>{
 const f=createFixture();try{
  const a=await f.store.listPages(A,{}),b=await f.store.listPages(B,{});
  assert.ok(a.every(p=>p.companyId===A));assert.ok(b.every(p=>p.companyId===B));
  const again=await f.store.listPages(A,{});
  assert.ok(again.every(p=>p.companyId===A));
 }finally{await f.close();}
});

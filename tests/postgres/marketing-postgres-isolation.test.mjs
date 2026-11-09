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
  assert.equal((await f.store.listPages(A,{})).length,1);
  assert.equal((await f.store.listPages(B,{})).length,1);
  assert.equal((await f.store.listContent(A,{})).length,1);
  assert.equal((await f.store.listContent(B,{})).length,1);
  assert.equal(await f.store.findPage(A,'pg-tenant-b'),null);
  assert.equal(await f.store.findContent(B,'pg-content-a'),null);
  assert.equal(await f.store.updatePage(A,'pg-tenant-b',{title:'Blocked',updatedAt:NOW}),null);
  assert.equal(await f.store.updateContent(B,'pg-content-a',{body:'Blocked',updatedAt:NOW}),null);
 } finally {await f.close();}
});

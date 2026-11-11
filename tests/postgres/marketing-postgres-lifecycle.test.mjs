import test from 'node:test';
import assert from 'node:assert/strict';
import {A,NOW,enabled,createFixture,page,content} from './marketing-postgres-support.mjs';
test('PostgreSQL: publication cannot be repeated once draft state is consumed', {skip:!enabled},async()=>{
 const f=createFixture();
 try {
  await f.store.insertPage(page(A,'pg-page-lifecycle'));
  const published=await f.store.updatePage(A,'pg-page-lifecycle',{status:'published',publishedAt:NOW,updatedAt:NOW});
  assert.equal(published.status,'published');
  assert.equal(await f.store.updatePage(A,'pg-page-lifecycle',{title:'Stale edit',updatedAt:NOW}),null);
  assert.equal(await f.store.updatePage(A,'pg-page-lifecycle',{status:'published',updatedAt:NOW}),null);
 } finally {await f.close();}
});
test('PostgreSQL: approved content publishes once, and stale edits return null', {skip:!enabled},async()=>{
 const f=createFixture();
 try {
  await f.store.insertContent(content(A,'pg-content-lifecycle'));
  assert.equal((await f.store.updateContent(A,'pg-content-lifecycle',{status:'approved',updatedAt:NOW})).status,'approved');
  assert.equal(await f.store.updateContent(A,'pg-content-lifecycle',{body:'Stale',updatedAt:NOW}),null);
  assert.equal((await f.store.updateContent(A,'pg-content-lifecycle',{status:'published',publishedAt:NOW,updatedAt:NOW})).status,'published');
  assert.equal(await f.store.updateContent(A,'pg-content-lifecycle',{status:'published',updatedAt:NOW}),null);
 } finally {await f.close();}
});

test('PostgreSQL: racing publish requests permit exactly one transition',{skip:!enabled},async()=>{
 const f=createFixture();try{
  const id='pg-racing-page-'+process.pid;
  await f.store.insertPage(page(A,id));
  const results=await Promise.all([f.store.updatePage(A,id,{status:'published',publishedAt:NOW,updatedAt:NOW}),f.store.updatePage(A,id,{status:'published',publishedAt:NOW,updatedAt:NOW})]);
  assert.equal(results.filter(Boolean).length,1);
  assert.equal((await f.store.findPage(A,id)).status,'published');
 }finally{await f.close();}
});

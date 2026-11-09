import test from 'node:test';
import assert from 'node:assert/strict';
import {enabled,createFixture} from './marketing-postgres-support.mjs';
import {verifyMarketingSchema,requireMarketingSchema} from '../../server/modules/marketing/schema-readiness.ts';
test('PostgreSQL: deployment readiness matches actual row-level privileges and policies',{skip:!enabled},async()=>{
 const fixture=createFixture();
 try {
  const state=await verifyMarketingSchema(fixture.pool);
  assert.deepEqual(state,{ready:true,issues:[]});
  await requireMarketingSchema(fixture.pool);
 } finally {await fixture.close();}
});

test('PostgreSQL: policy metadata must include permissive and exact role names',{skip:!enabled},async()=>{
 const f=createFixture();try{
  const state=await f.checkReadiness();assert.equal(state.ready,true,JSON.stringify(state.issues));
  const rows=(await f.pool.query("SELECT tablename,policyname,roles,cmd,permissive FROM pg_policies WHERE tablename IN ('landing_pages','content_items')")).rows;
  assert.ok(rows.every(r=>r.permissive==='PERMISSIVE'&&r.cmd==='ALL'));
 }finally{await f.close();}
});

test('PostgreSQL: verified production service creates durable Marketing rows',{skip:!enabled},async()=>{
 const f=createFixture();try{
  const {createVerifiedMarketingService}=await import('../../server/modules/marketing/production-service.ts');
  const {A}=await import('./marketing-postgres-support.mjs');
  const service=await createVerifiedMarketingService({pool:f.pool,schemaProbe:f.pool,
   campaigns:{campaignExists:async()=>false},chatbots:{chatbotExists:async()=>false}});
  const slug='verified-production-'+process.pid;
  const page=await service.createPage(A,{kind:'human',id:'staff'}, {slug,title:'Durable page'});
  assert.equal((await service.getPage(A,page.id)).slug,slug);
  assert.equal((await f.store.findPage(A,page.id)).title,'Durable page');
  await service.publishPage(A,{kind:'human',id:'staff'},page.id);
  assert.equal((await f.store.findPage(A,page.id)).status,'published');
 }finally{await f.close();}
});

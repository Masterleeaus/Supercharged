import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFileSync} from 'node:fs';
import express from 'express';
import {enabled,createFixture,A,B} from './marketing-postgres-support.mjs';
import {registerVerifiedCommsRoutes} from '../../server/routes/core/verified-marketing-routes.ts';
import {withTenant} from '../../server/infrastructure/database/tenant-context.ts';
const MIGRATION=new URL('../../migrations/0023_marketing_tables_tenant_rls.sql',import.meta.url);
async function startApp(pool) {
 const app=express();app.use(express.json());
 const authenticate=(req,_res,next)=>{req.userId='staff1';req.userRole='manager';next();};
 const company=(req,res,next)=>{res.locals.companyId=req.headers['x-company']==='b'?B:A;next();};
 const role=(...roles)=>(req,res,next)=>roles.includes(req.userRole)?next():res.status(403).json({error:'forbidden'});
 const out=await registerVerifiedCommsRoutes(app,{authenticate,requireCompanyScope:company,requireRole:role,
  pool,schemaProbe:pool,chatbots:{findChatbot:async()=>null},env:{COMMS_MARKETING_ENABLED:'true'}});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const request=(method,path,company,body)=>new Promise((resolve,reject)=>{
  const payload=body===undefined?undefined:JSON.stringify(body);
  const req=http.request({host:'127.0.0.1',port:server.address().port,path,method,
   headers:{host:'syncedat.work','x-company':company,...(payload?{'content-type':'application/json','content-length':Buffer.byteLength(payload)}:{})}},res=>{
   let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,text}));});
  req.on('error',reject);if(payload)req.write(payload);req.end();
 });
 return {mounted:out.mounted,request,close:()=>new Promise(r=>{server.close(r);server.closeAllConnections();})};
}
test('PostgreSQL: promoted marketing migration passes readiness and mounts routes that respond per company',{skip:!enabled},async()=>{
 const f=createFixture();
 const slug='startup-'+process.pid+'-'+Date.now();
 let app;
 try {
  await f.pool.query(readFileSync(MIGRATION,'utf8'));
  app=await startApp(f.pool);
  assert.deepEqual(app.mounted,['marketing']);
  const created=await app.request('POST','/api/comms/marketing/pages','a',{slug,title:'Startup page',sections:[]});
  assert.ok(created.status<300,created.text);
  const pageId=JSON.parse(created.text).id ?? JSON.parse(created.text).page?.id;
  assert.ok(pageId);
  const own=await app.request('GET','/api/comms/marketing/pages/'+pageId,'a');
  assert.equal(own.status,200);
  const list=await app.request('GET','/api/comms/marketing/pages','a');
  assert.equal(list.status,200);assert.ok(list.text.includes(pageId));
  // Cross-company: company B cannot read, list or update company A's page.
  const crossRead=await app.request('GET','/api/comms/marketing/pages/'+pageId,'b');
  assert.ok(crossRead.status>=400 || !crossRead.text.includes(pageId),crossRead.text);
  const crossList=await app.request('GET','/api/comms/marketing/pages','b');
  assert.equal(crossList.status,200);assert.ok(!crossList.text.includes(pageId));
  const crossPatch=await app.request('PATCH','/api/comms/marketing/pages/'+pageId,'b',{title:'hijack'});
  assert.ok(crossPatch.status>=400,crossPatch.text);
  // Database layer: RLS refuses a write that names another company's id.
  await assert.rejects(withTenant(f.pool,B,db=>db.query(
    'INSERT INTO landing_pages (company_id,slug,title,author_kind,author_id) VALUES ($1,$2,$3,$4,$5)',
    [A,slug+'-x','Forged','human','attacker'])));
 } finally {
  if (app) await app.close();
  await f.pool.query('DELETE FROM landing_pages WHERE slug = $1',[slug]).catch(()=>{});
  await f.close();
 }
});

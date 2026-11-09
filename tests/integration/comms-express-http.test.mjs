import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { registerOptionalCommsRoutes } from '../../server/routes/core/optional-comms-routes.ts';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
async function serverFor() {
 const calls=[];
 const service=new Proxy({},{get(_t,name){return (...args)=>{calls.push({name,args});return Promise.resolve([]);};}});
 const app=express();app.use(express.json());
 const authenticate=(req,_res,next)=>{req.userId='member1';req.userRole='manager';next();};
 const company=(req,res,next)=>{res.locals.companyId=req.headers['x-company']==='b'?B:A;next();};
 const role=(...roles)=>(req,res,next)=>roles.includes(req.userRole)?next():res.status(403).json({error:'forbidden'});
 registerOptionalCommsRoutes(app,{authenticate,requireCompanyScope:company,requireRole:role,inbox:service,marketing:service,
 env:{COMMS_INBOX_ENABLED:'true',COMMS_MARKETING_ENABLED:'true'}});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 return {calls,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}),
  request:(path,host,headers={})=>new Promise((resolve,reject)=>{
   const req=http.request({host:'127.0.0.1',port:server.address().port,path,method:'GET',headers:{host,...headers}},res=>{
    let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));
   });req.on('error',reject);req.end();
  })};
}
test('mounted inbox returns only the authenticated company scope, regardless of query',async()=>{
 const s=await serverFor();try{
  const a=await s.request('/api/comms/inbox/threads?companyId='+B,'syncedat.work');
  const b=await s.request('/api/comms/inbox/threads?companyId='+A,'syncedat.work',{'x-company':'b'});
  assert.equal(a.status,200);assert.equal(b.status,200);
  assert.deepEqual(s.calls.filter(c=>c.name==='listThreads').map(c=>c.args[0]),[A,B]);
 }finally{await s.close();}
});
test('host allowlist rejects workforce and forwarded host spoof before service call',async()=>{
 const s=await serverFor();try{
  const bad=await s.request('/api/comms/inbox/threads','superchargedat.work',{'x-forwarded-host':'syncedat.work'});
  assert.equal(bad.status,404);assert.equal(s.calls.length,0);
 }finally{await s.close();}
});
test('marketing listing uses the same authenticated company and mode boundary',async()=>{
 const s=await serverFor();try{
  const ok=await s.request('/api/comms/marketing/pages','syncedat.work',{'x-company':'b'});
  const denied=await s.request('/api/comms/marketing/pages','unknown.example');
  assert.equal(ok.status,200);assert.equal(denied.status,404);
  assert.deepEqual(s.calls.map(c=>c.args[0]),[B]);
 }finally{await s.close();}
});

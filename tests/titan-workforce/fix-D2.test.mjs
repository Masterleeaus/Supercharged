// D2: workforce preview routes must require a named permission, not team membership.
// Install as tests/titan-workforce/fix-D2.test.mjs in the repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import {registerPlugin} from '../../plugins/titan-workforce-bridge/index.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const repo=resolve(here,'../..');
const PREVIEW='/api/titan-workforce/v1/previews';
const LEAD='/api/titan-workforce/v1/revenue/leads/preview';
const previewInput={workflow:'booking',resource_reference:'br_42',client_request_reference:'req_1'};
const leadInput={lead_reference:'lead_1',to_state:'qualifying',client_event_reference:'evt_5'};
const ctx={trusted:true,company_id:'company_ABC',desk_actor_id:'actor_1'};
const ports=(counter)=>({
  resolveIdentity:async()=>{counter.n++;return ctx},
  resolveResource:async({context,kind,reference})=>({verified:true,kind,reference,company_id:context.company_id,state:'captured'}),
  authorize:async({context})=>({allowed:true,company_id:context.company_id}),
});

// Team-member check, as checkAdminOrTeamMember behaves for a team token: records order, passes.
const teamCheck=(calls)=>(req,res,next)=>{calls.push('team');req.adminTeamMember={roleId:'role_1'};next()};
// Named-permission check, as requireAdminPermission behaves: allow or deny with 403.
const permCheck=(calls,allowed)=>(req,res,next)=>{
  calls.push('perm');
  if(allowed)return next();
  return res.status(403).json({error:'Permission denied'});
};

function fakeApp(){const routes=new Map();return {routes,post:(p,...fns)=>routes.set(p,fns)}}

function invoke(fns,req){
  return new Promise((resolveResult)=>{
    const res={
      set(){return this},
      status(code){this._status=code;return this},
      json(body){resolveResult({status:this._status??200,body});return this},
    };
    const step=(i)=>{if(i<fns.length)fns[i](req,res,()=>step(i+1))};
    step(0);
    setTimeout(()=>resolveResult({status:'no_response'}),500).unref();
  });
}
const req=(body)=>({rawBody:Buffer.from(JSON.stringify(body)),body,headers:{}});

function withMode(fn){
  const prior=process.env.TITAN_WORKFORCE_ADAPTER_MODE;
  process.env.TITAN_WORKFORCE_ADAPTER_MODE='shadow';
  try{return fn()}finally{
    if(prior===undefined)delete process.env.TITAN_WORKFORCE_ADAPTER_MODE;else process.env.TITAN_WORKFORCE_ADAPTER_MODE=prior;
  }
}

test('team membership alone no longer registers workforce routes',()=>{
  withMode(()=>{
    const app=fakeApp();
    const calls=[];
    const result=registerPlugin(app,{adminAuthMiddleware:teamCheck(calls),titanWorkforcePorts:ports({n:0})});
    assert.equal(result.workforce.registered,false);
    assert.equal(result.revenue.registered,false);
    assert.equal(app.routes.size,0);
  });
});

test('team member without the named permission is refused before the preview runs',async()=>{
  const calls=[];const counter={n:0};
  await withMode(async()=>{
    const app=fakeApp();
    registerPlugin(app,{
      adminAuthMiddleware:teamCheck(calls),
      workforceAdminMiddleware:[teamCheck(calls),permCheck(calls,false)],
      titanWorkforcePorts:ports(counter),
    });
    const r=await invoke(app.routes.get(PREVIEW),req(previewInput));
    assert.equal(r.status,403);
    assert.equal(counter.n,0);
  });
  assert.deepEqual(calls.slice(-2),['team','perm']);
});

test('team member with the named permission gets the preview',async()=>{
  const calls=[];
  await withMode(async()=>{
    const app=fakeApp();
    registerPlugin(app,{workforceAdminMiddleware:[teamCheck(calls),permCheck(calls,true)],titanWorkforcePorts:ports({n:0})});
    const r=await invoke(app.routes.get(PREVIEW),req(previewInput));
    assert.equal(r.status,202);
    assert.equal(r.body.execution,'not_executed');
  });
});

test('revenue lead route uses the same named-permission gate',async()=>{
  const calls=[];
  await withMode(async()=>{
    const app=fakeApp();
    registerPlugin(app,{workforceAdminMiddleware:[teamCheck(calls),permCheck(calls,false)],titanWorkforcePorts:ports({n:0})});
    const r=await invoke(app.routes.get(LEAD),req(leadInput));
    assert.equal(r.status,403);
  });
});

test('gate must be an explicit array or function; a bare adminAuth option is not enough',()=>{
  withMode(()=>{
    const app=fakeApp();
    const result=registerPlugin(app,{adminAuthMiddleware:(q,s,n)=>n(),workforceAdminMiddleware:[(q,s,n)=>n(),'not-a-function'],titanWorkforcePorts:ports({n:0})});
    assert.equal(result.workforce.registered,false);
    assert.equal(app.routes.size,0);
  });
});

test('routes.ts gives the bridge a named permission gate',()=>{
  const routes=readFileSync(resolve(repo,'server/routes.ts'),'utf8');
  assert.match(routes,/workforceAdminMiddleware:\s*\[\s*checkAdminOrTeamMember[\s\S]{0,200}requireAdminPermission\('workforce',\s*'previews',\s*'create'\)/);
});

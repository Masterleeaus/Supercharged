import { createRestartCheckpointStore } from './restart-checkpoint.mjs';
import { createServiceWorkerLifecycle } from './service-worker-lifecycle.mjs';

const FORBIDDEN=new Set(['tenant_id','tenant_company_id','workspace_tenant_id']);
const clone=value=>value==null?value:globalThis.structuredClone?structuredClone(value):JSON.parse(JSON.stringify(value));
const text=(value,field)=>{const out=String(value??'').trim();if(!out)throw new Error(`${field}-required`);return out;};
function rejectLegacy(value,path='browser-restart-harness'){
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){value.forEach((child,index)=>rejectLegacy(child,`${path}[${index}]`));return;}
  for(const [key,child] of Object.entries(value)){
    if(FORBIDDEN.has(key))throw new Error(`legacy-company-boundary:${path}.${key}`);
    rejectLegacy(child,`${path}.${key}`);
  }
}
function context(raw={}){
  rejectLegacy(raw,'context');
  return Object.freeze({
    company_id:text(raw.company_id,'company_id'),
    actor_id:String(raw.actor_id||'titan-browser-restart-harness').trim()||'titan-browser-restart-harness',
    operation_id:String(raw.operation_id||'browser-restart-harness').trim()||'browser-restart-harness',
  });
}
function assertCompany(ctx,value,path='input'){
  rejectLegacy(value,path);
  const requested=String(value?.company_id||'').trim();
  if(requested&&requested!==ctx.company_id)throw new Error(`cross-company:${path}`);
}

export function createDeterministicBrowserRestartHarness({database,clock=()=>Date.now()}={}){
  if(!database?.putRecord||!database?.getRecord||!database?.listRecords)throw new Error('business-database-required');
  let workerGeneration=0;
  let restartCount=0;
  let current=null;
  let lastLifecycle=null;

  const spawn=()=>{
    const checkpointStore=createRestartCheckpointStore({database,clock});
    const lifecycle=createServiceWorkerLifecycle({checkpointStore,clock});
    workerGeneration+=1;
    current=Object.freeze({checkpointStore,lifecycle,generation:workerGeneration});
    return current;
  };
  const requireWorker=()=>current||spawn();
  const baseSnapshot=()=>Object.freeze({
    schema:'titan.offline.browser-restart-harness.v1',
    worker_generation:workerGeneration,
    restart_count:restartCount,
    worker_active:Boolean(current),
    last_lifecycle:lastLifecycle?clone(lastLifecycle):null,
    automatic_effect_replay:false,
    effect_replay_allowed:false,
    authority_neutral:true,
  });

  return Object.freeze({
    async start(rawContext){
      const ctx=context(rawContext);
      if(!current)spawn();
      const lifecycle=await current.lifecycle.afterStart(ctx,{at:clock()});
      lastLifecycle=lifecycle;
      return Object.freeze({...baseSnapshot(),company_id:ctx.company_id,lifecycle:clone(lifecycle)});
    },
    async suspend(rawContext,options={}){
      const ctx=context(rawContext);assertCompany(ctx,options,'suspend-options');
      const worker=requireWorker();
      const lifecycle=await worker.lifecycle.beforeSuspend(ctx,{...options,at:options.at??clock()});
      lastLifecycle=lifecycle;
      current=null;
      return Object.freeze(clone(lifecycle));
    },
    async restart(rawContext,options={}){
      const ctx=context(rawContext);assertCompany(ctx,options,'restart-options');
      current=null;
      restartCount+=1;
      spawn();
      const lifecycle=await current.lifecycle.afterStart(ctx,{...options,at:options.at??clock()});
      lastLifecycle=lifecycle;
      return Object.freeze({...baseSnapshot(),company_id:ctx.company_id,lifecycle:clone(lifecycle)});
    },
    async checkpoint(rawContext,input={}){
      const ctx=context(rawContext);assertCompany(ctx,input,'checkpoint');
      return requireWorker().checkpointStore.checkpoint(ctx,input);
    },
    async acknowledgeResume(rawContext,input={}){
      const ctx=context(rawContext);assertCompany(ctx,input,'acknowledge-resume');
      return requireWorker().checkpointStore.acknowledgeResume(ctx,input);
    },
    async prepareContinuation(rawContext,input={}){
      const ctx=context(rawContext);assertCompany(ctx,input,'prepare-continuation');
      return requireWorker().checkpointStore.prepareContinuation(ctx,input);
    },
    async claimContinuation(rawContext,input={}){
      const ctx=context(rawContext);assertCompany(ctx,input,'claim-continuation');
      return requireWorker().checkpointStore.claimContinuation(ctx,input);
    },
    async evaluateConflictRetry(rawContext,input={}){
      const ctx=context(rawContext);assertCompany(ctx,input,'conflict-retry');
      return requireWorker().checkpointStore.evaluateConflictRetry(ctx,input);
    },
    async receipts(rawContext,input={}){
      const ctx=context(rawContext);assertCompany(ctx,input,'receipt-query');
      return requireWorker().checkpointStore.listRestartReceipts(ctx,input);
    },
    snapshot(){ return baseSnapshot(); },
  });
}

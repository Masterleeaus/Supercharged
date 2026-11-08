const FORBIDDEN=new Set(['tenant_id','tenant_company_id','workspace_tenant_id']);
const text=(value,field)=>{const out=String(value??'').trim();if(!out)throw new Error(`${field}-required`);return out;};
function rejectLegacy(value,path='service-worker-lifecycle'){
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){value.forEach((child,index)=>rejectLegacy(child,`${path}[${index}]`));return;}
  for(const [key,child] of Object.entries(value)){
    if(FORBIDDEN.has(key))throw new Error(`legacy-company-boundary:${path}.${key}`);
    rejectLegacy(child,`${path}.${key}`);
  }
}
function ctx(raw={}){rejectLegacy(raw,'context');return Object.freeze({company_id:text(raw.company_id,'company_id'),actor_id:String(raw.actor_id||'titan-service-worker-lifecycle'),operation_id:String(raw.operation_id||'service-worker-lifecycle')});}
export function createServiceWorkerLifecycle({checkpointStore,clock=()=>Date.now()}={}){
  if(!checkpointStore?.markSuspended||!checkpointStore?.recover)throw new Error('restart-checkpoint-store-required');
  return Object.freeze({
    async beforeSuspend(rawContext,options={}){
      const context=ctx(rawContext);rejectLegacy(options,'options');
      const requested=String(options.company_id||'').trim();if(requested&&requested!==context.company_id)throw new Error('cross-company:service-worker-lifecycle');
      const operations=await checkpointStore.markSuspended(context,{reason:options.reason||'service-worker-suspend'});
      return Object.freeze({schema:'titan.offline.worker-lifecycle.v1',status:'suspended',company_id:context.company_id,at:options.at??clock(),operations,automatic_effect_replay:false,effect_replay_allowed:false,authority_neutral:true,best_effort_suspend_evidence:true});
    },
    async afterStart(rawContext,options={}){
      const context=ctx(rawContext);rejectLegacy(options,'options');
      const requested=String(options.company_id||'').trim();if(requested&&requested!==context.company_id)throw new Error('cross-company:service-worker-lifecycle');
      const recovered=await checkpointStore.recover(context);
      return Object.freeze({schema:'titan.offline.worker-lifecycle.v1',status:recovered.length?'recovery-required':'ready',company_id:context.company_id,at:options.at??clock(),recovered,requires_explicit_resume:recovered.length>0,automatic_effect_replay:false,effect_replay_allowed:false,authority_neutral:true});
    }
  });
}

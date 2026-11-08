import { createCompanyCheckpointStorage } from './checkpoint-storage.mjs';
import { createReplaySafeRecoveryStateMachine } from './recovery-state-machine.mjs';
import { createContinuationGuard } from './continuation-guard.mjs';
import { createOfflineConflictRetryPolicy } from './conflict-retry-policy.mjs';
import { createRestartEvidenceLedger } from './restart-evidence-ledger.mjs';
import { hardenCheckpointForPersistence } from './production-hardening.mjs';
import { assertAuthorityDecisionAllowsExecution, assertCurrentExecutionContextBinding } from '../titan-runtime/authority/index.mjs';
const MODULE_ID='titan.offline';
const COLLECTION='restart-checkpoints';
const clone=value=>value==null?value:globalThis.structuredClone?structuredClone(value):JSON.parse(JSON.stringify(value));
const text=(value,field)=>{const out=String(value??'').trim();if(!out)throw new Error(`${field}-required`);return out;};
const FORBIDDEN=new Set(['tenant_id','tenant_company_id','workspace_tenant_id']);
function rejectLegacy(value,path='checkpoint'){
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){value.forEach((child,index)=>rejectLegacy(child,`${path}[${index}]`));return;}
  for(const [key,child] of Object.entries(value)){
    if(FORBIDDEN.has(key))throw new Error(`legacy-company-boundary:${path}.${key}`);
    rejectLegacy(child,`${path}.${key}`);
  }
}
function context(input={}){
  rejectLegacy(input,'context');
  return Object.freeze({
    company_id:text(input.company_id,'company_id'),
    actor_id:String(input.actor_id||'titan-offline-restart').trim()||'titan-offline-restart',
    operation_id:String(input.operation_id||'restart-recovery').trim()||'restart-recovery',
  });
}
export function isTerminalRuntimeType(type){
  const value=String(type||'').toLowerCase();
  return /(?:\.complete|\.completed|\.result|\.failed|\.error|\.cancelled|\.canceled)$/.test(value);
}
export function createRestartCheckpointStore({database,clock=()=>Date.now()}={}){
  if(!database?.putRecord||!database?.getRecord||!database?.listRecords)throw new Error('business-database-required');
  const stateMachine=createReplaySafeRecoveryStateMachine();
  const continuationGuard=createContinuationGuard({clock});
  const conflictRetryPolicy=createOfflineConflictRetryPolicy({clock});
  const evidenceLedger=createRestartEvidenceLedger({database,clock});
  const storageFor=rawContext=>{const ctx=context(rawContext);return {ctx,storage:createCompanyCheckpointStorage({database,company_id:ctx.company_id,actor_id:ctx.actor_id,operation_id:ctx.operation_id})};};
  const read=async(rawContext,operation_id)=>storageFor(rawContext).storage.get(operation_id);
  const write=async(rawContext,record)=>{
    const {ctx,storage}=storageFor(rawContext); rejectLegacy(record,'checkpoint');
    const hardened=hardenCheckpointForPersistence(record,{company_id:ctx.company_id});
    const operation_id=hardened.operation_id;
    return storage.put({operation_id,data:clone(hardened),provenance:{source:'titan-offline-restart',company_id:ctx.company_id,operation_id}});
  };
  return Object.freeze({
    async checkpoint(rawContext,input={}){
      const ctx=context(rawContext); rejectLegacy(input,'checkpoint');
      const operation_id=text(input.operation_id||ctx.operation_id,'operation_id');
      const prior=await read(ctx,operation_id);
      const now=clock();
      const terminal=Boolean(input.terminal??isTerminalRuntimeType(input.type));
      const data={
        ...(prior?.data||{}),
        schema:'titan.offline.restart-checkpoint.v1',company_id:ctx.company_id,operation_id,
        correlation_id:String(input.correlation_id??prior?.data?.correlation_id??'').trim()||null,
        idempotency_key:String(input.idempotency_key??prior?.data?.idempotency_key??'').trim()||null,
        last_event_type:String(input.type??prior?.data?.last_event_type??'').trim()||null,
        state:terminal?'completed':'active',terminal,
        created_at:prior?.data?.created_at??now,updated_at:now,
        recovery_count:Number(prior?.data?.recovery_count||0),
        requires_explicit_resume:false,
        automatic_effect_replay:false,
        effect_replay_allowed:false,
        authority_neutral:true,
        requires_fresh_authority_for_effects:Boolean(input.authority_decision),
        authority_continuity:input.authority_decision?createAuthorityContinuityBinding({authority_decision:input.authority_decision,current_context:input.current_context||{}}):(prior?.data?.authority_continuity||null),
      };
      return write(ctx,data);
    },
    async pending(rawContext){
      const ctx=context(rawContext);
      const rows=await storageFor(ctx).storage.list({limit:10000,order_by:'updated_at',direction:'asc'});
      return Object.freeze(rows.filter(row=>!row.data?.terminal&&['active','recovery_required'].includes(row.data?.state)).map(row=>clone(row.data)));
    },
    async recover(rawContext){
      const ctx=context(rawContext);const rows=await this.pending(ctx);const recovered=[];
      for(const item of rows){
        const next=stateMachine.transition(item,'recover',{company_id:ctx.company_id,at:clock()});
        const lifecycleNext={...next,worker_lifecycle:'recovery_required',automatic_effect_replay:false,effect_replay_allowed:false,authority_neutral:true};
        await write(ctx,lifecycleNext);
        await evidenceLedger.record(ctx,'recovered',lifecycleNext,{state:lifecycleNext.state,worker_lifecycle:lifecycleNext.worker_lifecycle});
        recovered.push(lifecycleNext);
      }
      return Object.freeze(recovered.map(clone));
    },
    async acknowledgeResume(rawContext,{operation_id,idempotency_key=null}={}){
      const ctx=context(rawContext);const id=text(operation_id,'operation_id');const prior=await read(ctx,id);
      if(!prior?.data)throw new Error('restart-checkpoint-not-found');
      if(prior.data.terminal)throw new Error('restart-checkpoint-terminal');
      if(prior.data.state!=='recovery_required')throw new Error('restart-checkpoint-not-awaiting-resume');
      const next=stateMachine.transition(prior.data,'resume',{company_id:ctx.company_id,idempotency_key,at:clock()});
      const lifecycleNext={...next,worker_lifecycle:'resumed',automatic_effect_replay:false,effect_replay_allowed:false,authority_neutral:true};
      await write(ctx,lifecycleNext);
      await evidenceLedger.record(ctx,'resumed',lifecycleNext,{state:lifecycleNext.state,worker_lifecycle:lifecycleNext.worker_lifecycle});
      return lifecycleNext;
    },
    async markSuspended(rawContext,{reason='service-worker-suspend'}={}){
      const ctx=context(rawContext);const rows=await this.pending(ctx);const now=clock();const suspended=[];
      for(const item of rows){
        const next={...item,worker_lifecycle:'suspended',suspended_at:now,suspend_reason:String(reason||'service-worker-suspend'),suspend_count:Number(item.suspend_count||0)+1,updated_at:now,automatic_effect_replay:false,effect_replay_allowed:false,authority_neutral:true};
        await write(ctx,next);
        await evidenceLedger.record(ctx,'suspended',next,{state:next.state,worker_lifecycle:next.worker_lifecycle,reason:next.suspend_reason});
        suspended.push(next);
      }
      return Object.freeze(suspended.map(clone));
    },
    async prepareContinuation(rawContext,{operation_id,idempotency_key=null,authority_decision=null,current_context=null}={}){
      const ctx=context(rawContext);const id=text(operation_id,'operation_id');const prior=await read(ctx,id);
      if(!prior?.data)throw new Error('restart-checkpoint-not-found');
      const expected=String(prior.data.idempotency_key||'').trim();const supplied=String(idempotency_key||'').trim();
      if(expected&&expected!==supplied)throw new Error('continuation-idempotency-key-mismatch');
      const prepared=continuationGuard.prepare(prior.data,{company_id:ctx.company_id,at:clock()});
      let next=prepared;
      if(prepared.authority_continuity){
        if(!authority_decision||!current_context)throw new Error('fresh-authority-required-for-continuation');
        const continuity=assertFreshAuthorityContinuity(prepared.authority_continuity,{authority_decision,current_context,not_before:prepared.resumed_at||prepared.recovered_at||prepared.updated_at});
        next={...prepared,authority_continuity_verified:{...continuity,verified_at:clock()}};
      }
      await write(ctx,next);
      return next;
    },
    async claimContinuation(rawContext,{operation_id,idempotency_key=null,continuation_token=null,authority_decision=null,current_context=null}={}){
      const ctx=context(rawContext);const id=text(operation_id,'operation_id');const prior=await read(ctx,id);
      if(!prior?.data)throw new Error('restart-checkpoint-not-found');
      if(prior.data.authority_continuity){
        if(!authority_decision||!current_context)throw new Error('fresh-authority-required-for-continuation');
        assertFreshAuthorityContinuity(prior.data.authority_continuity,{authority_decision,current_context,not_before:prior.data.resumed_at||prior.data.recovered_at||prior.data.updated_at});
      }
      const result=continuationGuard.claim(prior.data,{company_id:ctx.company_id,idempotency_key,continuation_token,at:clock()});
      if(result.claimed){await write(ctx,result.record);await evidenceLedger.record(ctx,'continuation_claimed',result.record,{claimed:true,duplicate:false});}
      else if(result.record)await evidenceLedger.record(ctx,'continuation_duplicate',result.record,{claimed:false,duplicate:Boolean(result.duplicate)});
      return result;
    },
    async acquireDispatchFence(rawContext,{operation_id}={}){
      const ctx=context(rawContext);const id=text(operation_id,'operation_id');const prior=await read(ctx,id);
      if(!prior?.data)throw new Error('restart-checkpoint-not-found');
      if(prior.data.terminal||['cancelled','canceled','paused'].includes(String(prior.data.state||'').toLowerCase()))throw new Error('dispatch-fenced');
      const fence_version=Number(prior.data.dispatch_fence_version||0);
      return Object.freeze({schema:'titan.offline.dispatch-fence.v1',company_id:ctx.company_id,operation_id:id,fence_version,acquired_at:clock(),authority_neutral:true,grants_authority:false});
    },
    async assertDispatchFence(rawContext,{operation_id,fence_version}={}){
      const ctx=context(rawContext);const id=text(operation_id,'operation_id');const prior=await read(ctx,id);
      if(!prior?.data)throw new Error('restart-checkpoint-not-found');
      const state=String(prior.data.state||'').toLowerCase();
      if(prior.data.terminal||['cancelled','canceled','paused'].includes(state))throw new Error('dispatch-fenced');
      if(Number(prior.data.dispatch_fence_version||0)!==Number(fence_version))throw new Error('stale-dispatch-fence');
      return Object.freeze({valid:true,company_id:ctx.company_id,operation_id:id,fence_version:Number(fence_version),authority_neutral:true,grants_authority:false});
    },
    async pause(rawContext,{operation_id,reason='user_pause'}={}){
      const ctx=context(rawContext);const id=text(operation_id,'operation_id');const prior=await read(ctx,id);
      if(!prior?.data)throw new Error('restart-checkpoint-not-found');
      if(prior.data.terminal)throw new Error('restart-checkpoint-terminal');
      const now=clock();const next={...prior.data,state:'paused',worker_lifecycle:'paused',paused_at:now,pause_reason:String(reason||'user_pause'),dispatch_fence_version:Number(prior.data.dispatch_fence_version||0)+1,requires_explicit_resume:true,automatic_effect_replay:false,effect_replay_allowed:false,authority_neutral:true,updated_at:now};
      await write(ctx,next);await evidenceLedger.record(ctx,'paused',next,{reason:next.pause_reason,dispatch_fence_version:next.dispatch_fence_version});return next;
    },
    async cancel(rawContext,{operation_id,reason='user_cancel'}={}){
      const ctx=context(rawContext);const id=text(operation_id,'operation_id');const prior=await read(ctx,id);
      if(!prior?.data)throw new Error('restart-checkpoint-not-found');
      const now=clock();const next={...prior.data,state:'cancelled',terminal:true,worker_lifecycle:'cancelled',cancelled_at:now,cancel_reason:String(reason||'user_cancel'),dispatch_fence_version:Number(prior.data.dispatch_fence_version||0)+1,next_retry_at:null,requires_explicit_resume:false,automatic_effect_replay:false,effect_replay_allowed:false,authority_neutral:true,updated_at:now};
      await write(ctx,next);await evidenceLedger.record(ctx,'cancelled',next,{reason:next.cancel_reason,dispatch_fence_version:next.dispatch_fence_version});return next;
    },
    async listRestartReceipts(rawContext,{operation_id=null,limit=10000}={}){
      const ctx=context(rawContext);
      return evidenceLedger.list({company_id:ctx.company_id,operation_id,limit});
    },
    async evaluateConflictRetry(rawContext,{operation_id,failure_class,max_retries=null,base_delay_ms=null,max_delay_ms=null}={}){
      const ctx=context(rawContext);const id=text(operation_id,'operation_id');const prior=await read(ctx,id);
      if(!prior?.data)throw new Error('restart-checkpoint-not-found');
      const options={company_id:ctx.company_id,failure_class,at:clock()};
      if(max_retries!=null)options.max_retries=max_retries;
      if(base_delay_ms!=null)options.base_delay_ms=base_delay_ms;
      if(max_delay_ms!=null)options.max_delay_ms=max_delay_ms;
      const decision=conflictRetryPolicy.evaluate(prior.data,options);
      await write(ctx,decision);
      await evidenceLedger.record(ctx,'conflict_retry_decision',decision,{disposition:decision.retry_disposition||decision.disposition||null,failure_class:failure_class||null});
      return decision;
    },
  });
}


// v12 startup-budget convergence: authority continuity lives in the already-loaded restart checkpoint module.

const AUTH_CONTINUITY_FORBIDDEN=new Set(['tenant_id','tenant_company_id','workspace_tenant_id']);
const authorityText=v=>String(v??'').trim();
const authorityClone=v=>v==null?v:globalThis.structuredClone?structuredClone(v):JSON.parse(JSON.stringify(v));
function rejectAuthorityContinuityLegacy(value,path='authority_continuity'){
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){value.forEach((x,i)=>rejectAuthorityContinuityLegacy(x,`${path}[${i}]`));return;}
  for(const [k,v] of Object.entries(value)){if(AUTH_CONTINUITY_FORBIDDEN.has(k))throw new Error(`legacy-company-boundary:${path}.${k}`);rejectAuthorityContinuityLegacy(v,`${path}.${k}`);}
}
function authorityRequired(v,field){const out=authorityText(v);if(!out)throw new Error(`${field}-required`);return out;}
function authorityIsoMs(v){const n=Date.parse(String(v??''));return Number.isFinite(n)?n:null;}
export function createAuthorityContinuityBinding({authority_decision,current_context={}}={}){
  rejectAuthorityContinuityLegacy(authority_decision,'authority_continuity.decision');rejectAuthorityContinuityLegacy(current_context,'authority_continuity.context');
  if(!authority_decision||typeof authority_decision!=='object')throw new Error('authority-decision-required');
  const company_id=authorityRequired(authority_decision.company_id,'company_id');
  const worker_id=authorityRequired(authority_decision.worker_id,'worker_id');
  const capability=authorityRequired(authority_decision.capability,'capability');
  const operation_id=authorityRequired(authority_decision.operation_id,'operation_id');
  const action_id=authorityRequired(authority_decision.action_id,'action_id');
  assertAuthorityDecisionAllowsExecution(authority_decision,{company_id,worker_id,capability,operation_id,action_id});
  if(current_context.company_id)assertCurrentExecutionContextBinding({
    company_id,worker_id,
    account_id:current_context.account_id,session_id:current_context.session_id,tab_id:current_context.tab_id,
    account_revision:current_context.account_revision,context_revision:current_context.context_revision,
  },current_context);
  return Object.freeze({
    schema:'titan.offline.authority-continuity.v1',company_id,worker_id,capability,operation_id,action_id,
    prior_authority_decision_ref:authorityRequired(authority_decision.authority_decision_id,'authority_decision_id'),
    prior_autonomy_snapshot_ref:authorityText(authority_decision.autonomy_snapshot_id)||null,
    prior_delegation_ref:authorityText(authority_decision.authority_delegation?.delegation_id)||null,
    prior_evaluated_at:authorityRequired(authority_decision.evaluated_at,'authority_evaluated_at'),
    context_binding:Object.freeze({
      account_id:authorityText(current_context.account_id)||null,session_id:authorityText(current_context.session_id)||null,
      tab_id:authorityText(current_context.tab_id)||null,account_revision:authorityText(current_context.account_revision)||null,
      context_revision:authorityText(current_context.context_revision)||null,
    }),
    authority_neutral:true,grants_authority:false,requires_fresh_authority_for_effects:true,
  });
}
export function assertFreshAuthorityContinuity(binding,{authority_decision,current_context={},not_before}={}){
  rejectAuthorityContinuityLegacy(binding,'authority_continuity.binding');rejectAuthorityContinuityLegacy(authority_decision,'authority_continuity.decision');rejectAuthorityContinuityLegacy(current_context,'authority_continuity.context');
  if(!binding||binding.schema!=='titan.offline.authority-continuity.v1')throw new Error('authority-continuity-binding-required');
  const company_id=authorityRequired(binding.company_id,'company_id');
  assertAuthorityDecisionAllowsExecution(authority_decision,{
    company_id,worker_id:binding.worker_id,capability:binding.capability,operation_id:binding.operation_id,action_id:binding.action_id,
  });
  const evaluated=authorityIsoMs(authority_decision.evaluated_at);const threshold=authorityIsoMs(not_before);
  if(evaluated==null)throw new Error('fresh-authority-evaluated-at-invalid');
  if(threshold!=null&&evaluated<threshold)throw new Error('fresh-authority-precedes-resume');
  const expected={company_id,worker_id:binding.worker_id,...authorityClone(binding.context_binding)};
  assertCurrentExecutionContextBinding(expected,current_context);
  return Object.freeze({valid:true,company_id,operation_id:binding.operation_id,action_id:binding.action_id,capability:binding.capability,
    prior_authority_decision_ref:binding.prior_authority_decision_ref,current_authority_decision_ref:authority_decision.authority_decision_id,
    authority_neutral:true,grants_authority:false});
}

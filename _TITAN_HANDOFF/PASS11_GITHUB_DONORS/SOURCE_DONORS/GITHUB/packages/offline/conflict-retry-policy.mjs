const FORBIDDEN=new Set(['tenant_id','tenant_company_id','workspace_tenant_id']);
const clone=value=>value==null?value:globalThis.structuredClone?structuredClone(value):JSON.parse(JSON.stringify(value));
const text=(value,field)=>{const out=String(value??'').trim();if(!out)throw new Error(`${field}-required`);return out;};
function rejectLegacy(value,path='retry-policy'){
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){value.forEach((child,index)=>rejectLegacy(child,`${path}[${index}]`));return;}
  for(const [key,child] of Object.entries(value)){
    if(FORBIDDEN.has(key))throw new Error(`legacy-company-boundary:${path}.${key}`);
    rejectLegacy(child,`${path}.${key}`);
  }
}
const TRANSIENT=new Set(['network_unavailable','timeout_before_dispatch','provider_unavailable','rate_limited','offline']);
const CONFLICT=new Set(['stale_state_conflict','version_conflict','concurrent_update']);
const AMBIGUOUS=new Set(['unknown_effect_outcome','timeout_after_dispatch','provider_response_lost','effect_status_unknown']);
const BLOCKED=new Set(['authority_denied','validation_failed','policy_denied','terminal_failure','cancelled']);
function delayFor(retryCount,baseDelayMs,maxDelayMs){
  const exp=Math.max(0,Math.min(10,retryCount-1));
  return Math.min(maxDelayMs,baseDelayMs*(2**exp));
}
export function createOfflineConflictRetryPolicy({clock=()=>Date.now(),base_delay_ms=1000,max_delay_ms=60000,max_retries=5}={}){
  return Object.freeze({
    evaluate(rawRecord,options={}){
      rejectLegacy(rawRecord,'retry.record'); rejectLegacy(options,'retry.options');
      const record=clone(rawRecord); const company_id=text(record.company_id,'company_id');
      const requested=String(options.company_id??'').trim(); if(requested&&requested!==company_id)throw new Error('cross-company:retry-policy');
      const failure_class=text(options.failure_class,'failure_class').toLowerCase();
      const at=Number(options.at??clock());
      const retryCount=Number(record.retry_count||0);
      const retryMax=Number(options.max_retries??max_retries);
      let disposition='manual_review_required',retryAllowed=false,nextRetryAt=null,requiresReview=true;
      if(record.terminal){disposition='blocked';requiresReview=false;}
      else if(TRANSIENT.has(failure_class)){
        if(retryCount>=retryMax){disposition='retry_exhausted';}
        else {disposition='retry_scheduled';retryAllowed=true;requiresReview=false;nextRetryAt=at+delayFor(retryCount+1,Number(options.base_delay_ms??base_delay_ms),Number(options.max_delay_ms??max_delay_ms));}
      } else if(CONFLICT.has(failure_class)){disposition='conflict_review_required';}
      else if(AMBIGUOUS.has(failure_class)){disposition='manual_review_required';}
      else if(BLOCKED.has(failure_class)){disposition='blocked';requiresReview=false;}
      const nextRetryCount=retryAllowed?retryCount+1:retryCount;
      return Object.freeze({
        ...record,
        retry_policy_schema:'titan.offline.conflict-retry.v1',
        failure_class,disposition,retry_allowed:retryAllowed,retry_count:nextRetryCount,max_retries:retryMax,
        retry_evaluated_at:at,next_retry_at:nextRetryAt,requires_review:requiresReview,
        requires_explicit_resume:true,automatic_effect_replay:false,effect_replay_allowed:false,authority_neutral:true,
      });
    }
  });
}

const FORBIDDEN=new Set(['tenant_id','tenant_company_id','workspace_tenant_id']);
const clone=value=>value==null?value:globalThis.structuredClone?structuredClone(value):JSON.parse(JSON.stringify(value));
const text=(value,field)=>{const out=String(value??'').trim();if(!out)throw new Error(`${field}-required`);return out;};
function rejectLegacy(value,path='recovery-state'){
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){value.forEach((child,index)=>rejectLegacy(child,`${path}[${index}]`));return;}
  for(const [key,child] of Object.entries(value)){
    if(FORBIDDEN.has(key))throw new Error(`legacy-company-boundary:${path}.${key}`);
    rejectLegacy(child,`${path}.${key}`);
  }
}
function normalize(record){
  rejectLegacy(record,'recovery-state.record');
  const company_id=text(record?.company_id,'company_id');
  const operation_id=text(record?.operation_id,'operation_id');
  return {...clone(record),company_id,operation_id,state:String(record?.state||'active').trim()||'active',terminal:Boolean(record?.terminal),automatic_effect_replay:false,effect_replay_allowed:false,authority_neutral:true};
}
function assertContextCompany(record,options={}){
  rejectLegacy(options,'recovery-state.options');
  const requested=String(options.company_id??'').trim();
  if(requested&&requested!==record.company_id)throw new Error('cross-company:recovery-state');
}
export function createReplaySafeRecoveryStateMachine(){
  return Object.freeze({
    transition(rawRecord,event,options={}){
      const record=normalize(rawRecord);assertContextCompany(record,options);
      const action=text(event,'transition');
      const at=options.at??Date.now();
      if(record.terminal&&action!=='observe')throw new Error('restart-checkpoint-terminal');
      if(action==='recover'){
        if(!['active','recovery_required','resumed'].includes(record.state))throw new Error(`illegal-transition:${record.state}->recover`);
        return Object.freeze({...record,state:'recovery_required',terminal:false,recovered_at:at,updated_at:at,recovery_count:Number(record.recovery_count||0)+1,requires_explicit_resume:true,automatic_effect_replay:false,effect_replay_allowed:false,authority_neutral:true});
      }
      if(action==='resume'){
        if(record.state!=='recovery_required')throw new Error(`illegal-transition:${record.state}->resume`);
        const expected=String(record.idempotency_key||'').trim();
        const supplied=String(options.idempotency_key||'').trim();
        if(expected&&expected!==supplied)throw new Error('restart-idempotency-key-mismatch');
        return Object.freeze({...record,state:'resumed',terminal:false,resumed_at:at,updated_at:at,requires_explicit_resume:false,automatic_effect_replay:false,effect_replay_allowed:false,authority_neutral:true});
      }
      if(action==='complete'){
        if(!['active','resumed','recovery_required'].includes(record.state))throw new Error(`illegal-transition:${record.state}->complete`);
        return Object.freeze({...record,state:'completed',terminal:true,completed_at:at,updated_at:at,requires_explicit_resume:false,automatic_effect_replay:false,effect_replay_allowed:false,authority_neutral:true});
      }
      if(action==='observe')return Object.freeze(record);
      throw new Error(`unsupported-transition:${action}`);
    },
  });
}

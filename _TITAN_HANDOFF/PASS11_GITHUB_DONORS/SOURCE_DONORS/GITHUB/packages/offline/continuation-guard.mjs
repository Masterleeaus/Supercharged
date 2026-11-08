const FORBIDDEN=new Set(['tenant_id','tenant_company_id','workspace_tenant_id']);
const clone=value=>value==null?value:globalThis.structuredClone?structuredClone(value):JSON.parse(JSON.stringify(value));
const text=(value,field)=>{const out=String(value??'').trim();if(!out)throw new Error(`${field}-required`);return out;};
function rejectLegacy(value,path='continuation'){
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){value.forEach((child,index)=>rejectLegacy(child,`${path}[${index}]`));return;}
  for(const [key,child] of Object.entries(value)){
    if(FORBIDDEN.has(key))throw new Error(`legacy-company-boundary:${path}.${key}`);
    rejectLegacy(child,`${path}.${key}`);
  }
}
function assertCompany(record,options={}){
  rejectLegacy(options,'continuation.options');
  const requested=String(options.company_id??'').trim();
  if(requested&&requested!==record.company_id)throw new Error('cross-company:continuation');
}
function tokenFor(record){
  const company_id=encodeURIComponent(text(record.company_id,'company_id'));
  const operation_id=encodeURIComponent(text(record.operation_id,'operation_id'));
  const idempotency_key=encodeURIComponent(text(record.idempotency_key,'idempotency_key'));
  const generation=Number(record.recovery_count||0);
  return `titan-cont:${company_id}:${operation_id}:${idempotency_key}:${generation}`;
}
export function createContinuationGuard({clock=()=>Date.now()}={}){
  return Object.freeze({
    prepare(rawRecord,options={}){
      rejectLegacy(rawRecord,'continuation.record');
      const record=clone(rawRecord);assertCompany(record,options);
      if(record.terminal)throw new Error('continuation-terminal');
      if(record.state!=='resumed')throw new Error('continuation-requires-resumed-state');
      const token=tokenFor(record);const at=options.at??clock();
      return Object.freeze({...record,continuation_token:token,continuation_pending:true,continuation_claimed:false,continuation_prepared_at:at,continuation_claimed_at:null,automatic_effect_replay:false,effect_replay_allowed:false,authority_neutral:true});
    },
    claim(rawRecord,options={}){
      rejectLegacy(rawRecord,'continuation.record');
      const record=clone(rawRecord);assertCompany(record,options);
      const expectedIdempotency=text(record.idempotency_key,'idempotency_key');
      const suppliedIdempotency=text(options.idempotency_key,'idempotency_key');
      if(expectedIdempotency!==suppliedIdempotency)throw new Error('continuation-idempotency-key-mismatch');
      const expectedToken=text(record.continuation_token,'continuation_token');
      const suppliedToken=text(options.continuation_token,'continuation_token');
      if(expectedToken!==suppliedToken)throw new Error('continuation-token-mismatch');
      if(record.continuation_claimed===true||record.continuation_pending===false){
        return Object.freeze({claimed:false,duplicate:true,record:Object.freeze({...record,automatic_effect_replay:false,effect_replay_allowed:false,authority_neutral:true})});
      }
      if(record.state!=='resumed')throw new Error('continuation-requires-resumed-state');
      const at=options.at??clock();
      const next=Object.freeze({...record,continuation_pending:false,continuation_claimed:true,continuation_claimed_at:at,updated_at:at,automatic_effect_replay:false,effect_replay_allowed:false,authority_neutral:true});
      return Object.freeze({claimed:true,duplicate:false,record:next});
    },
  });
}

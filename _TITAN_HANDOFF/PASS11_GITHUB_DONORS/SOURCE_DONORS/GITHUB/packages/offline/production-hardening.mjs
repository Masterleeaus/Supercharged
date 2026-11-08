const FORBIDDEN=new Set(['tenant_id','tenant_company_id','workspace_tenant_id']);
const VALID_STATES=new Set(['active','recovery_required','resumed','paused','cancelled','completed']);
const EXPECTED_SCHEMA='titan.offline.restart-checkpoint.v1';
const clone=v=>v==null?v:globalThis.structuredClone?structuredClone(v):JSON.parse(JSON.stringify(v));
const text=(v,f)=>{const out=String(v??'').trim();if(!out)throw new Error(`${f}-required`);return out;};
function walk(value,path='checkpoint'){
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){value.forEach((v,i)=>walk(v,`${path}[${i}]`));return;}
  for(const [k,v] of Object.entries(value)){
    if(FORBIDDEN.has(k))throw new Error(`legacy-company-boundary:${path}.${k}`);
    walk(v,`${path}.${k}`);
  }
}
export function hardenCheckpointForPersistence(record,{company_id}={}){
  if(!record||typeof record!=='object'||Array.isArray(record))throw new Error('checkpoint-invalid');
  walk(record);
  const company=text(company_id,'company_id');
  if(record.company_id!=null&&String(record.company_id).trim()!==company)throw new Error('cross-company:checkpoint.company_id');
  const operation_id=text(record.operation_id,'operation_id');
  if(record.authority_neutral===false)throw new Error('checkpoint-corrupt:authority-neutral-false');
  if(record.automatic_effect_replay===true)throw new Error('checkpoint-corrupt:automatic-effect-replay-true');
  if(record.effect_replay_allowed===true)throw new Error('checkpoint-corrupt:effect-replay-allowed-true');
  if(String(record.schema||'').trim()!==EXPECTED_SCHEMA)throw new Error('checkpoint-corrupt:schema-mismatch');
  const state=String(record.state||'').trim();
  if(!VALID_STATES.has(state))throw new Error('checkpoint-corrupt:state-invalid');
  if(record.terminal===true&&!['completed','cancelled'].includes(state))throw new Error('checkpoint-corrupt:terminal-state-mismatch');
  if(['completed','cancelled'].includes(state)&&record.terminal!==true)throw new Error('checkpoint-corrupt:completed-terminal-mismatch');
  if(state==='recovery_required'&&record.requires_explicit_resume!==true)throw new Error('checkpoint-corrupt:recovery-resume-invariant');
  return Object.freeze({...clone(record),company_id:company,operation_id,authority_neutral:true,automatic_effect_replay:false,effect_replay_allowed:false});
}
export const PRODUCTION_HARDENING_SCHEMA=EXPECTED_SCHEMA;

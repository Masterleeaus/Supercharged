const FORBIDDEN=new Set(['tenant_id','tenant_company_id','workspace_tenant_id']);
const VALID_STATES=new Set(['active','recovery_required','resumed','paused','cancelled','completed']);
const EXPECTED_SCHEMA='titan.offline.restart-checkpoint.v1';
const text=value=>String(value??'').trim();
function walk(value,visitor,path='checkpoint'){
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){value.forEach((child,index)=>walk(child,visitor,`${path}[${index}]`));return;}
  for(const [key,child] of Object.entries(value)){visitor(key,child,`${path}.${key}`);walk(child,visitor,`${path}.${key}`);}
}
function corruption(reason){throw new Error(`checkpoint-corrupt:${reason}`);}
function isRestartCheckpoint(data={}){
  return data.schema!=null||data.recovery_count!=null||data.requires_explicit_resume!=null||data.automatic_effect_replay!=null||data.effect_replay_allowed!=null||data.last_event_type!=null||data.worker_lifecycle!=null;
}
export function validateCheckpointRow(row,{company_id}={}){
  if(!row||typeof row!=='object')corruption('row-invalid');
  const company=text(company_id); if(!company)throw new Error('company_id-required');
  if(text(row.company_id)!==company)corruption('row-company-mismatch');
  const recordId=text(row.record_id); if(!recordId)corruption('record-id-missing');
  const data=row.data; if(!data||typeof data!=='object'||Array.isArray(data))corruption('data-invalid');
  walk(data,(key,child,path)=>{
    if(FORBIDDEN.has(key))throw new Error(`legacy-company-boundary:${path}`);
    if(key==='company_id'&&child!=null&&text(child)!==company)corruption(`company-mismatch:${path}`);
  },'checkpoint.data');
  if(text(data.operation_id)!==recordId)corruption('operation-id-mismatch');
  if(data.authority_neutral===false)corruption('authority-neutral-false');
  if(data.automatic_effect_replay===true)corruption('automatic-effect-replay-true');
  if(data.effect_replay_allowed===true)corruption('effect-replay-allowed-true');
  if(isRestartCheckpoint(data)){
    if(text(data.schema)!==EXPECTED_SCHEMA)corruption('schema-mismatch');
    if(!VALID_STATES.has(text(data.state)))corruption('state-invalid');
    if(data.terminal===true&&!['completed','cancelled'].includes(text(data.state)))corruption('terminal-state-mismatch');
    if(['completed','cancelled'].includes(text(data.state))&&data.terminal!==true)corruption('completed-terminal-mismatch');
    if(text(data.state)==='recovery_required'&&data.requires_explicit_resume!==true)corruption('recovery-resume-invariant');
  }
  return row;
}
export const RESTART_CHECKPOINT_SCHEMA=EXPECTED_SCHEMA;

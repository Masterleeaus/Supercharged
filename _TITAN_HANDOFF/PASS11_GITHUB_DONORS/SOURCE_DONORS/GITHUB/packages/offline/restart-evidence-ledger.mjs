const MODULE_ID='titan.offline';
const COLLECTION='restart-receipts';
const FORBIDDEN=new Set(['tenant_id','tenant_company_id','workspace_tenant_id']);
const clone=v=>v==null?v:globalThis.structuredClone?structuredClone(v):JSON.parse(JSON.stringify(v));
const text=(v,f)=>{const s=String(v??'').trim();if(!s)throw new Error(`${f}-required`);return s;};
function rejectLegacy(v,path='restart-receipt'){
  if(!v||typeof v!=='object')return;
  if(Array.isArray(v)){v.forEach((x,i)=>rejectLegacy(x,`${path}[${i}]`));return;}
  for(const [k,x] of Object.entries(v)){if(FORBIDDEN.has(k))throw new Error(`legacy-company-boundary:${path}.${k}`);rejectLegacy(x,`${path}.${k}`);}
}
function assertCompany(v,company_id,path='restart-receipt'){
  if(!v||typeof v!=='object')return;
  if(Array.isArray(v)){v.forEach((x,i)=>assertCompany(x,company_id,`${path}[${i}]`));return;}
  for(const [k,x] of Object.entries(v)){if(k==='company_id'&&x!=null&&String(x).trim()!==company_id)throw new Error(`cross-company:${path}.company_id`);assertCompany(x,company_id,`${path}.${k}`);}
}
function stableHash(input){let h=2166136261;for(const c of String(input)){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}return (h>>>0).toString(16).padStart(8,'0');}
export function createRestartEvidenceLedger({database,clock=()=>Date.now()}={}){
  if(!database?.putRecord||!database?.listRecords)throw new Error('business-database-required');
  return Object.freeze({
    async record(rawContext,kind,checkpoint={},details={}){
      rejectLegacy(rawContext,'restart-receipt.context');rejectLegacy(checkpoint);rejectLegacy(details,'restart-receipt.details');
      const company_id=text(rawContext?.company_id,'company_id');assertCompany(checkpoint,company_id);assertCompany(details,company_id,'restart-receipt.details');
      const operation_id=text(checkpoint.operation_id,'operation_id');const at=clock();const recovery_count=Number(checkpoint.recovery_count||0);
      const receipt_id=`rr_${stableHash([company_id,operation_id,kind,recovery_count,at].join('|'))}_${at}`;
      const receipt={schema:'titan.offline.restart-receipt.v1',receipt_id,company_id,operation_id,kind:text(kind,'receipt_kind'),recovery_count,idempotency_key:String(checkpoint.idempotency_key||'').trim()||null,checkpoint_state:String(details.state||checkpoint.state||'').trim()||null,created_at:at,details:clone(details),grants_authority:false,authority_neutral:true,automatic_effect_replay:false,effect_replay_allowed:false};
      await database.putRecord({company_id,actor_id:'titan-offline-receipts',operation_id},{module_id:MODULE_ID,collection:COLLECTION,record_id:receipt_id,data:receipt,provenance:{source:'titan-offline-restart-evidence',company_id,operation_id}});
      return Object.freeze(clone(receipt));
    },
    async list({company_id,operation_id=null,limit=10000}={}){
      const cid=text(company_id,'company_id');const rows=await database.listRecords({company_id:cid,actor_id:'titan-offline-receipts',operation_id:operation_id||'receipt-list'},{module_id:MODULE_ID,collection:COLLECTION,limit,order_by:'updated_at',direction:'asc'});
      const scoped=rows.filter(r=>String(r.company_id||'').trim()===cid).map(r=>clone(r.data)).filter(r=>!operation_id||r.operation_id===operation_id);
      if(scoped.length!==rows.filter(r=>!operation_id||r.data?.operation_id===operation_id).length)throw new Error('cross-company:restart-receipt.list');
      return Object.freeze(scoped);
    }
  });
}
export const RESTART_RECEIPT_COLLECTION=COLLECTION;

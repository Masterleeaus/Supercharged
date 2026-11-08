import { validateCheckpointRow } from './checkpoint-integrity.mjs';
const MODULE_ID='titan.offline';
const COLLECTION='restart-checkpoints';
const FORBIDDEN=new Set(['tenant_id','tenant_company_id','workspace_tenant_id']);
const clone=value=>value==null?value:globalThis.structuredClone?structuredClone(value):JSON.parse(JSON.stringify(value));
const text=(value,field)=>{const out=String(value??'').trim();if(!out)throw new Error(`${field}-required`);return out;};
function rejectLegacy(value,path='checkpoint-storage'){
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){value.forEach((child,index)=>rejectLegacy(child,`${path}[${index}]`));return;}
  for(const [key,child] of Object.entries(value)){
    if(FORBIDDEN.has(key))throw new Error(`legacy-company-boundary:${path}.${key}`);
    rejectLegacy(child,`${path}.${key}`);
  }
}
function assertCompany(value,company_id,path='checkpoint-storage'){
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){value.forEach((child,index)=>assertCompany(child,company_id,`${path}[${index}]`));return;}
  for(const [key,child] of Object.entries(value)){
    if(key==='company_id'&&child!=null&&String(child).trim()!==company_id)throw new Error(`cross-company:${path}.company_id`);
    assertCompany(child,company_id,`${path}.${key}`);
  }
}
function locator(operation_id){return {module_id:MODULE_ID,collection:COLLECTION,record_id:text(operation_id,'operation_id')};}
export function createCompanyCheckpointStorage({database,company_id,actor_id='titan-offline-storage',operation_id='checkpoint-storage'}={}){
  if(!database?.putRecord||!database?.getRecord||!database?.listRecords)throw new Error('business-database-required');
  const boundCompanyId=text(company_id,'company_id');
  const baseContext=Object.freeze({company_id:boundCompanyId,actor_id:String(actor_id||'titan-offline-storage').trim()||'titan-offline-storage',operation_id:String(operation_id||'checkpoint-storage').trim()||'checkpoint-storage'});
  const api={
    company_id:boundCompanyId,
    authority_neutral:true,
    async put({operation_id:recordOperationId,data={},provenance={}}={}){
      rejectLegacy(data,'checkpoint-storage.data');rejectLegacy(provenance,'checkpoint-storage.provenance');
      assertCompany(data,boundCompanyId,'checkpoint-storage.data');assertCompany(provenance,boundCompanyId,'checkpoint-storage.provenance');
      const id=text(recordOperationId,'operation_id');
      return database.putRecord(baseContext,{...locator(id),data:{...clone(data),company_id:boundCompanyId,operation_id:id,authority_neutral:true},provenance:{...clone(provenance),company_id:boundCompanyId,operation_id:id,source:provenance?.source||'titan-offline-checkpoint-storage'}});
    },
    async get(recordOperationId){
      const row=await database.getRecord(baseContext,locator(recordOperationId),{includeDeleted:true});
      if(!row)return null;
      if(String(row.company_id||'').trim()!==boundCompanyId)throw new Error('cross-company:checkpoint-storage.row');
      if(row.data?.company_id&&String(row.data.company_id).trim()!==boundCompanyId)throw new Error('cross-company:checkpoint-storage.row.data');
      validateCheckpointRow(row,{company_id:boundCompanyId});
      return clone(row);
    },
    async list({limit=10000,order_by='updated_at',direction='asc'}={}){
      const rows=await database.listRecords(baseContext,{module_id:MODULE_ID,collection:COLLECTION,limit,order_by,direction});
      const scoped=rows.filter(row=>String(row.company_id||'').trim()===boundCompanyId);
      if(scoped.length!==rows.length)throw new Error('cross-company:checkpoint-storage.list');
      for(const row of scoped){
        if(row.data?.company_id&&String(row.data.company_id).trim()!==boundCompanyId)throw new Error('cross-company:checkpoint-storage.list.data');
        validateCheckpointRow(row,{company_id:boundCompanyId});
      }
      return Object.freeze(scoped.map(clone));
    },
  };
  return Object.freeze(api);
}
export const CHECKPOINT_STORAGE_MODULE_ID=MODULE_ID;
export const CHECKPOINT_STORAGE_COLLECTION=COLLECTION;

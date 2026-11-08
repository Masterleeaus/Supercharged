const MODULE_ID='titan.offline';
const COLLECTION='execution-receipts';
const FORBIDDEN=new Set(['tenant_id','tenant_company_id','workspace_tenant_id']);
const clone=value=>value==null?value:(globalThis.structuredClone?structuredClone(value):JSON.parse(JSON.stringify(value)));
const text=(value,field)=>{const out=String(value??'').trim();if(!out)throw new Error(`${field}-required`);return out;};
function rejectLegacy(value,path='execution-receipt'){
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){value.forEach((child,index)=>rejectLegacy(child,`${path}[${index}]`));return;}
  for(const [key,child] of Object.entries(value)){if(FORBIDDEN.has(key))throw new Error(`legacy-company-boundary:${path}.${key}`);rejectLegacy(child,`${path}.${key}`);}
}
function assertCompany(value,company_id,path='execution-receipt'){
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){value.forEach((child,index)=>assertCompany(child,company_id,`${path}[${index}]`));return;}
  for(const [key,child] of Object.entries(value)){if(key==='company_id'&&child!=null&&String(child).trim()!==company_id)throw new Error(`cross-company:${path}`);assertCompany(child,company_id,`${path}.${key}`);}
}
function context(company_id,actor_id,operation_id){return Object.freeze({company_id,actor_id,operation_id});}
function locator(receipt_id){return {module_id:MODULE_ID,collection:COLLECTION,record_id:text(receipt_id,'receipt_id')};}
function rid(){return globalThis.crypto?.randomUUID?.()||`receipt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;}
const TERMINAL=new Set(['committed','acknowledged','failed','cancelled']);
export function createCompanyExecutionReceiptStore({database,company_id,actor_id='titan-offline-receipts',clock=()=>Date.now()}={}){
  if(!database?.putRecord||!database?.getRecord||!database?.listRecords)throw new Error('business-database-required');
  const boundCompanyId=text(company_id,'company_id');
  const actor=String(actor_id||'titan-offline-receipts').trim()||'titan-offline-receipts';
  const api={
    company_id:boundCompanyId, authority_neutral:true,
    async prepare(input={}){
      rejectLegacy(input); assertCompany(input,boundCompanyId);
      const operation_id=text(input.operation_id,'operation_id'); const step_token=text(input.step_token,'step_token'); const marker=text(input.marker,'marker');
      const existing=(await api.list({operation_id})).find(row=>row.data?.step_token===step_token&&!TERMINAL.has(String(row.data?.state||'')));
      if(existing)return clone(existing);
      const receipt_id=String(input.receipt_id||rid()); const now=clock();
      const data={schema:'titan.offline.execution-receipt.v1',company_id:boundCompanyId,receipt_id,operation_id,step_token,marker,
        state:'prepared',attempt:Number(input.attempt)||1,tab_id:Number.isInteger(Number(input.tab_id))?Number(input.tab_id):null,
        created_at:now,updated_at:now,submitted_at:null,acknowledged_at:null,committed_at:null,evidence:null,error:null,
        authority_neutral:true,grants_authority:false};
      return database.putRecord(context(boundCompanyId,actor,operation_id),{...locator(receipt_id),data,provenance:{company_id:boundCompanyId,operation_id,source:'titan-offline-execution-receipts'}});
    },
    async transition(receipt_id,state,patch={}){
      rejectLegacy(patch); assertCompany(patch,boundCompanyId);
      const prior=await api.get(receipt_id); if(!prior)throw new Error('receipt-not-found');
      const operation_id=text(prior.data?.operation_id,'operation_id'); const nextState=text(state,'state'); const now=clock();
      const stamps={}; if(nextState==='submitted')stamps.submitted_at=now; if(nextState==='acknowledged')stamps.acknowledged_at=now; if(nextState==='committed')stamps.committed_at=now;
      const data={...clone(prior.data),...clone(patch),...stamps,state:nextState,updated_at:now,company_id:boundCompanyId,authority_neutral:true,grants_authority:false};
      return database.putRecord(context(boundCompanyId,actor,operation_id),{...locator(receipt_id),data,provenance:{company_id:boundCompanyId,operation_id,source:'titan-offline-execution-receipts-transition'}});
    },
    async get(receipt_id){
      const row=await database.getRecord(context(boundCompanyId,actor,'receipt-read'),locator(receipt_id),{includeDeleted:true});
      if(!row)return null; if(String(row.company_id||'').trim()!==boundCompanyId||String(row.data?.company_id||'').trim()!==boundCompanyId)throw new Error('cross-company:execution-receipt-row'); return clone(row);
    },
    async list({operation_id=null,state=null,limit=10000}={}){
      const rows=await database.listRecords(context(boundCompanyId,actor,'receipt-list'),{module_id:MODULE_ID,collection:COLLECTION,limit,order_by:'updated_at',direction:'desc'});
      const scoped=rows.filter(row=>String(row.company_id||'').trim()===boundCompanyId&&String(row.data?.company_id||'').trim()===boundCompanyId);
      if(scoped.length!==rows.length)throw new Error('cross-company:execution-receipt-list');
      return scoped.filter(row=>(operation_id==null||String(row.data?.operation_id||'')===String(operation_id))&&(state==null||String(row.data?.state||'')===String(state))).map(clone);
    }
  };
  return Object.freeze(api);
}
export const EXECUTION_RECEIPT_MODULE_ID=MODULE_ID;
export const EXECUTION_RECEIPT_COLLECTION=COLLECTION;

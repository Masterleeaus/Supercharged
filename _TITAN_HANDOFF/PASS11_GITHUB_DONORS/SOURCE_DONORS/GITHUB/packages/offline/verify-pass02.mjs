import assert from 'node:assert/strict';
import { createCompanyCheckpointStorage } from './checkpoint-storage.mjs';

function memoryDb(){
  const rows=new Map();
  return {
    async putRecord(ctx,input){
      const key=`${ctx.company_id}|${input.module_id}|${input.collection}|${input.record_id}`;
      const value={company_id:ctx.company_id,module_id:input.module_id,collection:input.collection,record_id:input.record_id,data:structuredClone(input.data),provenance:structuredClone(input.provenance)};
      rows.set(key,value); return structuredClone(value);
    },
    async getRecord(ctx,loc){return structuredClone(rows.get(`${ctx.company_id}|${loc.module_id}|${loc.collection}|${loc.record_id}`)||null);},
    async listRecords(ctx,q){return [...rows.values()].filter(r=>r.company_id===ctx.company_id&&r.module_id===q.module_id&&r.collection===q.collection).map(x=>structuredClone(x));},
  };
}

const db=memoryDb();
const companyA=createCompanyCheckpointStorage({database:db,company_id:'company-a'});
const companyB=createCompanyCheckpointStorage({database:db,company_id:'company-b'});
await companyA.put({operation_id:'op-1',data:{state:'active',company_id:'company-a'}});
assert.equal((await companyA.get('op-1')).data.state,'active');
assert.equal(await companyB.get('op-1'),null,'same operation id in another company must not be visible');
await companyB.put({operation_id:'op-1',data:{state:'other-company',company_id:'company-b'}});
assert.equal((await companyA.get('op-1')).data.state,'active');
assert.equal((await companyB.get('op-1')).data.state,'other-company');
assert.equal((await companyA.list()).length,1);
assert.equal((await companyB.list()).length,1);
await assert.rejects(()=>companyA.put({operation_id:'bad',data:{company_id:'company-b'}}),/cross-company/i);
await assert.rejects(()=>companyA.put({operation_id:'legacy',data:{tenant_id:'legacy'}}),/legacy-company-boundary/i);
assert.equal(companyA.company_id,'company-a');
assert.equal(companyA.authority_neutral,true);
console.log('TZ-WP-003 Pass 2 company-scoped checkpoint storage PASS');

import assert from 'node:assert/strict';
import { createRestartEvidenceLedger } from './restart-evidence-ledger.mjs';

class MemoryDb {
  constructor(){ this.rows=[]; }
  async putRecord(ctx,input){
    const row={...input,company_id:ctx.company_id,updated_at:Date.now()};
    const i=this.rows.findIndex(r=>r.company_id===ctx.company_id&&r.module_id===input.module_id&&r.collection===input.collection&&r.record_id===input.record_id);
    if(i>=0)this.rows[i]=structuredClone(row); else this.rows.push(structuredClone(row));
    return structuredClone(row);
  }
  async getRecord(ctx,loc){ return structuredClone(this.rows.find(r=>r.company_id===ctx.company_id&&r.module_id===loc.module_id&&r.collection===loc.collection&&r.record_id===loc.record_id)||null); }
  async listRecords(ctx,q){ return structuredClone(this.rows.filter(r=>r.company_id===ctx.company_id&&r.module_id===q.module_id&&r.collection===q.collection)); }
}

const db=new MemoryDb(); let now=1000;
const ledger=createRestartEvidenceLedger({database:db,clock:()=>++now});
const base={company_id:'co-a',operation_id:'op-1',recovery_count:2,idempotency_key:'idem-1',authority_neutral:true};
const r1=await ledger.record({company_id:'co-a'},'recovered',base,{state:'recovery_required'});
assert.equal(r1.company_id,'co-a');
assert.equal(r1.grants_authority,false);
assert.equal(r1.effect_replay_allowed,false);
assert.equal(r1.automatic_effect_replay,false);
assert.equal(r1.recovery_count,2);
const r2=await ledger.record({company_id:'co-a'},'resumed',base,{state:'resumed'});
assert.notEqual(r1.receipt_id,r2.receipt_id);
const rows=await ledger.list({company_id:'co-a',operation_id:'op-1'});
assert.equal(rows.length,2);
await assert.rejects(()=>ledger.record({company_id:'co-a'},'recovered',{...base,company_id:'co-b'}),/cross-company/);
await assert.rejects(()=>ledger.record({company_id:'co-a'},'recovered',{...base,tenant_id:'legacy'}),/legacy-company-boundary/);
console.log('Pass07 restart evidence ledger PASS');

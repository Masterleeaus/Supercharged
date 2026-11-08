import assert from 'node:assert/strict';
import { createDeterministicBrowserRestartHarness } from './browser-restart-harness.mjs';

class MemoryDb {
  constructor(){ this.rows=[]; }
  async putRecord(ctx,input){
    const row={...structuredClone(input),company_id:ctx.company_id,updated_at:input.updated_at??0};
    const i=this.rows.findIndex(r=>r.company_id===ctx.company_id&&r.module_id===input.module_id&&r.collection===input.collection&&r.record_id===input.record_id);
    if(i>=0)this.rows[i]=structuredClone(row); else this.rows.push(structuredClone(row));
    return structuredClone(row);
  }
  async getRecord(ctx,loc){ return structuredClone(this.rows.find(r=>r.company_id===ctx.company_id&&r.module_id===loc.module_id&&r.collection===loc.collection&&r.record_id===loc.record_id)||null); }
  async listRecords(ctx,q){ return structuredClone(this.rows.filter(r=>r.company_id===ctx.company_id&&r.module_id===q.module_id&&r.collection===q.collection)); }
  mutate(company_id,record_id,fn){ const row=this.rows.find(r=>r.company_id===company_id&&r.record_id===record_id); if(!row)throw new Error('row-not-found'); fn(row); }
}

let now=5000;
const db=new MemoryDb();
const ctx={company_id:'co-a',actor_id:'tester',operation_id:'op-multi'};
let harness=createDeterministicBrowserRestartHarness({database:db,clock:()=>++now});
await harness.start(ctx);
await harness.checkpoint(ctx,{operation_id:'op-multi',idempotency_key:'idem-multi',type:'browser.action.started'});
for(let i=1;i<=4;i++){
  const restarted=await harness.restart(ctx);
  assert.equal(restarted.lifecycle.status,'recovery-required');
  assert.equal(restarted.lifecycle.recovered.length,1);
  const row=restarted.lifecycle.recovered[0];
  assert.equal(row.recovery_count,i);
  assert.equal(row.state,'recovery_required');
  assert.equal(row.requires_explicit_resume,true);
  assert.equal(row.automatic_effect_replay,false);
  assert.equal(row.effect_replay_allowed,false);
  assert.equal(row.authority_neutral,true);
}
assert.equal(harness.snapshot().restart_count,4);
assert.equal(harness.snapshot().worker_generation,5);
const recoveredReceipts=await harness.receipts(ctx,{operation_id:'op-multi'});
assert.equal(recoveredReceipts.filter(r=>r.kind==='recovered').length,4);

// Corrupt durable checkpoint identity: record locator and payload operation must never diverge.
db.mutate('co-a','op-multi',row=>{ row.data.operation_id='op-forged'; });
harness=createDeterministicBrowserRestartHarness({database:db,clock:()=>++now});
await assert.rejects(()=>harness.start(ctx),/checkpoint-corrupt|operation.*mismatch|integrity/i);
db.mutate('co-a','op-multi',row=>{ row.data.operation_id='op-multi'; });

// Corrupt safety invariants must fail closed rather than be trusted or normalized into authority.
db.mutate('co-a','op-multi',row=>{ row.data.effect_replay_allowed=true; });
harness=createDeterministicBrowserRestartHarness({database:db,clock:()=>++now});
await assert.rejects(()=>harness.start(ctx),/checkpoint-corrupt|effect.*replay|integrity/i);
db.mutate('co-a','op-multi',row=>{ row.data.effect_replay_allowed=false; });

// Unknown states and schemas are corruption, not a reason to improvise recovery.
db.mutate('co-a','op-multi',row=>{ row.data.state='mystery'; });
harness=createDeterministicBrowserRestartHarness({database:db,clock:()=>++now});
await assert.rejects(()=>harness.start(ctx),/checkpoint-corrupt|state|integrity/i);
db.mutate('co-a','op-multi',row=>{ row.data.state='recovery_required'; row.data.schema='evil.schema'; });
harness=createDeterministicBrowserRestartHarness({database:db,clock:()=>++now});
await assert.rejects(()=>harness.start(ctx),/checkpoint-corrupt|schema|integrity/i);

// Recursive legacy boundary contamination must still be rejected.
db.mutate('co-a','op-multi',row=>{ row.data.schema='titan.offline.restart-checkpoint.v1'; row.data.nested={tenant_id:'legacy'}; });
harness=createDeterministicBrowserRestartHarness({database:db,clock:()=>++now});
await assert.rejects(()=>harness.start(ctx),/legacy-company-boundary|checkpoint-corrupt|integrity/i);

console.log('Pass09 multi-restart and corruption regression PASS');

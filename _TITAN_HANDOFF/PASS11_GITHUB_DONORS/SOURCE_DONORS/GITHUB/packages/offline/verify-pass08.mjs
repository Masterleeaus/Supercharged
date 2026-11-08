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
  async getRecord(ctx,loc){
    return structuredClone(this.rows.find(r=>r.company_id===ctx.company_id&&r.module_id===loc.module_id&&r.collection===loc.collection&&r.record_id===loc.record_id)||null);
  }
  async listRecords(ctx,q){
    return structuredClone(this.rows.filter(r=>r.company_id===ctx.company_id&&r.module_id===q.module_id&&r.collection===q.collection));
  }
}

const db=new MemoryDb();
let now=1000;
const harness=createDeterministicBrowserRestartHarness({database:db,clock:()=>++now});
const ctx={company_id:'co-a',actor_id:'tester',operation_id:'op-1'};

const w1=await harness.start(ctx);
assert.equal(w1.worker_generation,1);
await harness.checkpoint(ctx,{operation_id:'op-1',idempotency_key:'idem-1',type:'browser.action.started'});
const suspended=await harness.suspend(ctx,{reason:'test-suspend'});
assert.equal(suspended.status,'suspended');

const restarted=await harness.restart(ctx);
assert.equal(restarted.worker_generation,2);
assert.equal(restarted.lifecycle.status,'recovery-required');
assert.equal(restarted.lifecycle.recovered.length,1);
assert.equal(restarted.lifecycle.recovered[0].state,'recovery_required');
assert.equal(restarted.lifecycle.recovered[0].automatic_effect_replay,false);
assert.equal(restarted.lifecycle.recovered[0].effect_replay_allowed,false);
assert.equal(restarted.lifecycle.recovered[0].authority_neutral,true);

const resumed=await harness.acknowledgeResume(ctx,{operation_id:'op-1',idempotency_key:'idem-1'});
assert.equal(resumed.state,'resumed');
const prepared=await harness.prepareContinuation(ctx,{operation_id:'op-1',idempotency_key:'idem-1'});
const claim1=await harness.claimContinuation(ctx,{operation_id:'op-1',idempotency_key:'idem-1',continuation_token:prepared.continuation_token});
assert.equal(claim1.claimed,true);
const claim2=await harness.claimContinuation(ctx,{operation_id:'op-1',idempotency_key:'idem-1',continuation_token:prepared.continuation_token});
assert.equal(claim2.claimed,false);
assert.equal(claim2.duplicate,true);

const receipts=await harness.receipts(ctx,{operation_id:'op-1'});
assert.ok(receipts.some(r=>r.kind==='recovered'));
assert.ok(receipts.some(r=>r.kind==='resumed'));
assert.ok(receipts.some(r=>r.kind==='continuation_claimed'));
assert.ok(receipts.some(r=>r.kind==='continuation_duplicate'));

const snap=harness.snapshot();
assert.equal(snap.worker_generation,2);
assert.equal(snap.restart_count,1);
assert.equal(snap.automatic_effect_replay,false);
assert.equal(snap.effect_replay_allowed,false);
assert.equal(snap.authority_neutral,true);

await assert.rejects(()=>harness.checkpoint({company_id:'co-b',operation_id:'op-1'},{company_id:'co-a',operation_id:'op-1',type:'x'}),/cross-company|company/);
console.log('Pass08 deterministic browser restart harness PASS');

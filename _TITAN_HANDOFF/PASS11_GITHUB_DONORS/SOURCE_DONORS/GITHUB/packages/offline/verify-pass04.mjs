import assert from 'node:assert/strict';
import { createContinuationGuard } from './continuation-guard.mjs';
import { createRestartCheckpointStore } from './restart-checkpoint.mjs';

const guard=createContinuationGuard();
const resumed={company_id:'company-a',operation_id:'op-1',idempotency_key:'idem-1',state:'resumed',terminal:false,recovery_count:2,effect_replay_allowed:false};
const prepared=guard.prepare(resumed,{company_id:'company-a'});
assert.equal(prepared.effect_replay_allowed,false);
assert.equal(prepared.continuation_pending,true);
assert.match(prepared.continuation_token,/company-a/);
await assert.rejects(async()=>guard.prepare({...resumed,company_id:'company-b'},{company_id:'company-a'}),/cross-company/i);
await assert.rejects(async()=>guard.prepare({...resumed,state:'recovery_required'},{company_id:'company-a'}),/resumed/i);
const claimed=guard.claim(prepared,{company_id:'company-a',continuation_token:prepared.continuation_token,idempotency_key:'idem-1'});
assert.equal(claimed.claimed,true);
assert.equal(claimed.duplicate,false);
assert.equal(claimed.record.continuation_pending,false);
assert.equal(claimed.record.continuation_claimed,true);
assert.equal(claimed.record.effect_replay_allowed,false);
const duplicate=guard.claim(claimed.record,{company_id:'company-a',continuation_token:prepared.continuation_token,idempotency_key:'idem-1'});
assert.equal(duplicate.claimed,false);
assert.equal(duplicate.duplicate,true);
await assert.rejects(async()=>guard.claim(prepared,{company_id:'company-a',continuation_token:'wrong',idempotency_key:'idem-1'}),/token/i);
await assert.rejects(async()=>guard.claim(prepared,{company_id:'company-a',continuation_token:prepared.continuation_token,idempotency_key:'wrong'}),/idempotency/i);

function memoryDb(){
  const rows=new Map();return {
    async putRecord(ctx,input){const key=`${ctx.company_id}|${input.module_id}|${input.collection}|${input.record_id}`;const value={company_id:ctx.company_id,module_id:input.module_id,collection:input.collection,record_id:input.record_id,data:structuredClone(input.data),provenance:structuredClone(input.provenance)};rows.set(key,value);return structuredClone(value);},
    async getRecord(ctx,loc){return structuredClone(rows.get(`${ctx.company_id}|${loc.module_id}|${loc.collection}|${loc.record_id}`)||null);},
    async listRecords(ctx,q){return [...rows.values()].filter(r=>r.company_id===ctx.company_id&&r.module_id===q.module_id&&r.collection===q.collection).map(x=>structuredClone(x));},
  };
}
let now=100;const store=createRestartCheckpointStore({database:memoryDb(),clock:()=>++now});const ctx={company_id:'company-a',operation_id:'op-2'};
await store.checkpoint(ctx,{type:'titan.work.started',operation_id:'op-2',idempotency_key:'idem-2'});
await store.recover(ctx);
await store.acknowledgeResume(ctx,{operation_id:'op-2',idempotency_key:'idem-2'});
const continuation=await store.prepareContinuation(ctx,{operation_id:'op-2',idempotency_key:'idem-2'});
assert.equal(continuation.continuation_pending,true);
const first=await store.claimContinuation(ctx,{operation_id:'op-2',idempotency_key:'idem-2',continuation_token:continuation.continuation_token});
assert.equal(first.claimed,true);
const second=await store.claimContinuation(ctx,{operation_id:'op-2',idempotency_key:'idem-2',continuation_token:continuation.continuation_token});
assert.equal(second.claimed,false);
assert.equal(second.duplicate,true);
console.log('TZ-WP-003 Pass 4 idempotent operation continuation PASS');
